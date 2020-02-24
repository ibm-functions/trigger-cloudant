FROM node:10.19.0

RUN apt-get update && apt-get upgrade -y

ADD package.json /cloudantTrigger/
RUN cd /cloudantTrigger && npm install --production

ADD provider/. /cloudantTrigger/
