'use strict';

/**
 * Scene rotation: every time a watched Roon zone starts a new track, activate a
 * different installed Nanoleaf music scene. The device's own Rhythm engine does
 * the visualization; this module only decides *which* scene shows *when*.
 */

const { ScenePicker, filterScenes } = require('./picker');
const { isMusicEffect, NanoleafHttpError } = require('../nanoleaf/client');
const log = require('../log')('scenes');

class SceneRotator {
  /**
   * @param {{ client: import('../nanoleaf/client').NanoleafClient,
   *           watcher: import('node:events').EventEmitter,
   *           config: { include: string[], exclude: string[], musicOnly: boolean,
   *                     onStop: string, minSeconds: number },
   *           onStatus?: (msg: string, isError?: boolean) => void,
   *           now?: () => number,
   *           rng?: () => number }} opts
   */
  constructor(opts) {
    this.client = opts.client;
    this.watcher = opts.watcher;
    this.config = opts.config;
    this.onStatus = opts.onStatus ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng;
    this.picker = null;
    this.lastSwitchAt = 0;
    this.currentScene = null;
    this.poweredOff = false;
    this._chain = Promise.resolve(); // serializes async reactions to events

    this._onTrack = (track) => this._enqueue(() => this.handleTrack(track));
    this._onIdle = () => this._enqueue(() => this.handleIdle());
  }

  /** Discover rotation candidates and start listening. */
  async start() {
    await this.refreshScenes();
    this.watcher.on('track', this._onTrack);
    this.watcher.on('idle', this._onIdle);
    const n = this.picker.scenes.length;
    log.info(`rotating ${n} scene${n === 1 ? '' : 's'}: ${this.picker.scenes.join(', ')}`);
    this.onStatus(`Scene rotation ready — ${n} music scene${n === 1 ? '' : 's'}`);
  }

  stop() {
    this.watcher.off('track', this._onTrack);
    this.watcher.off('idle', this._onIdle);
  }

  /** (Re)build the candidate list from the device. */
  async refreshScenes() {
    let candidates;
    if (this.config.include.length > 0) {
      // explicit list: trust the user, just validate against what's installed
      const installed = await this.client.getEffectsList();
      candidates = filterScenes(installed, { include: this.config.include });
      const missing = this.config.include.filter(
        (n) => !candidates.some((c) => c.toLowerCase() === n.toLowerCase())
      );
      if (missing.length) log.warn(`scenes.include entries not installed: ${missing.join(', ')}`);
    } else {
      const all = await this.client.getAllEffects();
      const pool = this.config.musicOnly ? all.filter(isMusicEffect) : all;
      candidates = filterScenes(pool.map((e) => e.animName), { exclude: this.config.exclude });
    }
    if (candidates.length === 0) {
      throw new Error(
        this.config.musicOnly
          ? 'no music scenes installed on the controller — download some Rhythm scenes from the ' +
            'Nanoleaf app\'s Discover tab, or list scenes explicitly in scenes.include ' +
            '(run with --list-scenes to see what\'s installed)'
          : 'no scenes matched the configured filters'
      );
    }
    this.picker = new ScenePicker(candidates, this.rng ? { rng: this.rng } : {});
  }

  async handleTrack(track) {
    const sinceLast = (this.now() - this.lastSwitchAt) / 1000;
    if (this.lastSwitchAt && sinceLast < this.config.minSeconds) {
      log.debug(`track change within ${this.config.minSeconds}s window — keeping current scene`);
      return;
    }
    const scene = this.picker.next();
    try {
      if (this.poweredOff) {
        await this.client.setPower(true);
        this.poweredOff = false;
      }
      await this._select(scene);
      this.lastSwitchAt = this.now();
      this.currentScene = scene;
      const who = [track.title, track.artist].filter(Boolean).join(' — ');
      log.info(`"${scene}" for: ${who}`);
      this.onStatus(`♪ ${scene} · ${who}`);
    } catch (err) {
      this.onStatus(`Scene switch failed: ${err.message}`, true);
      log.warn('scene switch failed:', err.message);
    }
  }

  /** Select, refreshing the candidate list once if the scene vanished (renamed/deleted in the app). */
  async _select(scene) {
    try {
      await this.client.selectEffect(scene);
    } catch (err) {
      if (err instanceof NanoleafHttpError && err.status === 404) {
        log.warn(`scene "${scene}" no longer exists — refreshing scene list`);
        await this.refreshScenes();
        await this.client.selectEffect(this.picker.next());
        return;
      }
      throw err;
    }
  }

  async handleIdle() {
    const action = this.config.onStop;
    if (action === 'keep') return;
    try {
      if (action === 'off') {
        await this.client.setPower(false);
        this.poweredOff = true;
        this.onStatus('Playback stopped — panels off');
      } else {
        await this.client.selectEffect(action);
        this.currentScene = action;
        this.onStatus(`Playback stopped — ${action}`);
      }
    } catch (err) {
      this.onStatus(`onStop action failed: ${err.message}`, true);
      log.warn('onStop action failed:', err.message);
    }
  }

  /** Chain event reactions so scene switches never interleave. */
  _enqueue(fn) {
    this._chain = this._chain.catch(() => {}).then(fn).catch((err) => log.error(err));
  }
}

module.exports = { SceneRotator };
