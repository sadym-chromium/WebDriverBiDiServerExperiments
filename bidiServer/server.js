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

const http = require('http');
const debug = require('debug');

const debugBiDiServer = debug('Server:console ◀');
const debugBiDiSend = debug('BiDi:SEND ►');
const debugBiDiReceive = debug('BiDi:RECV ◀');

const port = process.env.PORT || 8080;
const headless = process.env.HEADLESS !== 'false';

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

const ignoredTargetTypes = ['browser', 'iframe', 'service_worker'];

function originIsAllowed(origin) {
  debugBiDiServer("origin: ", origin);
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

function sendClientMessage(message, connection) {
  const messageStr = JSON.stringify(message);
  debugBiDiSend(messageStr);
  connection.sendUTF(messageStr);
}

function isPrimitive(obj) {
  if (!obj._remoteObject)
    return true;

  if (!["object", "function", "wasm"].includes(obj._remoteObject.type))
    return true;

  if (obj._remoteObject.subtype && [
    "null",
    "regexp",
    "date",
    "error",
    "i32",
    "i64",
    "f32",
    "f64",
    "v128"].includes(obj._remoteObject.subtype))
    return true;

  return false;
}

async function serializeForBiDi(obj) {
  // TODO: Implement proper serialisation according to
  // https://w3c.github.io/webdriver-bidi/#data-types-remote-value.
  if (isPrimitive(obj)) {
    const val = await obj.jsonValue();
    return {
      type: typeof val,
      value: val
    };
  }

  return {
    type: "object",
    objectId: obj._remoteObject.objectId,
  };
}

// https://w3c.github.io/webdriver-bidi/#respond-with-an-error
function respondWithError(connection, plainCommandData, errorCode, errorMessage) {
  const errorResponse = getErrorResponse(plainCommandData, errorCode, errorMessage);
  sendClientMessage(errorResponse, connection);
}

wsServer.on('request', async function (request) {
  // A session per connection.
  const session = { pages: {}, elements: {} };

  if (!originIsAllowed(request.origin)) {
    // Make sure we only accept requests from an allowed origin
    request.reject();
    console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
    return;
  }

  // Launch browser for the newly created session.
  try {
    session.browser = await puppeteer.launch({ headless });
  } catch (e) {
    console.log((new Date()) + ' Cannot launch browser.', e);
    return;
  }

  try {
    session.connection = request.accept();
  } catch (e) {
    console.log((new Date()) + ' Cannot accept connection from origin', request.origin, e);
    session.browser.close();
    return;
  }

  session.connection.on('close', function () {
    console.log((new Date()) + ' Peer ' + session.connection.remoteAddress + ' disconnected.');
    session.browser.close();
  });

  addBrowserEventHandlers(session.browser, session.connection);

  // https://w3c.github.io/webdriver-bidi/#handle-an-incoming-message
  session.connection.on('message', function (message) {
    // 1. If |type| is not text, return.
    if (message.type !== 'utf8') {
      respondWithError(session.connection, {}, "invalid argument", `not supported type (${message.type})`, `type (${message.type}) is not supported`);
      return;
    }

    const plainCommandData = message.utf8Data;
    debugBiDiReceive(plainCommandData);

    // 2. Assert: |data| is a scalar value string, because the WebSocket
    //    handling errors in UTF-8-encoded data would already have
    //    failed the WebSocket connection otherwise.
    // TODO: Is this already handled correctly by the websocket library?

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
  // Puppeteer `page` corresponds to BiDi `context`
  const pageID = commandData.context;
  if (!(pageID in session.pages)) {
    throw new Error('context not found');
  }

  return session.pages[pageID];
}

function getElement(commandData, session) {
  // Puppeteer `element` corresponds to BiDi `object`
  const elementID = commandData.objectId;

  if (!(elementID in session.elements)) {
    throw new Error('context not found');
  }

  return session.elements[elementID];
}

function getElementID(element) {
  return element._remoteObject.objectId;
}

async function processCommand(commandData, session) {
  const response = {};
  response.id = commandData.id;

  switch (commandData.method) {
    // Commands specified in https://w3c.github.io/webdriver-bidi.
    case "session.status":
      return await process_session_status(commandData.params, session, response);
    case "browsingContext.getTree":
      return await process_browsingContext_getTree(commandData.params, session, response);

    // Prototype commands not specified in https://w3c.github.io/webdriver-bidi.
    case "PROTO.browsingContext.createContext":
      return await process_PROTO_browsingContext_createContext(commandData.params, session, response);
    case "PROTO.browsingContext.navigate":
      return await process_PROTO_browsingContext_navigate(commandData.params, session, response);
    case "PROTO.browsingContext.selectElement":
      return await process_PROTO_browsingContext_selectElement(commandData.params, session, response);
    case "PROTO.browsingContext.waitForSelector":
      return await process_PROTO_browsingContext_waitForSelector(commandData.params, session, response);
    case "PROTO.browsingContext.click":
      return await process_PROTO_browsingContext_click(commandData.params, session, response);
    case "PROTO.browsingContext.type":
      return await process_PROTO_browsingContext_type(commandData.params, session, response);
    case "PROTO.page.evaluate":
      return await process_PROTO_page_evaluate(commandData.params, session, response);

    // Debug commands not specified in https://w3c.github.io/webdriver-bidi.
    case "DEBUG.Page.close":
      return await process_DEBUG_Page_close(commandData.params, session, response);
    case "DEBUG.Page.screenshot":
      return await process_DEBUG_Page_screenshot(commandData.params, session, response);
    default:
      throw new Error('unknown command');
  }
}

function addPageEventHandlers(pageID, page, connection) {
  // Events specified in https://w3c.github.io/webdriver-bidi should be here.

  // Debug events not specified in https://w3c.github.io/webdriver-bidi.
  page.on('load', () => {
    handle_pageLoad_event(pageID, connection)
  });

  page.on('console', async msg => {
    handle_pageConsole_event(msg, pageID, connection);
  });
}

function addBrowserEventHandlers(browser, connection) {
  // Events specified in https://w3c.github.io/webdriver-bidi.
  browser.on('targetcreated', (target) => {
    handle_browserTargetcreated_event(target, connection);
  });

  browser.on('targetdestroyed', (target) => {
    handle_browserTargetdestroyed_event(target, connection);
  });

  // Debug events not specified in https://w3c.github.io/webdriver-bidi
  // should be here.
  browser.on('disconnected', () => {
    handle_browserDisconnected_event(connection);
  });
}

// Command processors
async function process_PROTO_browsingContext_createContext(params, session, response) {
  const page = await session.browser.newPage(params.url);

  // Use CDP targetID for mapping.
  const pageID = page.target()._targetId;
  session.pages[pageID] = page;

  response.result = getBrowsingContextInfo(page.target());

  addPageEventHandlers(pageID, page, session.connection);

  return response;
}

async function process_PROTO_browsingContext_navigate(params, session, response) {
  const page = getPage(params, session);

  if (!params.url) {
    throw new Error('missing params.url');
  }

  const options = {};
  if (params.waitUntil) {
    // Possible values are in PuppeteerLifeCycleEvent: `src/common/LifecycleWatcher.ts`.
    options.waitUntil = params.waitUntil
  }
  if (params.referer) {
    options.referer = params.referer;
  }
  if (params.timeout >= 0) {
    options.timeout = params.timeout;
  }

  await page.goto(params.url, options);
  response.result = {};

  return response;
}

async function process_DEBUG_Page_close(params, session, response) {
  const page = getPage(params, session);
  const pageID = page.target()._targetId;

  page.close();
  // Remove page from session map.
  delete session.pages[pageID];

  response.result = {};

  return response;
}

async function process_DEBUG_Page_screenshot(params, session, response) {
  const page = getPage(params, session);
  const screenshot = await page.screenshot({ encoding: 'base64' });
  response.result = { screenshot };
  return response;
}

async function process_PROTO_browsingContext_waitForSelector(params, session, response) {
  const page = getPage(params, session);

  if (!params.selector)
    throw new Error('missing params.selector');

  const options = {};
  if ('visible' in params)
    options.visible = params.visible;
  if ('hidden' in params)
    options.hidden = params.hidden;
  if ('timeout' in params)
    options.timeout = params.timeout;

  const element = await page.waitForSelector(params.selector, options);

  if (element) {
    // Store element in the local cache.
    session.elements[getElementID(element)] = element;
    response.result = getElementValue(element);
  } else {
    response.result = {};
  }

  return response;
}

async function process_PROTO_browsingContext_selectElement(params, session, response) {
  const page = getPage(params, session);

  if (!params.selector)
    throw new Error('missing params.selector');

  const element = await page.$(params.selector);

  if (element) {
    // Store element in the local cache.
    session.elements[getElementID(element)] = element;
    response.result = getElementValue(element);
  } else {
    response.result = {};
  }

  return response;
}

async function process_PROTO_browsingContext_click(params, session, response) {
  const page = getPage(params, session);
  // TODO: make element optionals.
  // TODO: add click options.
  const element = getElement(params, session);

  await element.click();
  response.result = {};

  return response;
}

async function process_PROTO_browsingContext_type(params, session, response) {
  const page = getPage(params, session);
  // TODO: make element optionals.
  // TODO: add type options.
  const element = getElement(params, session);

  if (!params.text)
    throw new Error('missing params.text');

  const options = params.options ? params.options : {};

  await element.type(params.text, options);

  response.result = {};

  return response;
}

async function process_PROTO_page_evaluate(params, session, response) {
  const page = getPage(params, session);

  if (!params.function)
    throw new Error('missing params.function');

  const args = [params.function];
  if (params.args) {
    for (const arg of params.args) {
      if (arg.objectId) {
        args.push(getElement(arg, session));
      } else {
        // TODO: Implement proper scalar deserialisation according to
        // https://w3c.github.io/webdriver-bidi/#data-types-remote-value.
        args.push(arg);
      }
    }
  }
  const result = await page.evaluate.apply(page, args);

  // TODO: Implement proper scalar serialisation according to
  // https://w3c.github.io/webdriver-bidi/#data-types-remote-value.
  response.result = JSON.stringify(result);

  return response;
}

async function process_browsingContext_getTree(params, session, response) {
  // BiDi `context` corresponds to puppeteer `target`

  const targets = session.browser.targets()
    .filter(t => !ignoredTargetTypes.includes(t._targetInfo.type));

  for await (const t of targets) {
    const pageID = t._targetId;
    const page = await t.page();

    // After the page exposed to the external world,
    // it's events has to be processed.
    addPageEventHandlers(pageID, page, session.connection)

    // For now pages need to be stored in the map.
    // Can be replaced with getting page object by ID on demand.
    session.pages[pageID] = page;
  }

  const contexts = targets
    .map(t => getBrowsingContextInfo(t));

  response.result = { contexts };

  return response;
}

async function process_session_status(params, session, response) {
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

function handle_pageLoad_event(pageID, connection) {
  sendClientMessage({
    method: 'DEBUG.Page.load',
    params: {
      // Pupputeer `pageID` corresponds to BiDi `context`
      context: pageID
    }
  }, connection);
}
async function handle_pageConsole_event(msg, pageID, connection) {
  const args = await Promise.all(
    msg.args()
      .map(serializeForBiDi));

  // TODO: Handle `console.log('%s %s', 'foo', 'bar')` case.
  const text = msg.args()
    .map(arg => arg.toSimpleValue())
    .join(' ');

  const stackTrace = msg.stackTrace().map(e => {
    return {
      url: e.url,
      functionName: e.functionName,
      lineNumber: e.lineNumber,
      columnNumber: e.columnNumber
    }
  });

  let level = "info";
  if (["error", "assert"].includes(msg.type()))
    level = "error";
  if (["debug", "trace"].includes(msg.type()))
    level = "debug";
  if (["warn", "warning"].includes(msg.type()))
    level = "warning";

  sendClientMessage({
    method: 'log.entryAdded',
    params: {
      // BaseLogEntry
      level,
      text,
      timestamp: msg.timestamp(),
      stackTrace,
      // ConsoleLogEntry
      type: "console",
      method: msg.type(),
      // TODO: Replace `PROTO.context` with `realm`
      "PROTO.context": pageID,
      args,
    }
  }, connection);
}

async function handle_browserDisconnected_event(connection) {
  respondWithError(connection, {}, "unknown error", "browser closed");
  connection.close();
}

async function handle_browserTargetcreated_event(target, connection) {
  if (!ignoredTargetTypes.includes(target._targetInfo.type)) {
    sendClientMessage({
      method: 'browsingContext.contextCreated',
      params: getBrowsingContextInfo(target)
    }, connection);
  }
}
async function handle_browserTargetdestroyed_event(target, connection) {
  if (!ignoredTargetTypes.includes(target._targetInfo.type)) {
    sendClientMessage({
      method: 'browsingContext.contextDestroyed',
      params: getBrowsingContextInfo(target)
    }, connection);
  }
}

// Data contracts
function getBrowsingContextInfo(target) {
  return {
    // Properties specified in https://w3c.github.io/webdriver-bidi.
    context: target._targetId,
    parent: target.opener() ? target.opener().id() : null,
    url: target.url(),
    // TODO add `children` field.

    // Debug properties not specified in https://w3c.github.io/webdriver-bidi.
    // 'DEBUG.type': target._targetInfo.type
  }
}

function getElementValue(element) {
  return {
    // Properties specified in https://w3c.github.io/webdriver-bidi.
    type: "node",
    objectId: getElementID(element)
  };
}