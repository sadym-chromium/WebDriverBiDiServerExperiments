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
    assert resp['id'] == None
    assert resp['error'] == 'invalid argument'
    assert isinstance(resp['message'], str)

@pytest.mark.asyncio
async def test_invalid_json(websocket):
    message = 'this is not json'
    await websocket.send(message)
    resp = json.loads(await websocket.recv())
    assert resp['id'] == None
    assert resp['error'] == 'invalid argument'
    assert isinstance(resp['message'], str)

@pytest.mark.asyncio
async def test_empty_object(websocket):
    command = {}
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    assert resp['id'] == None
    assert resp['error'] == 'invalid argument'
    assert isinstance(resp['message'], str)

@pytest.mark.asyncio
async def test_session_status(websocket):
    command = {"id": 5, "method": "session.status", "params": {}}
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 5
    assert resp['value']['ready'] == True
    assert resp['value']['message'] == 'ready'
