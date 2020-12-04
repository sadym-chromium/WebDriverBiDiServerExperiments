import asyncio
import json
import os
import pytest
import websockets

@pytest.fixture
async def server():
    port = os.getenv('PORT')
    if port:
        url = f'ws://localhost:{port}'
        print(f'Using existing server ({url})')
        yield url
        # no tearndown, server will keep running
        return

    port = 8080 # must match server.js default

    proc = await asyncio.create_subprocess_shell(
        'npm run bidi-server',
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE)

    while True:
        if proc.returncode != None:
            raise Exception(f'Fixture server failed to start, port {port} already in use?')
        line = await proc.stdout.readline()
        if b'Server is listening' in line:
            break

    url = f'ws://localhost:{port}'
    print(f'Started fixture server ({url})')
    yield url

    proc.terminate()
    stdout, stderr = await proc.communicate()
    # TODO: somehow show the logs on failure:
    #print(proc.returncode)
    #print(stdout)
    #print(stderr)

@pytest.fixture
async def websocket(server):
    async with websockets.connect(server) as websocket:
        yield websocket

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

@pytest.mark.asyncio
async def test_session_status(websocket):
    command = {"id": 5, "method": "session.status", "params": {}}
    await websocket.send(json.dumps(command))
    resp = json.loads(await websocket.recv())
    assert resp['id'] == 5
    assert resp['value']['ready'] == True
    assert resp['value']['message'] == 'ready'
