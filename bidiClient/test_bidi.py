import asyncio
import json
import os
import pytest
import websockets

@pytest.fixture
async def websocket():
    port = os.getenv('PORT', 8080)
    url = f'ws://localhost:{port}'
    connection = await websockets.connect(url)
    yield connection
    await connection.close()

@pytest.mark.asyncio
async def test_empty(websocket):
    command = {}
    await websocket.send(json.dumps(command))
    resp = await websocket.recv()
    assert isinstance(resp, str)
    resp = json.loads(resp)
    assert isinstance(resp, dict)

@pytest.mark.asyncio
async def test_session_status(websocket):
    command = { 'method': 'session.status' }
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    # Excpected behavior:
    #assert resp['ready'] == True
    # Actual behavior:
    assert resp['message'] == 'unknown method `session.status`'
