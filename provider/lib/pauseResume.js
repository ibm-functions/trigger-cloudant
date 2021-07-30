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

module.exports = function (logger, manager) {

    //******************************************* 
    //* pauseresume Endpoint 
    //*  to set or query the pauseresume capability flag 
    //* 
    //* supports URL-encoded paramter only 
    //* e.g  ../pauseresume?enabled=true   (set)
    //*      ../pauseresume?enabled        (query)
    //*******************************************
    this.endPoint = '/pauseresume';

    this.pauseresume = function (req, res) {
        var method = 'pauseresume';
        
        //************************************
        //* detect request details : 
        //* enabled == true  --> switch ON 
        //* enabled == false --> switch OFF 
        //************************************
        if ( "true" == req.query.enabled ) {  
            logger.info( method, 'Pause/Resume capability enabled by operator');
            manager.pauseResumeEnabled = "true";
            res.send({
                enabled: "true"
            });
        }else if ( "false" == req.query.enabled ) {
            logger.info( method, 'Pause/Resume capability disabled by operator');
            manager.pauseResumeEnabled = "false";
            res.send({
                enabled: "false"
            });
        }else if ( req.query.enabled.length == 0 ){
            logger.info( method, 'Pause/Resume capability status queried by operator');
            res.send({
                enabled: manager.pauseResumeEnabled
            });
        }else {
            logger.error( method, 'Request to change Pause/Resume capability contained incorrect arguments');
            res.status(400).send({
                message: 'Missing  parameter [/pauseresume?enabled=] in URL'
            });
        }
    };
};
