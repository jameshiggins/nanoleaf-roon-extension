'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isTransientNetworkError } = require('../src/roon/neterr');

function nodeErr(syscall, code, withSyscall = true) {
  const e = new Error(`${syscall} ${code}`);
  e.code = code;
  if (withSyscall) e.syscall = syscall;
  return e;
}

test('the real one: addMembership EADDRNOTAVAIL from a dgram callback', () => {
  assert.equal(isTransientNetworkError(nodeErr('addMembership', 'EADDRNOTAVAIL')), true);
});

test('bind / setBroadcast / send with a network-down code are transient too', () => {
  for (const sc of ['bind', 'setBroadcast', 'send']) {
    for (const code of ['ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH']) {
      assert.equal(isTransientNetworkError(nodeErr(sc, code)), true, `${sc} ${code}`);
    }
  }
});

test('falls back to parsing the message when .syscall is absent', () => {
  assert.equal(isTransientNetworkError(nodeErr('addMembership', 'EADDRNOTAVAIL', false)), true);
});

test('programming errors and non-socket failures still crash the service', () => {
  assert.equal(isTransientNetworkError(new TypeError('x is not a function')), false);
  assert.equal(isTransientNetworkError(nodeErr('open', 'ENOENT')), false);
  assert.equal(isTransientNetworkError(nodeErr('connect', 'ECONNREFUSED')), false);
  const wrongSyscall = nodeErr('open', 'EADDRNOTAVAIL');
  assert.equal(isTransientNetworkError(wrongSyscall), false);
  assert.equal(isTransientNetworkError(null), false);
  assert.equal(isTransientNetworkError('EADDRNOTAVAIL'), false);
});
