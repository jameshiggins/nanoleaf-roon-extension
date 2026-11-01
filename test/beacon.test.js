'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { Beacon, parseProbe, buildReply, PROBE, REPLY, SERVICE } = require('../src/control/beacon');

test('parseProbe: accepts the probe with or without a nonce, rejects everything else', () => {
  assert.deepEqual(parseProbe(Buffer.from(PROBE)), { nonce: '' });
  assert.deepEqual(parseProbe(Buffer.from(`${PROBE} abc123\n`)), { nonce: 'abc123' });
  assert.equal(parseProbe(Buffer.from('M-SEARCH * HTTP/1.1')), null, 'SSDP chatter is ignored');
  assert.equal(parseProbe(Buffer.from('NANOLEAF-ROON {"service":"nanoleaf-roon"}')), null, 'our own reply is not a probe');
  assert.equal(parseProbe(Buffer.from(`${PROBE} ${'x'.repeat(500)}`)).nonce.length, 64, 'nonce is capped');
});

test('buildReply: prefixed JSON that echoes the nonce and carries the companion port', () => {
  const buf = buildReply({ port: 8787, name: 'LIVINGROOM', version: '0.2.0', nonce: 'n1' });
  const text = buf.toString('utf8');
  assert.ok(text.startsWith(REPLY));
  assert.deepEqual(JSON.parse(text.slice(REPLY.length)), {
    service: SERVICE, port: 8787, name: 'LIVINGROOM', version: '0.2.0', nonce: 'n1',
  });
  assert.equal('nonce' in JSON.parse(buildReply({ port: 1 }).toString().slice(REPLY.length)), false);
});

// Send one datagram to the beacon and resolve with the first reply (or null after `ms`).
function ask(port, payload, ms = 400) {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const timer = setTimeout(() => { client.close(); resolve(null); }, ms);
    client.on('message', (msg, rinfo) => {
      clearTimeout(timer);
      client.close();
      resolve({ text: msg.toString('utf8'), from: rinfo.address });
    });
    client.send(Buffer.from(payload), port, '127.0.0.1');
  });
}

test('Beacon: answers a probe over UDP with the service port, ignores noise', async () => {
  const beacon = new Beacon({ port: 0, servicePort: 8787, name: 'test-host', version: '9.9.9' });
  const port = await beacon.start();
  try {
    assert.ok(port > 0);
    const reply = await ask(port, `${PROBE} deadbeef`);
    assert.ok(reply, 'beacon replied');
    assert.equal(reply.from, '127.0.0.1', 'reply comes from the host the app should load');
    assert.ok(reply.text.startsWith(REPLY));
    const body = JSON.parse(reply.text.slice(REPLY.length));
    assert.equal(body.service, SERVICE);
    assert.equal(body.port, 8787);
    assert.equal(body.nonce, 'deadbeef');
    assert.equal(body.name, 'test-host');
    assert.equal(await ask(port, 'hello?', 250), null, 'non-probe datagrams get no reply');
    assert.equal(beacon.replies, 1);
  } finally {
    beacon.stop();
  }
});

test('Beacon: stop() releases the port so a restart can rebind it', async () => {
  const first = new Beacon({ port: 0, servicePort: 8787 });
  const port = await first.start();
  first.stop();
  const second = new Beacon({ port, servicePort: 8787 });
  const again = await second.start();
  second.stop();
  assert.equal(again, port);
});
