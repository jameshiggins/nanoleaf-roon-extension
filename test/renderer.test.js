'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VisualRenderer } = require('../src/visuals/renderer');
const { resolvePalette } = require('../src/visuals/palettes');

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
  return { frames: [], blackouts: [], sendFrame(f) { this.frames.push(f); }, blackout(ids) { this.blackouts.push(ids); }, pause() {} };
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

test('setRotate floors a tiny numeric interval (rotate-storm DoS guard)', () => {
  const { renderer } = make({ minSeconds: 8 });
  const result = renderer.setRotate(0.001);
  assert.ok(result >= 8, `should clamp to minSeconds, got ${result}`);
  assert.equal(renderer.config.rotate, result);
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

// --- palette pin + vintage tone pass ---

test('visuals.palette pins the palette while scenes still rotate', () => {
  const seq = (() => { let s = 0.11; return () => (s = (s * 9301 + 0.4931) % 1); })();
  const { renderer } = make({ palette: 'Vintage Modern', include: ['wheel', 'ripple', 'sparkle', 'fire'] }, { rng: seq });
  const visuals = new Set();
  for (let i = 0; i < 16; i++) {
    renderer.rotate(false);
    assert.equal(renderer.currentPalette.name, 'Vintage Modern', 'palette stays pinned across rotations');
    visuals.add(renderer.currentName);
  }
  assert.ok(visuals.size > 1, `scenes should still rotate, saw ${visuals.size}`);
  assert.ok(renderer.currentPalette.sat < 1, 'pinned palette keeps its muting sat');
});

test('a palette with sat/val mutes and warms the frame (vintage tone pass)', () => {
  // The wall can't be observed from a headless run, so verify the color math:
  // the same scene + hues, rendered with Vintage Modern's sat/val vs a
  // full-saturation palette, must come out measurably less saturated (and warm).
  const { renderer } = make({ include: ['wheel'] });
  renderer.rotate(true); // establish a scene so renderFrame has a visual
  for (let i = 0; i < 12; i++) { renderer.features.onChunk(loudChunk()); renderer.renderFrame(); } // raise gate

  const plainPal = { name: 'Plain', base: 41, accent: 135, hit: 4 }; // Vintage Modern hues, full saturation
  const retroPal = resolvePalette('Vintage Modern');                 // same hues, muted sat/val

  renderer.features.onChunk(loudChunk());
  renderer._apply('wheel', plainPal, 'test');
  const plain = renderer.renderFrame();
  renderer.features.onChunk(loudChunk());
  renderer._apply('wheel', retroPal, 'test');
  const muted = renderer.renderFrame();

  const meanSat = (fr) => {
    const lit = fr.filter((p) => Math.max(p.r, p.g, p.b) > 8);
    assert.ok(lit.length, 'some panels are lit');
    const s = lit.map((p) => {
      const mx = Math.max(p.r, p.g, p.b), mn = Math.min(p.r, p.g, p.b);
      return mx > 0 ? (mx - mn) / mx : 0;
    });
    return s.reduce((a, b) => a + b, 0) / s.length;
  };
  const isWarm = (fr) => {
    const mean = (k) => fr.reduce((a, p) => a + p[k], 0) / fr.length;
    return mean('r') > mean('b');
  };

  assert.ok(
    meanSat(muted) < meanSat(plain) - 0.05,
    `muted (${meanSat(muted).toFixed(3)}) should be less saturated than plain (${meanSat(plain).toFixed(3)})`
  );
  assert.ok(isWarm(muted), 'vintage frame reads warm (mean R > mean B)');
});

test('setLivePalette overrides the pin, rebuilds the visual, persists across rotations; clear reverts', () => {
  const seq = (() => { let s = 0.2; return () => (s = (s * 7919 + 0.577) % 1); })();
  const { renderer } = make({ palette: 'Vintage Modern', include: ['bars', 'wheel', 'ripple'] }, { rng: seq });
  renderer.rotate(true);
  assert.equal(renderer.currentPalette.name, 'Vintage Modern', 'starts on the pin');

  const album = { name: 'Album', base: 200, accent: 40, hit: 300, sat: 0.9, val: 1 };
  renderer.setLivePalette(album);
  assert.equal(renderer.currentPalette.name, 'Album', 'live palette overrides the pin');
  assert.equal(renderer.currentPalette.base, 200, 'visual rebuilt with the album hues (not just re-toned)');

  for (let i = 0; i < 6; i++) { renderer.rotate(false); assert.equal(renderer.currentPalette.name, 'Album', 'live palette survives scene rotation'); }

  renderer.clearLivePalette();
  assert.equal(renderer.currentPalette.name, 'Vintage Modern', 'clearing reverts to the pin');
});

test('clearLivePalette with no pin falls back to a generated palette, not dark', () => {
  const { renderer } = make({ include: ['wheel'] });
  renderer.rotate(true);
  renderer.setLivePalette({ name: 'Album', base: 10, accent: 120, hit: 250 });
  assert.equal(renderer.currentPalette.name, 'Album');
  renderer.clearLivePalette();
  assert.ok(renderer.currentPalette && renderer.currentPalette.name !== 'Album', 'reverted to a real palette');
});

// --- control surface ---

test('getState / getCatalogue expose current look and choices', () => {
  const { renderer } = make({ include: ['wheel', 'ripple'] });
  renderer.rotate(true);
  const s = renderer.getState();
  assert.ok(['wheel', 'ripple'].includes(s.visual));
  assert.equal(typeof s.palette, 'string');
  assert.equal(s.locked, false);
  const cat = renderer.getCatalogue();
  assert.deepEqual(cat.visuals.map((v) => v.name).sort(), ['ripple', 'wheel']);
  assert.ok(cat.palettes.length >= 1);
  assert.equal(cat.layout.length, 3);
});

test('selectVisual / selectPalette pin choices and reject unknowns', () => {
  const { renderer } = make();
  renderer.rotate(true);
  assert.equal(renderer.selectVisual('WHEEL'), 'wheel');
  assert.equal(renderer.currentName, 'wheel');
  assert.equal(renderer.selectVisual('nope'), null);
  const pal = renderer.currentPalette.name;
  assert.equal(renderer.selectPalette(pal), pal);
  assert.equal(renderer.selectPalette('no-such-palette'), null);
  assert.equal(renderer.selectPalette(0), renderer.palettes[0].name);
});

test('setGain updates the feature extractor; setRotate toggles lock', () => {
  const { renderer } = make();
  renderer.rotate(true);
  renderer.setGain(3);
  assert.equal(renderer.config.gain, 3);
  assert.equal(renderer.features.gain, 3);
  renderer.setRotate('off');
  assert.equal(renderer.getState().locked, true);
  renderer.onTrackChange(); // ignored while off
  const name = renderer.currentName;
  renderer.next(); // manual advance still works
  assert.ok(renderer.currentName); // may differ; just shouldn't throw
});

test('emits frame/rotate/state events for the control server', () => {
  const { renderer } = make();
  const events = { frame: 0, rotate: 0, state: 0 };
  renderer.on('frame', () => events.frame++);
  renderer.on('rotate', () => events.rotate++);
  renderer.on('state', () => events.state++);
  renderer.rotate(true);
  assert.equal(events.rotate, 1);
  assert.ok(events.state >= 1);
  renderer.renderFrame();
  assert.equal(events.frame, 1, 'frame emitted only when a listener is attached');
});

test('setNowPlaying flows into state', () => {
  const { renderer } = make();
  renderer.rotate(true);
  renderer.setNowPlaying({ title: 'Song', artist: 'Band' });
  assert.deepEqual(renderer.getState().nowPlaying, { title: 'Song', artist: 'Band' });
});
