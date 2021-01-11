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

# Returns the only open contextID. Throws exception if it is not unique.
async def get_open_context_id(websocket):
    # Send "browsingContext.getTree" command.
    command = {"id": 9999, "method": "browsingContext.getTree", "params": {}}
    await websocket.send(json.dumps(command))
    # Get open context ID.
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 9999
    [context] = resp['result']['contexts']
    contextID = context['context']
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
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 1

    binary_msg = 'text_msg'.encode('utf-8')
    await websocket.send(binary_msg)
    resp = json.loads(await websocket.recv())
    assert resp == {
        "error": "invalid argument",
        "message": "not supported type (binary)"}

@pytest.mark.asyncio
async def test_invalid_json(websocket):
    message = 'this is not json'
    await websocket.send(message)
    resp = json.loads(await websocket.recv())
    assert resp == {
        "error": "invalid argument",
        "message": "Cannot parse data as JSON"}

@pytest.mark.asyncio
async def test_empty_object(websocket):
    command = {}
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    assert resp == {
        "error": "invalid argument",
        "message": "Expected unsigned integer but got undefined"}

@pytest.mark.asyncio
async def test_session_status(websocket):
    command = {"id": 5, "method": "session.status", "params": {}}
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    assert resp == {"id": 5, "result": {"ready": True, "message": "ready"}}

@pytest.mark.asyncio
async def test_getTree_contextReturned(websocket):
    command = {"id": 8, "method": "browsingContext.getTree", "params": {}}
    await websocket.send(json.dumps(command))

    # Assert "browsingContext.getTree" command done.
    resp = json.loads(await websocket.recv())
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
        "id": 9, "method": "PROTO.browsingContext.createContext",
        "params": {"url": "http://example.com/"}}
    await websocket.send(json.dumps(command))

    # Assert "browsingContext.contextCreated" event emitted.
    resp = json.loads(await websocket.recv())
    contextID = resp['params']['context']
    assert resp == {
        "method": "browsingContext.contextCreated",
        "params": {
            "context":contextID,
            "parent": None,
            "url":"http://example.com/",
            "DEBUG.type":"page"}}

    # Assert "PROTO.browsingContext.createContext" command done.
    resp = json.loads(await websocket.recv())
    assert resp == {
        "id": 9,
        "result": {
            "context": contextID,
            "parent": None,
            "url": "http://example.com/",
            "DEBUG.type": "page"}}

@pytest.mark.asyncio
async def test_PageClose_browsingContextContextDestroyedEmitted(websocket):
    contextID = await get_open_context_id(websocket)

    # Send "DEBUG.Page.close" command.
    command = {"id": 12, "method": "DEBUG.Page.close", "params": {"context": contextID}}
    await websocket.send(json.dumps(command))

    # Assert "DEBUG.Page.close" command done.
    resp = json.loads(await websocket.recv())
    assert resp == {"id": 12, "result": {}}

    # Assert "browsingContext.contextCreated" event emitted.
    resp = json.loads(await websocket.recv())
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

    # Send "DEBUG.Page.navigate" command.
    command = {
        "id": 14,
        "method": "DEBUG.Page.runJS",
        "params": {
            "jsFunction": "'!!@@##, ' + window.location.href",
            "context": contextID}}
    await websocket.send(json.dumps(command))

    # Assert "DEBUG.Page.navigate" command done.
    resp = json.loads(await websocket.recv())
    assert resp == {"id": 14, "result": "\"!!@@##, about:blank\""}

@pytest.mark.asyncio
async def test_navigate_eventPageLoadEmittedAndNavigated(websocket):
    contextID = await get_open_context_id(websocket)

    # Send "PROTO.browsingContext.navigate" command.
    command = {
        "id": 15,
        "method": "PROTO.browsingContext.navigate",
        "params": {
            "url": "http://example.com",
            "waitUntil": ["load", "domcontentloaded", "networkidle0", "networkidle2"],
            "context": contextID}}
    await websocket.send(json.dumps(command))

    # Assert "DEBUG.Page.load" event emitted.
    resp = json.loads(await websocket.recv())
    assert resp == {
        "method": "DEBUG.Page.load",
        "params": {
            "context": contextID}}

    # Assert "DEBUG.Page.navigate" command done.
    resp = json.loads(await websocket.recv())
    assert resp == {"id": 15, "result": {}}

@pytest.mark.asyncio
async def test_navigateWithShortTimeout_timeoutOccuredAndEventPageLoadEmitted(websocket):
    contextID = await get_open_context_id(websocket)

    # Send "PROTO.browsingContext.navigate" command.
    command = {
        "id": 16,
        "method": "PROTO.browsingContext.navigate",
        "params": {
            "url": "http://example.com",
            "context": contextID,
            "waitUntil": ["load", "domcontentloaded", "networkidle0", "networkidle2"],
            "timeout":"1"}}

    await websocket.send(json.dumps(command))

    # Assert "DEBUG.Page.navigate" command done.
    resp = json.loads(await websocket.recv())
    assert resp == {
        "id":16,
        "error": "unknown error",
        "message": "Navigation timeout of 1 ms exceeded"}

    resp = json.loads(await websocket.recv())
    assert resp == {
        "method": "DEBUG.Page.load",
        "params": {
            "context": contextID}}
