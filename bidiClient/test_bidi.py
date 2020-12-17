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
    # Session.status is used in this test, but any simple command without side
    # effects would work. It is first sent as text, which should work, and then
    # sent again as binary, which should get an error response instead.
    command = {"id": 1, "method": "Session.status", "params": {}}

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
    command = {"id": 5, "method": "Session.status", "params": {}}
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 5
    assert resp['value']['ready'] == True
    assert resp['value']['message'] == 'ready'

@pytest.mark.asyncio
async def test_newPage_pageNavigate_pageLoadRaised(websocket):
    command = {"id": 6, "method": "Browser.newPage", "params": {}}
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 6
    pageID = resp['value']['pageID']

    # send "Page.navigate" command
    command = {"id": 7, "method": "Page.navigate", "params": {"url": "http://example.com", "pageID": pageID}}
    await websocket.send(json.dumps(command))

    # assert "Page.load" event
    resp = json.loads(await websocket.recv())
    assert resp['method'] == 'Page.load'
    assert resp['params']['pageID'] == pageID

    # assert "Page.navigate" command done
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 7
