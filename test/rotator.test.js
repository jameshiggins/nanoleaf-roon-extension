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
