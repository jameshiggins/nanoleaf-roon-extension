'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { NanoleafClient, NanoleafHttpError } = require('../src/nanoleaf/client');

/** In-process mock of the Nanoleaf REST surface. */
function mockDevice(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        requests.push({ method: req.method, url: req.url, body });
        handler(req, res, body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, port: server.address().port });
    });
  });
}

test('createToken: POSTs /api/v1/new and stores the token', async () => {
  const { server, requests, port } = await mockDevice((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ auth_token: 'tok123' }));
  });
  try {
    const client = new NanoleafClient({ host: '127.0.0.1', port });
    const token = await client.createToken();
    assert.equal(token, 'tok123');
    assert.equal(client.token, 'tok123');
    assert.deepEqual(requests[0], { method: 'POST', url: '/api/v1/new', body: null });
  } finally {
    server.close();
  }
});

test('createToken: 403 (not in pairing mode) raises NanoleafHttpError', async () => {
  const { server, port } = await mockDevice((req, res) => {
    res.writeHead(403);
    res.end();
  });
  try {
    const client = new NanoleafClient({ host: '127.0.0.1', port });
    await assert.rejects(() => client.createToken(), (err) => {
      assert.ok(err instanceof NanoleafHttpError);
      assert.equal(err.status, 403);
      return true;
    });
  } finally {
    server.close();
  }
});

test('getLayout: token in path, layout parsed', async () => {
  const layout = { numPanels: 2, positionData: [{ panelId: 101, x: 0, y: 0 }, { panelId: 102, x: 100, y: 0 }] };
  const { server, requests, port } = await mockDevice((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(layout));
  });
  try {
    const client = new NanoleafClient({ host: '127.0.0.1', port, token: 'sekret' });
    assert.deepEqual(await client.getLayout(), layout);
    assert.equal(requests[0].url, '/api/v1/sekret/panelLayout/layout');
  } finally {
    server.close();
  }
});

test('enableExtControl: sends the v2 display command', async () => {
  const { server, requests, port } = await mockDevice((req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    const client = new NanoleafClient({ host: '127.0.0.1', port, token: 't' });
    await client.enableExtControl();
    assert.equal(requests[0].method, 'PUT');
    assert.equal(requests[0].url, '/api/v1/t/effects');
    assert.deepEqual(requests[0].body, {
      write: { command: 'display', animType: 'extControl', extControlVersion: 'v2' },
    });
  } finally {
    server.close();
  }
});

test('authed calls without a token fail fast with guidance', async () => {
  const client = new NanoleafClient({ host: '127.0.0.1' });
  await assert.rejects(() => client.getLayout(), /npm run pair/);
});

test('401 propagates status for the re-pair flow', async () => {
  const { server, port } = await mockDevice((req, res) => {
    res.writeHead(401);
    res.end();
  });
  try {
    const client = new NanoleafClient({ host: '127.0.0.1', port, token: 'stale' });
    await assert.rejects(() => client.getInfo(), (err) => err.status === 401);
  } finally {
    server.close();
  }
});

test('setPower: PUT state on/off body', async () => {
  const { server, requests, port } = await mockDevice((req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    const client = new NanoleafClient({ host: '127.0.0.1', port, token: 't' });
    await client.setPower(false);
    assert.deepEqual(requests[0], { method: 'PUT', url: '/api/v1/t/state', body: { on: { value: false } } });
  } finally {
    server.close();
  }
});
