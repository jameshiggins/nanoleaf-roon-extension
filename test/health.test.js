'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startHeartbeat } = require('../src/health');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (tag) => path.join(os.tmpdir(), `hb-${tag}-${process.pid}-${Math.trunc(performance.now())}.txt`);

test('heartbeat writes immediately and advances on the interval', async () => {
  const file = tmp('adv');
  let clock = 1000;
  const stop = startHeartbeat({ file, intervalMs: 15, now: () => clock });
  try {
    assert.ok(fs.existsSync(file), 'heartbeat file exists right after start');
    assert.equal(fs.readFileSync(file, 'utf8'), '1000', 'first beat is immediate');
    clock = 2000;
    await sleep(60); // several intervals
    assert.equal(fs.readFileSync(file, 'utf8'), '2000', 'heartbeat keeps advancing');
  } finally {
    stop();
    fs.rmSync(file, { force: true });
  }
});

test('heartbeat stops advancing after stop() — a frozen loop looks stale', async () => {
  const file = tmp('stop');
  let clock = 5000;
  const stop = startHeartbeat({ file, intervalMs: 15, now: () => clock });
  stop();
  clock = 9000;
  await sleep(60);
  assert.equal(fs.readFileSync(file, 'utf8'), '5000', 'no writes after stop');
  fs.rmSync(file, { force: true });
});
