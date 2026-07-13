'use strict';

/**
 * Pure PCM math over interleaved signed 16-bit little-endian samples.
 * No frequency-domain processing lives here (or anywhere in this project) by design.
 */

const FULL_SCALE = 32768;

/**
 * Measure one chunk of interleaved s16le audio.
 * Returns levels normalized to [0, 1], per channel and mixed.
 *
 * @param {Buffer} buf   interleaved s16le samples (odd trailing byte ignored)
 * @param {number} channels 1 or 2
 * @returns {{ peak: number, rms: number, left: number, right: number }}
 */
function measure(buf, channels = 2) {
  const samples = Math.floor(buf.length / 2);
  const frames = Math.floor(samples / channels);
  if (frames === 0) return { peak: 0, rms: 0, left: 0, right: 0 };

  let peak = 0;
  let sumSq = 0;
  let sumSqL = 0;
  let sumSqR = 0;

  for (let f = 0; f < frames; f++) {
    for (let ch = 0; ch < channels; ch++) {
      const s = buf.readInt16LE((f * channels + ch) * 2) / FULL_SCALE;
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sumSq += s * s;
      if (ch === 0) sumSqL += s * s;
      else sumSqR += s * s;
    }
  }

  const rms = Math.sqrt(sumSq / (frames * channels));
  const left = Math.sqrt(sumSqL / frames);
  const right = channels > 1 ? Math.sqrt(sumSqR / frames) : left;
  return { peak: Math.min(peak, 1), rms, left, right };
}

/**
 * One-pole attack/release envelope follower.
 * Rises toward the input with the attack time constant, falls with the release one.
 * update() is called once per PCM chunk with that chunk's level and duration.
 */
class EnvelopeFollower {
  /**
   * @param {{ attackMs?: number, releaseMs?: number }} [opts]
   */
  constructor(opts = {}) {
    this.attackMs = opts.attackMs ?? 5;
    this.releaseMs = opts.releaseMs ?? 180;
    this.value = 0;
  }

  /**
   * @param {number} level  instantaneous level in [0, 1]
   * @param {number} dtMs   duration this level represents, in milliseconds
   * @returns {number} the new envelope value in [0, 1]
   */
  update(level, dtMs) {
    const tau = level > this.value ? this.attackMs : this.releaseMs;
    // one-pole smoother over a dtMs step; tau 0 → track the input exactly
    if (tau <= 0) {
      this.value = level;
    } else {
      this.value += (level - this.value) * (1 - Math.exp(-dtMs / tau));
    }
    if (this.value < 0) this.value = 0;
    if (this.value > 1) this.value = 1;
    return this.value;
  }

  reset() {
    this.value = 0;
  }
}

/** Milliseconds of audio represented by a buffer of interleaved s16le samples. */
function durationMs(byteLength, sampleRate, channels) {
  return (byteLength / 2 / channels / sampleRate) * 1000;
}

module.exports = { measure, EnvelopeFollower, durationMs, FULL_SCALE };
