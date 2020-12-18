# WebDriver BiDi for Chromium Prototype

This is an experimental prototype of the [WebDriver BiDi](https://w3c.github.io/webdriver-bidi/) protocol for Chromium, implemented as a JavaScript layer translating between BiDi and CDP. It is based on (forked from) [Puppeteer](https://github.com/puppeteer/puppeteer) for use of its CDP abstractions, but isn't intended for use as a JavaScript client library.

## Starting the Server

    npm install
    npm run bidi-server

This will run the server on port 8080. Use the `PORT` environment variable to
run it on another port:

    PORT=8081 npm run bidi-server

## Running the Tests

The tests are written using Python, in order to learn how to eventually do this
in web-platform-tests. Python 3.6+ and some dependencies are required:

    python3 -m pip install --user -r bidiClient/requirements.txt

Running:

    python3 -m pytest --rootdir=bidiClient

This will run the tests against an already running server on port
8080. Use the `PORT` environment variable to connect to another port:

    PORT=8081 python3 -m pytest --rootdir=bidiClient
