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

const sessions = {};

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

// https://w3c.github.io/webdriver-bidi/#respond-with-an-error
function respondWithError(connection, data, code, message) {
  // TODO: this is bizarre per spec. We reparse the payload and
  // extract the ID, regardless of what kind of value it was.
  let commandId = null;
  try {
    const parsed = JSON.parse(data);
    if (jsonType(parsed) === 'object' && 'id' in parsed) {
      commandId = parsed.id;
    }
  } catch {}

  const errorData = {
    id: commandId,
    error: code,
    message,
    // TODO: optional stacktrace field
  };

  const response = JSON.stringify(errorData);

  connection.sendUTF(response);

  console.log('Sent error response:', response);
}

wsServer.on('request', function (request) {
  if (!originIsAllowed(request.origin)) {
    // Make sure we only accept requests from an allowed origin
    request.reject();
    console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
    return;
  }

  try {
    var connection = request.accept();
  } catch (e) {
    console.log("Connection rejected: ", e);
    console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
    return;
   }

  console.log((new Date()) + ' Connection accepted.');

  // https://w3c.github.io/webdriver-bidi/#handle-an-incoming-message
  connection.on('message', async function (message) {
    console.log('message: ', message);
    // 1. If |type| is not text, return.
    if (message.type !== 'utf8' ) {
      console.log(`Silently ignoring non-text (${message.type}) message`);
      return;
    }

    const data = message.utf8Data;

    // 2. Assert: |data| is a scalar value string, because the WebSocket
    //    handling errors in UTF-8-encoded data would already have
    //    failed the WebSocket connection otherwise.
    // TODO: Is this already handled correctly by the websocket library?

    console.log('Received Message: ' + data);

    // 3. Match |data| against the remote end definition.
    let parsed;
    try {
      parsed = matchData(data);
    } catch (e) {
      respondWithError(connection, data, "invalid argument", e.message);
      return;
    }

    let sessionID; // TODO: always undefined
    let pageID;  // TODO: always undefined

    const response = {};
    response.id = parsed.id;

    if (!!sessionID) {
      response.sessionID = sessionID;
    }
    if (!!pageID) {
      response.pageID = pageID;
    }

    let browser, page;
    switch (parsed.method) {
      case "launch":
        browser = await puppeteer.launch({ headless: false });

        sessionID = uuid();
        sessions[sessionID] = {
          browser: browser,
          pages: {}
        };
        response.sessionID = sessionID;
        break;
      case "newPage":
        if (!(sessionID in sessions)) {
          response.message = 'missing sessionID';
          break;
        }

        browser = sessions[sessionID].browser;
        page = await browser.newPage();

        pageID = uuid();
        sessions[sessionID].pages[pageID] = page;

        response.pageID = pageID;
        response.message = 'done';
        break;
      case "goto":
        if (!(sessionID in sessions)) {
          response.message = 'missing sessionID';
          break;
        }
        if (!(pageID in sessions[sessionID].pages)) {
          response.message = 'missing sessionID';
          break;
        }
        let params = parsed.params;
        if (!params.url) {
          response.message = 'missing params.url';
          break;
        }

        page = sessions[sessionID].pages[pageID];
        await page.goto(params.url);
        response.message = 'done';
        break;
      case "screenshot":
        if (!(sessionID in sessions)) {
          response.message = 'missing sessionID';
          break;
        }
        if (!(pageID in sessions[sessionID].pages)) {
          response.message = 'missing sessionID';
          break;
        }

        page = sessions[sessionID].pages[pageID];
        let screenshot = await page.screenshot({ encoding: 'base64'});
        response.screenshot = screenshot;
        response.message = 'done';
        break;
      default:
        respondWithError(connection, data, 'unknown command',
            `unknown method ${parsed.method}`);
        return;
    }

    const responseStr = JSON.stringify(response);

    console.log('Sent response: ' + responseStr);

    connection.sendUTF(responseStr);
  });
  connection.on('close', function (reasonCode, description) {
    console.log((new Date()) + ' Peer ' + connection.remoteAddress + ' disconnected.');
  });
});
