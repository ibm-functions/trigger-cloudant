FROM node:14

RUN apt-get update && apt-get upgrade -y

# Remove CURL and git as it is has constant security vulnerabilities and we don't use it
RUN apt-get purge -y --auto-remove curl git

ADD package.json /cloudantTrigger/
# let npm install call Fail in case of not matching npm engine requirements.
RUN echo "engine-strict=true" > /cloudantTrigger/.npmrc
RUN cd /cloudantTrigger && npm install --omit=dev

# 07/07/2023 :  FG - The used cloudant-follow lib npm package is out of support since 2022. Since the heartbeat 
#               behaviour has changed in  IBM Cloud Cloudant DB HA-handling the heartbeats will occur with 
#               longer delays. ( e.g follow lib has heartbeat setting of 30 sec, but DB respond sometimes only in 90 sec)
#               So the HEARTBEAT_TIMEOUT_COEFFICIENT of the follow lib needs to be adpted. Because follow-lib package will 
#               not be updated, this settings update needs to be done  during the provider image build by patching the feed.js file 

RUN sed -i 's/HEARTBEAT_TIMEOUT_COEFFICIENT = 1.25;/HEARTBEAT_TIMEOUT_COEFFICIENT = 3.25;/g' /cloudantTrigger/node_modules/cloudant-follow/lib/feed.js


ADD provider/. /cloudantTrigger/
