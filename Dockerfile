FROM openwhisk/cloudantprovider:1.9.3

COPY package.json /cloudantTrigger/
RUN cd /cloudantTrigger && npm install --production

COPY authHandler.js /cloudantTrigger/lib/
