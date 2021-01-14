import asyncio
import json
import os
import pytest
import websockets

@pytest.fixture
async def websocket():
    port = os.getenv('PORT', 8080)
    url = f'ws://localhost:{port}'
    async with websockets.connect(url) as connection:
        yield connection

# Returns the only open contextID.
# Throws an exception the context is not unique.
async def get_open_context_id(websocket):
    # Send "browsingContext.getTree" command.
    command = {"id": 9999, "method": "browsingContext.getTree", "params": {}}
    await send_JSON_command(websocket, command)
    # Get open context ID.
    resp = await read_JSON_message(websocket)
    assert resp['id'] == 9999
    [context] = resp['result']['contexts']
    contextID = context['context']
    return contextID

async def send_JSON_command(websocket, command):
    await websocket.send(json.dumps(command))

async def read_JSON_message(websocket):
    return json.loads(await websocket.recv())

# Open given URL in the given context.
async def goto_url(websocket, contextID, url):
    # Send "PROTO.browsingContext.navigate" command.
    command = {
        "id": 9998,
        "method": "PROTO.browsingContext.navigate",
        "params": {
            "url": url,
            "context": contextID}}
    await send_JSON_command(websocket, command)

    # Assert "DEBUG.Page.load" event emitted.
    resp = await read_JSON_message(websocket)
    assert resp["method"] == "DEBUG.Page.load"

    # Assert "PROTO.browsingContext.navigate" command done.
    resp = await read_JSON_message(websocket)
    assert resp["id"] == 9998
    return contextID

# Tests for "handle an incoming message" error handling, when the message
# can't be decoded as known command.
# https://w3c.github.io/webdriver-bidi/#handle-an-incoming-message

@pytest.mark.asyncio
async def test_binary(websocket):
    # session.status is used in this test, but any simple command without side
    # effects would work. It is first sent as text, which should work, and then
    # sent again as binary, which should get an error response instead.
    command = {"id": 1, "method": "session.status", "params": {}}

    text_msg = json.dumps(command)
    await websocket.send(text_msg)
    resp = await read_JSON_message(websocket)
    assert resp['id'] == 1

    binary_msg = 'text_msg'.encode('utf-8')
    await websocket.send(binary_msg)
    resp = await read_JSON_message(websocket)
    assert resp == {
        "error": "invalid argument",
        "message": "not supported type (binary)"}

@pytest.mark.asyncio
async def test_invalid_json(websocket):
    message = 'this is not json'
    await websocket.send(message)
    resp = await read_JSON_message(websocket)
    assert resp == {
        "error": "invalid argument",
        "message": "Cannot parse data as JSON"}

@pytest.mark.asyncio
async def test_empty_object(websocket):
    command = {}
    await send_JSON_command(websocket, command)
    resp = await read_JSON_message(websocket)
    assert resp == {
        "error": "invalid argument",
        "message": "Expected unsigned integer but got undefined"}

@pytest.mark.asyncio
async def test_session_status(websocket):
    command = {"id": 5, "method": "session.status", "params": {}}
    await send_JSON_command(websocket, command)
    resp = await read_JSON_message(websocket)
    assert resp == {"id": 5, "result": {"ready": True, "message": "ready"}}

@pytest.mark.asyncio
async def test_getTree_contextReturned(websocket):
    command = {"id": 8, "method": "browsingContext.getTree", "params": {}}
    await send_JSON_command(websocket, command)

    # Assert "browsingContext.getTree" command done.
    resp = await read_JSON_message(websocket)
    [context] = resp['result']['contexts']
    contextID = context['context']
    assert isinstance(contextID, str)
    assert len(contextID) > 1
    assert resp == {
        "id": 8,
        "result": {
            "contexts": [{
                    "context": contextID,
                    "parent": None,
                    "url": "about:blank",
                    "DEBUG.type": "page"}]}}

@pytest.mark.asyncio
async def test_createContext_eventContextCreatedEmittedAndContextCreated(websocket):
    # Send "PROTO.browsingContext.createContext" command.
    command = {
        "id": 9,
        "method": "PROTO.browsingContext.createContext",
        "params": {
            "url": "data:text/html,<h2>test</h2>"}}
    await send_JSON_command(websocket, command)

    # Assert "browsingContext.contextCreated" event emitted.
    resp = await read_JSON_message(websocket)
    contextID = resp['params']['context']
    assert resp == {
        "method": "browsingContext.contextCreated",
        "params": {
            "context":contextID,
            "parent": None,
            "url": "data:text/html,<h2>test</h2>",
            "DEBUG.type":"page"}}

    # Assert "PROTO.browsingContext.createContext" command done.
    resp = await read_JSON_message(websocket)
    assert resp == {
        "id": 9,
        "result": {
            "context": contextID,
            "parent": None,
            "url": "data:text/html,<h2>test</h2>",
            "DEBUG.type": "page"}}

@pytest.mark.asyncio
async def test_PageClose_browsingContextContextDestroyedEmitted(websocket):
    contextID = await get_open_context_id(websocket)

    # Send "DEBUG.Page.close" command.
    command = {"id": 12, "method": "DEBUG.Page.close", "params": {"context": contextID}}
    await send_JSON_command(websocket, command)

    # Assert "DEBUG.Page.close" command done.
    resp = await read_JSON_message(websocket)
    assert resp == {"id": 12, "result": {}}

    # Assert "browsingContext.contextCreated" event emitted.
    resp = await read_JSON_message(websocket)
    assert resp == {
        "method": "browsingContext.contextDestroyed",
        "params": {
            "context": contextID,
            "parent": None,
            "url": "about:blank",
            "DEBUG.type": "other"}}

@pytest.mark.asyncio
async def test_RunJs_jsEvaluated(websocket):
    contextID = await get_open_context_id(websocket)

    # Send "DEBUG.Page.runJS" command.
    command = {
        "id": 14,
        "method": "DEBUG.Page.runJS",
        "params": {
            "jsFunction": "'!!@@##, ' + window.location.href",
            "context": contextID}}
    await send_JSON_command(websocket, command)

    # Assert "DEBUG.Page.runJS" command done.
    resp = await read_JSON_message(websocket)
    assert resp == {"id": 14, "result": "\"!!@@##, about:blank\""}

@pytest.mark.asyncio
async def test_navigate_eventPageLoadEmittedAndNavigated(websocket):
    contextID = await get_open_context_id(websocket)

    # Send "PROTO.browsingContext.navigate" command.
    command = {
        "id": 15,
        "method": "PROTO.browsingContext.navigate",
        "params": {
            "url": "data:text/html,<h2>test</h2>",
            "waitUntil": ["load", "domcontentloaded", "networkidle0", "networkidle2"],
            "context": contextID}}
    await send_JSON_command(websocket, command)

    # Assert "DEBUG.Page.load" event emitted.
    resp = await read_JSON_message(websocket)
    assert resp == {
        "method": "DEBUG.Page.load",
        "params": {
            "context": contextID}}

    # Assert "PROTO.browsingContext.navigate" command done.
    resp = await read_JSON_message(websocket)
    assert resp == {"id": 15, "result": {}}

@pytest.mark.asyncio
async def test_navigateWithShortTimeout_timeoutOccuredAndEventPageLoadEmitted(websocket):
    contextID = await get_open_context_id(websocket)

    # Send "PROTO.browsingContext.navigate" command.
    command = {
        "id": 16,
        "method": "PROTO.browsingContext.navigate",
        "params": {
            "url": "data:text/html,<h2>test</h2>",
            "context": contextID,
            "waitUntil": ["load", "domcontentloaded", "networkidle0", "networkidle2"],
            "timeout":"1"}}

    await send_JSON_command(websocket, command)

    # Assert "PROTO.browsingContext.navigate" command done.
    resp = await read_JSON_message(websocket)
    assert resp == {
        "id":16,
        "error": "unknown error",
        "message": "Navigation timeout of 1 ms exceeded"}

    resp = await read_JSON_message(websocket)
    assert resp == {
        "method": "DEBUG.Page.load",
        "params": {
            "context": contextID}}

@pytest.mark.asyncio
async def test_waitForSelector_success(websocket):
    contextID = await get_open_context_id(websocket)
    await goto_url(websocket, contextID,
        "data:text/html,<h2>test</h2>")

    # Send "PROTO.browsingContext.waitForSelector" command.
    await send_JSON_command(websocket, {
        "id": 17,
        "method": "PROTO.browsingContext.waitForSelector",
        "params": {
            "selector": "body > h2",
            "context": contextID}})

    # Assert "PROTO.browsingContext.waitForSelector" command done.
    resp = await read_JSON_message(websocket)
    objectID = resp["result"]["objectId"]
    assert resp == {
        "id": 17,
        "result": {
            "type": "node",
            "objectId": objectID }}

@pytest.mark.asyncio
async def test_waitForSelector_success_slow(websocket):
# 1. Wait for element which is not on the page.
# 2. Assert element not found.
# 3. Add element to the page.
# 4. Wait for newly created element.
# 5. Assert element found.

    contextID = await get_open_context_id(websocket)

# 1. Wait for element which is not on the page.
    await send_JSON_command(websocket, {
        "id": 18,
        "method": "PROTO.browsingContext.waitForSelector",
        "params": {
            "selector": "body > h2",
            "timeout": 1000,
            "context": contextID}})

# 2. Assert element not found.
    resp = await read_JSON_message(websocket)
    assert resp == {"id":18,"error":"unknown error","message":"waiting for selector `body > h2` failed: timeout 1000ms exceeded"}

# 3. Add element to the page.
    command = {
        "id": 19,
        "method": "DEBUG.Page.runJS",
        "params": {
            "jsFunction": "document.documentElement.innerHTML='<h2 />'",
            "context": contextID}}
    await send_JSON_command(websocket, command)

    # Assert "DEBUG.Page.runJS" command done.
    resp = await read_JSON_message(websocket)
    assert resp == {"id":19,"result":"\"<h2 />\""}

# 4. Wait for newly created element.
    await send_JSON_command(websocket, {
        "id": 20,
        "method": "PROTO.browsingContext.waitForSelector",
        "params": {
            "selector": "body > h2",
            "timeout": 1000,
            "context": contextID}})

# 5. Assert element found.
    resp = await read_JSON_message(websocket)
    objectID = resp["result"]["objectId"]
    assert resp == {
        "id": 20,
        "result": {
            "type": "node",
            "objectId": objectID }}

@pytest.mark.asyncio
async def test_waitForHiddenSelector_success(websocket):
    contextID = await get_open_context_id(websocket)
    await goto_url(websocket, contextID,
        "data:text/html,<h2>test</h2>")

    # Send "PROTO.browsingContext.waitForSelector" command.
    await send_JSON_command(websocket, {
        "id": 21,
        "method": "PROTO.browsingContext.waitForSelector",
        "params": {
            "selector": "body > h3",
            "context": contextID,
            "hidden": True}})

    # Assert "PROTO.browsingContext.waitForSelector" command done.
    resp = await read_JSON_message(websocket)
    assert resp == {"id": 21, "result": {}}

@pytest.mark.asyncio
async def test_waitForSelectorWithMinimumTimeout_failedWithTimeout(websocket):
    contextID = await get_open_context_id(websocket)
    await goto_url(websocket, contextID,
        "data:text/html,<h2>test</h2>")

    # Send "PROTO.browsingContext.waitForSelector" command.
    await send_JSON_command(websocket, {
        "id": 22,
        "method": "PROTO.browsingContext.waitForSelector",
        "params": {
            "selector": "body > h2",
            "timeout": 1,
            "context": contextID}})

    # Assert "PROTO.browsingContext.waitForSelector" command done.
    resp = await read_JSON_message(websocket)
    assert resp == {
        "id": 22,
        "error": "unknown error",
        "message": "waiting for selector `body > h2` failed: timeout 1ms exceeded"}

@pytest.mark.asyncio
async def test_waitForSelectorWithMissingElement_failedWithTimeout_slow(websocket):
    contextID = await get_open_context_id(websocket)
    await goto_url(websocket, contextID,
        "data:text/html,<h2>test</h2>")

    # Send "PROTO.browsingContext.waitForSelector" command.
    await send_JSON_command(websocket, {
        "id": 23,
        "method": "PROTO.browsingContext.waitForSelector",
        "params": {
            "selector": "body > h3",
            "timeout": 1000,
            "context": contextID}})

    # Assert "PROTO.browsingContext.waitForSelector" command done.
    resp = await read_JSON_message(websocket)
    assert resp == {
        "id": 23,
        "error": "unknown error",
        "message": "waiting for selector `body > h3` failed: timeout 1000ms exceeded"}

@pytest.mark.asyncio
async def test_clickElement_clickProcessed(websocket):
# 1. Open page with button and click handler. Button click replaces button with `<h1 />`.
# 2. Assert `<h1 />` is not visible.
# 3. Get the button.
# 4. Click the button.
# TODO: assert the `PROTO.browsingContext.click` waited for the click happened.
# 5. Assert `<h1 />` is visible.

    contextID = await get_open_context_id(websocket)

# 1. Open page with button and click handler. Button click replaces button with `<h1 />`.
    await goto_url(websocket, contextID,
        "data:text/html,<button onclick=\"document.documentElement.innerHTML='<h1 />'\">button</button>")

# 2. Assert `<h1 />` is not visible.
    await send_JSON_command(websocket, {
        "id": 24,
        "method": "PROTO.browsingContext.selectElement",
        "params": {
            "selector": "body > h1",
            "context": contextID}})

    resp = await read_JSON_message(websocket)
    assert resp == {"id":24, "result": {}}

# 3. Get the button.
    # Send "PROTO.browsingContext.waitForSelector" command.
    await send_JSON_command(websocket, {
        "id": 25,
        "method": "PROTO.browsingContext.waitForSelector",
        "params": {
            "selector": "body > button",
            "context": contextID}})

    # Assert "PROTO.browsingContext.waitForSelector" command done.
    resp = await read_JSON_message(websocket)
    assert resp["id"] == 25
    objectID = resp["result"]["objectId"]

# 4. Click the button.
    # Send "PROTO.browsingContext.click" command.
    await send_JSON_command(websocket, {
        "id": 26,
        "method": "PROTO.browsingContext.click",
        "params": {
            "objectId": objectID,
            "context": contextID}})

    # Assert "PROTO.browsingContext.click" command done.
    resp = await read_JSON_message(websocket)
    assert resp ==  {"id": 26, "result": {}}

# 5. Assert `<h1 />` is visible.
    await send_JSON_command(websocket, {
        "id": 27,
        "method": "PROTO.browsingContext.selectElement",
        "params": {
            "selector": "body > h1",
            "context": contextID}})

    resp = await read_JSON_message(websocket)
    objectID = resp["result"]["objectId"]
    assert resp == {
        "id": 27,
        "result": {
            "type": "node",
            "objectId": objectID}}

@pytest.mark.asyncio
async def test_selectElement_success(websocket):
    contextID = await get_open_context_id(websocket)
    await goto_url(websocket, contextID,
        "data:text/html,<h2>test</h2>")

    # Send "PROTO.browsingContext.waitForSelector" command.
    await send_JSON_command(websocket, {
        "id": 28,
        "method": "PROTO.browsingContext.selectElement",
        "params": {
            "selector": "body > h2",
            "context": contextID}})

    # Assert "PROTO.browsingContext.waitForSelector" command done.
    resp = await read_JSON_message(websocket)
    objectID = resp["result"]["objectId"]
    assert resp == {
        "id": 28,
        "result": {
            "type": "node",
            "objectId": objectID }}

@pytest.mark.asyncio
async def test_selectElementMissingElement_missingElement(websocket):
    contextID = await get_open_context_id(websocket)
    await goto_url(websocket, contextID,
        "data:text/html,<h2>test</h2>")

    # Send "PROTO.browsingContext.waitForSelector" command.
    await send_JSON_command(websocket, {
        "id": 29,
        "method": "PROTO.browsingContext.selectElement",
        "params": {
            "selector": "body > h3",
            "context": contextID}})

    # Assert "PROTO.browsingContext.waitForSelector" command done.
    resp = await read_JSON_message(websocket)
    assert resp == {"id":29, "result": {}}
