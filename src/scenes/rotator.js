'use strict';

/**
 * Scene rotation: every time a watched Roon zone starts a new track, activate a
 * different installed Nanoleaf music scene. The device's own Rhythm engine does
 * the visualization; this module only decides *which* scene shows *when*.
 */

const { ScenePicker, filterScenes } = require('./picker');
const { isMusicEffect, NanoleafHttpError } = require('../nanoleaf/client');
const log = require('../log')('scenes');

/** Configuration-shaped problems (no scenes to rotate) — not transient failures. */
class SceneConfigError extends Error {}

const ONSTOP_RETRIES = 3;
const ONSTOP_RETRY_DELAY_MS = 5000;

class SceneRotator {
  /**
   * @param {{ client: import('../nanoleaf/client').NanoleafClient,
   *           watcher: import('node:events').EventEmitter,
   *           config: { include: string[], exclude: string[], musicOnly: boolean,
   *                     onStop: string, minSeconds: number },
   *           onStatus?: (msg: string, isError?: boolean) => void,
   *           now?: () => number,
   *           delay?: (ms: number) => Promise<void>,
   *           rng?: () => number }} opts
   */
  constructor(opts) {
    this.client = opts.client;
    this.watcher = opts.watcher;
    this.config = opts.config;
    this.onStatus = opts.onStatus ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rng = opts.rng;
    this.picker = null;
    this.onStopEffect = null;  // canonical installed name for a named onStop, or null
    this.lastSwitchAt = 0;
    this.currentScene = null;
    this.poweredOff = false;
    this._chain = Promise.resolve(); // serializes async reactions to events

    this._onTrack = (track) => this._enqueue(() => this.handleTrack(track));
    this._onIdle = () => this._enqueue(() => this.handleIdle());
    this._onPlaying = () => this._enqueue(() => this.handlePlaying());
  }

  /** Discover rotation candidates and start listening. */
  async start() {
    await this.refreshScenes();
    // Best-effort: learn the current power state, so a service restart that
    // happened while the panels were off (onStop "off") still recovers.
    try {
      const info = await this.client.getInfo();
      if (info?.state?.on?.value === false) this.poweredOff = true;
    } catch (err) {
      log.debug('could not read power state at startup:', err.message);
    }
    this.watcher.on('track', this._onTrack);
    this.watcher.on('idle', this._onIdle);
    this.watcher.on('playing', this._onPlaying);
    const n = this.picker.scenes.length;
    log.info(`rotating ${n} scene${n === 1 ? '' : 's'}: ${this.picker.scenes.join(', ')}`);
    this.onStatus(`Scene rotation ready — ${n} music scene${n === 1 ? '' : 's'}`);
  }

  stop() {
    this.watcher.off('track', this._onTrack);
    this.watcher.off('idle', this._onIdle);
    this.watcher.off('playing', this._onPlaying);
  }

  /** (Re)build the candidate list from the device. */
  async refreshScenes() {
    let candidates;
    let installed;
    if (this.config.include.length > 0) {
      // explicit list: trust the user, just validate against what's installed
      installed = await this.client.getEffectsList();
      candidates = filterScenes(installed, { include: this.config.include });
      const missing = this.config.include.filter(
        (n) => !candidates.some((c) => c.toLowerCase() === n.toLowerCase())
      );
      if (missing.length) log.warn(`scenes.include entries not installed: ${missing.join(', ')}`);
    } else {
      const all = await this.client.getAllEffects();
      installed = all.map((e) => e.animName);
      const pool = this.config.musicOnly ? all.filter(isMusicEffect) : all;
      candidates = filterScenes(pool.map((e) => e.animName), { exclude: this.config.exclude });
    }
    if (candidates.length === 0) {
      throw new SceneConfigError(
        this.config.musicOnly
          ? 'no music scenes installed on the controller — download some Rhythm scenes from the ' +
            'Nanoleaf app\'s Discover tab, or list scenes explicitly in scenes.include ' +
            '(run with --list-scenes to see what\'s installed)'
          : 'no scenes matched the configured filters'
      );
    }
    this.picker = new ScenePicker(candidates, this.rng ? { rng: this.rng } : {});
    this._resolveOnStop(installed);
  }

  /** Canonicalize a named onStop against installed effects (select is case-sensitive). */
  _resolveOnStop(installedNames) {
    const action = this.config.onStop;
    if (action === 'keep' || action === 'off') {
      this.onStopEffect = null;
      return;
    }
    const hit = installedNames.find((n) => n.toLowerCase() === action.toLowerCase());
    if (!hit) {
      log.warn(`scenes.onStop "${action}" is not installed on the controller — falling back to "keep"`);
      this.onStatus(`scenes.onStop "${action}" not found — using "keep"`, true);
    }
    this.onStopEffect = hit ?? null;
  }

  async handleTrack(track) {
    // Power restoration is never rate-limited — the minSeconds window exists to
    // keep the current scene stable during rapid skipping, not to keep panels dark.
    if (!(await this._ensurePower())) return;
    const sinceLast = (this.now() - this.lastSwitchAt) / 1000;
    if (this.lastSwitchAt && sinceLast < this.config.minSeconds) {
      log.debug(`track change within ${this.config.minSeconds}s window — keeping current scene`);
      return;
    }
    try {
      const selected = await this._select(this.picker.next());
      this.lastSwitchAt = this.now();
      this.currentScene = selected;
      const who = [track.title, track.artist].filter(Boolean).join(' — ');
      log.info(`"${selected}" for: ${who}`);
      this.onStatus(`♪ ${selected} · ${who}`);
    } catch (err) {
      this.onStatus(`Scene switch failed: ${err.message}`, true);
      log.warn('scene switch failed:', err.message);
    }
  }

  /** Playback resumed mid-track ('track' won't fire): undo whatever onStop did. */
  async handlePlaying() {
    if (this.poweredOff) {
      await this._ensurePower();
      return;
    }
    // a named stop effect is showing → bring a music scene back
    if (this.onStopEffect && this.currentScene === this.onStopEffect) {
      try {
        const selected = await this._select(this.picker.next());
        this.lastSwitchAt = this.now();
        this.currentScene = selected;
        this.onStatus(`♪ ${selected} (resumed)`);
      } catch (err) {
        this.onStatus(`Scene switch failed: ${err.message}`, true);
        log.warn('resume scene switch failed:', err.message);
      }
    }
  }

  async handleIdle() {
    if (this.config.onStop === 'keep') return;
    try {
      if (this.config.onStop === 'off') {
        await this._retry(() => this.client.setPower(false), 'power-off');
        this.poweredOff = true;
        this.onStatus('Playback stopped — panels off');
      } else if (this.onStopEffect) {
        await this._retry(() => this.client.selectEffect(this.onStopEffect), 'stop-scene select');
        this.currentScene = this.onStopEffect;
        this.onStatus(`Playback stopped — ${this.onStopEffect}`);
      }
      // onStopEffect null (bad name, already warned): behave like "keep"
    } catch (err) {
      this.onStatus(`onStop action failed: ${err.message}`, true);
      log.warn('onStop action failed:', err.message);
    }
  }

  /** @returns {Promise<boolean>} panels are (now) on */
  async _ensurePower() {
    if (!this.poweredOff) return true;
    try {
      await this.client.setPower(true);
      this.poweredOff = false;
      return true;
    } catch (err) {
      this.onStatus(`Power-on failed: ${err.message}`, true);
      log.warn('power-on failed:', err.message);
      return false;
    }
  }

  /**
   * Select a scene; on 404 (renamed/deleted in the app since discovery) refresh
   * the pool once and pick a replacement. Returns the name actually selected.
   */
  async _select(scene) {
    try {
      await this.client.selectEffect(scene);
      return scene;
    } catch (err) {
      if (err instanceof NanoleafHttpError && err.status === 404) {
        log.warn(`scene "${scene}" no longer exists — refreshing scene list`);
        await this.refreshScenes();
        const replacement = this.picker.next();
        await this.client.selectEffect(replacement);
        return replacement;
      }
      throw err;
    }
  }

  /** Retry transient failures — a Wi-Fi blip during onStop must not leave panels on all night. */
  async _retry(fn, what, tries = ONSTOP_RETRIES, delayMs = ONSTOP_RETRY_DELAY_MS) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        // an HTTP status means the device answered — retrying won't change it
        if (attempt >= tries || err instanceof NanoleafHttpError) throw err;
        log.warn(`${what} failed (${err.message}) — retry ${attempt}/${tries - 1} in ${delayMs} ms`);
        await this.delay(delayMs);
      }
    }
  }

  /** Chain event reactions so scene switches never interleave. */
  _enqueue(fn) {
    this._chain = this._chain.catch(() => {}).then(fn).catch((err) => log.error(err));
  }
}

module.exports = { SceneRotator, SceneConfigError };
