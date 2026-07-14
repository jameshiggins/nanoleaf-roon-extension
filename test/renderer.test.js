'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VisualRenderer } = require('../src/visuals/renderer');

const LAYOUT = [
  { id: 1, nx: 0, ny: 0 },
  { id: 2, nx: 0.5, ny: 0.5 },
  { id: 3, nx: 1, ny: 1 },
];

const BASE_CFG = {
  include: [], exclude: [], palettes: 12, rotate: 'track', minSeconds: 8,
  gain: 1, attackMs: 5, releaseMs: 180, silenceFloor: 0.02,
};

function fakeStreamer() {
  return { frames: [], blackouts: [], sendFrame(f) { this.frames.push(f); }, blackout(ids) { this.blackouts.push(ids); } };
}

function loudChunk(frames = 1000) {
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(Math.sin(i * 0.4) * 0.9 * 32767);
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(s, i * 4 + 2);
  }
  return buf;
}

function make(cfgOverrides = {}, opts = {}) {
  const source = new EventEmitter();
  const streamer = fakeStreamer();
  let clock = 1_000_000;
  const renderer = new VisualRenderer({
    source,
    streamer,
    layout: LAYOUT,
    config: { ...BASE_CFG, ...cfgOverrides },
    fps: 30,
    now: opts.now ?? (() => clock),
    rng: opts.rng ?? (() => 0.42),
  });
  return { renderer, source, streamer, setClock: (v) => { clock = v; }, getClock: () => clock };
}

test('rotate picks a visual + palette and reports status', () => {
  const statuses = [];
  const { renderer } = make({}, {});
  renderer.onStatus = (m) => statuses.push(m);
  renderer.rotate(true);
  assert.ok(renderer.currentName, 'a visual is chosen');
  assert.ok(renderer.currentPalette && renderer.currentPalette.name);
  assert.ok(renderer.visual, 'a visualizer instance exists');
});

test('renders frames from loud audio, all panels addressed', () => {
  const { renderer, streamer } = make();
  renderer.rotate(true);
  for (let i = 0; i < 10; i++) { renderer.features.onChunk(loudChunk()); renderer.renderFrame(); }
  const last = streamer.frames.at(-1);
  assert.equal(last.length, LAYOUT.length);
  const bright = Math.max(...last.map((p) => Math.max(p.r, p.g, p.b)));
  assert.ok(bright > 10, `loud audio should light panels, got ${bright}`);
});

test('silence gate fades panels toward black', () => {
  const { renderer, streamer } = make();
  renderer.rotate(true);
  for (let i = 0; i < 10; i++) { renderer.features.onChunk(loudChunk()); renderer.renderFrame(); }
  const litMax = Math.max(...streamer.frames.at(-1).map((p) => Math.max(p.r, p.g, p.b)));
  // now go quiet for a while
  for (let i = 0; i < 120; i++) { renderer.features.onChunk(Buffer.alloc(4000)); renderer.renderFrame(); }
  const quietMax = Math.max(...streamer.frames.at(-1).map((p) => Math.max(p.r, p.g, p.b)));
  assert.ok(quietMax < litMax * 0.1, `silence should fade out: lit ${litMax} → quiet ${quietMax}`);
  assert.ok(renderer.gate < 0.05, `gate should be low, is ${renderer.gate}`);
});

test('onTrackChange rotates, but not within minSeconds', () => {
  let clock = 1_000_000;
  const { renderer } = make({ minSeconds: 8 }, { now: () => clock });
  renderer.rotate(true);
  const first = renderer.currentName + '|' + renderer.currentPalette.name;
  clock += 3000; // 3s — inside window
  renderer.onTrackChange();
  assert.equal(renderer.currentName + '|' + renderer.currentPalette.name, first, 'no rotation inside window');
  clock += 6000; // 9s total — outside window
  renderer.onTrackChange();
  assert.notEqual(renderer.lastRotateAt, 1_000_000, 'rotation happened');
});

test('rotate "off" ignores track changes', () => {
  const { renderer } = make({ rotate: 'off' });
  renderer.rotate(true);
  const before = renderer.currentName;
  const beforeAt = renderer.lastRotateAt;
  renderer.onTrackChange();
  assert.equal(renderer.lastRotateAt, beforeAt, 'no rotation when rotate is off');
});

test('include filter restricts the visual pool', () => {
  const { renderer } = make({ include: ['wheel'] });
  for (let i = 0; i < 20; i++) renderer.rotate(false);
  assert.equal(renderer.currentName, 'wheel');
});

test('start wires the source and stop blacks out', () => {
  const { renderer, source, streamer } = make();
  renderer.start();
  try {
    source.emit('format', { sampleRate: 48000, channels: 2 });
    source.emit('pcm', loudChunk());
    assert.equal(renderer.features.sampleRate, 48000);
  } finally {
    renderer.stop();
  }
  assert.deepEqual(streamer.blackouts.at(-1), [1, 2, 3], 'stop sends a blackout');
});

test('empty include/exclude intersection throws at construction', () => {
  assert.throws(() => make({ include: ['does-not-exist'] }).renderer, /no visualizers left/);
});
