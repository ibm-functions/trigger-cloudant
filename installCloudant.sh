#!/bin/bash
#
# use the command line interface to install standard actions deployed
# automatically
#
# To run this command
# ./installCatalog.sh <authkey> <edgehost> <dburl> <dbprefix> <apihost> <workers>

set -e
set -x

: ${OPENWHISK_HOME:?"OPENWHISK_HOME must be set and non-empty"}
WSK_CLI="$OPENWHISK_HOME/bin/wsk"

if [ $# -eq 0 ]; then
    echo "Usage: ./installCatalog.sh <authkey> <edgehost> <dburl> <dbprefix> <apihost> <workers>"
fi

AUTH="$1"
EDGEHOST="$2"
DB_URL="$3"
DB_NAME="${4}cloudanttrigger"
APIHOST="$5"
WORKERS="$6"
ACTION_RUNTIME_VERSION=${ACTION_RUNTIME_VERSION:="nodejs:6"}

# If the auth key file exists, read the key in the file. Otherwise, take the
# first argument as the key itself.
if [ -f "$AUTH" ]; then
    AUTH=`cat $AUTH`
fi

# Make sure that the EDGEHOST is not empty.
: ${EDGEHOST:?"EDGEHOST must be set and non-empty"}

# Make sure that the DB_URL is not empty.
: ${DB_URL:?"DB_URL must be set and non-empty"}

# Make sure that the DB_NAME is not empty.
: ${DB_NAME:?"DB_NAME must be set and non-empty"}

# Make sure that the APIHOST is not empty.
: ${APIHOST:?"APIHOST must be set and non-empty"}

PACKAGE_HOME="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

export WSK_CONFIG_FILE= # override local property file to avoid namespace clashes

echo Installing Cloudant package.

$WSK_CLI -i --apihost "$EDGEHOST" package update --auth "$AUTH" --shared yes cloudant \
    -a description "Cloudant database service" \
    -a parameters '[  {"name":"bluemixServiceName", "required":false, "bindTime":true}, {"name":"username", "required":false, "bindTime":true, "description": "Your Cloudant username"}, {"name":"password", "required":false, "type":"password", "bindTime":true, "description": "Your Cloudant password"}, {"name":"host", "required":true, "bindTime":true, "description": "This is usually your username.cloudant.com"}, {"name":"iamApiKey", "required":false}, {"name":"iamUrl", "required":false}, {"name":"dbname", "required":false, "description": "The name of your Cloudant database"}, {"name":"overwrite", "required":false, "type": "boolean"} ]' \
    -p bluemixServiceName 'cloudantNoSQLDB' \
    -p apihost "$APIHOST"

# make changesFeed.zip
cd actions/event-actions

if [ -e changesFeed.zip ]; then
    rm -rf changesFeed.zip
fi

cp -f changesFeed_package.json package.json
zip -r changesFeed.zip lib package.json changes.js

$WSK_CLI -i --apihost "$EDGEHOST" action update --kind "$ACTION_RUNTIME_VERSION" --auth "$AUTH" cloudant/changes "$PACKAGE_HOME/actions/event-actions/changesFeed.zip" \
    -t 90000 \
    -a feed true \
    -a provide-api-key true \
    -a description 'Database change feed' \
    -a parameters '[ {"name":"dbname", "required":true, "updatable":false}, {"name":"iamApiKey", "required":false, "updatable":false}, {"name":"iamUrl", "required":false, "updatable":false}, {"name": "filter", "required":false, "updatable":true, "type": "string", "description": "The name of your Cloudant database filter"}, {"name": "query_params", "required":false, "updatable":true, "description": "JSON Object containing query parameters that are passed to the filter"} ]' \
    -a sampleInput '{ "dbname": "mydb", "filter": "mailbox/by_status", "query_params": {"status": "new"} }'

COMMAND=" -i --apihost $EDGEHOST package update --auth $AUTH --shared no cloudantWeb \
     -p DB_URL $DB_URL \
     -p DB_NAME $DB_NAME \
     -p apihost $APIHOST"

if [ -n "$WORKERS" ]; then
    COMMAND+=" -p workers $WORKERS"
fi

$WSK_CLI $COMMAND

# make changesWebAction.zip
cp -f changesWeb_package.json package.json
npm install

if [ -e changesWebAction.zip ]; then
    rm -rf changesWebAction.zip
fi

zip -r changesWebAction.zip lib package.json changesWebAction.js node_modules

$WSK_CLI -i --apihost "$EDGEHOST" action update --kind "$ACTION_RUNTIME_VERSION" --auth "$AUTH" cloudantWeb/changesWebAction "$PACKAGE_HOME/actions/event-actions/changesWebAction.zip" \
    -a description 'Create/Delete a trigger in cloudant provider Database' \
    --web true
