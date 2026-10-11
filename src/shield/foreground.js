'use strict';

/**
 * Watches which app is in the foreground on the NVIDIA Shield and, when a TV/media app comes
 * to the front, hands the Hegel amp back to its TV input right away — the fast path that makes
 * the amp follow the Shield instead of waiting out the idle timer in inputswitch.js.
 *
 * Why this works: everything on the Shield — video apps AND music apps — sends its audio out
 * through the TV to the amp's Optical 2, while Roon streams straight to the amp's Network input.
 * So "a Shield media app is in front" means "the TV is the source" → select Optical 2. Roon
 * playing pulls the amp back to Network on its own, so the two never fight.
 *
 * Rules (match inputswitch.js — don't loosen them):
 *  - only acts while Roon is idle (the caller starts us on 'idle', stops us on 'playing', and
 *    also guards onTrigger) — never switch the amp off Network mid-song;
 *  - only the apps in `triggerApps` count; the Roon Shield visualiser is deliberately NOT one,
 *    so it can be on screen during network playback without flipping the amp to the TV;
 *  - edge-triggered: one hand-back when a media app comes to the front, not once per poll;
 *  - the Shield being asleep or unreachable is logged at debug and ignored, never retried hard.
 *
 * The actual amp move (read the input, switch only if it is still on Network) is delegated to
 * HegelInputSwitch#handBack, so there is exactly one place that talks to the amp.
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

/**
 * Pull the foreground package out of `dumpsys activity activities | grep ResumedActivity`.
 * Lines look like: `  mResumedActivity: ActivityRecord{hash u0 com.plexapp.android/.Act t42}`.
 * Prefers the `mResumedActivity` line; returns the package before the `/`, or null.
 */
function parseForegroundPackage(out) {
  const lines = String(out || '').split('\n').filter((l) => l.includes('ResumedActivity'));
  lines.sort((a, b) => Number(b.includes('mResumedActivity')) - Number(a.includes('mResumedActivity')));
  for (const l of lines) {
    const m = /\s([a-zA-Z][a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+/.exec(l);
    if (m) return m[1];
  }
  return null;
}

class ShieldForegroundWatcher {
  /**
   * @param {{ adb?: string, adbKey?: string, target: string, triggerApps?: string[],
   *           pollMs?: number, onTrigger?: (pkg: string) => any, run?: Function,
   *           setInterval?: Function, clearInterval?: Function }} opts
   */
  constructor(opts) {
    this.adb = opts.adb || 'adb';
    this.target = opts.target;
    this.triggerApps = new Set(opts.triggerApps || []);
    this.pollMs = opts.pollMs ?? 4000;
    this.onTrigger = opts.onTrigger || (() => {});
    this.run = opts.run || defaultRun;
    this.setInterval = opts.setInterval || setInterval;
    this.clearInterval = opts.clearInterval || clearInterval;
    this.env = opts.adbKey ? { ...process.env, ADB_VENDOR_KEYS: opts.adbKey } : process.env;
    this.timer = null;
    this.lastPkg = null;   // for edge-triggering; null means "re-evaluate the next poll"
    this.connected = false;
    this.polling = false;
  }

  _adb(args) {
    return this.run(this.adb, args, { env: this.env, timeout: 15000 });
  }

  _shell(cmd) {
    return this._adb(['-s', this.target, 'shell', cmd]);
  }

  /** One foreground check. Awake + a known media app in front (and newly so) → onTrigger(pkg). */
  async poll() {
    if (this.polling) return;              // never overlap a slow poll with the next tick
    this.polling = true;
    try {
      if (!this.connected) {
        await this._adb(['connect', this.target]);
        this.connected = true;
      }
      const out = await this._shell(
        'dumpsys power | grep mWakefulness=; dumpsys activity activities | grep ResumedActivity'
      );
      if (!/mWakefulness=Awake/.test(out)) { this.lastPkg = null; return; }
      const pkg = parseForegroundPackage(out);
      if (!pkg) return;
      if (pkg === this.lastPkg) return;    // same app still in front — nothing new
      this.lastPkg = pkg;
      if (this.triggerApps.has(pkg)) {
        log.debug(`Shield foreground → ${pkg} (a TV/media app) — handing the amp to the TV input`);
        await this.onTrigger(pkg);
      }
    } catch (err) {
      this.connected = false;              // force a reconnect on the next tick
      log.debug(`Shield foreground check failed (${this.target}): ${err.message}`);
    } finally {
      this.polling = false;
    }
  }

  /** Begin polling (idempotent). Re-evaluates the foreground fresh on the first tick. */
  start() {
    if (this.timer !== null) return;
    this.lastPkg = null;
    this.timer = this.setInterval(() => { this.poll(); }, this.pollMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer !== null) this.clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { ShieldForegroundWatcher, parseForegroundPackage, defaultRun };
