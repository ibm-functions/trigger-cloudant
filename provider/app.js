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

'use strict';
/**
 * Service which can be configured to listen for triggers from a provider.
 * The Provider will store, invoke, and POST whisk events appropriately.
 */
var URL = require('url').URL;
var http = require('http');
var express = require('express');
var bodyParser = require('body-parser');
var bluebird = require('bluebird');
var logger = require('./Logger');
const process = require('node:process');


var ProviderManager = require('./lib/manager.js');
var ProviderHealth = require('./lib/health.js');
var ProviderActivation = require('./lib/active.js');
var ProviderPauseResume = require('./lib/pauseResume.js');
var ProviderChangesFilter = require('./lib/ChangesFilterFlag.js');
var constants = require('./lib/constants.js');

const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { BasicAuthenticator } = require('ibm-cloud-sdk-core');



// Initialize the Express Application
var app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));
app.set('port', process.env.PORT || 8080);

// Allow invoking servers with self-signed certificates.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// If it does not already exist, create the triggers database.  This is the database that will
// store the managed triggers.
var dbUsername = process.env.DB_USERNAME;
var dbPassword = process.env.DB_PASSWORD;
var dbHost = process.env.DB_HOST;
var dbProtocol = process.env.DB_PROTOCOL;
var dbPrefix = process.env.DB_PREFIX;
var databaseName = dbPrefix + constants.TRIGGER_DB_SUFFIX;
var redisUrl = process.env.REDIS_URL;
var monitoringAuth = process.env.MONITORING_AUTH;
var monitoringInterval = process.env.MONITORING_INTERVAL || constants.MONITOR_INTERVAL;
var firstMonitoringWaittime = Math.round(monitoringInterval / 5)



// Create the Provider Server
var server = http.createServer(app);
server.listen(app.get('port'), function () {
    logger.info('server.listen', 'Express server listening on port ' + app.get('port'));
});


//************************************************
//* connect to the trigger configDB 
//************************************************
function verifyDatabase() {
    var method = 'verifyDatabase';
    logger.info(method, 'Setup Trigger configDB connection and verify if database exists');

	const authenticator = new BasicAuthenticator({
		username: dbUsername,
		password: dbPassword,
	});
	const options = {
		authenticator,
	};

    var client = CloudantV1.newInstance(options); 
	var dbURL = `https://${dbHost}`;
	client.setServiceUrl(dbURL);
	
    return new Promise(function (resolve, reject) {
        client.getDatabaseInformation({ 'db' : databaseName })
        .then((dbInfo) => {
            if( dbInfo.result != undefined ) {
                const documentCount = dbInfo.result.doc_count;
                const dbNameResult = dbInfo.result.db_name;

                // Show document count in database =========================================
			    logger.info(method, `Document count in "${dbNameResult}" database is ${documentCount}.`	);
                logger.info(method, 'Successfully connected to  trigger configuration database = ', dbInfo.result);
                resolve(client);
            }
        })
        .catch(err => {
            logger.error(method, 'Failed to retrieve db info of  trigger configuration  while connection setup to database "${dbNameResult}" with err = ', err);
            reject(err);
        });
	}); 
}

function createRedisClient() {
    var method = 'createRedisClient';

    return new Promise(function (resolve, reject) {
        if (redisUrl) {
            var client;
            var redis = require('redis');
            bluebird.promisifyAll(redis.RedisClient.prototype);
            if (redisUrl.startsWith('rediss://')) {
                // If this is a rediss: connection, we have some other steps.
                client = redis.createClient(redisUrl, {
                    tls: {servername: new URL(redisUrl).hostname}
                });
                // This will, with node-redis 2.8, emit an error:
                // "node_redis: WARNING: You passed "rediss" as protocol instead of the "redis" protocol!"
                // This is a bogus message and should be fixed in a later release of the package.
            } else {
                client = redis.createClient(redisUrl);
            }

            client.on('connect', function () {
            	   logger.info(method, 'Successfully connected to redis');
                   resolve(client);
            });

            client.on('error', function (err) {
                logger.error(method, 'Error connecting to redis', err);
                reject(err);
            });
        } else {
        	logger.info(method, 'Cloudant provider init without redis connection (test mode) ');
            resolve();
        }
    });
}

// Initialize the Provider Server
function init(server) {
    var method = 'init';
    var cloudantDb;
    var providerManager;

    //********************************************************************************
    //* Since Nodejs16  UnhandledRejections result in process termination. To avoid 
    //* this new behavior the process scope handler is registered
    //******************************************************************************* 
    process.on('unhandledRejection', (reason, promise) => {
        logger.info(method, 'Cloudant provider caught an Unhandled Rejection at promise:' + promise + ' reason: ' +  reason );
        //Application specific logging, throwing an error, or other logic here
    });

    if (server !== null) {
        var address = server.address();
        if (address === null) {
            logger.error(method, 'Error initializing server. Perhaps port is already in use.');
            process.exit(-1);
        }
    }

    verifyDatabase()
    .then(db => {
        cloudantDb = db;
        return createRedisClient();
    })
    .then(redisClient => {
        logger.info(method,' Start cloudant provider using the trigger config DB = '+ databaseName );
        providerManager = new ProviderManager(logger, cloudantDb, redisClient, databaseName);
        return providerManager.initRedis();
    })
    .then(() => {
        var providerHealth = new ProviderHealth(logger, providerManager);
        var providerActivation = new ProviderActivation(logger, providerManager);
        var providerPauseResume = new ProviderPauseResume(logger, providerManager);
        var providerChangesFilter = new ProviderChangesFilter(logger, providerManager);

        // Health Endpoint
        app.get(providerHealth.endPoint, providerManager.authorize, providerHealth.health);

        // Activation Endpoint
        app.get(providerActivation.endPoint, providerManager.authorize, providerActivation.active);
        
        // PauseResume Endpoint
        app.get(providerPauseResume.endPoint, providerManager.authorize, providerPauseResume.pauseresume);
        
        // ChangesFilter Endpoint
        app.get(providerChangesFilter.endPoint, providerManager.authorize, providerChangesFilter.changesfilter);

        //*********************************************************
        //* register health object, so that manager use it 
        //*********************************************************
        providerManager.registerHealthObject(providerHealth);
        
        
        //*****************************************************************
        //* Trigger a single self-test (monitor) run  immediately after 
        //* starting the provider to ensure that monitoringService calls to 
        //* the health endpoint will provide a result. 
        //* - ca 1 min  delay to ensure that the providers asynchronous start handling 
        //*   is completed 
        //********************************************************************
        if (monitoringAuth) {
            setTimeout(function () {
                providerHealth.monitor(monitoringAuth,monitoringInterval);
            }, firstMonitoringWaittime );
        }
        
        providerManager.initAllTriggers();

        if (monitoringAuth) {
            setInterval(function () {
                providerHealth.monitor(monitoringAuth, monitoringInterval);
            }, monitoringInterval);
        }

        //***************************************************************
        //* ISSUE: Cloudant provider gets OOM  if reach > 5GB heapSize
        //*   -> Add dynamic tracing if  heapSize reach limit of 3 GB 
        //***************************************************************
        setInterval(function () { 
            var heapSize ; 
            heapSize = Math.round(v8.getHeapStatistics().total_heap_size / 1000000 );  // calc in MB 
        
            logger.info(method, "heap usage: " , heapSize);
            if ( heapSize > 3000 ) {
              v8.setFlagsFromString('--trace-gc');
            } else {
              v8.setFlagsFromString('--notrace-gc');
            }
        }, monitoringInterval );   

    })
    .catch(err => {
        logger.error(method, 'The following connection error occurred:', err);
        //***** delayed exit 
        setTimeout(function () { process.exit(1); }, 500 ); 
    });

}

init(server);
