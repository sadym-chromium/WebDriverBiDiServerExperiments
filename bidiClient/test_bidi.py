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
    assert resp['error'] == 'invalid argument'
    assert resp['message'] == 'not supported type (binary)'
    assert isinstance(resp['message'], str)

@pytest.mark.asyncio
async def test_invalid_json(websocket):
    message = 'this is not json'
    await websocket.send(message)
    resp = json.loads(await websocket.recv())
    assert resp['error'] == 'invalid argument'
    assert isinstance(resp['message'], str)

@pytest.mark.asyncio
async def test_empty_object(websocket):
    command = {}
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    assert resp['error'] == 'invalid argument'
    assert isinstance(resp['message'], str)

@pytest.mark.asyncio
async def test_session_status(websocket):
    command = {"id": 5, "method": "session.status", "params": {}}
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 5
    assert resp['result']['ready'] == True
    assert resp['result']['message'] == 'ready'

@pytest.mark.asyncio
async def test_newPage_browsingContextContextCreatedRaised_pageNavigate_pageLoadRaised(websocket):
    # Send "DEBUG.Browser.newPage" command.
    command = {"id": 6, "method": "DEBUG.Browser.newPage", "params": {}}
    await websocket.send(json.dumps(command))

    # Receive "browsingContext.contextCreated" event raised.
    resp = json.loads(await websocket.recv())
    assert resp['method'] == 'browsingContext.contextCreated'

    # Assert "DEBUG.Browser.newPage" command done.
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 6
    pageID = resp['result']['pageID']

    # Send "DEBUG.Page.navigate" command.
    command = {"id": 7, "method": "DEBUG.Page.navigate", "params": {"url": "http://example.com", "pageID": pageID}}
    await websocket.send(json.dumps(command))

    # Assert "DEBUG.Page.load" event raised.
    resp = json.loads(await websocket.recv())
    assert resp['method'] == 'DEBUG.Page.load'
    assert resp['params']['pageID'] == pageID

    # Assert "DEBUG.Page.navigate" command done.
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 7

@pytest.mark.asyncio
async def test_getTree_pageNavigated(websocket):
    command = {"id": 8, "method": "browsingContext.getTree", "params": {}}
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 8
    assert len(resp['result']['contexts']) == 1
    context = resp['result']['contexts'][0]
    contextID = context['context']

    # Send "DEBUG.Page.navigate" command.
    command = {"id": 9, "method": "DEBUG.Page.navigate", "params": {"url": "http://example.com", "pageID": contextID}}
    await websocket.send(json.dumps(command))

    # Assert "DEBUG.Page.navigate" command done.
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 9
    assert resp['result'] == {}

@pytest.mark.asyncio
async def test_newPage_browsingContextContextCreatedRaised(websocket):
    # Send "DEBUG.Browser.newPage" command.
    command = {"id": 10, "method": "DEBUG.Browser.newPage", "params": {}}
    await websocket.send(json.dumps(command))

    # Assert "browsingContext.contextCreated" event raised.
    resp = json.loads(await websocket.recv())
    assert resp['method'] == 'browsingContext.contextCreated'
    pageID = resp['params']['context']

    # Assert "DEBUG.Browser.newPage" command done.
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 10
    assert resp['result']['pageID'] == pageID

@pytest.mark.asyncio
async def test_PageClose_browsingContextContextDestroyedRaised(websocket):
    # Get open context ID.
    command = {"id": 11, "method": "browsingContext.getTree", "params": {}}
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 11
    contextID = resp['result']['contexts'][0]['context']

    # Send "DEBUG.Page.close" command.
    command = {"id": 12, "method": "DEBUG.Page.close", "params": {"pageID": contextID}}
    await websocket.send(json.dumps(command))

    # Assert "DEBUG.Page.close" command done.
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 12

    # Assert "browsingContext.contextCreated" event raised.
    resp = json.loads(await websocket.recv())
    assert resp['method'] == 'browsingContext.contextDestroyed'
    assert resp['params']['context'] == contextID
    assert resp['params']['parent'] == None
    assert resp['params']['url'] == "about:blank"
