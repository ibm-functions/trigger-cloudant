FROM openwhisk/cloudantprovider:1.8.0

COPY package.json /cloudantTrigger/
RUN cd /cloudantTrigger && npm install --production

COPY authHandler.js /cloudantTrigger/lib/
