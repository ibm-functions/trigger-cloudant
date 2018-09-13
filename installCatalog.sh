#!/bin/bash
set -ex

if [ ! -d ./openwhisk-cloudant ]; then
 git clone https://github.com/apache/incubator-openwhisk-package-cloudant openwhisk-cloudant
fi

cp config.js ./openwhisk-cloudant/actions/event-actions/lib/config.js

export ACTION_RUNTIME_VERSION=nodejs:8

cd openwhisk-cloudant
./installCatalog.sh $1 $2 $3 $4 $5 $6
