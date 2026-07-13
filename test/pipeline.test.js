'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Pipeline, mapEnvelopeToFrame } = require('../src/pipeline');

const MAPPING = {
  attackMs: 0, releaseMs: 0, gain: 1,
  baseColor: [100, 50, 200], floor: 0.02, stereo: true,
};

const PANELS = [
  { panelId: 3, x: 200 },
  { panelId: 1, x: 0 },
  { panelId: 2, x: 100 },
];

test('mapEnvelopeToFrame: silence renders black on every panel', () => {
  const frame = mapEnvelopeToFrame(PANELS, { mono: 0, left: 0, right: 0 }, MAPPING);
  assert.equal(frame.length, 3);
  for (const p of frame) assert.deepEqual([p.r, p.g, p.b], [0, 0, 0]);
});

test('mapEnvelopeToFrame: full envelope renders the base color', () => {
  const frame = mapEnvelopeToFrame(PANELS, { mono: 1, left: 1, right: 1 }, MAPPING);
  for (const p of frame) assert.deepEqual([p.r, p.g, p.b], [100, 50, 200]);
});

test('mapEnvelopeToFrame: panels are ordered left-to-right by layout x', () => {
  const frame = mapEnvelopeToFrame(PANELS, { mono: 1, left: 1, right: 1 }, MAPPING);
  assert.deepEqual(frame.map((p) => p.id), [1, 2, 3]);
});

test('mapEnvelopeToFrame: stereo — left-only signal lights the left side', () => {
  const frame = mapEnvelopeToFrame(PANELS, { mono: 0.5, left: 1, right: 0 }, MAPPING);
  const [left, middle, right] = frame;
  assert.equal(left.r, 100);   // full level at leftmost panel
  assert.equal(middle.r, 50);  // 50/50 blend in the center
  assert.equal(right.r, 0);    // silent on the right
});

test('mapEnvelopeToFrame: stereo=false uses the mono envelope everywhere', () => {
  const frame = mapEnvelopeToFrame(PANELS, { mono: 0.5, left: 1, right: 0 },
    { ...MAPPING, stereo: false });
  for (const p of frame) assert.equal(p.r, 50);
});

test('mapEnvelopeToFrame: noise gate zeroes sub-floor levels', () => {
  const frame = mapEnvelopeToFrame(PANELS, { mono: 0.01, left: 0.01, right: 0.01 },
    { ...MAPPING, floor: 0.02, stereo: false });
  for (const p of frame) assert.deepEqual([p.r, p.g, p.b], [0, 0, 0]);
});

test('mapEnvelopeToFrame: single panel gets the L/R blend, not an edge', () => {
  const frame = mapEnvelopeToFrame([{ panelId: 9, x: 0 }], { mono: 0, left: 1, right: 0 }, MAPPING);
  assert.equal(frame.length, 1);
  assert.equal(frame[0].r, 50); // 0.5 blend of left=1, right=0
});

function fakeStreamer() {
  return {
    frames: [],
    blackouts: [],
    sendFrame(f) { this.frames.push(f); },
    blackout(ids) { this.blackouts.push(ids); },
  };
}

function sineChunk(amplitude, frames = 441) {
  const buf = Buffer.alloc(frames * 4); // stereo s16le
  for (let i = 0; i < frames; i++) {
    const s = Math.round(Math.sin((i / frames) * 20 * Math.PI) * amplitude * 32767);
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(s, i * 4 + 2);
  }
  return buf;
}

test('Pipeline: PCM drives the envelope, frames reflect it, stop blacks out', () => {
  const source = new EventEmitter();
  source.start = () => {};
  source.stop = () => {};
  const streamer = fakeStreamer();
  const pipeline = new Pipeline({ source, streamer, panels: PANELS, mapping: MAPPING, fps: 30 });

  pipeline.start();
  try {
    source.emit('format', { sampleRate: 44100, channels: 2 });

    let frame = pipeline.renderFrame();
    assert.ok(frame.every((p) => p.r === 0), 'silent before any audio');

    source.emit('pcm', sineChunk(0.9));
    frame = pipeline.renderFrame();
    assert.ok(frame.some((p) => p.r > 20), `loud chunk should light panels, got ${JSON.stringify(frame)}`);

    source.emit('pcm', sineChunk(0)); // instant release (releaseMs: 0)
    frame = pipeline.renderFrame();
    assert.ok(frame.every((p) => p.r === 0), 'silence should darken with zero release');
  } finally {
    pipeline.stop();
  }
  assert.deepEqual(streamer.blackouts, [[3, 1, 2]], 'stop() must send a blackout');
});
