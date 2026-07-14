'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SceneRotator } = require('../src/scenes/rotator');
const { NanoleafHttpError } = require('../src/nanoleaf/client');

function fakeClient(effects) {
  return {
    effects: [...effects],
    calls: [],
    async getEffectsList() {
      this.calls.push(['list']);
      return this.effects.map((e) => e.animName);
    },
    async getAllEffects() {
      this.calls.push(['all']);
      return this.effects;
    },
    async selectEffect(name) {
      this.calls.push(['select', name]);
      if (!this.effects.some((e) => e.animName === name)) {
        throw new NanoleafHttpError(404, 'PUT', '/effects');
      }
    },
    async setPower(on) {
      this.calls.push(['power', on]);
    },
  };
}

const MUSIC = [
  { animName: 'Sound Bar', animType: 'plugin', pluginType: 'rhythm' },
  { animName: 'Ripple', animType: 'plugin', pluginType: 'rhythm' },
  { animName: 'Beatdrop', animType: 'rhythm' }, // legacy style
];
const STATIC = [{ animName: 'Snowfall', animType: 'plugin', pluginType: 'color' }];

const CFG = { include: [], exclude: [], musicOnly: true, onStop: 'keep', minSeconds: 0 };

function makeRotator(client, cfgOverrides = {}, opts = {}) {
  const watcher = new EventEmitter();
  const statuses = [];
  const rotator = new SceneRotator({
    client,
    watcher,
    config: { ...CFG, ...cfgOverrides },
    onStatus: (m, e) => statuses.push([m, !!e]),
    ...opts,
  });
  return { rotator, watcher, statuses };
}

function settle(rotator) {
  return rotator._chain;
}

test('start: discovers only music effects when musicOnly', async () => {
  const client = fakeClient([...MUSIC, ...STATIC]);
  const { rotator } = makeRotator(client);
  await rotator.start();
  assert.deepEqual([...rotator.picker.scenes].sort(), ['Beatdrop', 'Ripple', 'Sound Bar']);
});

test('start: explicit include list skips music filtering', async () => {
  const client = fakeClient([...MUSIC, ...STATIC]);
  const { rotator } = makeRotator(client, { include: ['snowfall', 'Ripple'] });
  await rotator.start();
  assert.deepEqual([...rotator.picker.scenes].sort(), ['Ripple', 'Snowfall']);
});

test('start: no music scenes → actionable error', async () => {
  const client = fakeClient(STATIC);
  const { rotator } = makeRotator(client);
  await assert.rejects(() => rotator.start(), /no music scenes installed.*--list-scenes/s);
});

test('track events rotate scenes without immediate repeats', async () => {
  const client = fakeClient(MUSIC);
  const { rotator, watcher } = makeRotator(client);
  await rotator.start();
  for (let i = 0; i < 6; i++) watcher.emit('track', { title: `T${i}`, artist: 'A' });
  await settle(rotator);
  const selects = client.calls.filter(([op]) => op === 'select').map(([, n]) => n);
  assert.equal(selects.length, 6);
  for (let i = 1; i < selects.length; i++) {
    assert.notEqual(selects[i], selects[i - 1], 'no back-to-back repeats');
  }
});

test('minSeconds rate-limits rapid track skipping', async () => {
  const client = fakeClient(MUSIC);
  let clock = 1000_000;
  const { rotator, watcher } = makeRotator(client, { minSeconds: 8 }, { now: () => clock });
  await rotator.start();
  watcher.emit('track', { title: 'T1' });
  await settle(rotator);
  clock += 3000; // 3 s later — inside the window
  watcher.emit('track', { title: 'T2' });
  await settle(rotator);
  clock += 6000; // 9 s after the first switch — outside
  watcher.emit('track', { title: 'T3' });
  await settle(rotator);
  const selects = client.calls.filter(([op]) => op === 'select');
  assert.equal(selects.length, 2, 'middle skip is absorbed');
});

test('vanished scene (404) refreshes the list and picks another', async () => {
  const client = fakeClient(MUSIC);
  const { rotator, watcher } = makeRotator(client, {}, { rng: () => 0.99 });
  await rotator.start();
  // simulate the user deleting a scene in the app after discovery
  const doomed = rotator.picker.bag?.[rotator.picker.bag.length - 1];
  client.effects = client.effects.filter((e) => e.animName !== (doomed ?? 'Sound Bar'));
  watcher.emit('track', { title: 'T1' });
  await settle(rotator);
  const selects = client.calls.filter(([op]) => op === 'select').map(([, n]) => n);
  const last = selects[selects.length - 1];
  assert.ok(client.effects.some((e) => e.animName === last), `final selection "${last}" must exist on device`);
  assert.ok(client.calls.some(([op]) => op === 'all'), 'list was refreshed after 404');
});

test('onStop "off" powers down and next track powers back on', async () => {
  const client = fakeClient(MUSIC);
  const { rotator, watcher } = makeRotator(client, { onStop: 'off' });
  await rotator.start();
  watcher.emit('track', { title: 'T1' });
  watcher.emit('idle');
  watcher.emit('track', { title: 'T2' });
  await settle(rotator);
  const powers = client.calls.filter(([op]) => op === 'power').map(([, v]) => v);
  assert.deepEqual(powers, [false, true]);
});

test('onStop "keep" does nothing on idle', async () => {
  const client = fakeClient(MUSIC);
  const { rotator, watcher } = makeRotator(client, { onStop: 'keep' });
  await rotator.start();
  watcher.emit('idle');
  await settle(rotator);
  assert.equal(client.calls.filter(([op]) => op !== 'all' && op !== 'list').length, 0);
});

test('onStop with an effect name selects it on idle', async () => {
  const client = fakeClient([...MUSIC, ...STATIC]);
  const { rotator, watcher } = makeRotator(client, { onStop: 'Snowfall' });
  await rotator.start();
  watcher.emit('idle');
  await settle(rotator);
  const selects = client.calls.filter(([op]) => op === 'select').map(([, n]) => n);
  assert.deepEqual(selects, ['Snowfall']);
});

test('select failure surfaces as an error status, not a crash', async () => {
  const client = fakeClient(MUSIC);
  client.selectEffect = async () => { throw new Error('boom'); };
  const { rotator, watcher, statuses } = makeRotator(client);
  await rotator.start();
  watcher.emit('track', { title: 'T1' });
  await settle(rotator);
  assert.ok(statuses.some(([m, isErr]) => isErr && /boom/.test(m)));
});

test('stop() detaches listeners', async () => {
  const client = fakeClient(MUSIC);
  const { rotator, watcher } = makeRotator(client);
  await rotator.start();
  rotator.stop();
  watcher.emit('track', { title: 'T1' });
  await settle(rotator);
  assert.equal(client.calls.filter(([op]) => op === 'select').length, 0);
});

// --- regression tests from the adversarial review ---

test('resume after onStop "off": playing event powers panels back on', async () => {
  const client = fakeClient(MUSIC);
  const { rotator, watcher } = makeRotator(client, { onStop: 'off' });
  await rotator.start();
  watcher.emit('track', { title: 'T1' });
  watcher.emit('idle');            // pause → panels off
  watcher.emit('playing');         // resume same track → no 'track' event fires
  await settle(rotator);
  const powers = client.calls.filter(([op]) => op === 'power').map(([, v]) => v);
  assert.deepEqual(powers, [false, true], 'resume must power panels back on');
});

test('resume after a named onStop effect swaps back to a music scene', async () => {
  const client = fakeClient([...MUSIC, ...STATIC]);
  const { rotator, watcher } = makeRotator(client, { onStop: 'Snowfall' });
  await rotator.start();
  watcher.emit('track', { title: 'T1' });
  watcher.emit('idle');            // pause → Snowfall
  watcher.emit('playing');         // resume same track
  await settle(rotator);
  const selects = client.calls.filter(([op]) => op === 'select').map(([, n]) => n);
  assert.equal(selects[1], 'Snowfall');
  const resumed = selects[2];
  assert.ok(MUSIC.some((e) => e.animName === resumed), `resume must select a music scene, got "${resumed}"`);
});

test('power restoration is never rate-limited by minSeconds', async () => {
  const client = fakeClient(MUSIC);
  let clock = 1000_000;
  const { rotator, watcher } = makeRotator(client, { onStop: 'off', minSeconds: 8 }, { now: () => clock });
  await rotator.start();
  watcher.emit('track', { title: 'T1' });   // t=0: scene switch
  await settle(rotator);
  clock += 3000;
  watcher.emit('idle');                     // t=3: stop → panels off
  await settle(rotator);
  clock += 2000;
  watcher.emit('track', { title: 'T2' });   // t=5: new track inside the window
  await settle(rotator);
  const powers = client.calls.filter(([op]) => op === 'power').map(([, v]) => v);
  assert.deepEqual(powers, [false, true], 'panels must come back on even within the rate-limit window');
});

test('start seeds poweredOff from the device (service restarted while panels off)', async () => {
  const client = fakeClient(MUSIC);
  client.getInfo = async () => ({ state: { on: { value: false } } });
  const { rotator, watcher } = makeRotator(client);
  await rotator.start();
  watcher.emit('track', { title: 'T1' });
  await settle(rotator);
  const powers = client.calls.filter(([op]) => op === 'power').map(([, v]) => v);
  assert.deepEqual(powers, [true], 'first track after restart must power panels on');
});

test('start tolerates getInfo failure (power state stays unknown-on)', async () => {
  const client = fakeClient(MUSIC);
  client.getInfo = async () => { throw new Error('timeout'); };
  const { rotator } = makeRotator(client);
  await rotator.start();
  assert.equal(rotator.poweredOff, false);
});

test('onStop transient failure is retried until it lands', async () => {
  const client = fakeClient(MUSIC);
  let failures = 2;
  const origPower = client.setPower.bind(client);
  client.setPower = async (on) => {
    if (failures-- > 0) throw new Error('EHOSTUNREACH');
    return origPower(on);
  };
  const delays = [];
  const { rotator, watcher } = makeRotator(client, { onStop: 'off' }, { delay: (ms) => { delays.push(ms); return Promise.resolve(); } });
  await rotator.start();
  watcher.emit('idle');
  await settle(rotator);
  assert.equal(delays.length, 2, 'two retries after two transient failures');
  assert.deepEqual(client.calls.filter(([op]) => op === 'power'), [['power', false]]);
});

test('onStop with a wrong-case name is canonicalized to the installed effect', async () => {
  const client = fakeClient([...MUSIC, ...STATIC]);
  const { rotator, watcher } = makeRotator(client, { onStop: 'snowfall' });
  await rotator.start();
  watcher.emit('idle');
  await settle(rotator);
  const selects = client.calls.filter(([op]) => op === 'select').map(([, n]) => n);
  assert.deepEqual(selects, ['Snowfall'], 'case-sensitive select must get the canonical name');
});

test('onStop naming a missing effect warns and degrades to keep', async () => {
  const client = fakeClient(MUSIC);
  const { rotator, watcher, statuses } = makeRotator(client, { onStop: 'Not Installed' });
  await rotator.start();
  assert.ok(statuses.some(([m, isErr]) => isErr && /Not Installed/.test(m)), 'user is warned at startup');
  watcher.emit('idle');
  await settle(rotator);
  assert.equal(client.calls.filter(([op]) => op === 'select').length, 0, 'behaves like keep');
});

test('404 recovery reports the scene actually selected, not the vanished one', async () => {
  const client = fakeClient(MUSIC);
  const { rotator, watcher, statuses } = makeRotator(client);
  await rotator.start();
  const doomed = rotator.picker.bag[rotator.picker.bag.length - 1];
  client.effects = client.effects.filter((e) => e.animName !== doomed);
  watcher.emit('track', { title: 'T1' });
  await settle(rotator);
  assert.notEqual(rotator.currentScene, doomed, 'currentScene must be the replacement');
  assert.ok(client.effects.some((e) => e.animName === rotator.currentScene));
  const trackStatus = statuses.find(([m]) => m.startsWith('♪'));
  assert.ok(trackStatus && trackStatus[0].includes(rotator.currentScene), 'status shows the real scene');
});
