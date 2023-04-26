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

var isShutdown = false; 

module.exports = function (logger, triggerDB, redisClient) {

    var redisKeyPrefix = process.env.REDIS_KEY_PREFIX || triggerDB.config.db;
    var self = this;

    this.triggers = {};
    this.endpointAuth = process.env.ENDPOINT_AUTH;
    this.exitOnDBError = process.env.EXIT_ON_DB_ERROR || 'false';
    this.routerHost = process.env.ROUTER_HOST || 'localhost';
    this.worker = process.env.WORKER || 'worker0';
    this.host = process.env.HOST_INDEX || 'host0';
    this.hostPrefix = this.host.replace(/\d+$/, '');
    this.activeHost = `${this.hostPrefix}0`; //default value on init (will be updated for existing redis)
    this.db = triggerDB;                     //Database in which the triggers are configured
    this.redisClient = redisClient;
    this.redisKey = redisKeyPrefix + '_' + this.worker;
    this.redisField = constants.REDIS_FIELD;
    this.uriHost = 'https://' + this.routerHost;
    this.monitorStatus = {};
    this.pauseResumeEnabled = "true";   //* By default it is switched ON
    this.changesFilterEnabled = "true"; //* By default it is switched ON
    this.healthObject; 
    this.openTimeout = process.env.HTTP_OPEN_TIMEOUT_MS || 30000;
    
    //****************************************************
    //* Registering of Health object which can be used 
    //* to update the self-test monitor status whenever 
    //* is needed 
    //****************************************************
    this.registerHealthObject = function (healthObj) {
        var method = 'registerHealthObject'; 
        
        this.healthObject = healthObj;
        logger.info(method, 'Health obj successfully registered ');    
    };
    
    // Add a trigger: listen for changes and dispatch.
    this.createTrigger = function (triggerData, isStartup) {
        var method = 'createTrigger';

        var Cloudant = require('@cloudant/cloudant');
        var cloudantConnection;

        if (triggerData.iamApiKey) {
            var dbURL = `${triggerData.protocol}://${triggerData.host}`;
            if (triggerData.port) {
                dbURL += ':' + triggerData.port;
            }
            cloudantConnection = new Cloudant({
                url: dbURL,
                plugins: {iamauth: {iamApiKey: triggerData.iamApiKey, iamTokenUrl: triggerData.iamUrl}}
            });
        } else {
            var url = `${triggerData.protocol}://${triggerData.user}:${triggerData.pass}@${triggerData.host}`;
            if (triggerData.port) {
                url += ':' + triggerData.port;
            }
            cloudantConnection = require('nano')(url);
        }

        try {
            var triggeredDB = cloudantConnection.use(triggerData.dbname);

            // Listen for changes on this database.
            var feed = triggeredDB.follow({since: triggerData.since, include_docs: false});
            if (triggerData.filter) {
                feed.filter = triggerData.filter;
            }
            if (triggerData.query_params) {
                feed.query_params = triggerData.query_params;
            }

            triggerData.feed = feed;
            self.triggers[triggerData.id] = triggerData;
          
            feed.on('change', function (change) {
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
                    if ( !(triggerHandle.lruCache == undefined) ) {
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
            
            });

            feed.on('timeout', function (info) {
                logger.info(method, 'Got timeout for', triggerData.id, 'from follow library for customer DB ', triggerData.dbname ,' :', JSON.stringify(info));
            });

            feed.on('retry', function (info) {
                logger.info(method, 'Attempting retry for', triggerData.id, 'in follow library for customer DB ', triggerData.dbname ,' :', JSON.stringify(info));
            });

            feed.on('stop', function () {
                logger.info(method, "Cloudant provider stop change listening socket to customer DB ', triggerData.dbname ,' for trigger:",  triggerData.id );
            });
            
            //**********************************************************
            //* additional feed listeners for logging purpose to get info 
            //* about DB change listener socket to customer DB 
            //***********************************************************
            feed.on('confirm_request', function (req) {
                logger.info(method, 'Cloudant provider establish change listen socket to customer db ', triggerData.dbname ,' for trigger: ', triggerData.id );
            });
            
            feed.on('catchup', function (seq_id) {
            	logger.info(method, 'Changes sequences number on customer db ', triggerData.dbname ,' ( for trigger  ', triggerData.id , ' ) adjusted to : ', seq_id);
            });

           
            return new Promise(function (resolve, reject) {
                feed.on('error', function (err) {
                    logger.error(method, 'Error occurred for trigger', triggerData.id, '(db ' + triggerData.dbname + ' ):', err);
                    if (self.exitOnDBError === 'true' && isStartup) {
                        process.exit(1);
                    } else {
                        reject(err);
                    }
                });

                feed.on('confirm', function () {
                    logger.info(method, 'Added cloudant data trigger', triggerData.id, 'listening for changes in customer database', triggerData.dbname);
                    if (isMonitoringTrigger(triggerData.monitor, triggerData.id)) {
                        self.monitorStatus.triggerStarted = "success";
                    }
                    resolve(triggerData.id);
                });

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
                    .finally(() => {
                        //*******************************************
                        //* in all cases start cloudant DB listening
                        //*******************************************
                        feed.follow();
                    });
                    
                } else { 
                    feed.follow(); 
                } 
            });
            

        } catch (err) {
            logger.info(method, 'caught an exception in change listener to customer DB ', triggerData.dbname ,' for trigger', triggerData.id, err);
            return Promise.reject(err);
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
            lruCache: initLRUCache()
        };
    }

    function disableTrigger(id, statusCode, message) {
        var method = 'disableTrigger';

        triggerDB.get(id, function (err, existing) {
            if (!err) {
                if (!existing.status || existing.status.active === true) {
                    var updatedTrigger = existing;
                    updatedTrigger.status = {
                        'active': false,
                        'dateChanged': Date.now(),
                        'reason': {'kind': 'AUTO', 'statusCode': statusCode, 'message': message}
                    };

                    triggerDB.insert(updatedTrigger, id, function (err) {
                        if (err) {
                            logger.error(method, 'there was an error while disabling', id, 'in database. ' + err);
                        } else {
                            logger.info(method, 'trigger', id, 'successfully disabled in database');
                        }
                    });
                }
            } else {
                logger.info(method, 'could not find', id, 'in database');
                //make sure it is removed from memory as well
                deleteTrigger(id);
            }
        });
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
                                //*   and schedule  a  feed.resume() to run in 120 sec to restart reading events 
                                //***************************************************************************************
                                var timeout = 1000;  //default 
                                if ( statusCode === 429 && self.pauseResumeEnabled == "true" ) {
                                    timeout = 6000;
                                    try {
                                      triggerData.feed.pause();  
                                      logger.info(method, 'Paused receiving events for trigger:', triggerIdentifier, ' issued while Retry Count:', (retryCount + 1));    
                                      //********************************************************************
                                      //* schedule the asynchronous function in 120 sec resuming the feed  
                                      //* to continue reading cloudant db changes events 
                                      //******************************************************************** 
                                      setTimeout(function () {
                                        try {                                           
                                          triggerData.feed.resume(); 
                                          logger.info(method, 'Resumed receiving events for trigger:', triggerIdentifier, 'issued while Retry Count:', (retryCount + 1));
                                        } catch (err) {
                                          logger.error(method, 'Failed on Resume the feed. Error: ', err );  
                                          //** continue processing without pausing/resuming this trigger
                                        }       
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

        logger.info(method, 'resetting system from last state');
        triggerDB.view(constants.VIEWS_DESIGN_DOC, constants.TRIGGERS_BY_WORKER, {
            reduce: false,
            include_docs: true,
            key: self.worker
        }, function (err, body) {
            if (!err) {
                body.rows.forEach(function (trigger) {
                    var triggerIdentifier = trigger.id;
                    var doc = trigger.doc;

                    if (!(triggerIdentifier in self.triggers)) {
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
                                    logger.info(method, triggerIdentifier, 'created successfully');
                                })
                                .catch(err => {
                                    var message = 'Automatically disabled after receiving exception on init trigger: ' + err;
                                    disableTrigger(triggerIdentifier, undefined, message);
                                    logger.error(method, 'Disabled trigger', triggerIdentifier, 'due to exception:', err);
                                });
                            }
                        });
                    }
                });
            } else {
                logger.error(method, 'could not get latest state from database', err);
            }
        });
    };

    function setupFollow(seq) {
        var method = 'setupFollow';

        try {
            var feed = triggerDB.follow({
                since: seq,
                include_docs: true,
                filter: constants.FILTERS_DESIGN_DOC + '/' + constants.TRIGGERS_BY_WORKER,
                query_params: {worker: self.worker}
            });

            feed.on('change', (change) => {
                var triggerIdentifier = change.id;
                var doc = change.doc;

                if (self.triggers[triggerIdentifier]) {
                    if (doc.status && doc.status.active === false) {
                        deleteTrigger(triggerIdentifier);
                    }
                } else {
                    //ignore changes to disabled triggers
                    if (!doc.status || doc.status.active === true) {
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
            });

            feed.on('stop', function () {
                logger.info(method, "Cloudant provider stop change listening socket to trigger configuration database");
            });
            
            feed.on('error', function (err) {
                logger.error(method, err);
            });

            feed.follow();
            
            //**********************************************************
            //* additional feed listeners for logging purpose to get info 
            //* about DB change listener socket to trigger config DB 
            //***********************************************************
            feed.on('confirm_request', function (req) {
                logger.info(method, 'Cloudant provider establish change listen socket to  trigger configuration database');
            });
            
            feed.on('confirm', function () {
                logger.info(method, 'Cloudant provider starts listening for changes in configuration database');
            });
            
            feed.on('timeout', function (info) {
                logger.info(method, 'Got timeout while listening changes in cloudant trigger configuration database:', JSON.stringify(info));
            });
            
            feed.on('catchup', function (seq_id) {
                logger.info(method, 'Cloudant providers listening changes sequences number adjusted to :', JSON.stringify(seq_id));
            });
            
            feed.on('retry', function (info) {
                logger.info(method, 'Follow lib retries to establish listening changes socket to cloudant trigger configuration database:', JSON.stringify(info));
            });
            
        } catch (err) {
            logger.error(method, err);
        }
    }

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

            var auth = new Buffer(parts[1], 'base64').toString();
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
                    logger.info(method, message, 'set to active host in channel', channel);
                    self.activeHost = message;
                });

                subscriber.on('error', function (err) {
                    logger.error(method, 'Error connecting to redis while subscription', err);
                    reject(err);
                });

                subscriber.subscribe(self.redisKey);

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
                            for( triggername in self.triggers ) {
                                if (  (!( self.triggers[triggername].lruCache == undefined )) && self.triggers[triggername].lruCache.size > 0 ) {                
                        
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
                rejectUnauthorized: false,
                open_timeout: self.openTimeout
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
        	    needle.request( needleMethod, needleUrl, needleParams, needleOptions ,cb);
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
        for (p in obj) {
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

};

