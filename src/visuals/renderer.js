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
 * Panel ownership: the renderer only holds the panels while Roon is playing. It
 * `acquire()`s on the first 'playing' event — saving the selected effect and power
 * state first — and `release()`s (debounced) when Roon goes idle, restoring exactly
 * what it found. While released it sends nothing, so the Nanoleaf app / schedule /
 * whatever had the panels keeps them. Without this the panels sit in extControl
 * forever, streaming black, and never go back to their normal effect.
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

    // Panel ownership. While not acquired we run no render timer and send no frames,
    // so whatever effect the panels were showing stays on screen.
    this.client = opts.client || null;
    this.releaseDebounceMs = opts.releaseDebounceMs ?? 5000;
    this.acquired = false;
    this.savedEffect = null;
    this.savedPower = null;
    this._acquireInFlight = false;
    this._releaseTimer = null;

    this._onFormat = (fmt) => this.features.setFormat(fmt);
    this._onPcm = (chunk) => this.features.onChunk(chunk);
  }

  /**
   * Attach to the audio source and pick the first look. Frames do not flow until
   * acquire() — keeping the extractor warm means the first frame after acquire is
   * already band-informed rather than starting from silence.
   */
  start() {
    this.rotate(true); // pick the first combo
    this.source.on('format', this._onFormat);
    this.source.on('pcm', this._onPcm);
    if (typeof this.config.rotate === 'number' && this.config.rotate > 0) {
      this.rotateTimer = setInterval(() => this.rotate(false), this.config.rotate * 1000);
    }
  }

  /**
   * Take the panels: save what they were showing, power them on, enter extControl
   * and start streaming. Idempotent, and cancels a pending release.
   */
  async acquire() {
    if (this._releaseTimer) this._cancelPendingRelease();
    if (this.acquired || this._acquireInFlight) return;
    this._acquireInFlight = true;
    try {
      if (this.client) {
        try {
          // Snapshot before we touch anything, so release() can put it all back.
          // `*Dynamic*` means something was already streaming — not a restorable effect,
          // so keep any effect we saved on an earlier acquire that never released cleanly.
          const [effect, power] = await Promise.all([
            this.client.getSelectedEffect(),
            this.client.getPower(),
          ]);
          if (effect && effect !== '*Dynamic*' && String(effect).trim().length > 0) {
            this.savedEffect = effect;
            this.savedPower = power;
            log.info(`acquire: saved effect "${effect}" (panels were ${power ? 'on' : 'off'})`);
          } else if (this.savedEffect) {
            log.info(`acquire: reusing previously-saved effect "${this.savedEffect}"`);
          } else {
            log.info('acquire: panels were already in *Dynamic*; nothing to restore later');
          }
          await this.client.setPower(true);
          await this.client.enableExtControl();
        } catch (err) {
          log.error(`acquire failed: ${err.message}`);
        }
      }
      this.acquired = true;
      if (!this.renderTimer) {
        this.renderTimer = setInterval(() => this.renderFrame(), 1000 / this.fps);
      }
      log.info('acquired: streaming to panels');
    } finally {
      this._acquireInFlight = false;
    }
  }

  /** Give the panels back once Roon has been idle for the debounce window. */
  release({ debounceMs = this.releaseDebounceMs } = {}) {
    if (!this.acquired) return;
    if (this._releaseTimer) return; // already scheduled
    log.info(`release scheduled in ${debounceMs} ms (waiting for Roon idle)`);
    this._releaseTimer = setTimeout(() => this._doRelease(), debounceMs);
  }

  /** Release immediately, skipping the debounce (shutdown). */
  async releaseNow() {
    if (this._releaseTimer) this._cancelPendingRelease();
    if (!this.acquired) return;
    await this._doRelease();
  }

  _cancelPendingRelease() {
    if (this._releaseTimer) {
      clearTimeout(this._releaseTimer);
      this._releaseTimer = null;
      log.info('release cancelled — Roon resumed within the debounce window');
    }
  }

  async _doRelease() {
    this._releaseTimer = null;
    if (!this.acquired) return;
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    this.acquired = false;
    this.gate = 0; // next acquire fades up from black rather than resuming mid-look
    if (!this.client) return;
    try {
      if (this.savedEffect) {
        await this.client.selectEffect(this.savedEffect);
        log.info(`released: restored effect "${this.savedEffect}"`);
      } else {
        log.info('released: no saved effect to restore, panels stay in *Dynamic*');
      }
      // Selecting an effect powers the panels on, so restore power last — otherwise
      // panels that were off before we took them would be left on.
      if (this.savedPower === false) {
        await this.client.setPower(false);
        log.info('released: panels powered back off (they were off before)');
      }
    } catch (err) {
      log.error(`release: failed to restore panels: ${err.message}`);
    }
  }

  stop() {
    clearInterval(this.renderTimer);
    clearInterval(this.rotateTimer);
    clearTimeout(this._releaseTimer);
    this.renderTimer = null;
    this.rotateTimer = null;
    this._releaseTimer = null;
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
