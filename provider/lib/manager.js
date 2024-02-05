/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and 
 * limitations under the License.
 */

var needle = require('needle');
const LRU = require('lru-cache');
var HttpStatus = require('http-status-codes');
var constants = require('./constants.js');
var authHandler = require('./authHandler');
const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator, BasicAuthenticator  } = require('ibm-cloud-sdk-core');
var https = require('https');
var isShutdown = false; 

module.exports = function (logger, triggerDB, redisClient, databaseName) {

    var redisKeyPrefix = process.env.REDIS_KEY_PREFIX || databaseName;
    var self = this;

    self.triggers = {};
    self.endpointAuth = process.env.ENDPOINT_AUTH;
    self.exitOnDBError = process.env.EXIT_ON_DB_ERROR || 'false';
    self.routerHost = process.env.ROUTER_HOST || 'localhost';
    self.worker = process.env.WORKER || 'worker0';
    self.host = process.env.HOST_INDEX || 'host0';
    self.hostPrefix = this.host.replace(/\d+$/, '');
    self.activeHost = `${this.hostPrefix}0`; //default value on init (will be updated for existing redis)
    self.triggerDB = triggerDB;                     //Database in which the triggers are configured
    self.redisClient = redisClient;
    self.redisKey = redisKeyPrefix + '_' + this.worker;
    self.redisField = constants.REDIS_FIELD;
    self.uriHost = 'https://' + this.routerHost;
    self.monitorStatus = {};
    self.pauseResumeEnabled = "true";   //* By default it is switched ON
    self.changesFilterEnabled = "true"; //* By default it is switched ON
    self.healthObject; 
    self.databaseName = databaseName;
    this.openTimeout = parseInt(process.env.HTTP_OPEN_TIMEOUT_MS) || 30000;
    this.httpAgent = new https.Agent({
      keepAlive: process.env.HTTP_SOCKET_KEEP_ALIVE === 'true',
      maxSockets: parseInt(process.env.HTTP_MAX_SOCKETS) || 400,
      maxTotalSockets: parseInt(process.env.HTTP_MAX_TOTAL_SOCKETS) || 800,
      scheduling: process.env.HTTP_SCHEDULING || 'lifo',
    });
    
    //****************************************************
    //* Registering of Health object which can be used 
    //* to update the self-test monitor status whenever 
    //* is needed 
    //****************************************************
    this.registerHealthObject = function (healthObj) {
        const method = 'registerHealthObject'; 
        
        this.healthObject = healthObj;
        logger.info(method, 'Health obj successfully registered ');    
    };
    
    // Add a trigger: listen for changes and dispatch.
    this.createTrigger = function (triggerData, isStartup) {
        var method = 'createTrigger';
        var postChangesTimeout = 50000;  //** 50 seconds to wait max in one call for a doc change 
        let options;

        var dbURL = `${triggerData.protocol}://${triggerData.host}`;
        if (triggerData.port) {
            dbURL += ':' + triggerData.port;
        }

        if (triggerData.iamApiKey) {
            //******************************************************
            //* options if cloudant DB is using IAM Authentication 
            //******************************************************
            const authenticator = new IamAuthenticator({
                apikey: triggerData.iamApiKey,
                url: triggerData.iamUrl
            });

            options = {
                authenticator,
            };
            
        } else {
            //******************************************************
            //* options if cloudant DB is using Basic Auth with 
            //* userid/pw 	
            //******************************************************
            const authenticator = new BasicAuthenticator({
                username: triggerData.user,
                password: triggerData.pass,
            });

            options = {
                authenticator,
            };
        }

        //******************************
        //* connect to customerDB 
        //******************************
        var customerDBClient = CloudantV1.newInstance(options); 
        customerDBClient.setServiceUrl(dbURL);

        //** only for logging  */
        if ( triggerData.query_params ) {
            logger.info(method, 'Trigger', triggerData.id, ' customer DB :', triggerData.dbname , ' db filter : ' , triggerData.filter, ' uses query_params :  ' , triggerData.query_params ); 
        }
        //*********************************************************************
        //* check if db connect was successful.
        //* HINT: in old implementation with cloudant-follow-lib the result of the 
        //*       initial feed.follow() call was used to decide for resolve / reject 
        //*       Now with SDK the result of getDatabaseInformation will be used. 
        //*********************************************************************
        return new Promise(function (resolve, reject) {

            customerDBClient.getDatabaseInformation({ 'db' : triggerData.dbname })
            .then(() => {
                logger.info(method, 'Trigger', triggerData.id,  'Start listening for changes in customer database', triggerData.dbname);
                if (isMonitoringTrigger(triggerData.monitor, triggerData.id)) {
                    self.monitorStatus.triggerStarted = "success";
                }
                self.triggers[triggerData.id] = triggerData;
                resolve(triggerData.id);
                
            })
            .then(() => {
                //***************************************************************
                //* define function that listen on doc changes in customer DB 
                //***************************************************************
                let followCustomerDB = () => {
                    //****************************************************************
                    //* start changes listener , surrounded by try / catch , 
                    //* so that in any case the promise will be resolved or rejected 
                    //****************************************************************
                    try {

                        //******************************************************************** 
                        //* Start listening on document changes in customer DB 
                        //*****************************************************************************************
                        //* IMPORTANT: workaround for queryParams handling, because  cloudant-sdk
                        //*            module does not provide queryParams support. So use an 
                        //*            intercept to the http listener before starting the follow db changes loop
                        //*****************************************************************************************
                        if ( triggerData.query_params ) {
                            // logger.info(method, 'Trigger', triggerData.id, ' customer DB :', triggerData.dbname , ' uses query_params :  ' , triggerData.query_params ); 
                            customerDBClient.getHttpClient().interceptors.request.use(queryParamsInterceptor( triggerData.filter, triggerData.query_params, triggerData.id ));
                        }	
                        //***************************************
                        //* Call function with async endless loop
                        //***************************************
                        customerDbFollow( customerDBClient, triggerData.dbname, postChangesTimeout , 'now', triggerData )
                        
                    } catch (err) {
                        if (err.message != undefined) {
                            logger.error(method, ' error in change listener to customer DB ', triggerData.dbname ,' for trigger', triggerData.id, ', err = ', err.message);
                        } else {
                            logger.error(method, ' caught an exception in change listener to customer DB ', triggerData.dbname ,' for trigger', triggerData.id, err);
                        } 
                    }

                }

                //***************************************************************
                //* if createTrigger() is called during initAllTriggers  then 
                //* read the chgHistory Hash table from Redis and fill into the 
                //* lruCache before starting to listen on customer DB (feed.follow)
                //***************************************************************
                if  ( isStartup ) {
                    let redisHashName = self.worker + "_" + triggerData.id; 
                    self.redisClient.hgetallAsync( redisHashName )
                    .then(  docHistory => {
                        //****************************************
                        //* docHistory == null, if no docs in Hash 
                        //****************************************
                        if ( docHistory == null ) {
                            logger.info(method, 'No ChgHistory found in REDIS DB for trigger ', redisHashName, '. Provider runs OK without pre-loaded chgHistory cache');
                        } else {
                            //*******************************************************************************
                            //* docHistory is in format :  "history" : <JsonString of all doc/rev elememts>
                            //* JsonString :  [{"doc": "<docName>","rev":"<revValue>"},{"doc": "<docName>","rev":"<revValue>"},....]
                            //*******************************************************************************
                            let docHistoryArray = docHistory.history
                            var chgHistoryOftrigger =  JSON.parse(docHistoryArray) 
                            var numOfChgHistoryElements = 0 ; 

                            //***********************************************************
                            //* Fill read chgHistory info to the lru Caches
                            //***********************************************************
                            chgHistoryOftrigger.forEach( (element) =>{  
                                triggerData.lruCache.set ( element.doc, element.rev)
                                numOfChgHistoryElements = numOfChgHistoryElements + 1 ; 

                            })
                            logger.info(method, 'lruCache for trigger = ', redisHashName, ' loaded with ', numOfChgHistoryElements , ' doc/revision records');
                            if ( numOfChgHistoryElements > 0 ) {
                                self.redisClient.delAsync(redisHashName) 
                                .then(  () => {
                                    logger.info(method, 'chgHistory for trigger = ', redisHashName, ' with ', numOfChgHistoryElements , ' doc/revision records intentionally deleted');
                                })   
                            }
                        }    
                    })
                    .catch(err => {
                        logger.info(method, 'Error while reading chgHistory in REDIS DB for trigger ', redisHashName, '. Provider runs OK without pre-loaded chgHistory cache. Err = ', err);
                    })
                    .finally( () => {
                        //*******************************************
                        //* run listening independent if lru cache 
                        //* could be read or not. 
                        //*******************************************
                        followCustomerDB();
                    });
                    
                } else {
                    //*******************************************
                    //* run listening without lru cache for 
                    //* triggers create during lifetime of provider
                    //*******************************************
                    followCustomerDB(); 
                }
            })
            .catch(err => {
                logger.error(method, 'Trigger', triggerData.id, ' failed to read db info of customer DB :', triggerData.dbname , ' indicator that trigger config data incorrect,  err = ', err);
                if (self.exitOnDBError === 'true' && isStartup) {
                    logger.error(method, 'Error occurred during startup of trigger', triggerData.id, '(db ' + triggerData.dbname + ' ):', err , "process will exit ");
                    process.exit(1);  //** ENV var can set exitOnDBError, so the whole provider stop/restart, when a trigger cannot be set up during startup 
                } else {
                    self.triggers[triggerData.id] = triggerData;
                    reject(err);
                    return;  //** return immediately and do not start the listening on changes for this trigger
                }
            });


        }) //**  end of  return new Promise  */    
    };


	//***************************************************
    //* start a follow on custer DB dod changes
    //***************************************************	
    async function customerDbFollow( customerDBClient, dbname, timeout, seq, triggerData) {
        var method = 'CustomerDbFollow';
	
        //********************************************************************************************
		//* wrapper function to ensure that the postChanges() call from the @ibm-cloud/cloudant sdk 
		//* module will not wait forever on connecting to DB and try to get changes. 
		//* HINT: The wrapper is necessary because it was detected that the postChanges did not 
		//*       issue resolve() or reject()  in any cases. So the postChanges SDK call sometimes seems to hang forever 
		//********************************************************************************************
		let wrappingPostChanges = () => new Promise( (resolve, reject) => {
			var  error = false; 
			
			//*******************************************************************************************
			//* setup a timeout value that is little bigger then the postChanges() timeout e.g + 1 sec 
			//* if this timeout reached send the STRING "WRAPPER_TIMEOUT" as err info
			//*******************************************************************************************
			setTimeout( function(){ reject( "WRAPPER_TIMEOUT" ) }, timeout + 2000); 
			
			//*******************************************************************************************
			//* do the cloudant-sdk call to get the changes. Provide resolve(), reject() accordingly. 
			//* if the customer provided a filter, then it must be set 
			//*******************************************************************************************
  	        var postChangesParams = { 
			  db : dbname ,
			  feed : 'longpoll',
			  timeout : timeout,
			  since: seq ,
			  includeDocs : false 
			}
					
            if ( triggerData.filter ) { 
				postChangesParams.filter = triggerData.filter; 
		    }
			
			customerDBClient.postChanges(postChangesParams)
			.then( response => {
				if(!error) {

					resolve(response);
				} 		
		    })
			.catch ( err  => {
				reject(err); 
			})			
		});
	
	
        //********************************************
        //* try/catch/finally used to handle result of 
        //* Promise in  await wrappingPostChanges 
		//* run in endless asynchronous loop 
		//*********************************************		
        while( true ){
  		    try {

                //***********************************************************************
                //* Before starting to listen on doc changes, check if the trigger id is
                //* still in the active triggers list. A deleteTrigger() call can delete 
                //* a trigger id anytime 
                //***********************************************************************
                if ( ! self.triggers[triggerData.id]  ) {
                    //***********************************************
                    //* end loop for trigger id that does not exist 
                    //***********************************************
                    logger.info(method,'Trigger', triggerData.id, " end the listen loop for trigger ");
                    break;
                }

                //*************************************************************
                //* Handling of pause state.   listening on DB changes may be 
                //* paused for a customerDB on overload situation ( e.g rc=429)
                //**************************************************************
                if ( triggerData.pauseState == true ) {
                    //****************************************************
                    //* check every 10 sec, if pauseState is still active 
                    //****************************************************
                    logger.info(method,'Trigger', triggerData.id, " is in pause_state = true mode ");
                    await PromiseTimeout(10000);			
					continue;
                }

                //TODO: switch off log statement for PROD env  
                //logger.info(method,'Trigger', triggerData.id, " Wait for " , timeout ,"seconds on a doc change in DB ", dbname);
                let response = await wrappingPostChanges();	
                // logger.info(method,'Trigger', triggerData.id, " Received following change from DB = ", response);
              

                //***********************************************************************
                //*  if  response =""      -> SDK version < 0.4  returns in json error case an empty string 
                //*  if  response =  {  "results": [] , "last_seq" : value }  means  timeout occur 
                //*  if  response = <value>  Doc change received  ( feed.on(data,..))
                //************************************************************************
                if ( Object.keys(response).length === 0  ) {
                    logger.error(method, " : Cloudant-SDK provided an unexpected empty response object on postChanges() call.");
                    //* Intentionally continuing with the same seq as in previous loop-run. NO need to explicitly set it       
                    //* seq = seq; 
                } else if ( response  && response.result.results == 0  ) {
                    var lastSeq = response.result.last_seq ;
                    //**Continue to  loop with provided seq number 
                    //logger.info(method,'Trigger', triggerData.id, " Received expected timeout result from DB ");
                    seq = lastSeq;

                } else { 
                 
                    //********************************************************************
                    //* get the last_seq value to use in the next postChanges() query 
                    //********************************************************************
                    var lastSeq = response.result.last_seq ; 
                    var numOfChangesDetected = Object.keys(response.result.results).length
                
                    logger.info(method, 'Trigger', triggerData.id, ' got change from customer DB, with lastseq = ', lastSeq );
                
                    for ( let i = 0 ; i < numOfChangesDetected; i++ ) {
                        // logger.info(method, 'Trigger', triggerData.id, '!!!!!! customerDB Obj =   " , response.result.results[i]);
                        customerDbChangeHandler(triggerData, response.result.results[i] ); 
                    }
                    seq = lastSeq;
                }    
            } catch (err) {
         
                //*****************************************************
                //* handle how to proceed loop in case of WRAPPER_TIMEOUT
				//*******************************************************
				if ( "WRAPPER_TIMEOUT" == err ) {
                    //****************************************************
                    //* wrapper timeout received, when sdk timeout not worked (SDK bug )
                    //****************************************************
                    logger.info(method, 'Trigger', triggerData.id, 'Got wrapper timeout on listen to customer DB ', triggerData.dbname );
					seq = seq ;   //** run postChanges call with the same start value again 
				} else {
					//***************************************************
					//* postChanges()  call ends with error 
                    //* err.body exists, so err thrown by postChanges() call 
					//***************************************************
                    if ( err.body ) {
					    var errObj = JSON.parse(err.body)
                        logger.info(method, 'Trigger', triggerData.id,' got error in listen changes loop. Will restart loop in 3 sec. ( err = ' , err ,  ' details = ', errObj.error, ' )' );	
                        await PromiseTimeout(3000);			
					    seq = 'now';
                    } else {
                        logger.info(method, 'Trigger', triggerData.id,' received error in listen changes loop. Will restart loop in 1 sec. ( err = ' , err.toString(), ' )' );	
                        await PromiseTimeout(1000);			
			            seq = 'now';
                    }    	 
				}
            
            }

        } // end of endless while loop 
        logger.info(method,'Trigger', triggerData.id, " endless loop to wait on changes ended. ");  		
    }


    //***************************************************
    //* react on a single change of a document in the customer DB 
    //***************************************************
    function customerDbChangeHandler(triggerData, change){
        var method = 'customerDbChangeHandler';
       
        //****************************************************************
        //* Cloundant DB changes tracking gets sometimes duplicated Changes
        //* notified in case of "cloudant DB rewind" situation. To prevent the 
        //* provider from fire triggers use a chgHistoryCache
        //******************************************************************
        let doc_name ="unknown"
        let doc_revision="unknown"
        let doc_revision_nr = 0

        //*********************************************
        //* extract seq_nr from change object to log it
        //*********************************************
        if ( change.id != null){
            doc_name = change.id; 
        }
        if ( change.changes != null && change.changes[0] != null && change.changes[0].rev != null ){
            doc_revision= change.changes[0].rev; 
            doc_revision_nr= Number(doc_revision.split('-')[0]); 
        }
        
        //***********************************************************
        //* if changes filter is switched off, then fire trigger for 
        //* each received change notification 
        //***********************************************************
        var triggerHandle = self.triggers[triggerData.id];
        var filterChangeOut = false; 

        if ( self.changesFilterEnabled == "true"   &&  doc_name != "unknown" ) {  //** over endpoint switch ON/OFF possible */
            
            //********************************************************
            //* internal health test triggers, created in health.js do 
            //* not create an lruCache in its triggerdata. So skip the 
            //* filtering for them 
            //*********************************************************
            if ( triggerHandle && !(triggerHandle.lruCache == undefined) ) {
                var revInHistory = triggerHandle.lruCache.get(doc_name);
                if (revInHistory == undefined){
                    triggerHandle.lruCache.set(doc_name, doc_revision_nr);  
                    filterChangeOut = false;   
                }else  if ( parseInt(doc_revision_nr)  > parseInt(revInHistory) ){
                    triggerHandle.lruCache.set(doc_name, doc_revision_nr);  
                    filterChangeOut = false;
                    
                }else{
                    filterChangeOut = true; 
                }
            }
        }
        
        logger.info(method, 'Trigger', triggerData.id, 'got change from customer DB :', triggerData.dbname ,' for doc: ', doc_name , ' whith revision : ', doc_revision );
        
        if ( filterChangeOut == false ) {  
            if (triggerHandle && shouldFireTrigger(triggerHandle) && hasTriggersRemaining(triggerHandle)) {
                try {
                    fireTrigger(triggerData.id, change);
                } catch (e) {
                    logger.error(method, 'Exception occurred while firing trigger', triggerData.id, e);
                }
            }
        }else{
            logger.info(method, 'Trigger', triggerData.id, ' on customer DB: ',  triggerData.dbname ,' filtered out the on document : ', doc_name , ' whith revision : ', doc_revision);
        }
	};

	


    function initTrigger(newTrigger) {
        var maxTriggers = newTrigger.maxTriggers || constants.DEFAULT_MAX_TRIGGERS;

        return {
            id: newTrigger.id,
            host: newTrigger.host,
            port: newTrigger.port,
            protocol: newTrigger.protocol || 'https',
            dbname: newTrigger.dbname,
            user: newTrigger.user,
            pass: authHandler.decryptAuth(newTrigger.pass),
            apikey: newTrigger.apikey,
            since: newTrigger.since || 'now',
            maxTriggers: maxTriggers,
            triggersLeft: maxTriggers,
            filter: newTrigger.filter,
            query_params: newTrigger.query_params,
            additionalData: newTrigger.additionalData,
            iamApiKey: authHandler.decryptAuth(newTrigger.iamApiKey),
            iamUrl: newTrigger.iamUrl,
            lruCache: initLRUCache(),
            pauseState : false
        };
    }

    function disableTrigger(triggerIdentifier, statusCode, message , inRetry) {
        var method = 'disableTrigger';

        self.triggerDB.getDocument({
            db: self.databaseName,
            docId: triggerIdentifier
        })
        .then(response => {
            var existingConfig = response.result;
            if (!existingConfig.status || existingConfig.status.active === true) {
                var updatedTriggerConfig = existingConfig;
                updatedTriggerConfig.status = {
                    'active': false,
                    'dateChanged': Date.now(),
                    'reason': {'kind': 'AUTO', 'statusCode': statusCode, 'message': message}
                };
                self.triggerDB.putDocument({
                    db: self.databaseName,
                    docId: triggerIdentifier,
                    document: updatedTriggerConfig
                }).then(response => {
                    logger.info(method, triggerIdentifier, ': Trigger successfully disabled in database');
                })
                .catch( (err) => {
                    if (err.message != undefined) {
                        logger.error(method, "Failed update trigger config info in configDB while disabling with  err = ",err.message);
                    } else {
                        logger.error(method, triggerIdentifier, ': There was an error while disabling in database :', err);
                    }    
                })
            }
        })
        .catch( (err) => {
            //***************************************************************************************
            //* Do a one time retry in case of timeout 
            //***************************************************************************************
            if (err.message != undefined) {
                logger.error(method, "Failed to read all trigger config info from configDB with err = ",err.message);
            } else if ( err && err.code == 408 && inRetry == undefined ) {
                logger.info(method,triggerIdentifier, ': timeout in getDocument() call, do a retry'); 
                disableTrigger(triggerIdentifier,  statusCode, message , "inRetry");                 
            } else if ( err && err.code == 404) {
                logger.warn(method,triggerIdentifier, ': Could not find trigger in database anymore');  
                deleteTrigger(triggerIdentifier);
            } else {
                logger.warn(method,triggerIdentifier, ': Could not find trigger in database : '+ err);
                deleteTrigger(triggerIdentifier);
            }

        })
    }

    // Delete a trigger: stop listening for changes and remove it.
    function deleteTrigger(triggerIdentifier, monitorTrigger) {
        var method = 'deleteTrigger';

        if (self.triggers[triggerIdentifier]) {
            if (self.triggers[triggerIdentifier].feed) {
                self.triggers[triggerIdentifier].feed.stop();
            }

            //*******************************************************
            //* Internal test triggers do not have a lruCache as 
            //* Change History tracker and no RedisHashmap to store it.
            //* So ensure that only for prod triggers the Redis 
            //* hashmap gets deleted, when a trigger gets deleted 
            //********************************************************
            if ( !( self.triggers[triggerIdentifier].lruCache == undefined) )  {
                if(  self.triggers[triggerIdentifier].lruCache.size > 0 ) {   
                    let redisHashName = self.worker + "_" + triggerIdentifier;             
                    self.redisClient.delAsync(redisHashName) 
                    .then(  () => {
                        logger.info(method, 'chgHistory for the deleted trigger = ', redisHashName, ' intentionally deleted');
                    })
                }       
            }
            
            delete self.triggers[triggerIdentifier];
            logger.info(method, 'trigger', triggerIdentifier, 'successfully deleted from memory');
            
            if (isMonitoringTrigger(monitorTrigger, triggerIdentifier)) {
                self.monitorStatus.triggerStopped = "success";
                if ( self.healthObject ) {
                	//**************************************************
                	//* trigger the health obj to pull the monitor status 
                	//* of the successfully executed self-test trigger 
                	//* immediately, instead of waiting next monitor() loop
                	//***************************************************
                	self.healthObject.updateMonitorStatus()
                }
            }
        }
    }

    function fireTrigger(triggerIdentifier, change) {
        var method = 'fireTrigger';

        var triggerData = self.triggers[triggerIdentifier];
        var triggerObj = parseQName(triggerData.id);

        var form = change;
        form.dbname = triggerData.dbname;

        logger.info(method, 'Database change detected for', triggerData.id);

        var host = 'https://' + self.routerHost;
        var uri = host + '/api/v1/namespaces/' + triggerObj.namespace + '/triggers/' + triggerObj.name;

        postTrigger(triggerData, form, uri, 0)
        .then(triggerId => {
            logger.info(method, 'Trigger', triggerId, 'was successfully fired');
            if (isMonitoringTrigger(triggerData.monitor, triggerId)) {
                self.monitorStatus.triggerFired = "success";
            }
            if (triggerData.triggersLeft === 0) {
                if (triggerData.monitor) {
                    deleteTrigger(triggerId, triggerData.monitor);
                } else {
                    disableTrigger(triggerId, undefined, 'Automatically disabled after reaching max triggers');
                    logger.warn(method, 'no more triggers left, disabled', triggerId);
                }
            }
        })
        .catch(err => {
            logger.error(method, err);
        });
    }

    function postTrigger(triggerData, form, uri, retryCount) {
        var method = 'postTrigger';
        var isIAMNamespace = triggerData.additionalData && triggerData.additionalData.iamApikey;

        return new Promise(function (resolve, reject) {

            // only manage trigger fires if they are not infinite
            if (triggerData.maxTriggers && triggerData.maxTriggers !== -1) {
                triggerData.triggersLeft--;
            }

            self.authRequest(triggerData, {
                method: 'post',
                uri: uri
            },form,
            function (error, response) {
                try {
                    var statusCode = response ? response.statusCode : undefined;
                    var headers = response ? response.headers : undefined;
                    var triggerIdentifier = triggerData.id;

                    //check for IAM auth error and ignore for now (do not disable) due to bug with IAM
                    if (error && error.statusCode === 400) {
                        var message;
                        try {
                            message = `${error.error.errorMessage} for ${triggerIdentifier}, requestId: ${error.error.context.requestId}`;
                        } catch (e) {
                            message = `Received an error generating IAM token for ${triggerIdentifier}: ${error}`;
                        }
                        reject(message);
                    } else if (error || statusCode >= 400) {
                        logger.error(method, 'Received an error invoking', triggerIdentifier, statusCode || error);

                        // only manage trigger fires if they are not infinite
                        if (triggerData.maxTriggers && triggerData.maxTriggers !== -1) {
                            triggerData.triggersLeft++;
                        }
                        if (statusCode && shouldDisableTrigger(statusCode, headers, isIAMNamespace)) {
                            var errMsg = `Received a ${statusCode} status code when firing the trigger`;
                            disableTrigger(triggerIdentifier, statusCode, `Trigger automatically disabled: ${errMsg}`);
                            reject(`Disabled trigger ${triggerIdentifier}: ${errMsg}`);
                        } else {
                            if (retryCount < constants.RETRY_ATTEMPTS) {
                                //**************************************************************************************
                                //* Special handling for reaching Namespace limits for this trigger  ( if Pause/Resume Flag is enabled)
                                //* - if limit reached ( statusCode == 429 ) then pause the reading events
                                //*   from customer cloudant DB and do retry every 5 seconds to fire pending trigger 
                                //*   and schedule  an end of the pause to run in 120 sec to restart reading events 
                                //***************************************************************************************
                                var timeout = 1000;  //default 
                                if ( statusCode === 429 && self.pauseResumeEnabled == "true" ) {
                                    timeout = 6000;
                                    try {
                                      triggerData.pauseState = true ;  
                                      logger.info(method, 'Paused receiving events for trigger:', triggerIdentifier, ' issued while Retry Count:', (retryCount + 1));    
                                      //********************************************************************
                                      //* schedule the asynchronous function in 120 sec resuming the feed  
                                      //* to continue reading cloudant db changes events 
                                      //******************************************************************** 
                                      setTimeout(function () {
                                        triggerData.pauseState = false; 
                                        logger.info(method, 'Resumed receiving events for trigger:', triggerIdentifier, 'issued while Retry Count:', (retryCount + 1));
                                           
                                      }, 120000);
                                    } catch (err) {
                                      logger.error(method, 'Failed on Pause the feed. Error: ', err );  
                                      //** continue processing without pausing/resuming this trigger
                                    }  
                                }else if ( statusCode === 429 && self.pauseResumeEnabled != "true" && retryCount === 0 ) { 
                                    timeout = 60000;
                                }else if ( statusCode === 429 && self.pauseResumeEnabled != "true" ) { 
                                    //*********************************************************************
                                    //* exponential handling of timeouts for retries has no effect on reaching 
                                    //* limits. -> so use a  fix value for timeout 
                                    //********************************************************************** 
                                    timeout = 6000;
                                }else{
                                    timeout =  1000 * Math.pow(retryCount + 1, 2);
                                }
                                logger.info(method, 'Attempting to fire trigger again', triggerIdentifier, 'Retry Count:', (retryCount + 1));
                                
                                setTimeout(function () {
                                    postTrigger(triggerData, form, uri, (retryCount + 1))
                                    .then(triggerId => {
                                        resolve(triggerId);
                                    })
                                    .catch(err => {
                                        reject(err);
                                    });
                                }, timeout);
                            } else {
                                reject('Unable to reach server to fire trigger ' + triggerIdentifier);
                            }
                        }
                    } else {
                        logger.info(method, 'Fire', triggerIdentifier, 'request,', 'Status Code:', statusCode);
                        resolve(triggerIdentifier);
                    }
                } catch (err) {
                    reject('Exception occurred while firing trigger ' + err);
                }
            });
        });
    }

    function shouldDisableTrigger(statusCode, headers, isIAMNamespace) {
        //temporary workaround for IAM issues
        // do not disable for 401s or 403s for IAM namespaces
        if ((statusCode === HttpStatus.FORBIDDEN || statusCode === HttpStatus.UNAUTHORIZED) && isIAMNamespace) {
            return false;
        }

        return statusCode === HttpStatus.BAD_REQUEST || ((statusCode > 400 && statusCode < 500) && hasTransactionIdHeader(headers) &&
            [HttpStatus.REQUEST_TIMEOUT, HttpStatus.TOO_MANY_REQUESTS, HttpStatus.CONFLICT].indexOf(statusCode) === -1);
    }

    function hasTransactionIdHeader(headers) {
        return headers && headers['x-request-id'];
    }

    function shouldFireTrigger(trigger) {
        return trigger.monitor || self.activeHost === self.host;
    }

    function hasTriggersRemaining(trigger) {
        return !trigger.maxTriggers || trigger.maxTriggers === -1 || trigger.triggersLeft > 0;
    }

    function isMonitoringTrigger(monitor, triggerIdentifier) {
        return monitor && self.monitorStatus.triggerName === parseQName(triggerIdentifier).name;
    }

    this.initAllTriggers = function () {
        var method = 'initAllTriggers';

        //follow the trigger DB
        setupFollow('now');

        try{       
            logger.info(method, 'resetting system from last state in DB');
            //*********************************************************
            //* Read currently existing trigger configs from DB and 
            //* create a trigger for each 
            //*********************************************************
            let postViewParams = {
                db: self.databaseName,
                ddoc : constants.VIEWS_DESIGN_DOC,
                view : constants.ALL_TRIGGERS,
                reduce: false,
                includeDocs: true
                //key: self.worker
            }
            
            self.triggerDB.postView( postViewParams)
            .then(response => {
                // (only debug log statement) logger.info(method, 'Found trigger document : ', response);
                
                if ( response.result ) {
                    var triggerConfigList = response.result.rows; 

                    if ( triggerConfigList ) {
                        triggerConfigList.forEach(function (trigger) {
                            var triggerIdentifier = trigger.id;
                            var doc = trigger.doc;

                            //***************************************************
                            //* Check if detected trigger is NOT a disabled one
                            //***************************************************
                            if ( doc && doc.status && doc.status.active === false ) {
                                logger.info(method, ' configured trigger', triggerIdentifier, ' is marked as disabled. Not starting it');
                            
                            } else if (!(triggerIdentifier in self.triggers)) {     //* trigger not already started
                                //check if trigger still exists in whisk db
                                var triggerObj = parseQName(triggerIdentifier);
                                var host = 'https://' + self.routerHost + ':' + 443;
                                var triggerURL = host + '/api/v1/namespaces/' + triggerObj.namespace + '/triggers/' + triggerObj.name;
                                var isIAMNamespace = doc.additionalData && doc.additionalData.iamApikey;
        
                                logger.info(method, 'Checking if trigger', triggerIdentifier, 'still exists');
                                self.authRequest(doc, {
                                    method: 'get',
                                    uri: triggerURL
                                },undefined, 
                                function (error, response) {
                                    if (!error && shouldDisableTrigger(response.statusCode, response.headers, isIAMNamespace)) {
                                        var message = 'Automatically disabled after receiving a ' + response.statusCode + ' status code on init trigger';
                                        disableTrigger(triggerIdentifier, response.statusCode, message);
                                        logger.error(method, 'trigger', triggerIdentifier, 'has been disabled due to status code:', response.statusCode);
                                    } else {
                                        self.createTrigger(initTrigger(doc), true)
                                        .then(triggerIdentifier => {
                                            logger.info(method, 'trigger ', triggerIdentifier, 'created successfully');
                                        })
                                        .catch(err => {
                                            // GIT issue #86: Do no more automatically disable trigger on startup , because in case of a 
                                            //                temporarily network/DNS error all triggers got disabled 
                                            // var message = 'Automatically disabled after receiving exception on init trigger: ' + err;
                                            // disableTrigger(triggerIdentifier, undefined, message);
                                            // logger.error(method, 'Disabled trigger', triggerIdentifier, 'due to exception:', err);
                                       
                                            logger.error(method, 'trigger ', triggerIdentifier, 'could not be started during provider start this time :', err);
                                            logger.info(method, 'A subsequent provider stop and restart will re-activate the trigger again');
                                       
                                        });
                                    }
                                });
                            }
                        });
                        logger.info(method, ' all triggers configured in ConfigDB at Startup are started ');
                        
                    }
                    else {
                        logger.error(method, ': No configured Trigger obj found in database. Count nr = ', response.result.total_rows );
                    }
                }
            })
            .catch( err => {             
                if (err.message != undefined) {
                    logger.error(method, "Failed to read trigger config info from configDB with  err = ",err.message);
                }
                logger.error(method, "Failed to read trigger config info from configDB with  error : ",err);
            })
 
        } catch (err) {
            logger.error(method, ": Error in call command to provider configuration DB : " + err );
        }

    };

    //*********************************************************
    //* setup follow is continuously receiving changes of the  
    //* trigger configDB 
    //* parm: seq - allows to define the start point of changes 
    //*             to receive 
    //*********************************************************
    async function setupFollow(seq) {
        var method = 'setupFollow';
        var postChangesTimeout = 60000; 
        var wrapperTimeout = postChangesTimeout + 1000; 
        
        //********************************************************************************************
		//* wrapper function to ensure that the postChanges() call from the @ibm-cloud/cloudant sdk 
		//* module will not wait forever on connecting to DB and try to get changes. 
		//* HINT: The wrapper is necessary because it was detected that the postChanges did not 
		//*       issue resolve() or reject()  in any cases. So it seems to hang forever 
		//********************************************************************************************
		var wrappingPostChanges = () => new Promise( (resolve, reject) => {
			var  error = false; 
            //*******************************************************************************************
			//* setup a timeout value that is little bigger then the postChanges() timeout e.g + 1 sec 
			//* if this timeout reached send the STRING "WRAPPER_TIMEOUT" as err info
			//*******************************************************************************************
			setTimeout( function(){ reject( "WRAPPER_TIMEOUT" ) }, wrapperTimeout); 
			
			//******************************************************************************
            //* use longpoll feed to hold the socket to the trigger configDB open as long as 
            //* possible to reduce HTTP session start/stop cycles . ( max timeout =  1 min)
            //* It may be that one response contains multiple change recods !!! 
            //******************************************************************************
            var viewPath = constants.VIEWS_DESIGN_DOC + '/' + constants.ALL_TRIGGERS ;
            var postChangesParams = { 
                db : self.databaseName,
                feed : 'longpoll',
                timeout : postChangesTimeout,
                filter :  "_view",
                view: viewPath,
                since: seq ,
                includeDocs : true 
                // query_Params : "worker0 | worker1"  --> no more needed since FRA and SYD rebuilt to single worker0  setup
              }
            
            self.triggerDB.postChanges( postChangesParams)
         	.then( response => {
				if(!error) {
					resolve(response);
				} 		
		    })
			.catch ( err  => {
				reject(err); 
			})			
		});


        while ( true ) {
            try {
                logger.info(method, "Next trigger configDB read sequence starts on : [", seq, "]");
                
                let response = await wrappingPostChanges();	
                //********************************************************************
                //* get the last_seq value to use in the next setupFollow() query 
                //* if not part of response, then let it thrown an exception to end in 
                //* the catch() to ensure that loop continues. 
                //********************************************************************
                if ( Object.keys(response).length === 0  ) {
                    logger.error(method, " : Cloudant-SDK provided an unexpected empty response object on postChanges() call.");
                }

                var lastSeq = response.result.last_seq ;  //on a "empty" response which cloudantSDK sometimes deliver an exception occur here and logic continue in catch block
                var numOfChangesDetected = Object.keys(response.result.results).length
                logger.info(method,  numOfChangesDetected + " changes records received from configDB with last seq : ", lastSeq);
        
                for ( let i = 0 ; i < numOfChangesDetected; i++ ) {
                    //***********************************************************************
                    //* Do not write logs for changes received for  monitoring self-test triggers 
                    //* assigned to other worker host. 
                    //***********************************************************************
                    var changedDoc = response.result.results[i].doc; 

                    if ( changedDoc && changedDoc.monitor &&  changedDoc.monitor != self.host ){
                        logger.info(method,  "detected a change of the self-test trigger related to the partner worker : doc_id = ", changedDoc._id, changedDoc._rev, " and doc_status = ",  changedDoc.status);     
                    }else{

                        if ( response.result.results[i].deleted == true) {
                            logger.info(method,  "call change Handler on deleted doc with  doc_id = ", changedDoc._id, changedDoc._rev );    
                        }else {
                            logger.info(method,  "call change Handler with for doc_id = ", changedDoc._id, changedDoc._rev, " and doc_status = ",  changedDoc.status);    
                        }
                        changeHandler( response.result.results[i] ); 
                    }
                }
                //** Continue to try to read from configDB immediately   
                seq = lastSeq;	
                
            } catch (err) {
                seq = seq ;   //** run postChanges call with the same start value again 
                //*****************************************************
                //* handle how to proceed loop in case of WRAPPER_TIMEOUT
				//*******************************************************
				if ( "WRAPPER_TIMEOUT" == err ) {
                    logger.warn(method, ": processing postChanges() did not end in its own timeout. Wrapper timeout ended the postChanges() call. postChanges() Loop continuing ...");
				} else if (err.message != undefined) {
                    logger.error(method, "Failed to read the trigger config info from configDB with  err = ",err.message);
                } else {
		            logger.error(method, "Failed to read the trigger config info in configDB with  error : ",err);
		        }    	
            }
        } // end of endless while loop 	    
    }

    //***************************************************
    //* react on the event that the trigger configuration
	//* has changed in the trigger configDB 
    //***************************************************
    function changeHandler(change){
        var method = 'changeHandler';

        var triggerIdentifier = change.id;
		var doc = change.doc;
        var triggerDeleted = change.deleted;

        if (self.triggers[triggerIdentifier]) {
            if (doc.status && doc.status.active === false) {
                deleteTrigger(triggerIdentifier);
            }
        } else {
            //ignore changes to disabled  and deletedtriggers
            if ( (!triggerDeleted == true ) &&  (!doc.status || doc.status.active === true) ) {
                self.createTrigger(initTrigger(doc),false)
                .then(triggerIdentifier => {
                    logger.info(method, triggerIdentifier, 'created successfully');
                })
                .catch(err => {
                    var message = 'Automatically disabled after receiving exception on create trigger: ' + err;
                    disableTrigger(triggerIdentifier, undefined, message);
                    logger.error(method, 'Disabled trigger', triggerIdentifier, 'due to exception:', err);
                });
            }
        }
	};


    this.authorize = function (req, res, next) {
        var method = 'authorize';

        if (self.endpointAuth) {
            if (!req.headers.authorization) {
                res.set('www-authenticate', 'Basic realm="Private"');
                res.status(HttpStatus.UNAUTHORIZED);
                return res.send('');
            }

            var parts = req.headers.authorization.split(' ');
            if (parts[0].toLowerCase() !== 'basic' || !parts[1]) {
                return sendError(method, HttpStatus.BAD_REQUEST, 'Malformed request, basic authentication expected', res);
            }

            var auth = Buffer.from(parts[1], 'base64').toString();
            auth = auth.match(/^([^:]*):(.*)$/);
            if (!auth) {
                return sendError(method, HttpStatus.BAD_REQUEST, 'Malformed request, authentication invalid', res);
            }

            var uuid = auth[1];
            var key = auth[2];
            var endpointAuth = self.endpointAuth.split(':');
            if (endpointAuth[0] === uuid && endpointAuth[1] === key) {
                next();
            } else {
                logger.warn(method, 'Invalid key');
                return sendError(method, HttpStatus.UNAUTHORIZED, 'Invalid key', res);
            }
        } else {
            next();
        }
    };

    function sendError(method, code, message, res) {
        logger.error(method, message);
        res.status(code).json({error: message});
    }

    this.initRedis = function () {
        var method = 'initRedis';

        return new Promise(function (resolve, reject) {

            if (redisClient) {
                var subscriber = redisClient.duplicate();

                //create a subscriber client that listens for requests to perform swap
                subscriber.on('message', function (channel, message) {
                    logger.info(method," on subscriber1 : ", message, 'set to active host in channel', channel);
                    self.activeHost = message;
                });
                subscriber.on('connect', function () {
                    logger.info(method," on subscriber1 :", 'Successfully connected or re-connected  the subscriber client to redis');
                });


                subscriber.on('error', function (err) {
                    logger.error(method," on subscriber1 :", 'Error connecting to redis while subscription', err);
                    reject(err);
                });

                subscriber.subscribe(self.redisKey);

                //*********************************************************************************
                //* create a second subscriber with 1 min delay to ensure that 
                //* anytime at least one subscriber is listening on the channel
                //* Background info: The redis DB subscriber connection is terminating all 10 min 
                //* and re-connecting immedately in 100-200 msec. 
                //* So with a second subscriber is ensured that one is always available
                //**********************************************************************************
                setTimeout(function () {
                    var subscriber2 = redisClient.duplicate();

                    //create a second subscriber client that listens for requests to perform swap
                    subscriber2.on('message', function (channel, message) {
                        logger.info(method," on subscriber2 :", message, 'set to active host in channel', channel);
                        self.activeHost = message;
                 });
                
                    subscriber2.on('connect', function () {
                        logger.info(method," on subscriber2 :", 'Successfully connected or re-connected  the subscriber client to redis');
                    });

                    subscriber2.on('error', function (err) {
                        logger.warn(method," on subscriber2 :", 'Error on subscriber client to redis (automatically reconnecting) ', err);
                    });

                    subscriber2.subscribe(self.redisKey);
                }, 60000 );

                redisClient.hgetAsync(self.redisKey, self.redisField)
                .then(activeHost => {
                	//*********************************************************
                	//* Call a one time sync immediately after init() - 10 sec 
                	//* to fix Sev1 situation when hgetAsync() and subscribe() 
                	//* provide different info 
                	//**********************************************************
                	setTimeout(function () {
                   		logger.info(method, 'Redis one-time synchronizer checks if [ ', self.activeHost, ' ] is still the valid one');
                		redisClient.hgetAsync(self.redisKey, self.redisField)
                        .then(activeHost => {
                        	if ( activeHost != null && activeHost != "" && self.activeHost != activeHost ){
                        		logger.info(method, 'Redis one-time synchronizer updated active host to: ', activeHost);
                        		self.activeHost = activeHost;
                        	}
                         })
                         .catch(err => {
                             logger.error(method, "Redis one-time synchronizer regular run fails with :",  err);
                         })
                     }, 10000 );
                	//************************************************
                	//* Start regularly Redis synchronization, to recover
                	//* from "Redis-Out-of-sync" situations (all 9 min , 
                	//* because default inactivity timeout is 10 min ) 
                	//************************************************
                	setInterval(function () {
                   		logger.info(method, 'Redis synchronizer checks if [ ', self.activeHost, ' ] is still the valid one');
                		redisClient.hgetAsync(self.redisKey, self.redisField)
                        .then(activeHost => {
                        	if ( activeHost != null && activeHost != "" && self.activeHost != activeHost ){
                        		logger.info(method, 'Redis synchronizer updated active host to: ', activeHost);
                        		self.activeHost = activeHost;
                        	}
                         })
                         .catch(err => {
                             logger.error(method, "Redis synchronizer regular run fails with :",  err);
                         })
                     }, 540000 );
                    	
                     return initActiveHost(activeHost);
                })
                .then(() => {
                    process.on('SIGTERM', function onSigterm() {
                        //*************************************
                        //* prevent from running SIGTERM multiple times 
                        //* in parallel 
                        //**************************************
                        if ( isShutdown == false ) {
                            isShutdown=true; 

                            logger.info(method, 'SIGTERM Handler started. Going to store provider data to REDIS' );
                            let promiseArray = [];
                            let promiseToAwait;
                            
                            if (self.activeHost === self.host) {
                                logger.info(method, 'SIGTERM Handler will set worker partner to active host ');
                                var redundantHost = self.host === `${self.hostPrefix}0` ? `${self.hostPrefix}1` : `${self.hostPrefix}0`;
                                promiseToAwait = self.redisClient.hsetAsync(self.redisKey, self.redisField, redundantHost)
                                .then(() => {
                                    //*******************************************************
                                    //* notify worker partner to get info about worker 
                                    //* active state change 
                                    //********************************************************
                                    self.redisClient.publish(self.redisKey, redundantHost);
                                })
                                .catch(err => {
                                    logger.error(method,'Fail to process SIGTERM and inform redis about active status change ', err);
                                });
                                promiseArray.push(promiseToAwait);
                            }    
                                
                            //*******************************************************
                            //* save lruCache with chgHistory for each trigger to REDIS, so it can 
                            //* be reloaded on next re-start of this worker
                            //********************************************************
                            logger.info(method, 'SIGTERM Handler going to store chgHistory data to REDIS ');
                            for( let triggername in self.triggers ) {
                                if (self.triggers[triggername] && self.triggers[triggername].lruCache && self.triggers[triggername].lruCache.size > 0) {               
                        
                                    let redisHashName = self.worker + "_" + triggername; 
                                    let historyDocsArrayFromCache = new Array ();
                                    let numOfChgHistoryElements = 0; 

                                    self.triggers[triggername].lruCache.forEach( (value,key,cache) =>{
                                        historyDocsArrayFromCache.push({ 'doc' : key , 'rev' : value } );
                                        numOfChgHistoryElements = numOfChgHistoryElements +  1; 
                                    })
                                    let historyDataJsonString = JSON.stringify(historyDocsArrayFromCache);

                                    promiseToAwait = self.redisClient.hsetAsync( redisHashName, "history" , historyDataJsonString)
                                    .then(  res => {
                                        logger.info(method, 'lruCache for trigger = ', redisHashName, ' stored to Redis with ', numOfChgHistoryElements , ' doc/revision records');
                                    })
                                    .catch(err => {
                                        logger.info(method, 'lruCache for trigger = ', redisHashName, ' stored to Redis failed with err = ',err );
                                    }) 
                                    promiseArray.push(promiseToAwait);
                                } else {
                                    logger.info(method, 'No elements in lruCache available to store to redis for trigger =', triggername);
                                }
                            }
                        
                            //**********************************
                            //* add the promise to the list of open "threads"
                            //************************************************
                            Promise.allSettled( promiseArray )
                            .then ( (results) => { 
                                logger.info(method,'Writing data to REDIS completed ');
                            })      
                    
                            logger.info(method, 'SIGTERM Handler done. started async termination actions ' );
                        }
                        else{
                            logger.info(method, 'SIGTERM Handler called twice, ignore second calling ' );
                        }                    
                    });
                    resolve();
                })
                .catch(err => {
                    reject(err);
                });
            } else {
            	logger.info(method, 'Running cloudant provider worker without redis connection (test mode) ');
                resolve();
            }
        });
    };

    function initActiveHost(activeHost) {
        var method = 'initActiveHost';

        if (activeHost === null) {
            //initialize redis key with active host
            logger.info(method, 'redis hset', self.redisKey, self.redisField, self.activeHost);
            return redisClient.hsetAsync(self.redisKey, self.redisField, self.activeHost);
        } else {
            self.activeHost = activeHost;
            logger.info(method, 'start provider with activeHost = ',  self.activeHost);
            return Promise.resolve();
        }
    }

    this.authRequest = function (triggerData, options, body,  cb) {

        authHandler.handleAuth(triggerData, logger, options)
        .then(requestOptions => {
        	//**********************************************************
        	//* input options must be adapted to match the usage 
        	//* of the needle-package (substitution of request-package)
        	//* Current limitation is, that no query parameters are 
        	//* considered, because providers do not need them. 
        	//**********************************************************
        	var needleMethod = requestOptions.method; 
        	var needleUrl = requestOptions.uri;
        	var needleOptions = {
            agent: self.httpAgent,
            open_timeout: self.openTimeout,
            rejectUnauthorized: false,
          };

            if( requestOptions.auth.user ) {   //* cf-based authorization 
                const usernamePassword = requestOptions.auth.user  +":"+ requestOptions.auth.pass;
                const usernamePasswordEnc = Buffer.from(usernamePassword).toString('base64');
                needleOptions.headers = {}
                needleOptions.headers['Authorization'] = "Basic " + usernamePasswordEnc
            }else if ( requestOptions.auth.bearer) { //* IAM based authorization 
                needleOptions.headers = {}
                needleOptions.headers['Authorization'] = 'Bearer ' +  requestOptions.auth.bearer
            }else {
            	logger.info(method, "no authentication info available");
            }
        
           	if (needleMethod === 'get') {
        		needleOptions.json = false
                needle.request( needleMethod, needleUrl, undefined, needleOptions ,cb);
        	   
        	}else {
        	    needleOptions.json = true
                needleParams = body;
              let stream = needle.request(needleMethod, needleUrl, needleParams, needleOptions, cb);

              stream.on('timeout', (type) => {
                cb(new Error(`timeout during request: type=${type}, trigger=${triggerData.id}`));
              });
            }
       
        })
        .catch(err => {
            cb(err);
        });
    };

    //***************************************************************
    //* helper function to format parameters to an url-encoded string 
    //***************************************************************
    serialize = function(obj, prefix) {
        var str = [],
        p;
        for ( let p in obj) {
            if (obj.hasOwnProperty(p)) {
                var k = prefix ? prefix + "[" + p + "]" : p,
                v = obj[p];
                str.push((v !== null && typeof v === "object") ?
                serialize(v, k) :
                encodeURIComponent(k) + "=" + encodeURIComponent(v));
            }
        }
        return str.join("&");
    }

    
    function parseQName(qname, separator) {
        var parsed = {};
        var delimiter = separator || ':';
        var defaultNamespace = '_';
        if (qname && qname.charAt(0) === delimiter) {
            var parts = qname.split(delimiter);
            parsed.namespace = parts[1];
            parsed.name = parts.length > 2 ? parts.slice(2).join(delimiter) : '';
        } else {
            parsed.namespace = defaultNamespace;
            parsed.name = qname;
        }
        return parsed;
    }

    //**************************************************************************************************
    //* Each trigger object gets its own LruCache to hold the change history data. 
    //* For the cache size calculation the max available storage in REDIS DB to save the whole chgHistory 
    //* during deployment is relevant. That size is 500 MB. Assuming the max number of triggers on one 
    //* provider will be 100. So 5 MB can be spent for each lruCache
    //**************************************************************************************************
    function initLRUCache() {

        const lruCache = new LRU({
            // number of most recently used items to keep ( 35000 items in average size of 160 Bytes =  ca 5MB in memory )
            max: 35000,
            updateAgeOnGet: true,
            //*************************************************************
            //* time after that an item in the cache will be handled as 
            //* dead ( in msec ) -> 10 days  ( 10 * 24 *60 *60 *1000 )
            //*************************************************************
            ttl: 10 * 24 *60 *60 *1000 
        });

        return lruCache;     
    };

    //**************************************************************************************************
    //* Helper function to delay in loops 
    //**************************************************************************************************
    function PromiseTimeout(delayms) {
        return new Promise(function (resolve, reject) {
            setTimeout(resolve, delayms);
        });
    }

    //************************************************************************
	// * Helper Function that returns a request interceptor for a given filter name
	// * and query parameters
	// * @param {*} filter - name of filter
	// * @param {*} query_params - query parameter dict
	// * @returns request interceptor function which is called each time the 
	//*           dbclient is doing an HTTP request to DB 
	//*
	//*  Add the query parameter to the URL only in case of base URL 
	//*  ends with "_changes"
	//************************************************************************
	function queryParamsInterceptor(filter, query_params, triggerIdentifier) {
        var method ="queryParamsInterceptor";

        return (config) => {
          
          if (
            // Unsure on your client distribution, e.g. whether you have one client
            // instance per feed or whether you need to do something like this
            // and gate the activity of the interceptor by filter name.
            config.method === 'post' &&
            config.url.endsWith('_changes') &&
            config.params.filter === filter
          ) {
              
            const newConfig = config;
            // Unsure on the expectations of your existing code in terms of parameter serialization.
            // The default serializer in use will, I believe, handle URL encoding etc, but you may
            // want to e.g. check for duplicates etc
            newConfig.params = { ...config.params, ...query_params };
            //TODO: switch off log statement for PROD env  
            //logger.info(method,'Trigger ',  triggerIdentifier, " intercepted url with config = ", config.params, query_params );
            return newConfig;
          }
          return config;
          };
      }
  
};

