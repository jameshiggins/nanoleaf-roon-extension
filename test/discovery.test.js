'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSsdpResponse } = require('../src/nanoleaf/discovery');

const NANOLEAF_RESPONSE = [
  'HTTP/1.1 200 OK',
  'CACHE-CONTROL: max-age=3600',
  'LOCATION: http://192.168.1.50:16021',
  'ST: nanoleaf:nl42',
  'USN: uuid:8e2b1f3a::nanoleaf:nl42',
  'NL-DEVICEID: AA:BB:CC',
  'NL-DEVICENAME: Living Room Shapes',
  '', '',
].join('\r\n');

test('parseSsdpResponse: extracts host, port, name from a Shapes reply', () => {
  const dev = parseSsdpResponse(NANOLEAF_RESPONSE);
  assert.deepEqual(dev, {
    host: '192.168.1.50',
    port: 16021,
    name: 'Living Room Shapes',
    st: 'nanoleaf:nl42',
  });
});

test('parseSsdpResponse: defaults the port when Location omits it', () => {
  const dev = parseSsdpResponse(NANOLEAF_RESPONSE.replace(':16021', ''));
  assert.equal(dev.port, 16021);
});

test('parseSsdpResponse: matches nanoleaf in USN even without ST', () => {
  const text = NANOLEAF_RESPONSE.replace('ST: nanoleaf:nl42\r\n', '');
  const dev = parseSsdpResponse(text);
  assert.ok(dev);
  assert.equal(dev.host, '192.168.1.50');
});

test('parseSsdpResponse: ignores non-Nanoleaf devices', () => {
  const sonos = NANOLEAF_RESPONSE.replaceAll('nanoleaf', 'sonos');
  assert.equal(parseSsdpResponse(sonos), null);
});

test('parseSsdpResponse: ignores replies with an unparseable Location', () => {
  const broken = NANOLEAF_RESPONSE.replace('http://192.168.1.50:16021', 'not a url');
  assert.equal(parseSsdpResponse(broken), null);
});
