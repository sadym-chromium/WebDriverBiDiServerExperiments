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

@pytest.mark.skip(reason="requires a working command to test")
@pytest.mark.asyncio
async def test_binary(websocket):
    # Send something which would be valid JSON and trigger
    # an error if it were understood.
    await websocket.send(b'{}')
    # There should be no response at all to this binary message.
    # Ensure this by sending another message
    resp = await websocket.recv()
    assert resp == None

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
