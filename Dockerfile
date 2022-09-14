FROM node:16

RUN apt-get update && apt-get upgrade -y

# Remove CURL and git as it is has constant security vulnerabilities and we don't use it
RUN apt-get purge -y --auto-remove curl git

ADD package.json /cloudantTrigger/
# let npm install call Fail in case of not matching npm engine requirements.
RUN echo "engine-strict=true" > /cloudantTrigger/.npmrc
RUN cd /cloudantTrigger && npm install --omit=dev

ADD provider/. /cloudantTrigger/
