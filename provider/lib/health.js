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

var si = require('systeminformation');
var v8 = require('v8');
var _ = require('lodash');
var URL = require('url').URL;
var constants = require('./constants.js');

module.exports = function (logger, manager) {

    // Health Endpoint
    this.endPoint = '/health';

    var triggerName;
    var triggerNamePrefix = 'cloudant_' + manager.worker + manager.host + '_';
    var canaryDocID;
    var monitorStatus;
    var monitorStages = ['triggerStarted', 'triggerFired', 'triggerStopped'];

    // Health Logic
    this.health = function (req, res) {
        var method = 'health';
        
        var stats = {triggerCount: Object.keys(manager.triggers).length};

        // Write log info if the health enpoint is called when no monitoring status 
        // is available. (Maybe the self-test has not already executed after a restart) 
        if ( !monitorStatus ) {
            logger.info(method, triggerNamePrefix, 'No MonitorStatus available.(Potentially the cloudant backendprovider was restarted in the last hour)');
        }

        // get all system stats in parallel
        Promise.all([
            si.mem(),
            si.currentLoad(),
            si.fsSize(),
            si.networkStats(),
            si.inetLatency(manager.routerHost)
        ])
        .then(results => {
            stats.triggerMonitor = monitorStatus;
            stats.memory = results[0];
            stats.cpu = _.omit(results[1], 'cpus');
            stats.disk = results[2];
            stats.network = results[3];
            stats.apiHostLatency = results[4];
            stats.heapStatistics = v8.getHeapStatistics();
            res.send(stats);
        })
        .catch(error => {
            stats.error = error;
            res.send(stats);
        });
    };

    this.monitor = function (apikey, monitoringInterval) {
        var method = 'monitor';

        if (triggerName) {
            monitorStatus = Object.assign({}, manager.monitorStatus);
            manager.monitorStatus = {};

            var monitorStatusSize = Object.keys(monitorStatus).length;
            if (monitorStatusSize < 5) {
                //we have a failure in one of the stages
                var stageFailed = monitorStages[monitorStatusSize - 2];
                monitorStatus[stageFailed] = 'failed';
            }
            var existingTriggerID = `:_:${triggerName}`;
            var existingCanaryID = canaryDocID;

            //delete the trigger
            var triggerData = {
                apikey: apikey,
                uri: manager.uriHost + '/api/v1/namespaces/_/triggers/' + triggerName,
                triggerID: existingTriggerID
            };
            logger.info(method, existingTriggerID, " self-test trigger deleted");
            deleteTrigger(triggerData, 0);

            //delete the canary doc which resides in the trigger config db,  too 
            //* delayed, so that it does not conflict with the next createTrigger of 
            //* the subsequent next self-test trigger 
            setTimeout(function () {
            	deleteDocFromDB(existingCanaryID, 0);
            }, 10000 );
            
        }

        //create new cloudant trigger and canary doc
        var docSuffix = manager.worker + manager.host + '_' + Date.now();
        triggerName = 'cloudant_' + docSuffix;
        canaryDocID = 'canary_' + docSuffix;

        //update status monitor object
        manager.monitorStatus.triggerName = triggerName;
        manager.monitorStatus.triggerType = 'changes';

        var triggerURL = manager.uriHost + '/api/v1/namespaces/_/triggers/' + triggerName;
        var triggerID = `:_:${triggerName}`;
        createTrigger(triggerURL, apikey)
        .then(info => {
            logger.info(method, triggerID, info);
            var newTrigger = createCloudantTrigger(triggerID, apikey);
            manager.createTrigger(newTrigger, false);
            setTimeout(function () {
                var canaryDoc = {
                    isCanaryDoc: true,
                    host: manager.host
                };
                createDocInDB(canaryDocID, canaryDoc);
            }, monitoringInterval / 10);
        })
        .catch(err => {
            if (err.message != undefined) {
                logger.error(method, triggerID, "Failed to create monitor self-test trigger.  err = ",err.message);
            } else {
                logger.error(method, triggerID, "Failed to create monitor self-test trigger.  err obj = ",err);
            }    
        });
    };

    this.updateMonitorStatus = function () {
        var method = 'updateMonitorStatus';

        //*******************************************************************
        //* copy the status of the self-test trigger from the manager
        //* object into the health object, to have the status earlier 
        //* then by waiting on the expiration of the waiting loop of the 
        //* monitor() call 
        //********************************************************************
        if (triggerName) {
            monitorStatus = Object.assign({}, manager.monitorStatus);
            
            var monitorStatusSize = Object.keys(monitorStatus).length;
            if (monitorStatusSize < 5) {
                //we have a failure in one of the stages
                var stageFailed = monitorStages[monitorStatusSize - 2];
                monitorStatus[stageFailed] = 'failed';
            }
        }
    };
    
    //**********************************************************
    //* self-test trigger is expecting the canary document inside 
    //* of the triggerConfigDB.  So the configDB url and the 
    //* configDB Name stored in the manager can be used 
    //***********************************************************
    function createCloudantTrigger(triggerID, apikey) {
        var dbURL = new URL(manager.triggerDB.baseOptions.serviceUrl);
        var dbName = manager.databaseName;

        return {
            apikey: apikey,
            id: triggerID,
            host: dbURL.hostname,
            port: dbURL.port,
            protocol: dbURL.protocol.replace(':', ''),
            dbname: dbName,
            user: process.env.DB_USERNAME,
            pass: process.env.DB_PASSWORD,
            filter: constants.MONITOR_DESIGN_DOC + '/' + constants.DOCS_FOR_MONITOR,
            query_params: {host: manager.host},
            maxTriggers: 1,
            triggersLeft: 1,
            since: 'now',
            worker: manager.worker,
            monitor: manager.host
        };
    }

    function createTrigger(triggerURL, apikey) {

        return new Promise(function (resolve, reject) {
        	var body = {};
            manager.authRequest({apikey: apikey}, {
                method: 'put',
                uri: triggerURL
            }, body, function (error, response) {
                if (error || response.statusCode >= 400) {
                	if( error ) {
                      reject('self-test trigger HTTP call to openWhisk failed with error = ',error );
                	}else {
                      reject('self-test trigger HTTP call to openWhisk failed with rc = ',response.statusCode );
                	}
                } else {
                    resolve('self-test trigger HTTP call to openWhisk was successful');
                }
            });
        });
    }

    function createDocInDB(docID, doc) {
        var method = 'createDocInDB';

        manager.triggerDB.putDocument({
            db: manager.databaseName,
            docId: docID,
            document: doc
        })
        .then(response => {
            logger.info(method, docID, ': successfully inserted self-test trigger in trigger config DB ');
        })
        .catch( (err) => {
            logger.error(method, docID, " : Failed to create self-test trigger in trigger configuration DB :", err);
        })
    }

    function deleteTrigger(triggerData, retryCount) {
        var method = 'deleteTrigger';

        var triggerID = triggerData.triggerID;
        manager.authRequest(triggerData, {
            method: 'delete',
            uri: triggerData.uri
        }, undefined, 
        function (error, response) {
            logger.info(method, triggerID, 'http delete request, STATUS:', response ? response.statusCode : undefined);
            if (error || response.statusCode >= 400) {
                if (!error && response.statusCode === 409 && retryCount < 5) {
                    logger.info(method, 'attempting to delete trigger again', triggerID, 'Retry Count:', (retryCount + 1));
                    setTimeout(function () {
                        deleteTrigger(triggerData, (retryCount + 1));
                    }, 1000);
                } else {
                    logger.error(method, triggerID, 'trigger delete request failed');
                }
            } else {
                logger.info(method, triggerID, 'trigger delete request was successful');
            }
        });
    }

    function deleteDocFromDB(docID, retryCount) {
        var method = 'deleteDocFromDB';

        //delete from database
        manager.triggerDB.getDocument({
            db: manager.databaseName,
            docId: docID
        })
        .then(response => {
            var rev = response.result._rev; 
            //**************************************************************
            //* if trigger still exist in DB , then remove 
            //**************************************************************    
            manager.triggerDB.deleteDocument({
                db: manager.databaseName,
                docId: docID,
                rev: rev
            })
            .then(response => {
                logger.info(method, docID, ': Trigger was successfully deleted from the provider configuration database');
            })
            .catch( (err) => {
                logger.error(method, docID, ": delete trigger confing from DB with err.code = ", err.code) ;
                if (err.code == 409 && retryCount < 5) {
                    logger.error(method, docID, ": There was an error deleting the trigger from the trigger configuration database with error code = 409, so will retry ");
                    setTimeout(function () {
                        self.deleteDocFromDB(docID, (retryCount + 1));
                    }, 1000);
                } else {
                    logger.error(method, docID, ': There was an error deleting the trigger from the trigger configuration database :', err , " and retry count = ", retryCount) ;
                }
            })
        })
        .catch( (err) => {
            if ( err && err.code == 408 && retryCount < 5) {
                logger.error(method, docID, ": There was a timeout in getDocument() to identify trigger for deletion from the trigger configuration database, so will retry ");
                setTimeout(function () {
                    self.deleteDocFromDB(docID, (retryCount + 1));
                }, 1000);
            } else if ( err && err.code == 404) {
                logger.warn(method,docID, ': doc to delete does not exist in trigger config DB at this time. ');  
            } else {
                logger.error(method, docID, ': could not be found as document in the trigger config database err = :', err);
            }
        })
    }

};
