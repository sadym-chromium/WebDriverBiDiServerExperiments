/**
 * Copyright 2020 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const puppeteer = require('..');
const WebSocketServer = require('websocket').server;

const uuid = require('uuid').v4;
const http = require('http');

const port = process.env.PORT || 8080;

const server = http.createServer(function (request, response) {
  console.log((new Date()) + ' Received request for ' + request.url);
  response.writeHead(404);
  response.end();
});
server.listen(port, function () {
  console.log(`${new Date()} Server is listening on port ${port}`);
});

const wsServer = new WebSocketServer({
  httpServer: server,
  // You should not use autoAcceptConnections for production
  // applications, as it defeats all standard cross-origin protection
  // facilities built into the protocol and the browser.  You should
  // *always* verify the connection's origin and decide whether or not
  // to accept it.
  autoAcceptConnections: false
});

function originIsAllowed(origin) {
  console.log("origin: ", origin);
  return true;
}

function jsonType(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function matchData(data) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error('Cannot parse data as JSON');
  }

  const parsedType = jsonType(parsed);
  if (parsedType !== 'object') {
    throw new Error(`Expected JSON object but got ${parsedType}`);
  }

  // Extract amd validate id, method and params.
  const {id, method, params} = parsed;

  const idType = jsonType(id);
  if (idType !== 'number' || !Number.isInteger(id) || id < 0) {
    // TODO: should uint64_t be the upper limit?
    // https://tools.ietf.org/html/rfc7049#section-2.1
    throw new Error(`Expected unsigned integer but got ${idType}`);
  }

  const methodType = jsonType(method);
  if (methodType !== 'string') {
    throw new Error(`Expected string method but got ${methodType}`);
  }

  const paramsType = jsonType(params);
  if (paramsType !== 'object') {
    throw new Error(`Expected object params but got ${paramsType}`);
  }

  return {id, method, params};
}

function getErrorResponse(plainCommandData, errorCode, errorMessage) {
  // TODO: this is bizarre per spec. We reparse the payload and
  // extract the ID, regardless of what kind of value it was.
  let commandId = null;
  try {
    const commandData = JSON.parse(plainCommandData);
    if (jsonType(commandData) === 'object' && 'id' in commandData) {
      commandId = commandData.id;
    }
  } catch { }

  return {
    id: commandId,
    error: errorCode,
    message: errorMessage,
    // TODO: optional stacktrace field
  };
}

// https://w3c.github.io/webdriver-bidi/#respond-with-an-error
function respondWithError(connection, plainCommandData, errorCode, errorMessage) {
  const response = JSON.stringify(getErrorResponse(plainCommandData, errorCode, errorMessage));
  connection.sendUTF(response);

  console.log('Sent error response:', response);
}

wsServer.on('request', async function (request) {
  console.log("!!@@## request");
  // A session per connection.
  const session = { pages: {} };

  if (!originIsAllowed(request.origin)) {
    // Make sure we only accept requests from an allowed origin
    request.reject();
    console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
    return;
  }

  try {
    // Launch browser for the newly created session.
    session.browser = await puppeteer.launch({ headless: true });
    var connection = request.accept();
  } catch (e) {
    console.log("Connection rejected: ", e);
    console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
    return;
   }

  console.log((new Date()) + ' Connection accepted.');

  connection.on('close', function () {
    console.log((new Date()) + ' Peer ' + connection.remoteAddress + ' disconnected.');
    session.browser.close();
  });

  // https://w3c.github.io/webdriver-bidi/#handle-an-incoming-message
  connection.on('message', async function (message) {
    console.log('message: ', message);
    // 1. If |type| is not text, return.
    if (message.type !== 'utf8' ) {
      console.log(`Silently ignoring non-text (${message.type}) message`);
      return;
    }

    const plainCommandData = message.utf8Data;

    // 2. Assert: |data| is a scalar value string, because the WebSocket
    //    handling errors in UTF-8-encoded data would already have
    //    failed the WebSocket connection otherwise.
    // TODO: Is this already handled correctly by the websocket library?

    console.log('Received Message: ' + plainCommandData);

    // 3. Match |data| against the remote end definition.
    let commandData;
    try {
      commandData = matchData(plainCommandData);
    } catch (e) {
      respondWithError(connection, plainCommandData, "invalid argument", e.message);
      return;
    }

    try {
      const response = await processCommand(commandData, session);
      const responseStr = JSON.stringify(response);
      connection.sendUTF(responseStr);
      console.log('Sent response: ' + responseStr);
      return;
    } catch (e) {
      respondWithError(connection, plainCommandData, "error processing command", e.message);
      return;
    }
  });
  connection.on('close', function (reasonCode, description) {
    console.log((new Date()) + ' Peer ' + connection.remoteAddress + ' disconnected.');
  });
});

function getPage(commandData, session) {
  if (!(commandData.pageID in session.pages)) {
    throw new Error('page not found');
  }

  return session.pages[commandData.pageID];
}

async function processCommand(commandData, session) {
  const response = {};
  response.id = commandData.id;

  switch (commandData.method) {
    case "session.status":
      return await processSessionStatus(commandData.params, session, response);
    case "newPage":
      return await processNewPage(commandData.params, session, response);
    case "goto":
      return await processGoto(commandData.params, session, response);
    case "screenshot":
      return await processScreenshot(commandData.params, session, response);
    default:
      throw new Error('unknown command');
  }
}

async function processNewPage(params, session, response) {
  const page = await session.browser.newPage();

  const pageID = uuid();
  session.pages[pageID] = page;

  response.pageID = pageID;
  response.message = 'done';

  return response;
}

async function processGoto(params, session, response) {
  const page = getPage(params, session);

  if (!params.url) {
    throw new Error('missing params.url');
  }

  await page.goto(params.url);
  response.message = 'done';
  return response;
}

async function processScreenshot(params, session, response) {
  const page = getPage(params, session);
  const screenshot = await page.screenshot({ encoding: 'base64' });
  response.screenshot = screenshot;
  response.message = 'done';
  return response;
}

async function processSessionStatus(params, session, response) {
  if (session.browser.isConnected()) {
    response.value = {
      ready: true,
      message: "ready"
    }
  } else {
    response.value = {
      ready: false,
      message: "disconnected"
    }
  }
  return response;
}
