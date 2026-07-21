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
      mapping: {
        gain: this.config.gain,
        attackMs: this.config.attackMs,
        releaseMs: this.config.releaseMs,
        onsetSensitivity: this.config.onsetSensitivity,
      },
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

    // Externally-supplied palette (e.g. derived from album art), overriding the
    // pin/rotation until cleared. Set via setLivePalette() as fetches resolve.
    this.livePalette = null;

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

    // Panel ownership: the renderer only holds the panels while Roon is playing.
    // acquire() (on 'playing') saves the current effect + power, enters extControl and
    // streams; release() (debounced, on 'idle') restores exactly what it found. While
    // released the render timer is off and no frames go out, so whatever effect the
    // panels were showing stays on screen.
    this.client = opts.client || null;
    this.releaseDebounceMs = opts.releaseDebounceMs ?? this.config.releaseDebounceMs ?? 5000;
    // How often to re-assert extControl while acquired. The controller drops streaming
    // mode if anything else grabs the panels (someone picks a scene in the Nanoleaf app,
    // a schedule, HomeKit) — re-asserting on this interval takes ownership back within a
    // few seconds so the visuals always win while music plays.
    this.extControlKeepaliveMs = opts.extControlKeepaliveMs ?? this.config.extControlKeepaliveMs ?? 4000;
    this.acquired = false;      // realized: are we currently streaming / holding extControl
    this.savedEffect = null;
    this.savedPower = null;
    this._want = 'released';     // desired ownership, set synchronously by acquire()/release()
    this._reconciling = false;  // single-flight guard for the async transition
    this._reconcileAgain = false;
    this._reconcilePromise = Promise.resolve();
    this._releaseTimer = null;
    this._extControlTimer = null;

    this._onFormat = (fmt) => this.features.setFormat(fmt);
    this._onPcm = (chunk) => this.features.onChunk(chunk);
  }

  start() {
    this.started = true;
    this.rotate(true); // pick the first combo
    this.source.on('format', this._onFormat);
    this.source.on('pcm', this._onPcm);
    // NB: no render timer here — frames only flow once acquire() takes the panels.
    // Keeping the feature extractor warm means the first frame after acquire is
    // already band-informed rather than starting from silence.
    this._armRotateTimer();
  }

  stop() {
    this.started = false;
    clearInterval(this.renderTimer);
    clearInterval(this.rotateTimer);
    clearTimeout(this._releaseTimer);
    this._stopExtControlKeepalive();
    this.renderTimer = null;
    this.rotateTimer = null;
    this._releaseTimer = null;
    this.acquired = false;   // reset ownership so a reused renderer can re-acquire cleanly
    this._want = 'released';
    this.source.off('format', this._onFormat);
    this.source.off('pcm', this._onPcm);
    this.streamer.blackout(this.layout.map((p) => p.id));
  }

  // ---- panel ownership ----
  //
  // acquire()/release()/releaseNow() only set the DESIRED state (`_want`) and kick a
  // reconcile. _reconcile() is single-flight and drives the REALIZED state (this.acquired,
  // the render/keepalive timers, the controller's extControl mode) toward `_want`.
  // Separating desired from realized removes the races a single synchronous `acquired`
  // boolean had: an 'idle' arriving mid-acquire (was silently dropped), an acquire landing
  // during a release's restore (corrupted panel state), and shutdown firing before an
  // in-flight acquire finished (left panels stuck in extControl). Callers can await the
  // reconcile; concurrent calls share and await the same in-flight promise.

  /** Roon started playing: we want the panels. */
  acquire() {
    this._want = 'acquired';
    this._cancelPendingRelease();
    return this._reconcile();
  }

  /** Roon went idle: give the panels back after the debounce window. */
  release({ debounceMs = this.releaseDebounceMs } = {}) {
    this._want = 'released';
    if (this._releaseTimer) return; // debounce already scheduled
    if (!this.acquired && !this._reconciling) return; // nothing held or being taken
    log.info(`release scheduled in ${debounceMs} ms (waiting for Roon idle)`);
    this._releaseTimer = setTimeout(() => {
      this._releaseTimer = null;
      this._reconcile();
    }, debounceMs);
  }

  /** Release immediately, skipping the debounce (shutdown). Resolves once restored. */
  async releaseNow() {
    this._want = 'released';
    this._cancelPendingRelease();
    await this._reconcile();
  }

  _cancelPendingRelease() {
    if (this._releaseTimer) {
      clearTimeout(this._releaseTimer);
      this._releaseTimer = null;
      log.info('release cancelled — Roon resumed within the debounce window');
    }
  }

  /**
   * Single-flight reconcile: drive realized ownership toward `_want`, looping until it
   * matches. A concurrent call flags a re-run and returns the same in-flight promise, so
   * the latest intent always wins and awaiters see the final state.
   * @returns {Promise<void>}
   */
  _reconcile() {
    if (this._reconciling) {
      this._reconcileAgain = true;
      return this._reconcilePromise;
    }
    this._reconciling = true;
    this._reconcilePromise = (async () => {
      try {
        do {
          this._reconcileAgain = false;
          if (this._want === 'acquired' && !this.acquired) {
            await this._enterAcquired();
          } else if (this._want === 'released' && this.acquired) {
            if (this._releaseTimer) break; // debounce still pending; its timer re-runs us
            await this._exitAcquired();
          }
        } while (this._reconcileAgain);
      } finally {
        this._reconciling = false;
      }
    })();
    return this._reconcilePromise;
  }

  async _enterAcquired() {
    if (this.client) {
      try {
        // Snapshot before touching anything so release can put it back. `*Dynamic*` means
        // something was already streaming (not restorable) — keep any effect saved earlier.
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
    if (!this.renderTimer) this.renderTimer = setInterval(() => this.renderFrame(), 1000 / this.fps);
    this._startExtControlKeepalive();
    log.info('acquired: streaming to panels');
    this.emit('state', this.getState());
  }

  async _exitAcquired() {
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    this._stopExtControlKeepalive();
    this.streamer.pause(); // stop the UDP last-frame keepalive so the panels aren't frozen
    this.acquired = false;
    this.gate = 0; // next acquire fades up from black rather than resuming mid-look
    if (this.client) {
      try {
        if (this.savedEffect) {
          await this.client.selectEffect(this.savedEffect);
          log.info(`released: restored effect "${this.savedEffect}"`);
        } else {
          log.info('released: no saved effect to restore, panels stay in *Dynamic*');
        }
        // Selecting an effect powers panels on, so restore power last — otherwise panels
        // that were off before we took them would be left on.
        if (this.savedPower === false) {
          await this.client.setPower(false);
          log.info('released: panels powered back off (they were off before)');
        }
      } catch (err) {
        log.error(`release: failed to restore panels: ${err.message}`);
      }
    }
    this.emit('state', this.getState());
  }

  /**
   * Re-assert extControl on an interval so the visuals reclaim the panels if anything else
   * takes them (a scene picked in the Nanoleaf app, a schedule) — the controller silently
   * leaves streaming mode and ignores our frames until we re-enter it.
   */
  _startExtControlKeepalive() {
    if (this._extControlTimer || !this.client) return;
    this._extControlTimer = setInterval(async () => {
      if (!this.acquired || this._keepaliveInFlight) return;
      this._keepaliveInFlight = true;
      try {
        // Only re-assert when the controller has actually left extControl (someone set a
        // scene / a schedule fired). Re-asserting unconditionally every tick can hitch the
        // panels mid-stream — a cheap GET here avoids that while still reclaiming fast.
        const sel = await this.client.getSelectedEffect();
        if (this.acquired && sel !== '*Dynamic*') {
          await this.client.enableExtControl();
          log.info('extControl reclaimed — panels had been set to a scene');
        }
      } catch (err) {
        log.debug(`extControl keepalive: ${err.message}`);
      } finally {
        this._keepaliveInFlight = false;
      }
    }, this.extControlKeepaliveMs);
    this._extControlTimer.unref();
  }

  _stopExtControlKeepalive() {
    if (this._extControlTimer) {
      clearInterval(this._extControlTimer);
      this._extControlTimer = null;
    }
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
    const palette = this.livePalette || this.pinnedPalette || this.palettes[this.paletteBag.next()];
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
    // Stall detection: if the loop is late by 3+ frames, something blocked the event loop
    // (GC, a synchronous op, a stalled log write). Logs the gap so we can correlate freezes.
    const nowMs = this.now();
    if (this._lastFrameAt) {
      const gap = nowMs - this._lastFrameAt;
      const expected = 1000 / this.fps;
      if (gap > expected * 3) log.warn(`render stall: ${Math.round(gap)}ms gap (expected ~${Math.round(expected)}ms)`);
    }
    this._lastFrameAt = nowMs;

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
      acquired: this.acquired,
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

  /**
   * Apply an externally-derived palette (e.g. extracted from album art) and keep
   * it across scene rotations until cleared. Rebuilds the current visual so its
   * hues actually change (the tone pass alone can't inject new hues).
   * @returns {string|null} the palette name, or null if none was given
   */
  setLivePalette(palette) {
    if (!palette) return null;
    this.livePalette = palette;
    this._apply(this.currentName || this.visualBag.next(), palette, 'album colors');
    return palette.name;
  }

  /** Drop the live palette and recolor to the pinned (or next rotation) palette. */
  clearLivePalette() {
    if (!this.livePalette) return;
    this.livePalette = null;
    const palette = this.pinnedPalette || this.palettes[this.paletteBag.next()];
    this._apply(this.currentName || this.visualBag.next(), palette, 'album colors off');
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
    // Floor a numeric interval to minSeconds (>=1s): the config-load floor doesn't apply
    // on the live command path, and a tiny value would arm a runaway rotate/render storm.
    if (typeof mode === 'number') mode = Math.max(this.config.minSeconds || 1, mode);
    this.config.rotate = mode;
    this._armRotateTimer();
    this.emit('state', this.getState());
    return mode;
  }
}

module.exports = { VisualRenderer };
