'use strict';

/**
 * The stream visual renderer.
 *
 * PCM chunks from the audio source feed a FeatureExtractor; a fixed-fps timer
 * asks the current visualizer to paint the panels from those features and hands
 * the frame to the extControl streamer. On every Roon track change (or a timer,
 * or never — configurable) it rotates to a fresh visualizer + palette combo, so
 * the look changes with the music while always reacting to the live audio.
 *
 * A master silence gate fades everything to black when the feed goes quiet, so
 * pauses and gaps between tracks look intentional rather than frozen.
 *
 * It is an EventEmitter so a control surface (the companion app's API) can
 * observe it and drive it live:
 *   'frame'  (frame[], features, gate)  — every rendered frame
 *   'rotate' ({visual, palette})        — the look changed
 *   'state'  (getState())               — any state change worth pushing
 */

const { EventEmitter } = require('node:events');
const { FeatureExtractor } = require('../dsp/features');
const { generatePalettes, resolvePalette } = require('./palettes');
const { visualNames, describeVisuals, createVisual } = require('./visualizers');
const { ShuffleBag, filterNames } = require('./shuffle');
const log = require('../log')('visuals');

/**
 * Mute a frame toward vintage tones: pull each pixel toward its own luma
 * (desaturate) and scale brightness. Applied per-frame when the active palette
 * carries `sat`/`val` < 1. Commutes with the silence gate's uniform scaling, so
 * ordering between the two doesn't matter.
 */
function toneMap(frame, sat, val) {
  for (const p of frame) {
    const luma = 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
    p.r = (luma + (p.r - luma) * sat) * val;
    p.g = (luma + (p.g - luma) * sat) * val;
    p.b = (luma + (p.b - luma) * sat) * val;
  }
}

class VisualRenderer extends EventEmitter {
  /**
   * @param {{ source: import('node:events').EventEmitter,
   *           streamer: { sendFrame(panels): void, blackout(ids): void },
   *           layout: Array<{id:number,nx:number,ny:number}>,
   *           config: object,   // the `visuals` config block
   *           fps?: number,
   *           onStatus?: (msg: string, isError?: boolean) => void,
   *           now?: () => number,
   *           rng?: () => number }} opts
   */
  constructor(opts) {
    super();
    this.source = opts.source;
    this.streamer = opts.streamer;
    this.layout = opts.layout;
    this.config = opts.config;
    this.fps = opts.fps ?? 30;
    this.onStatus = opts.onStatus ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;

    this.features = new FeatureExtractor({
      mapping: { gain: this.config.gain, attackMs: this.config.attackMs, releaseMs: this.config.releaseMs },
      now: this.now,
    });

    this.poolNames = filterNames(visualNames(), { include: this.config.include, exclude: this.config.exclude });
    if (this.poolNames.length === 0) throw new Error('no visualizers left after include/exclude filtering');
    const missing = (this.config.include || []).filter(
      (n) => !visualNames().some((v) => v.toLowerCase() === n.toLowerCase())
    );
    if (missing.length) log.warn(`visuals.include entries unknown: ${missing.join(', ')}`);

    this.visualBag = new ShuffleBag(this.poolNames, { rng: this.rng });
    this.palettes = generatePalettes(this.config.palettes);
    this.paletteBag = new ShuffleBag(this.palettes.map((_, i) => i), { rng: this.rng });

    // Optional palette pin: freeze the colors on one palette while scenes still
    // rotate. Config validation already checked the name resolves.
    this.pinnedPalette = null;
    if (this.config.palette) {
      this.pinnedPalette = resolvePalette(this.config.palette, this.config.palettes);
      if (!this.pinnedPalette) throw new Error(`unknown palette pin: ${this.config.palette}`);
    }

    this.visual = null;
    this.currentName = null;
    this.currentPalette = null;
    this.nowPlaying = null;    // { title, artist, album, zoneName } | null
    this.gate = 0;             // master silence gate [0,1]
    this.lastFeatures = this.features.snapshot();
    this.lastRotateAt = 0;
    this.started = false;
    this.renderTimer = null;
    this.rotateTimer = null;

    this._onFormat = (fmt) => this.features.setFormat(fmt);
    this._onPcm = (chunk) => this.features.onChunk(chunk);
  }

  start() {
    this.started = true;
    this.rotate(true); // pick the first combo
    this.source.on('format', this._onFormat);
    this.source.on('pcm', this._onPcm);
    this.renderTimer = setInterval(() => this.renderFrame(), 1000 / this.fps);
    this._armRotateTimer();
  }

  stop() {
    this.started = false;
    clearInterval(this.renderTimer);
    clearInterval(this.rotateTimer);
    this.source.off('format', this._onFormat);
    this.source.off('pcm', this._onPcm);
    this.streamer.blackout(this.layout.map((p) => p.id));
  }

  _armRotateTimer() {
    clearInterval(this.rotateTimer);
    this.rotateTimer = null;
    if (this.started && typeof this.config.rotate === 'number' && this.config.rotate > 0) {
      this.rotateTimer = setInterval(() => this.rotate(false), this.config.rotate * 1000);
    }
  }

  /** Called by the track watcher (or the rotate timer) to switch the look. */
  onTrackChange() {
    if (this.config.rotate !== 'track') return;
    const sinceLast = (this.now() - this.lastRotateAt) / 1000;
    if (this.lastRotateAt && sinceLast < this.config.minSeconds) {
      log.debug(`track change within ${this.config.minSeconds}s — keeping the current look`);
      return;
    }
    this.rotate(false);
  }

  /** Swap in a new visualizer + palette from the shuffle bags. */
  rotate(initial) {
    const name = this.visualBag.next();
    const palette = this.pinnedPalette || this.palettes[this.paletteBag.next()];
    this._apply(name, palette, initial ? 'starting with' : 'switching to');
  }

  _apply(name, palette, verb) {
    this.currentName = name;
    this.currentPalette = palette;
    this.visual = createVisual(name, this.layout, palette, this.rng);
    this.lastRotateAt = this.now();
    const label = `${name} · ${palette.name}`;
    log.info(`${verb} ${label}`);
    this.onStatus(`▶ ${label}`);
    this.emit('rotate', { visual: name, palette: palette.name });
    this.emit('state', this.getState());
  }

  renderFrame() {
    const f = this.features.snapshot();
    this.lastFeatures = f;
    // Silence gate: rise quickly when sound returns, fall gently on quiet.
    const target = f.energy > this.config.silenceFloor ? 1 : 0;
    const rate = target > this.gate ? 0.5 : 0.06; // per frame
    this.gate += (target - this.gate) * rate;
    if (this.gate < 0.01) this.gate = target === 0 ? 0 : this.gate;

    const frame = this.visual.render(f, 1000 / this.fps);
    // Vintage tone pass: only when the active palette opts in via sat/val < 1.
    // Absent (generated palettes) → treated as 1, so their output is unchanged.
    const pal = this.currentPalette;
    const sat = pal && pal.sat != null ? pal.sat : 1;
    const val = pal && pal.val != null ? pal.val : 1;
    if (sat < 1 || val < 1) toneMap(frame, sat, val);
    if (this.gate < 0.999) {
      for (const p of frame) {
        p.r *= this.gate;
        p.g *= this.gate;
        p.b *= this.gate;
      }
    }
    this.streamer.sendFrame(frame);
    if (this.listenerCount('frame') > 0) this.emit('frame', frame, f, this.gate);
    return frame;
  }

  // ---- control surface (used by the companion-app API) ----

  /** @returns {{visual, palette, paletteCount, gain, rotate, minSeconds, locked, nowPlaying, panels}} */
  getState() {
    return {
      visual: this.currentName,
      palette: this.currentPalette ? this.currentPalette.name : null,
      paletteCount: this.palettes.length,
      gain: this.config.gain,
      rotate: this.config.rotate,
      minSeconds: this.config.minSeconds,
      locked: this.config.rotate === 'off',
      nowPlaying: this.nowPlaying,
      panels: this.layout.length,
    };
  }

  /** The full catalogue the app offers as choices. */
  getCatalogue() {
    return {
      visuals: describeVisuals().filter((v) => this.poolNames.includes(v.name)),
      palettes: this.palettes.map((p) => p.name),
      layout: this.layout.map((p) => ({ id: p.id, nx: p.nx, ny: p.ny })),
    };
  }

  setNowPlaying(track) {
    this.nowPlaying = track;
    this.emit('state', this.getState());
  }

  /** Rotate immediately (manual "next"), independent of the rotate mode. */
  next() {
    this.rotate(false);
  }

  /** Pin a specific visualizer by name (case-insensitive). Returns the resolved name or null. */
  selectVisual(name) {
    const resolved = visualNames().find((v) => v.toLowerCase() === String(name).toLowerCase());
    if (!resolved) return null;
    this._apply(resolved, this.currentPalette || this.palettes[0], 'selecting');
    return resolved;
  }

  /** Pin a palette by name or index. Returns the resolved palette name or null. */
  selectPalette(nameOrIndex) {
    let palette = null;
    if (typeof nameOrIndex === 'number') {
      palette = this.palettes[nameOrIndex] || null;
    } else {
      palette = this.palettes.find((p) => p.name.toLowerCase() === String(nameOrIndex).toLowerCase()) || null;
    }
    if (!palette) return null;
    this._apply(this.currentName || this.visualBag.next(), palette, 'recoloring');
    return palette.name;
  }

  setGain(gain) {
    const g = Math.max(0, Math.min(100, Number(gain)));
    if (!Number.isFinite(g)) return this.config.gain;
    this.config.gain = g;
    this.features.gain = g;
    this.emit('state', this.getState());
    return g;
  }

  /** @param {'track'|'off'|number} mode */
  setRotate(mode) {
    if (mode !== 'track' && mode !== 'off' && !(typeof mode === 'number' && mode > 0)) return this.config.rotate;
    this.config.rotate = mode;
    this._armRotateTimer();
    this.emit('state', this.getState());
    return mode;
  }
}

module.exports = { VisualRenderer };
