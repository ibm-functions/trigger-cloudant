FROM node:10.16.3

RUN apt-get update && apt-get upgrade -y

ADD package.json /cloudantTrigger/
RUN cd /cloudantTrigger && npm install --production

ADD provider/. /cloudantTrigger/
