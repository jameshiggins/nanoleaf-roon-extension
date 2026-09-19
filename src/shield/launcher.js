'use strict';

/**
 * Brings the Roon Shield app's Now Playing screen up on the NVIDIA Shield when music
 * starts, over wireless adb — Roon's "Display" auto-launch, but for our own remote.
 *
 * It runs from this always-on service rather than inside the Android app because a
 * sleeping Shield cuts app network access (deep Doze): the app can't hear Roon start,
 * but adb can still wake the box.
 *
 * Rules (each one is the user's, don't loosen them):
 *  - fire only on a first play (quiet → playing), never per track — the caller feeds
 *    us TrackWatcher 'playing' events, which already have that shape;
 *  - do nothing if the app is already on screen (Shield awake + app resumed);
 *  - at most one launch per cooldown window (30 min by default).
 *
 * Strictly best-effort: every failure is logged and swallowed — the Shield being off
 * or unreachable must never disturb the panel pipeline.
 */

const { execFile } = require('node:child_process');
const log = require('../log')('shield');

function defaultRun(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

class ShieldLauncher {
  /**
   * @param {{ adb?: string, adbKey?: string, target: string, component?: string, tab?: string,
   *           cooldownMs?: number, run?: Function, now?: () => number }} opts
   *   adbKey: private key the Shield already trusts. The service runs as SYSTEM, whose own
   *   adb key the Shield has never authorized; ADB_VENDOR_KEYS lends it the user's.
   */
  constructor(opts) {
    this.adb = opts.adb || 'adb';
    this.target = opts.target;
    this.component = opts.component || 'com.roonshield/.MainActivity';
    this.tab = opts.tab ?? 'nowplaying';
    this.cooldownMs = opts.cooldownMs ?? 30 * 60 * 1000;
    this.run = opts.run || defaultRun;
    this.now = opts.now || Date.now;
    this.env = opts.adbKey ? { ...process.env, ADB_VENDOR_KEYS: opts.adbKey } : process.env;
    this.lastLaunch = null;
    this.busy = false;
  }

  _adb(args) {
    return this.run(this.adb, args, { env: this.env, timeout: 15000 });
  }

  _shell(cmd) {
    return this._adb(['-s', this.target, 'shell', cmd]);
  }

  /**
   * Call when the watched zone goes quiet → playing.
   * @returns {Promise<'launched'|'already-up'|'cooldown'|'busy'|'error'>}
   */
  async onFirstPlay() {
    const t = this.now();
    if (this.busy) return 'busy';
    if (this.lastLaunch !== null && t - this.lastLaunch < this.cooldownMs) {
      log.debug('playback started, but the app was launched within the cooldown — leaving the Shield alone');
      return 'cooldown';
    }
    this.busy = true;
    try {
      await this._adb(['connect', this.target]);
      const state = await this._shell('dumpsys power | grep mWakefulness=; dumpsys activity activities | grep ResumedActivity');
      const awake = /mWakefulness=Awake/.test(state);
      const pkg = this.component.split('/')[0];
      const inFront = state.split('\n').some((l) => l.includes('ResumedActivity') && l.includes(` ${pkg}/`));
      if (awake && inFront) {
        log.debug('playback started with the app already on screen — nothing to do');
        return 'already-up';
      }
      if (!awake) await this._shell('input keyevent KEYCODE_WAKEUP');
      await this._shell(`am start -n ${this.component}${this.tab ? ` --es start_tab ${this.tab}` : ''}`);
      this.lastLaunch = t;
      log.info(`playback started — opened ${pkg} on the Shield (${awake ? 'was awake' : 'woke it'})`);
      return 'launched';
    } catch (err) {
      log.warn(`could not open the app on the Shield (${this.target}): ${err.message}`);
      return 'error';
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { ShieldLauncher };
