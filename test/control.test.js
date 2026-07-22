'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ControlServer, applyCommand } = require('../src/control/server');
const { VisualRenderer } = require('../src/visuals/renderer');

const LAYOUT = [
  { id: 1, nx: 0, ny: 0 },
  { id: 2, nx: 1, ny: 1 },
];
const CFG = {
  include: [], exclude: [], palettes: 8, palette: '', rotate: 'track', minSeconds: 8,
  gain: 1, attackMs: 5, releaseMs: 180, silenceFloor: 0.02, flashStrength: 0.5, onsetSensitivity: 1.1,
  albumColors: true, albumSat: 0.9, albumVal: 1, albumMaxColors: 10,
  albumPredominantChance: 0.33, albumPredominantCount: 4,
  releaseDebounceMs: 5000, extControlKeepaliveMs: 4000,
};

function makeRenderer() {
  const renderer = new VisualRenderer({
    source: new EventEmitter(),
    streamer: { sendFrame() {}, blackout() {} },
    layout: LAYOUT,
    config: { ...CFG },
    fps: 30,
    rng: () => 0.3,
  });
  renderer.rotate(true);
  return renderer;
}

// ---- applyCommand (pure) ----

test('applyCommand: set drives any visuals lever, validates, rejects unknown', () => {
  const r = makeRenderer();
  // valid live set
  assert.equal(applyCommand(r, { cmd: 'set', key: 'flashStrength', value: 0.2 }).ok, true);
  assert.equal(r.config.flashStrength, 0.2);
  // out of range
  const bad = applyCommand(r, { cmd: 'set', key: 'flashStrength', value: 5 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /\[0, 1\]/);
  // unknown / read-only lever
  assert.equal(applyCommand(r, { cmd: 'set', key: 'nanoleaf.fps', value: 60 }).ok, false);
  // exclude rebuilds the pool live
  assert.equal(applyCommand(r, { cmd: 'set', key: 'exclude', value: ['wheel'] }).ok, true);
  assert.ok(!r.getCatalogue().visuals.some((v) => v.name === 'wheel'), 'wheel dropped from the pool');
  // album lever stored (applies next track)
  assert.equal(applyCommand(r, { cmd: 'set', key: 'albumMaxColors', value: 6 }).ok, true);
  assert.equal(r.config.albumMaxColors, 6);
});

test('applyCommand: next / lock / unlock / gain', () => {
  const r = makeRenderer();
  assert.equal(applyCommand(r, { cmd: 'next' }).ok, true);
  assert.equal(applyCommand(r, { cmd: 'lock' }).ok, true);
  assert.equal(r.getState().locked, true);
  assert.equal(applyCommand(r, { cmd: 'unlock' }).ok, true);
  assert.equal(r.getState().locked, false);
  const g = applyCommand(r, { cmd: 'gain', value: 2.5 });
  assert.equal(g.ok, true);
  assert.equal(g.state.gain, 2.5);
});

test('applyCommand: visual / palette validate against the catalogue', () => {
  const r = makeRenderer();
  const ok = applyCommand(r, { cmd: 'visual', value: 'wheel' });
  assert.equal(ok.ok, true);
  assert.equal(ok.state.visual, 'wheel');
  const bad = applyCommand(r, { cmd: 'visual', value: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown visual/);
  const badPal = applyCommand(r, { cmd: 'palette', value: 'no-such' });
  assert.equal(badPal.ok, false);
});

test('applyCommand: unknown command rejected', () => {
  const r = makeRenderer();
  assert.deepEqual(applyCommand(r, { cmd: 'explode' }).ok, false);
  assert.deepEqual(applyCommand(r, {}).ok, false);
});

// ---- HTTP + SSE ----

async function withServer(fn) {
  const renderer = makeRenderer();
  const server = new ControlServer({ renderer, port: 0, host: '127.0.0.1', frameHz: 60 });
  const port = await server.start();
  try {
    await fn({ renderer, port });
  } finally {
    server.stop();
  }
}

test('GET /api/config returns current lever values + ranges for the menu', async () => {
  await withServer(async ({ port }) => {
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    assert.equal(cfg.values.flashStrength, 0.5, 'current value present');
    assert.equal(cfg.values.albumMaxColors, 10);
    assert.ok(cfg.levers.flashStrength && cfg.levers.flashStrength.max === 1, 'range present');
    assert.ok(cfg.levers.gain && cfg.levers.gain.max === 100);
    assert.equal(Object.keys(cfg.values).length, Object.keys(cfg.levers).length, 'a value per lever');
  });
});

test('POST set persists via onChange, once per successful mutating command', async () => {
  const renderer = makeRenderer();
  let saves = 0;
  const server = new ControlServer({ renderer, port: 0, host: '127.0.0.1', onChange: () => { saves += 1; } });
  const port = await server.start();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'set', key: 'flashStrength', value: 0.3 }),
    });
    assert.equal(ok.status, 200);
    const bad = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'set', key: 'flashStrength', value: 99 }),
    });
    assert.equal(bad.status, 400);
    assert.equal(saves, 1, 'persist called only for the successful set');
  } finally { server.stop(); }
});

test('GET /api/state and /api/catalogue', async () => {
  await withServer(async ({ port }) => {
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.ok(state.visual);
    assert.equal(state.panels, 2);
    const cat = await (await fetch(`http://127.0.0.1:${port}/api/catalogue`)).json();
    assert.ok(cat.visuals.length > 0 && cat.palettes.length > 0);
    assert.equal(cat.layout.length, 2);
  });
});

test('GET / serves the web app', async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /EventSource\("\/events"\)/);
  });
});

test('POST /api/command drives the renderer', async () => {
  await withServer(async ({ renderer, port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'visual', value: 'ripple' }),
    });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(renderer.currentName, 'ripple');
  });
});

test('POST /api/command rejects bad JSON and unknown commands', async () => {
  await withServer(async ({ port }) => {
    const bad = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json',
    });
    assert.equal(bad.status, 400);
    const unknown = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'zzz' }),
    });
    assert.equal(unknown.status, 400);
  });
});

test('POST /api/command rejects a non-JSON content-type (CSRF guard)', async () => {
  await withServer(async ({ renderer, port }) => {
    const before = renderer.currentName;
    const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ cmd: 'visual', value: 'ripple' }),
    });
    assert.equal(res.status, 415, 'text/plain body is rejected');
    assert.equal(renderer.currentName, before, 'renderer was not driven by the simple cross-origin POST');
  });
});

test('SSE /events sends hello then live frames', async () => {
  await withServer(async ({ renderer, port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, { headers: { Accept: 'text/event-stream' } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    async function readUntil(marker, tries = 50) {
      for (let i = 0; i < tries; i++) {
        const { value, done } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        if (buf.includes(marker)) return true;
        if (done) break;
      }
      return false;
    }

    assert.ok(await readUntil('event: hello'), 'hello event received');
    assert.match(buf, /"catalogue"/);

    // a rendered frame should reach the connected client (server subscribed on connect)
    renderer.renderFrame();
    assert.ok(await readUntil('event: frame'), 'frame event received');
    assert.match(buf, /"c":\[\[/); // panel colors array

    await reader.cancel();
  });
});

test('frames are only emitted while a client is connected', async () => {
  const renderer = makeRenderer();
  const server = new ControlServer({ renderer, port: 0, host: '127.0.0.1', frameHz: 60 });
  await server.start();
  try {
    assert.equal(renderer.listenerCount('frame'), 0, 'no frame listener with no clients');
  } finally {
    server.stop();
  }
});

test('server reports reachable URLs (specific host binds to that host)', async () => {
  const renderer = makeRenderer();
  const server = new ControlServer({ renderer, port: 0, host: '127.0.0.1', frameHz: 20 });
  const port = await server.start();
  try {
    assert.deepEqual(server.urls, [`http://127.0.0.1:${port}`]);
  } finally {
    server.stop();
  }
});
