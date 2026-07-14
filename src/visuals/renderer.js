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
 */

const { FeatureExtractor } = require('../dsp/features');
const { generatePalettes } = require('./palettes');
const { visualNames, createVisual } = require('./visualizers');
const { ShuffleBag, filterNames } = require('./shuffle');
const log = require('../log')('visuals');

class VisualRenderer {
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

    const names = filterNames(visualNames(), { include: this.config.include, exclude: this.config.exclude });
    if (names.length === 0) throw new Error('no visualizers left after include/exclude filtering');
    const missing = (this.config.include || []).filter(
      (n) => !visualNames().some((v) => v.toLowerCase() === n.toLowerCase())
    );
    if (missing.length) log.warn(`visuals.include entries unknown: ${missing.join(', ')}`);

    this.visualBag = new ShuffleBag(names, { rng: this.rng });
    this.palettes = generatePalettes(this.config.palettes);
    this.paletteBag = new ShuffleBag(this.palettes.map((_, i) => i), { rng: this.rng });

    this.visual = null;
    this.currentName = null;
    this.currentPalette = null;
    this.gate = 0;             // master silence gate [0,1]
    this.lastRotateAt = 0;
    this.renderTimer = null;
    this.rotateTimer = null;

    this._onFormat = (fmt) => this.features.setFormat(fmt);
    this._onPcm = (chunk) => this.features.onChunk(chunk);
  }

  start() {
    this.rotate(true); // pick the first combo
    this.source.on('format', this._onFormat);
    this.source.on('pcm', this._onPcm);
    this.renderTimer = setInterval(() => this.renderFrame(), 1000 / this.fps);
    if (typeof this.config.rotate === 'number' && this.config.rotate > 0) {
      this.rotateTimer = setInterval(() => this.rotate(false), this.config.rotate * 1000);
    }
  }

  stop() {
    clearInterval(this.renderTimer);
    clearInterval(this.rotateTimer);
    this.source.off('format', this._onFormat);
    this.source.off('pcm', this._onPcm);
    this.streamer.blackout(this.layout.map((p) => p.id));
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

  /** Swap in a new visualizer + palette. */
  rotate(initial) {
    this.currentName = this.visualBag.next();
    const paletteIndex = this.paletteBag.next();
    this.currentPalette = this.palettes[paletteIndex];
    this.visual = createVisual(this.currentName, this.layout, this.currentPalette, this.rng);
    this.lastRotateAt = this.now();
    const label = `${this.currentName} · ${this.currentPalette.name}`;
    log.info(`${initial ? 'starting with' : 'switching to'} ${label}`);
    this.onStatus(`▶ ${label}`);
  }

  renderFrame() {
    const f = this.features.snapshot();
    // Silence gate: rise quickly when sound returns, fall gently on quiet.
    const target = f.energy > this.config.silenceFloor ? 1 : 0;
    const rate = target > this.gate ? 0.5 : 0.06; // per frame
    this.gate += (target - this.gate) * rate;
    if (this.gate < 0.01) this.gate = target === 0 ? 0 : this.gate;

    const frame = this.visual.render(f, 1000 / this.fps);
    if (this.gate < 0.999) {
      for (const p of frame) {
        p.r *= this.gate;
        p.g *= this.gate;
        p.b *= this.gate;
      }
    }
    this.streamer.sendFrame(frame);
    return frame;
  }
}

module.exports = { VisualRenderer };
