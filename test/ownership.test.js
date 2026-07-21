'use strict';

/**
 * Panel ownership: the renderer takes the panels only while Roon is playing and
 * hands them back exactly as it found them. Regression cover for the pre-ownership
 * behavior where the panels were held always-on and never restored on stop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VisualRenderer } = require('../src/visuals/renderer');

const LAYOUT = [
  { id: 1, nx: 0, ny: 0 },
  { id: 2, nx: 1, ny: 1 },
];

const BASE_CFG = {
  include: [], exclude: [], palettes: 12, rotate: 'track', minSeconds: 8,
  gain: 1, attackMs: 5, releaseMs: 180, silenceFloor: 0.02,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Records every controller call so tests can assert on order, not just occurrence. */
function fakeClient({ effect = 'Vintage Modern', power = false } = {}) {
  return {
    calls: [],
    async getSelectedEffect() { this.calls.push('getSelectedEffect'); return effect; },
    async getPower() { this.calls.push('getPower'); return power; },
    async setPower(on) { this.calls.push(`setPower(${on})`); },
    async enableExtControl() { this.calls.push('enableExtControl'); },
    async selectEffect(name) { this.calls.push(`selectEffect(${name})`); },
  };
}

function make({ client, cfg = {}, releaseDebounceMs = 5, extControlKeepaliveMs = 100000 } = {}) {
  const source = new EventEmitter();
  const streamer = { frames: [], blackouts: [], paused: 0, sendFrame(f) { this.frames.push(f); }, blackout(ids) { this.blackouts.push(ids); }, pause() { this.paused++; } };
  const renderer = new VisualRenderer({
    source, streamer, client,
    layout: LAYOUT,
    config: { ...BASE_CFG, ...cfg },
    fps: 30,
    releaseDebounceMs,
    extControlKeepaliveMs, // large by default so it doesn't perturb other tests
    rng: () => 0.42,
  });
  return { renderer, streamer, client };
}

test('start() alone does not touch the panels — no frames until acquire', () => {
  const client = fakeClient();
  const { renderer, streamer } = make({ client });
  renderer.start();
  assert.equal(renderer.acquired, false, 'not acquired just by starting');
  assert.equal(streamer.frames.length, 0, 'no frames streamed while released');
  assert.deepEqual(client.calls, [], 'controller untouched while released');
  renderer.stop();
});

test('acquire saves the current effect and power, powers on, enters extControl', async () => {
  const client = fakeClient({ effect: 'Vintage Modern', power: false });
  const { renderer } = make({ client });
  renderer.start();
  await renderer.acquire();

  assert.equal(renderer.acquired, true);
  assert.equal(renderer.savedEffect, 'Vintage Modern');
  assert.equal(renderer.savedPower, false);
  assert.ok(client.calls.includes('setPower(true)'), 'panels powered on');
  assert.ok(client.calls.includes('enableExtControl'), 'entered streaming mode');
  renderer.stop();
});

test('release is debounced, then restores the saved effect', async () => {
  const client = fakeClient({ effect: 'Vintage Modern', power: true });
  const { renderer } = make({ client, releaseDebounceMs: 20 });
  renderer.start();
  await renderer.acquire();

  renderer.release();
  assert.equal(renderer.acquired, true, 'still owns the panels during the debounce');

  await sleep(60);
  assert.equal(renderer.acquired, false, 'released after the debounce');
  assert.ok(client.calls.includes('selectEffect(Vintage Modern)'), 'restored the effect');
  renderer.stop();
});

test('panels that were OFF before are powered back off after restore', async () => {
  const client = fakeClient({ effect: 'Vintage Modern', power: false });
  const { renderer } = make({ client });
  renderer.start();
  await renderer.acquire();
  await renderer.releaseNow();

  const select = client.calls.indexOf('selectEffect(Vintage Modern)');
  const off = client.calls.indexOf('setPower(false)');
  assert.ok(select !== -1, 'effect restored');
  assert.ok(off !== -1, 'powered back off');
  assert.ok(select < off, 'select must come first — selecting an effect powers panels on');
});

test('panels that were ON before stay on after restore', async () => {
  const client = fakeClient({ effect: 'Northern Lights', power: true });
  const { renderer } = make({ client });
  renderer.start();
  await renderer.acquire();
  await renderer.releaseNow();

  assert.ok(client.calls.includes('selectEffect(Northern Lights)'));
  assert.ok(!client.calls.includes('setPower(false)'), 'must not power off panels that were on');
});

test('resuming within the debounce window cancels the pending release', async () => {
  const client = fakeClient({ effect: 'Vintage Modern', power: true });
  const { renderer } = make({ client, releaseDebounceMs: 40 });
  renderer.start();
  await renderer.acquire();

  renderer.release();
  await renderer.acquire(); // Roon resumed
  await sleep(80);

  assert.equal(renderer.acquired, true, 'still streaming — release was cancelled');
  assert.ok(!client.calls.includes('selectEffect(Vintage Modern)'), 'never restored');
  renderer.stop();
});

test('stops streaming frames once released', async () => {
  const client = fakeClient();
  const { renderer, streamer } = make({ client });
  renderer.start();
  await renderer.acquire();
  renderer.renderFrame();
  assert.ok(streamer.frames.length > 0, 'frames flow while acquired');

  await renderer.releaseNow();
  assert.equal(renderer.renderTimer, null, 'render timer stopped');
});

test('panels already in *Dynamic* leave nothing to restore', async () => {
  const client = fakeClient({ effect: '*Dynamic*', power: true });
  const { renderer } = make({ client });
  renderer.start();
  await renderer.acquire();
  assert.equal(renderer.savedEffect, null, '*Dynamic* is not a restorable effect');

  await renderer.releaseNow();
  assert.ok(!client.calls.some((c) => c.startsWith('selectEffect')), 'nothing restored');
});

test('acquire is idempotent — a second playing event does not re-enter extControl', async () => {
  const client = fakeClient({ effect: 'Vintage Modern', power: false });
  const { renderer } = make({ client });
  renderer.start();
  await renderer.acquire();
  await renderer.acquire();

  assert.equal(renderer.savedEffect, 'Vintage Modern', 'saved effect survives re-acquire');
  assert.equal(client.calls.filter((c) => c === 'enableExtControl').length, 1, 'acquired once');
  renderer.stop();
});

test('re-asserts extControl on an interval while acquired (reclaims the panels)', async () => {
  const client = fakeClient({ effect: 'Vintage Modern', power: true });
  const { renderer } = make({ client, extControlKeepaliveMs: 15 });
  renderer.start();
  await renderer.acquire();
  const afterAcquire = client.calls.filter((c) => c === 'enableExtControl').length;
  assert.equal(afterAcquire, 1, 'acquire enters extControl once');

  await sleep(70); // several keepalive intervals
  const afterKeepalive = client.calls.filter((c) => c === 'enableExtControl').length;
  assert.ok(afterKeepalive >= 3, `extControl re-asserted repeatedly, got ${afterKeepalive}`);
  renderer.stop();
});

test('keepalive stops re-asserting extControl once released', async () => {
  const client = fakeClient({ effect: 'Vintage Modern', power: true });
  const { renderer } = make({ client, extControlKeepaliveMs: 15 });
  renderer.start();
  await renderer.acquire();
  await renderer.releaseNow();
  const atRelease = client.calls.filter((c) => c === 'enableExtControl').length;

  await sleep(70);
  const later = client.calls.filter((c) => c === 'enableExtControl').length;
  assert.equal(later, atRelease, 'no extControl re-asserts after release');
});

test('idle arriving mid-acquire is NOT lost (reconcile releases after acquire finishes)', async () => {
  // The race the reconcile model fixes: release() used to no-op because `acquired` was
  // still false during acquire's awaited REST calls, leaving the panels held forever.
  const client = fakeClient({ effect: 'Vintage Modern', power: true });
  let openGate;
  const gate = new Promise((r) => { openGate = r; });
  const orig = client.enableExtControl.bind(client);
  client.enableExtControl = async () => { await gate; return orig(); };

  const { renderer } = make({ client, releaseDebounceMs: 10 });
  renderer.start();
  const acq = renderer.acquire();   // blocks inside enableExtControl
  await sleep(5);
  renderer.release();               // idle mid-acquire — must be honored, not dropped
  openGate();
  await acq;
  await sleep(40);                  // debounce + release
  assert.equal(renderer.acquired, false, 'released after the in-flight acquire completed');
  assert.ok(client.calls.includes('selectEffect(Vintage Modern)'), 'restored the saved scene');
  renderer.stop();
});

test('releaseNow during an in-flight acquire restores before it resolves (shutdown race)', async () => {
  const client = fakeClient({ effect: 'Vintage Modern', power: true });
  let openGate;
  const gate = new Promise((r) => { openGate = r; });
  const orig = client.enableExtControl.bind(client);
  client.enableExtControl = async () => { await gate; return orig(); };

  const { renderer } = make({ client });
  renderer.start();
  const acq = renderer.acquire();
  await sleep(5);
  const rel = renderer.releaseNow(); // shutdown fires before acquire finished
  openGate();
  await rel;                         // must resolve only AFTER the restore completed
  assert.equal(renderer.acquired, false);
  assert.ok(client.calls.includes('selectEffect(Vintage Modern)'), 'panels restored before releaseNow resolved');
  await acq;
});

test('release pauses the streamer keepalive so panels are not left frozen', async () => {
  const client = fakeClient({ effect: 'Vintage Modern', power: true });
  const { renderer, streamer } = make({ client });
  renderer.start();
  await renderer.acquire();
  await renderer.releaseNow();
  assert.ok(streamer.paused >= 1, 'streamer.pause() called on release');
});

test('a failing controller still starts streaming rather than dying', async () => {
  const client = fakeClient();
  client.getSelectedEffect = async () => { throw new Error('controller offline'); };
  const { renderer } = make({ client });
  renderer.start();
  await renderer.acquire();
  assert.equal(renderer.acquired, true, 'acquire survives an API failure');
  renderer.stop();
});
