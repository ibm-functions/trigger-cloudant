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

var request = require('request');
var HttpStatus = require('http-status-codes');
var constants = require('./constants.js');
var authHandler = require('./authHandler');

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
    this.db = triggerDB;
    this.redisClient = redisClient;
    this.redisKey = redisKeyPrefix + '_' + this.worker;
    this.redisField = constants.REDIS_FIELD;
    this.uriHost = 'https://' + this.routerHost;
    this.monitorStatus = {};
    this.pauseResumeEnabled = "true";   //* By default it is switched OFF
    this.healthObject; 
    
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
                var triggerHandle = self.triggers[triggerData.id];
                if (triggerHandle && shouldFireTrigger(triggerHandle) && hasTriggersRemaining(triggerHandle)) {
                    logger.info(method, 'Trigger', triggerData.id, 'got change from customer DB :', triggerData.dbname);
                    try {
                        fireTrigger(triggerData.id, change);
                    } catch (e) {
                        logger.error(method, 'Exception occurred while firing trigger', triggerData.id, e);
                    }
                }
            });

            feed.on('timeout', function (info) {
                logger.info(method, 'Got timeout for', triggerData.id, 'from follow library for customer DB:', JSON.stringify(info));
            });

            feed.on('retry', function (info) {
                logger.info(method, 'Attempting retry for', triggerData.id, 'in follow library for customer DB:', JSON.stringify(info));
            });

            feed.on('stop', function () {
                logger.info(method, "Cloudant provider stop change listening socket to customer DB for trigger:",  triggerData.id );
            });
            
            feed.follow();

            //**********************************************************
            //* additional feed listeners for logging purpose to get info 
            //* about DB change listener socket to customer DB 
            //***********************************************************
            feed.on('confirm_request', function (req) {
                logger.info(method, 'Cloudant provider establish change listen socket to customer db for trigger: ', triggerData.id );
            });
            
            feed.on('confirm', function () {
                logger.info(method, 'Cloudant provider starts listening for changes on customer db for trigger: ', triggerData.id );
            });
            
            feed.on('timeout', function (info) {
                logger.info(method, 'Got timeout while listening changes on customer database for trigger:', triggerData.id, ' : ', JSON.stringify(info));
            });
            
            feed.on('catchup', function (seq_id) {
                logger.info(method, 'Changes sequences number on customer db ( for trigger  ', triggerData.id , ' ) adjusted to : ', JSON.stringify(seq_id));
            });
            
            feed.on('retry', function (info) {
                logger.info(method, 'Follow lib retries to establish listening changes socket to customer database ( for trigger  ', triggerData.id,' ) : ', JSON.stringify(info));
            });
            
            return new Promise(function (resolve, reject) {
                feed.on('error', function (err) {
                    logger.error(method, 'Error occurred for trigger', triggerData.id, '(db ' + triggerData.dbname + '):', err);
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
            });

        } catch (err) {
            logger.info(method, 'caught an exception in change listener to customer DB for trigger', triggerData.id, err);
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
            iamUrl: newTrigger.iamUrl
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
                uri: uri,
                json: form
            }, function (error, response) {
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
                            url: triggerURL
                        }, function (error, response) {
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
                    logger.error(method, 'Error connecting to redis', err);
                    reject(err);
                });

                subscriber.subscribe(self.redisKey);

                redisClient.hgetAsync(self.redisKey, self.redisField)
                .then(activeHost => {
                	//************************************************
                	//* Start regularly Redis synchronization, to recover
                	//* from "Redis-Out-of-sync" situations (all 10 min) 
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
                     }, 600000 );
                    	
                     return initActiveHost(activeHost);
                })
                .then(() => {
                    process.on('SIGTERM', function onSigterm() {
                        if (self.activeHost === self.host) {
                            var redundantHost = self.host === `${self.hostPrefix}0` ? `${self.hostPrefix}1` : `${self.hostPrefix}0`;
                            self.redisClient.hsetAsync(self.redisKey, self.redisField, redundantHost)
                            .then(() => {
                                self.redisClient.publish(self.redisKey, redundantHost);
                            })
                            .catch(err => {
                                logger.error(method, err);
                            });
                        }
                    });
                    resolve();
                })
                .catch(err => {
                    reject(err);
                });
            } else {
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
            return Promise.resolve();
        }
    }

    this.authRequest = function (triggerData, options, cb) {

        authHandler.handleAuth(triggerData, logger, options)
        .then(requestOptions => {
            request(requestOptions, cb);
        })
        .catch(err => {
            cb(err);
        });
    };

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
};
