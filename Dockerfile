FROM openwhisk/cloudantprovider:b7b9994

RUN apt-get update && apt-get upgrade -y

COPY package.json /cloudantTrigger/
RUN cd /cloudantTrigger && npm install --production

COPY authHandler.js /cloudantTrigger/lib/
