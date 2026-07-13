'use strict';

/**
 * The one place audio becomes light.
 *
 * Scope guard: this is a time-domain loudness envelope only. No FFT, no band splitting,
 * no beat detection — that's an explicit non-goal of the project (see docs/PLAN.md §2).
 */

const { measure, EnvelopeFollower, durationMs } = require('./audio/pcm');

/**
 * Map the current envelope onto panel colors.
 * Pure function — unit-tested in isolation.
 *
 * @param {Array<{panelId: number, x: number}>} panels  layout positionData, any order
 * @param {{ mono: number, left: number, right: number }} env  envelope values in [0, 1]
 * @param {{ baseColor: number[], floor: number, stereo: boolean }} opts
 * @returns {Array<{id: number, r: number, g: number, b: number, transition: number}>}
 */
function mapEnvelopeToFrame(panels, env, opts) {
  const [br, bg, bb] = opts.baseColor;
  const sorted = [...panels].sort((a, b) => a.x - b.x);
  const mid = sorted.length / 2;

  return sorted.map((panel, i) => {
    let level;
    if (opts.stereo) {
      // left half follows the left channel, right half the right; blend near the middle
      const pos = sorted.length === 1 ? 0.5 : i / (sorted.length - 1); // 0 = leftmost
      level = env.left * (1 - pos) + env.right * pos;
    } else {
      level = env.mono;
    }
    if (level < opts.floor) level = 0;
    return {
      id: panel.panelId,
      r: br * level,
      g: bg * level,
      b: bb * level,
      transition: 1,
    };
  });
}

/**
 * Wires an AudioSource to a Streamer:
 * PCM chunks update three envelope followers (mono/left/right); a timer renders
 * frames at the configured fps so frame rate is decoupled from chunk rate.
 */
class Pipeline {
  /**
   * @param {{ source: import('node:events').EventEmitter,
   *           streamer: { sendFrame(panels): void, blackout(ids): void },
   *           panels: Array<{panelId: number, x: number}>,
   *           mapping: { attackMs, releaseMs, gain, baseColor, floor, stereo },
   *           fps?: number }} opts
   */
  constructor(opts) {
    this.source = opts.source;
    this.streamer = opts.streamer;
    this.panels = opts.panels;
    this.mapping = opts.mapping;
    this.fps = opts.fps ?? 30;
    this.format = { sampleRate: 44100, channels: 2 };
    const envOpts = { attackMs: this.mapping.attackMs, releaseMs: this.mapping.releaseMs };
    this.envMono = new EnvelopeFollower(envOpts);
    this.envLeft = new EnvelopeFollower(envOpts);
    this.envRight = new EnvelopeFollower(envOpts);
    this.renderTimer = null;

    this._onFormat = (fmt) => { this.format = fmt; };
    this._onPcm = (chunk) => this.onPcmChunk(chunk);
  }

  start() {
    this.source.on('format', this._onFormat);
    this.source.on('pcm', this._onPcm);
    this.renderTimer = setInterval(() => this.renderFrame(), 1000 / this.fps);
  }

  /** Update envelopes from one PCM chunk. Exposed for tests. */
  onPcmChunk(chunk) {
    const { rms, left, right } = measure(chunk, this.format.channels);
    const dt = durationMs(chunk.length, this.format.sampleRate, this.format.channels);
    const g = this.mapping.gain;
    this.envMono.update(Math.min(rms * g, 1), dt);
    this.envLeft.update(Math.min(left * g, 1), dt);
    this.envRight.update(Math.min(right * g, 1), dt);
  }

  /** Render the current envelope state to one frame. Exposed for tests. */
  renderFrame() {
    const frame = mapEnvelopeToFrame(
      this.panels,
      { mono: this.envMono.value, left: this.envLeft.value, right: this.envRight.value },
      this.mapping
    );
    this.streamer.sendFrame(frame);
    return frame;
  }

  stop() {
    clearInterval(this.renderTimer);
    this.source.off('format', this._onFormat);
    this.source.off('pcm', this._onPcm);
    this.streamer.blackout(this.panels.map((p) => p.panelId));
  }
}

module.exports = { Pipeline, mapEnvelopeToFrame };
