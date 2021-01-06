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
const headless = process.env.HEADLESS === 'false' ? false : true;

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
  let commandId = undefined;
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

async function sendClientMessage(message, connection) {
    const messageStr = JSON.stringify(message);
    connection.sendUTF(messageStr);
    console.log('Sent message: ' + messageStr);
}

// https://w3c.github.io/webdriver-bidi/#respond-with-an-error
function respondWithError(connection, plainCommandData, errorCode, errorMessage) {
  const errorResponse = getErrorResponse(plainCommandData, errorCode, errorMessage);
  sendClientMessage(errorResponse, connection);
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
    session.browser = await puppeteer.launch({ headless });
    session.connection = request.accept();
    addBrowserEventHandlers(session.browser, session.connection);
  } catch (e) {
    console.log("Connection rejected: ", e);
    console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
    return;
  }

  console.log((new Date()) + ' Connection accepted.');

  session.connection.on('close', function () {
    console.log((new Date()) + ' Peer ' + session.connection.remoteAddress + ' disconnected.');
    session.browser.close();
  });

  addConnectionEventHandlers(session.browser, session.connection);

  // https://w3c.github.io/webdriver-bidi/#handle-an-incoming-message
  session.connection.on('message', function (message) {
    console.log('message: ', message);
    // 1. If |type| is not text, return.
    if (message.type !== 'utf8') {
      respondWithError(session.connection, {}, "invalid argument", `not supported type (${message.type})`, `type (${message.type}) is not supported`);
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
      respondWithError(session.connection, plainCommandData, "invalid argument", e.message);
      return;
    }

    processCommand(commandData, session).then(response => {
      sendClientMessage(response, session.connection)
    }).catch(e => {
      respondWithError(session.connection, plainCommandData, "unknown error", e.message);
    });
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
    // Commands specified in https://w3c.github.io/webdriver-bidi.
    case "session.status":
      return await processSessionStatus(commandData.params, session, response);
    case "browsingContext.getTree":
      return await processBrowsingContextGetTree(commandData.params, session, response);

    // Debug commands not specified in https://w3c.github.io/webdriver-bidi.
    case "DEBUG.Browser.newPage":
      return await processDebugBrowserNewPage(commandData.params, session, response);
    case "DEBUG.Page.close":
      return await processDebugPageClose(commandData.params, session, response);
    case "DEBUG.Page.navigate":
      return await processDebugPageNavigate(commandData.params, session, response);
    case "DEBUG.Page.screenshot":
      return await processDebugPageScreenshot(commandData.params, session, response);
    default:
      throw new Error('unknown command');
  }
}

async function processDebugBrowserNewPage(params, session, response) {
  const page = await session.browser.newPage();

  // Use CDP targetID for mapping.
  const pageID = page.target()._targetId;
  session.pages[pageID] = page;

  response.result = { pageID };

  addPageEventHandlers(pageID, page, session.connection);

  return response;
}

async function processDebugPageClose(params, session, response) {
  const page = getPage(params, session);
  const pageID = page.target()._targetId;

  page.close();
  // Remove page from session map.
  session.pages[pageID] = undefined;

  response.result = {};

  return response;
}

async function processDebugPageNavigate(params, session, response) {
  const page = getPage(params, session);

  if (!params.url) {
    throw new Error('missing params.url');
  }

  await page.goto(params.url);
  response.result = {};
  return response;
}

async function processDebugPageScreenshot(params, session, response) {
  const page = getPage(params, session);
  const screenshot = await page.screenshot({ encoding: 'base64' });
  response.result = { screenshot };
  return response;
}

async function processBrowsingContextGetTree(params, session, response) {
  // BiDi `context` corresponds to puppeteer `target`

  const targets = session.browser.targets().filter(t => {
    // `browser` and `iframe` are not supported as targets yet.
    return t._targetInfo.type !== 'browser'
      && t._targetInfo.type !== 'iframe';
  });

  await Promise.all(targets.map(t => {
    if (!session.pages[t._targetId]) {
      return t.page().then(p => {
        // For now pages need to be stored in the map.
        // Can be replaced with getting page object by ID on demand.
        session.pages[t._targetId] = p;
      });
    }
  }));

  const contexts = targets
    .map(t => getBrowsingContextInfo(t));

  response.result = { contexts };

  return response;
}

async function processSessionStatus(params, session, response) {
  if (session.browser.isConnected()) {
    response.result = {
      ready: true,
      message: "ready"
    }
  } else {
    response.result = {
      ready: false,
      message: "disconnected"
    }
  }
  return response;
}

// Events handlers
// TODO: Add events filtering.

function addConnectionEventHandlers(browser, connection) {
  browser.on('disconnected', () => {
    respondWithError(connection, {}, "unknown error", "browser closed");
    connection.close();
  });
}

function addPageEventHandlers(pageID, page, connection) {
  // Events specified in https://w3c.github.io/webdriver-bidi should be here.

  // Debug events not specified in https://w3c.github.io/webdriver-bidi.
  page.on('load', () => {
    sendClientMessage({
      method: 'DEBUG.Page.load',
      params: {
        pageID: pageID
      }
    }, connection);
  });
}

function addBrowserEventHandlers(browser, connection) {
  // Events specified in https://w3c.github.io/webdriver-bidi.
  browser.on('targetcreated', (t) => {
    sendClientMessage({
      method: 'browsingContext.contextCreated',
      params: getBrowsingContextInfo(t)
    }, connection);
  });

  browser.on('targetdestroyed', (t) => {
    sendClientMessage({
      method: 'browsingContext.contextDestroyed',
      params: getBrowsingContextInfo(t)
    }, connection);
  });

  // Debug events not specified in https://w3c.github.io/webdriver-bidi
  // should be here.
}

// Data contracts
function getBrowsingContextInfo(target) {
  return {
    context: target._targetId,
    parent: target.opener() ? target.opener().id() : null,
    url: target.url(),
    // TODO: `type` is a debug property, remove when not needed.
    type: target._targetInfo.type
  }
}