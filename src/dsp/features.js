'use strict';

/**
 * Audio feature extraction for the visualizers — all from the direct PCM feed.
 *
 * Per render tick the pipeline gets a snapshot of:
 *   rms, peak      — overall level envelopes [0,1]
 *   left, right    — per-channel level envelopes [0,1]
 *   bass/mid/treble— band energy envelopes [0,1] (one-pole IIR split, no FFT)
 *   energy         — perceptual blend of the bands
 *   onset          — true once when a beat landed since the last snapshot
 *
 * Band split: cheap sample-wise one-pole filters (LP ~250 Hz, LP ~2.5 kHz);
 * bass = rms(lp250), mid = rms(lp2500 - lp250), treble = rms(x - lp2500).
 * Onset detection: bass-energy flux against a rolling mean/std with a
 * refractory window — robust to level changes, cheap, latency ≈ one chunk.
 */

const { EnvelopeFollower, durationMs } = require('../audio/pcm');

const FULL_SCALE = 32768;

class BandSplitter {
  constructor(sampleRate) {
    this.setSampleRate(sampleRate);
    this.lpBassState = 0;
    this.lpMidState = 0;
  }

  setSampleRate(sampleRate) {
    const alpha = (fc) => 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);
    this.aBass = alpha(250);
    this.aMid = alpha(2500);
  }

  /**
   * @param {Buffer} buf interleaved s16le
   * @param {number} channels
   * @returns {{ bass: number, mid: number, treble: number, level: number,
   *             left: number, right: number, peak: number }} RMS values in [0,1]
   */
  process(buf, channels) {
    const frames = Math.floor(buf.length / 2 / channels);
    if (frames === 0) return { bass: 0, mid: 0, treble: 0, level: 0, left: 0, right: 0, peak: 0 };

    let sumBass = 0, sumMid = 0, sumTreble = 0, sumSq = 0, sumL = 0, sumR = 0, peak = 0;
    let lpB = this.lpBassState;
    let lpM = this.lpMidState;
    const aB = this.aBass;
    const aM = this.aMid;

    for (let f = 0; f < frames; f++) {
      const l = buf.readInt16LE(f * channels * 2) / FULL_SCALE;
      const r = channels > 1 ? buf.readInt16LE((f * channels + 1) * 2) / FULL_SCALE : l;
      const x = (l + r) / 2;
      const ax = Math.abs(x);
      if (ax > peak) peak = ax;
      lpB += aB * (x - lpB);
      lpM += aM * (x - lpM);
      const bass = lpB;
      const mid = lpM - lpB;
      const treble = x - lpM;
      sumBass += bass * bass;
      sumMid += mid * mid;
      sumTreble += treble * treble;
      sumSq += x * x;
      sumL += l * l;
      sumR += r * r;
    }
    this.lpBassState = lpB;
    this.lpMidState = lpM;
    return {
      bass: Math.sqrt(sumBass / frames),
      mid: Math.sqrt(sumMid / frames),
      treble: Math.sqrt(sumTreble / frames),
      level: Math.sqrt(sumSq / frames),
      left: Math.sqrt(sumL / frames),
      right: Math.sqrt(sumR / frames),
      peak: Math.min(peak, 1),
    };
  }
}

class OnsetDetector {
  // sensitivity default 1.1 (was 1.5) and the mean margin 1.05 (was 1.3): the old bar
  // (mean*1.3 + 1.5σ) rarely cleared on compressed/steady-kick tracks, starving every
  // beat-driven visualizer. Lower = more beats detected (livelier), higher = stricter.
  constructor({ historyLength = 43, sensitivity = 1.1, floor = 0.01, refractoryMs = 150 } = {}) {
    this.history = [];
    this.historyLength = historyLength; // ~1.5 s of 35 ms chunks
    this.sensitivity = sensitivity;
    this.floor = floor;
    this.refractoryMs = refractoryMs;
    this.lastOnsetAt = -Infinity;
  }

  /** @returns {boolean} a beat landed on this chunk */
  update(bassEnergy, nowMs) {
    const h = this.history;
    let onset = false;
    if (h.length >= 8) {
      const mean = h.reduce((s, v) => s + v, 0) / h.length;
      const variance = h.reduce((s, v) => s + (v - mean) * (v - mean), 0) / h.length;
      const threshold = Math.max(this.floor, mean * 1.05 + this.sensitivity * Math.sqrt(variance));
      if (bassEnergy > threshold && nowMs - this.lastOnsetAt >= this.refractoryMs) {
        onset = true;
        this.lastOnsetAt = nowMs;
      }
    }
    h.push(bassEnergy);
    if (h.length > this.historyLength) h.shift();
    return onset;
  }
}

class FeatureExtractor {
  /**
   * @param {{ sampleRate?: number, channels?: number,
   *           mapping?: { attackMs?: number, releaseMs?: number, gain?: number },
   *           now?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this.channels = opts.channels ?? 2;
    this.gain = opts.mapping?.gain ?? 1;
    this.now = opts.now ?? Date.now;
    this.splitter = new BandSplitter(opts.sampleRate ?? 44100);
    const env = { attackMs: opts.mapping?.attackMs ?? 5, releaseMs: opts.mapping?.releaseMs ?? 180 };
    this.env = {
      rms: new EnvelopeFollower(env),
      peak: new EnvelopeFollower(env),
      left: new EnvelopeFollower(env),
      right: new EnvelopeFollower(env),
      bass: new EnvelopeFollower(env),
      mid: new EnvelopeFollower(env),
      treble: new EnvelopeFollower(env),
    };
    this.onsetDetector = new OnsetDetector(
      opts.mapping?.onsetSensitivity != null ? { sensitivity: opts.mapping.onsetSensitivity } : {}
    );
    this.pendingOnset = false;
    this.sampleRate = opts.sampleRate ?? 44100;
  }

  setFormat({ sampleRate, channels }) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.splitter.setSampleRate(sampleRate);
  }

  /** Feed one PCM chunk (interleaved s16le). */
  onChunk(buf) {
    const m = this.splitter.process(buf, this.channels);
    const dt = durationMs(buf.length, this.sampleRate, this.channels);
    const g = this.gain;
    const clamp = (v) => Math.min(v * g, 1);
    this.env.rms.update(clamp(m.level), dt);
    this.env.peak.update(clamp(m.peak), dt);
    this.env.left.update(clamp(m.left), dt);
    this.env.right.update(clamp(m.right), dt);
    // bands carry less energy each; boost so a full-band signal still reaches ~1
    this.env.bass.update(clamp(m.bass * 1.5), dt);
    this.env.mid.update(clamp(m.mid * 2.5), dt);
    this.env.treble.update(clamp(m.treble * 4), dt);
    if (this.onsetDetector.update(m.bass * g, this.now())) this.pendingOnset = true;
  }

  /** Read the current feature set; the onset flag is consumed (fires once). */
  snapshot() {
    const e = this.env;
    const onset = this.pendingOnset;
    this.pendingOnset = false;
    return {
      rms: e.rms.value,
      peak: e.peak.value,
      left: e.left.value,
      right: e.right.value,
      bass: e.bass.value,
      mid: e.mid.value,
      treble: e.treble.value,
      energy: Math.min(1, e.bass.value * 0.5 + e.mid.value * 0.35 + e.treble.value * 0.15 + e.rms.value * 0.2),
      onset,
    };
  }
}

module.exports = { FeatureExtractor, BandSplitter, OnsetDetector };
