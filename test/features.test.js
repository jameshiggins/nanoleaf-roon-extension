'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FeatureExtractor, BandSplitter, OnsetDetector } = require('../src/dsp/features');

const RATE = 44100;

/** Generate `ms` of a stereo s16le sine at `freq` Hz, amplitude 0..1. */
function tone(freq, ms, amp = 0.9, sampleRate = RATE) {
  const frames = Math.round((ms / 1000) * sampleRate);
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp * 32767);
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(s, i * 4 + 2);
  }
  return buf;
}

function silence(ms, sampleRate = RATE) {
  return Buffer.alloc(Math.round((ms / 1000) * sampleRate) * 4);
}

test('BandSplitter: low tone lands in bass, high tone in treble', () => {
  const bassSplit = new BandSplitter(RATE).process(tone(60, 100), 2);
  assert.ok(bassSplit.bass > bassSplit.treble, `bass ${bassSplit.bass} vs treble ${bassSplit.treble}`);
  const trebleSplit = new BandSplitter(RATE).process(tone(9000, 100), 2);
  assert.ok(trebleSplit.treble > trebleSplit.bass, `treble ${trebleSplit.treble} vs bass ${trebleSplit.bass}`);
});

test('BandSplitter: a mid tone dominates the mid band', () => {
  const m = new BandSplitter(RATE).process(tone(900, 120), 2);
  assert.ok(m.mid > m.bass && m.mid > m.treble, JSON.stringify(m));
});

test('BandSplitter: silence is all zeros', () => {
  const s = new BandSplitter(RATE).process(silence(50), 2);
  assert.equal(s.level, 0);
  assert.equal(s.bass, 0);
});

test('OnsetDetector: fires on a bass jump after quiet, respects refractory', () => {
  const det = new OnsetDetector({ refractoryMs: 150 });
  let fired = 0;
  let t = 0;
  for (let i = 0; i < 20; i++) { det.update(0.01, t); t += 30; } // build a quiet baseline
  fired += det.update(0.9, t) ? 1 : 0;                            // big jump → onset
  t += 30;
  fired += det.update(0.92, t) ? 1 : 0;                           // still loud, within refractory → no onset
  assert.equal(fired, 1);
});

test('FeatureExtractor: loud tone lights bands, snapshot onset consumed once', () => {
  const fe = new FeatureExtractor({ sampleRate: RATE, channels: 2, now: (() => { let t = 0; return () => (t += 35); })() });
  // establish a baseline then hit it with a loud bass burst
  for (let i = 0; i < 15; i++) fe.onChunk(silence(35));
  fe.onChunk(tone(60, 35, 0.95));
  const snap = fe.snapshot();
  assert.ok(snap.bass > 0.1, `bass ${snap.bass}`);
  assert.ok(snap.energy > 0.05);
  // onset flag is consumed
  const snap2 = fe.snapshot();
  assert.equal(snap2.onset, false);
});

test('FeatureExtractor: stereo separation survives to features', () => {
  const fe = new FeatureExtractor({ sampleRate: RATE, channels: 2 });
  // left-only tone
  const frames = 1000;
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(Math.sin(i * 0.2) * 30000), i * 4); // L
    buf.writeInt16LE(0, i * 4 + 2);                                  // R silent
  }
  fe.onChunk(buf);
  const snap = fe.snapshot();
  assert.ok(snap.left > snap.right, `left ${snap.left} vs right ${snap.right}`);
});

test('FeatureExtractor: setFormat updates rate/channels safely', () => {
  const fe = new FeatureExtractor({ sampleRate: RATE, channels: 2 });
  fe.setFormat({ sampleRate: 48000, channels: 1 });
  assert.equal(fe.sampleRate, 48000);
  assert.equal(fe.channels, 1);
  // mono chunk should not throw
  fe.onChunk(Buffer.alloc(200));
  assert.doesNotThrow(() => fe.snapshot());
});
