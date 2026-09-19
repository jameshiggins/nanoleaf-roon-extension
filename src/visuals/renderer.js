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
const { generatePalettes, resolvePalette, previewColors, CURATED } = require('./palettes');
const { visualNames, describeVisuals, createVisual } = require('./visualizers');
const { ShuffleBag, filterNames } = require('./shuffle');
const { VISUALS_LEVERS, validateLever } = require('../config');
const { prepareLayout } = require('./layout');
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
    // rawLayout + baseOrientation enable live re-rotation (rotateLayout lever);
    // plain opts.layout still works for tests and callers that pre-prepare.
    this.rawLayout = opts.rawLayout ?? null;
    this.baseOrientation = opts.baseOrientation ?? 0;
    this.panelSide = opts.panelSide ?? 0;
    this.config = opts.config;
    this.layout = this.rawLayout
      ? prepareLayout(this.rawLayout, this.baseOrientation + (this.config.rotateLayout || 0))
      : opts.layout;
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
    // curated presets (Nanoleaf classics) first, then the procedural set
    this.palettes = [...CURATED, ...generatePalettes(this.config.palettes)];
    this.paletteBag = new ShuffleBag(this.palettes.map((_, i) => i), { rng: this.rng });

    // Optional palette pin: freeze the colors on one palette while scenes still
    // rotate. Config validation already checked the name resolves.
    this.pinnedPalette = null;
    if (this.config.palette) {
      this.pinnedPalette = resolvePalette(this.config.palette, this.config.palettes);
      if (!this.pinnedPalette) throw new Error(`unknown palette pin: ${this.config.palette}`);
    }
    // Multi-pin: rotation shuffles among just these (overrides the single pin).
    // Unknown names are dropped rather than fatal — the set may come from an older config.
    this.pinnedSet = (this.config.palettePins || [])
      .map((n) => this.palettes.find((p) => p.name.toLowerCase() === String(n).toLowerCase()))
      .filter(Boolean);

    // Externally-supplied palette (e.g. derived from album art), overriding the
    // pin/rotation until cleared. Set via setLivePalette() as fetches resolve.
    this.livePalette = null;
    // albumMixEvery turn counter: which palette changes go to the album palette.
    // Starts on an album turn so the first track always shows its cover colors.
    this.paletteTurn = 0;
    this.onAlbumTurn = true;

    this.visual = null;
    this.currentName = null;
    this.currentPalette = null;
    this.nowPlaying = null;    // { title, artist, album, zoneName } | null
    this.warning = null;       // operator-facing problem (e.g. FeedMonitor: no audio from Roon) | null
    this.gate = 0;            // master silence gate [0,1]
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
    // Fallback effect for release when no pre-play effect was snapshotted (a hard
    // restart mid-stream leaves panels in *Dynamic* with nothing saved).
    this.idleEffect = opts.idleEffect || '';
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
        const [effect, power, brightness] = await Promise.all([
          this.client.getSelectedEffect(),
          this.client.getPower(),
          this.client.getBrightness(),
        ]);
        // Panels must be at full brightness while we stream — the controller's global
        // brightness scales our frames, and an evening schedule dimming it reads as
        // "the wall is dead". Snapshot the old level so release puts it back.
        if (brightness != null) this.savedBrightness = brightness;
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
        await this.client.setBrightness(100);
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
    // Otherwise the first frame of the next session logs the whole released window
    // as a bogus multi-minute "render stall".
    this._lastFrameAt = null;
    this._stopExtControlKeepalive();
    this.streamer.pause(); // stop the UDP last-frame keepalive so the panels aren't frozen
    this.acquired = false;
    this.gate = 0; // next acquire fades up from black rather than resuming mid-look
    if (this.client) {
      try {
        const restore = this.savedEffect || this.idleEffect;
        if (restore) {
          await this.client.selectEffect(restore);
          log.info(`released: ${this.savedEffect ? `restored effect "${restore}"` : `no saved effect — selected idle effect "${restore}"`}`);
        } else {
          log.info('released: no saved effect to restore, panels stay in *Dynamic*');
        }
        // Put the pre-acquire brightness back (we forced 100 while streaming).
        if (this.savedBrightness != null && this.savedBrightness !== 100) {
          await this.client.setBrightness(this.savedBrightness);
          log.info(`released: brightness restored to ${this.savedBrightness}%`);
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
        // Same for brightness: a Nanoleaf app schedule dimming the controller mid-play
        // scales our frames toward black. Reclaim full brightness while streaming.
        const bri = await this.client.getBrightness();
        if (this.acquired && bri != null && bri < 100) {
          await this.client.setBrightness(100);
          log.info(`brightness reclaimed — controller had been dimmed to ${bri}%`);
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

  /**
   * Palette for the next look. Album colors (livePalette) normally win outright;
   * with albumMixEvery >= 2 they only take every Nth turn, with bag/pinned
   * palettes shuffling in between. Tracks whether this turn went to the album so
   * a late-arriving album palette (async art fetch) knows whether to apply.
   */
  /** Non-album palette choice: the multi-pin set, the single pin, or the global bag. */
  _pinnedOrBag() {
    if (this.pinnedSet && this.pinnedSet.length) {
      return this.pinnedSet[Math.floor(this.rng() * this.pinnedSet.length)];
    }
    return this.pinnedPalette || this.palettes[this.paletteBag.next()];
  }

  _rotationPalette() {
    if (!this.livePalette) {
      // no album palette in play — leave onAlbumTurn alone so a late-arriving
      // first album fetch still applies (it starts true for exactly that reason)
      return this._pinnedOrBag();
    }
    const every = Math.floor(this.config.albumMixEvery || 0);
    if (every < 2) { this.onAlbumTurn = true; return this.livePalette; }
    this.onAlbumTurn = this.paletteTurn++ % every === 0;
    return this.onAlbumTurn ? this.livePalette : this._pinnedOrBag();
  }

  /** Swap in a new visualizer + palette from the shuffle bags. */
  rotate(initial) {
    const name = this.visualBag.next();
    const palette = this._rotationPalette();
    this._apply(name, palette, initial ? 'starting with' : 'switching to');
  }

  _apply(name, palette, verb) {
    this.currentName = name;
    this.currentPalette = palette;
    this.visual = createVisual(name, this.layout, palette, this.rng, { flashStrength: this.config.flashStrength });
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
    const expected = 1000 / this.fps;
    // Animate on measured elapsed time, not the nominal period: setInterval never
    // burst-fires missed ticks, so a fixed dt turns every late tick into lost visual
    // time — the wall runs slow under jitter, then snaps back. Capped at 3 frames so
    // a long stall reads as a brief freeze instead of a forward teleport.
    let dtMs = expected;
    if (this._lastFrameAt) {
      const gap = nowMs - this._lastFrameAt;
      if (gap > expected * 3) log.warn(`render stall: ${Math.round(gap)}ms gap (expected ~${Math.round(expected)}ms)`);
      dtMs = Math.min(gap, expected * 3);
    }
    this._lastFrameAt = nowMs;

    const f = this.features.snapshot();
    this.lastFeatures = f;
    // Silence gate: rise quickly when sound returns, fall gently on quiet.
    const target = f.energy > this.config.silenceFloor ? 1 : 0;
    const rate = target > this.gate ? 0.5 : 0.06; // per frame
    this.gate += (target - this.gate) * rate;
    if (this.gate < 0.01) this.gate = target === 0 ? 0 : this.gate;

    const frame = this.visual.render(f, dtMs);
    // Vintage tone pass: only when the active palette opts in via sat/val < 1.
    // Absent (generated palettes) → treated as 1, so their output is unchanged.
    const pal = this.currentPalette;
    const sat = pal && pal.sat != null ? pal.sat : 1;
    const val = pal && pal.val != null ? pal.val : 1;
    if (sat < 1 || val < 1) toneMap(frame, sat, val);
    // Master brightness × silence gate in one pass (hardware brightness stays
    // pinned at 100 by the keepalive, so dimming happens in the frames themselves).
    const bright = (this.config.brightness ?? 1) * this.gate;
    if (bright < 0.999) {
      for (const p of frame) {
        p.r *= bright;
        p.g *= bright;
        p.b *= bright;
      }
    }
    // 100 ms hardware fade per frame (extControl transition is in 100 ms units).
    // The controller interpolates toward each new frame instead of snapping, so
    // frames that arrive clumped by WiFi jitter blend instead of stuttering.
    // Costs a little beat sharpness; drop back to 0 for instant-apply.
    for (const p of frame) p.transition = 1;
    this.streamer.sendFrame(frame);
    if (this.listenerCount('frame') > 0) this.emit('frame', frame, f, this.gate);
    return frame;
  }

  /**
   * Re-initialize the panels: power on, full brightness, extControl re-handshake.
   * The fix-everything button for "the wall is dark but the app looks fine" —
   * covers external dimming (Nanoleaf app/schedules) and dropped extControl mode.
   */
  async resetPanels() {
    if (!this.client) return { ok: false, error: 'no Nanoleaf client (audio-only mode?)' };
    try {
      await this.client.setPower(true);
      await this.client.setBrightness(100);
      if (this.acquired) await this.client.enableExtControl(); // re-handshake; UDP stream is already flowing
      log.info(`panel reset: power on, brightness 100${this.acquired ? ', extControl re-asserted' : ''}`);
      return { ok: true };
    } catch (err) {
      log.error(`panel reset failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
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
      warning: this.warning,
    };
  }

  /** The full catalogue the app offers as choices. Every visual is listed;
   *  `enabled` says whether it's currently in the rotation pool. Palettes carry
   *  their preview colors and a `curated` flag so the app can group presets. */
  getCatalogue() {
    return {
      visuals: describeVisuals().map((v) => ({ ...v, enabled: this.poolNames.includes(v.name) })),
      palettes: this.palettes.map((p) => ({ name: p.name, colors: previewColors(p), curated: CURATED.includes(p) })),
      layout: this.layout.map((p) => ({ id: p.id, nx: p.nx, ny: p.ny, mx: p.mx, my: p.my, o: p.o, shape: p.shape })),
      panelSide: this.panelSide || 0, // panel side length (mm) for a true-scale preview
    };
  }

  setNowPlaying(track) {
    this.nowPlaying = track;
    this.emit('state', this.getState());
  }

  /** Surface (or clear, with null) a problem in the companion app's state. */
  setWarning(message) {
    this.warning = message || null;
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
    const every = Math.floor(this.config.albumMixEvery || 0);
    if (every >= 2) {
      if (this.config.rotate === 'off') {
        // Nothing else rotates, so the track change itself consumes a mix turn.
        this.onAlbumTurn = this.paletteTurn++ % every === 0;
        const chosen = this.onAlbumTurn ? palette : this._pinnedOrBag();
        this._apply(this.currentName || this.visualBag.next(), chosen, this.onAlbumTurn ? 'album colors' : 'mixing in');
        return chosen.name;
      }
      // Rotation already took this turn (the art fetch resolves after onTrackChange):
      // only refresh the look when that turn went to the album palette.
      if (!this.onAlbumTurn) return palette.name;
    }
    this._apply(this.currentName || this.visualBag.next(), palette, 'album colors');
    return palette.name;
  }

  /** Drop the live palette and recolor to the pinned (or next rotation) palette. */
  clearLivePalette() {
    if (!this.livePalette) return;
    this.livePalette = null;
    const palette = this._pinnedOrBag();
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

  /** Current value of every live-settable visuals lever (for the companion menu). */
  getOptions() {
    const out = {};
    for (const key of Object.keys(VISUALS_LEVERS)) out[key] = this.config[key];
    return out;
  }

  /**
   * Set one visuals lever live (the control API's `set` command). Validates against the
   * lever schema and realizes the change per its `apply` mode.
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  setOption(key, value) {
    const v = validateLever(key, value);
    if (!v.ok) return v;
    switch (VISUALS_LEVERS[key].apply) {
      case 'gain': this.setGain(value); break;
      case 'rotate': this.setRotate(value); break;
      case 'fps': {
        // Re-arm the frame timer and the streamer's send budget at the new rate.
        this.config.fps = value;
        this.fps = value;
        if (this.renderTimer) {
          clearInterval(this.renderTimer);
          this.renderTimer = setInterval(() => this.renderFrame(), 1000 / this.fps);
        }
        if (this.streamer) this.streamer.intervalMs = 1000 / value;
        break;
      }
      case 'palette': {
        if (value === '') { this.config.palette = ''; this.pinnedPalette = null; break; }
        const p = resolvePalette(value, this.config.palettes);
        if (!p) return { ok: false, error: `unknown palette: ${value}` };
        this.config.palette = value;
        this.pinnedPalette = p;
        if (!this.livePalette) this._apply(this.currentName || this.visualBag.next(), p, 'pinned palette');
        break;
      }
      case 'palettePins': {
        const resolved = value
          .map((n) => this.palettes.find((p) => p.name.toLowerCase() === String(n).toLowerCase()))
          .filter(Boolean);
        this.config.palettePins = resolved.map((p) => p.name);
        this.pinnedSet = resolved;
        // Recolor right away so the tap has visible feedback (album palette still wins).
        if (!this.livePalette && resolved.length) {
          this._apply(this.currentName || this.visualBag.next(), this._pinnedOrBag(), 'pinned palettes');
        }
        break;
      }
      case 'layout': {
        this.config[key] = value;
        if (!this.rawLayout) break; // no raw coordinates to re-derive from
        this.layout = prepareLayout(this.rawLayout, this.baseOrientation + (this.config.rotateLayout || 0));
        // visuals capture the layout at creation — rebuild the current one in place
        if (this.currentName && this.currentPalette) {
          this.visual = createVisual(this.currentName, this.layout, this.currentPalette, this.rng,
            { flashStrength: this.config.flashStrength });
        }
        break;
      }
      case 'onset':
        this.config.onsetSensitivity = value;
        if (this.features.onsetDetector) this.features.onsetDetector.sensitivity = value;
        break;
      case 'features':
        this.config[key] = value;
        this._rebuildFeatures();
        break;
      case 'pool':
        this.config[key] = value;
        this._rebuildPool();
        break;
      case 'palettes':
        this.config.palettes = value;
        this._rebuildPalettes();
        break;
      default: // 'set' — stored; read live or applied on the next track/rotate
        this.config[key] = value;
    }
    this.emit('state', this.getState());
    return { ok: true };
  }

  /** Rebuild the visualizer pool + shuffle bag after include/exclude changed. */
  _rebuildPool() {
    const names = filterNames(visualNames(), { include: this.config.include, exclude: this.config.exclude });
    if (names.length === 0) { log.warn('include/exclude left no visualizers — keeping the current pool'); return; }
    this.poolNames = names;
    this.visualBag = new ShuffleBag(this.poolNames, { rng: this.rng });
  }

  /** Regenerate the palette set + bag (and re-resolve the pin) after palettes count changed. */
  _rebuildPalettes() {
    this.palettes = [...CURATED, ...generatePalettes(this.config.palettes)];
    this.paletteBag = new ShuffleBag(this.palettes.map((_, i) => i), { rng: this.rng });
    if (this.config.palette) this.pinnedPalette = resolvePalette(this.config.palette, this.config.palettes) || this.pinnedPalette;
  }

  /** Rebuild the feature extractor after envelope constants changed, carrying the format. */
  _rebuildFeatures() {
    const { sampleRate, channels } = this.features;
    this.features = new FeatureExtractor({
      mapping: {
        gain: this.config.gain,
        attackMs: this.config.attackMs,
        releaseMs: this.config.releaseMs,
        onsetSensitivity: this.config.onsetSensitivity,
      },
      now: this.now,
    });
    this.features.setFormat({ sampleRate, channels });
  }
}

module.exports = { VisualRenderer };
