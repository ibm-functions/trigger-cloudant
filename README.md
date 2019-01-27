# Using the Cloudant package

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](http://www.apache.org/licenses/LICENSE-2.0)

The `/whisk.system/cloudant` package enables you to work with a Cloudant database. It includes the following feed action.

| Entity | Type | Parameters | Description |
| --- | --- | --- | --- |
| `/whisk.system/cloudant` | package | dbname, host, username, password | Work with a Cloudant database |
| `/whisk.system/cloudant/changes` | feed | dbname, iamApiKey, iamUrl, filter, query_params, maxTriggers | Fire trigger events on changes to a database |

## Firing a trigger on database changes

Use the `changes` feed to configure a service to fire a trigger on every change to your Cloudant database. The parameters are as follows:

- `dbname` (*required*): The name of the Cloudant database.

- `iamApiKey` (*optional*): The IAM API key for the Cloudant database.  If specified will be used as the credentials instead of username and password.

- `iamUrl` (*optional*): The IAM token service url that is used when `iamApiKey` is specified.  Defaults to `https://iam.bluemix.net/identity/token`. 

- `maxTriggers` (*optional*): Stop firing triggers when this limit is reached.  Defaults to infinite.

- `filter` (*optional*): Filter function that is defined on a design document.

- `query_params` (*optional*): Extra query parameters for the filter function.

The following topics walk through setting up a Cloudant database, configuring an associated package, and using the actions and feeds in the `/whisk.system/cloudant` package.

## Setting up a Cloudant database in Bluemix

If you're using OpenWhisk from Bluemix, OpenWhisk automatically creates package bindings for your Bluemix Cloudant service instances. If you're not using OpenWhisk and Cloudant from Bluemix, skip to the next step.

1. Create a Cloudant service instance in your Bluemix [dashboard](http://console.ng.Bluemix.net).

  Be sure to create a Credential key, after creating a new service instance.

2. Refresh the packages in your namespace. The refresh automatically creates a package binding for each Cloudant service instance that has a credential key defined.

  ```
  wsk package refresh
  ```
  ```
  created bindings:
  Bluemix_testCloudant_Credentials-1
  ```

  ```
  wsk package list
  ```
  ```
  packages
  /myBluemixOrg_myBluemixSpace/Bluemix_testCloudant_Credentials-1 private binding
  ```

  Your package binding now contains the credentials associated with your Cloudant service instance.

3. Check to see that the package binding that was created previously is configured with your Cloudant Bluemix service instance host and credentials.

  ```
  wsk package get /myBluemixOrg_myBluemixSpace/Bluemix_testCloudant_Credentials-1 parameters
  ```
  ```
  ok: got package /myBluemixOrg_myBluemixSpace/Bluemix_testCloudant_Credentials-1, displaying field parameters
  ```
  ```json
  [
      {
          "key": "username",
          "value": "cdb18832-2bbb-4df2-b7b1-Bluemix"
      },
      {
          "key": "host",
          "value": "cdb18832-2bbb-4df2-b7b1-Bluemix.cloudant.com"
      },
      {
          "key": "password",
          "value": "c9088667484a9ac827daf8884972737"
      }
  ]
  ```

## Setting up a Cloudant database outside Bluemix

If you're not using OpenWhisk in Bluemix or if you want to set up your Cloudant database outside of Bluemix, you must manually create a package binding for your Cloudant account. You need the Cloudant account host name, user name, and password.

1. Create a package binding that is configured for your Cloudant account.

  ```
  wsk package bind /whisk.system/cloudant myCloudant -p username MYUSERNAME -p password MYPASSWORD -p host MYCLOUDANTACCOUNT.cloudant.com
  ```

2. Verify that the package binding exists.

  ```
  wsk package list
  ```
  ```
  packages
  /myNamespace/myCloudant private binding
  ```


## Listening for changes to a Cloudant database

### Filter database change events

You can define a filter function, to avoid having unnecessary change events firing your trigger.

To create a new filter function you can use an action.

Create a json document file `design_doc.json` with the following filter function
```json
{
  "doc": {
    "_id": "_design/mailbox",
    "filters": {
      "by_status": "function(doc, req){if (doc.status != req.query.status){return false;} return true;}"
    }
  }
}
```

Create a new design document on the database with the filter function

```
wsk action invoke /_/myCloudant/write -p dbname testdb -p overwrite true -P design_doc.json -r
```
The information for the new design document is printed on the screen.
```json
{
    "id": "_design/mailbox",
    "ok": true,
    "rev": "1-5c361ed5141bc7856d4d7c24e4daddfd"
}
```

### Create the trigger using the filter function

You can use the `changes` feed to configure a service to fire a trigger on every change to your Cloudant database. The parameters are as follows:

- `dbname`: Name of Cloudant database.
- `maxTriggers`: Stop firing triggers when this limit is reached. Defaults to infinite.
- `filter`: Filter function defined on a design document.
- `query_params`: Optional query parameters for the filter function.


1. Create a trigger with the `changes` feed in the package binding that you created previously including `filter` and `query_params` to only fire the trigger when a document is added or modified when the status is `new`.
Be sure to replace `/_/myCloudant` with your package name.

  ```
  wsk trigger create myCloudantTrigger --feed /_/myCloudant/changes \
  --param dbname testdb \
  --param filter "mailbox/by_status" \
  --param query_params '{"status":"new"}'
  ```
  ```
  ok: created trigger feed myCloudantTrigger
  ```

2. Poll for activations.

  ```
  wsk activation poll
  ```

3. In your Cloudant dashboard, either modify an existing document or create a new one.

4. Observe new activations for the `myCloudantTrigger` trigger for each document change only if the document status is `new` based on the filter function and query parameter.

  **Note**: If you are unable to observe new activations, see the subsequent sections on reading from and writing to a Cloudant database. Testing the following reading and writing steps will help verify that your Cloudant credentials are correct.

  You can now create rules and associate them to actions to react to the document updates.

  The content of the generated events has the following parameters:

  - `id`: The document ID.
  - `seq`: The sequence identifier that is generated by Cloudant.
  - `changes`: An array of objects, each of which has a `rev` field that contains the revision ID of the document.

  The JSON representation of the trigger event is as follows:

  ```json
  {
      "id": "6ca436c44074c4c2aa6a40c9a188b348",
      "seq": "2-g1AAAAL9aJyV-GJCaEuqx4-BktQkYp_dmIfC",
      "changes": [
          {
              "rev": "2-da3f80848a480379486fb4a2ad98fa16"
          }
      ]
  }
  ```
  

