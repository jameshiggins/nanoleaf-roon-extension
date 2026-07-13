'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { measure, EnvelopeFollower, durationMs, FULL_SCALE } = require('../src/audio/pcm');

function s16leBuffer(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

test('measure: silence is all zeros', () => {
  const m = measure(s16leBuffer(new Array(200).fill(0)), 2);
  assert.deepEqual(m, { peak: 0, rms: 0, left: 0, right: 0 });
});

test('measure: full-scale square wave has peak and rms of 1', () => {
  const samples = [];
  for (let i = 0; i < 100; i++) samples.push(i % 2 ? 32767 : -32768);
  const m = measure(s16leBuffer(samples), 2);
  assert.equal(m.peak, 1);
  assert.ok(m.rms > 0.999 && m.rms <= 1.0001, `rms=${m.rms}`);
});

test('measure: stereo separation — signal only on the left channel', () => {
  const samples = [];
  for (let i = 0; i < 100; i++) samples.push(16384, 0); // L, R interleaved
  const m = measure(s16leBuffer(samples), 2);
  assert.ok(Math.abs(m.left - 16384 / FULL_SCALE) < 1e-6);
  assert.equal(m.right, 0);
});

test('measure: mono treats every sample as one channel', () => {
  const m = measure(s16leBuffer([16384, 16384]), 1);
  assert.ok(Math.abs(m.left - 0.5) < 1e-3);
  assert.equal(m.left, m.right);
});

test('measure: empty and sub-frame buffers are safe', () => {
  assert.equal(measure(Buffer.alloc(0), 2).peak, 0);
  assert.equal(measure(Buffer.alloc(1), 2).peak, 0); // odd trailing byte
  assert.equal(measure(Buffer.alloc(2), 2).peak, 0); // one sample, half a stereo frame
});

test('envelope: rises fast with short attack, falls slow with long release', () => {
  const env = new EnvelopeFollower({ attackMs: 5, releaseMs: 200 });
  env.update(1, 20); // 20 ms at full level, tau 5 ms → nearly there
  assert.ok(env.value > 0.95, `after attack: ${env.value}`);
  const peak = env.value;
  env.update(0, 20); // 20 ms of silence, tau 200 ms → barely moved
  assert.ok(env.value > peak * 0.85, `after release step: ${env.value}`);
});

test('envelope: zero time constants jump immediately', () => {
  const env = new EnvelopeFollower({ attackMs: 0, releaseMs: 0 });
  env.update(0.7, 1);
  assert.equal(env.value, 0.7);
  env.update(0.1, 1);
  assert.equal(env.value, 0.1);
});

test('envelope: clamps to [0, 1] and resets', () => {
  const env = new EnvelopeFollower({ attackMs: 0, releaseMs: 0 });
  env.update(5, 1);
  assert.equal(env.value, 1);
  env.reset();
  assert.equal(env.value, 0);
});

test('durationMs: 44100 Hz stereo, 4410 frames = 100 ms', () => {
  const bytes = 4410 * 2 * 2;
  assert.ok(Math.abs(durationMs(bytes, 44100, 2) - 100) < 1e-9);
});
