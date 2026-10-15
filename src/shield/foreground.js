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
 * Timing (why it's a self-scheduling loop, not setInterval): the caller runs us only while Roon
 * is idle. start() checks immediately — so stopping music while already in Plex switches at once —
 * then reschedules `pollMs` after each check completes (no overlapping polls). When the Shield is
 * off/unreachable, `adb connect` is slow to fail, so after a few misses we back off to `backoffMs`
 * instead of hammering a powered-off TV; the first success drops straight back to the fast cadence.
 *
 * Rules (match inputswitch.js — don't loosen them):
 *  - only acts while Roon is idle (caller starts us on 'idle', stops on 'playing', and guards
 *    onTrigger) — never switch the amp off Network mid-song;
 *  - only the apps in `triggerApps` count; the Roon Shield visualiser is deliberately NOT one,
 *    so it can be on screen during network playback without flipping the amp to the TV;
 *  - edge-triggered: one hand-back when a media app comes to the front, not once per poll;
 *  - a sleeping Shield never triggers; an unreachable Shield is logged at debug and backed off.
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

const FG_CMD = 'dumpsys power | grep mWakefulness=; dumpsys activity activities | grep ResumedActivity';
const FAIL_BACKOFF_AFTER = 3; // consecutive misses before we slow down (Shield likely off)

class ShieldForegroundWatcher {
  /**
   * @param {{ adb?: string, adbKey?: string, target: string, triggerApps?: string[],
   *           pollMs?: number, backoffMs?: number, onTrigger?: (pkg: string) => any,
   *           run?: Function, setTimeout?: Function, clearTimeout?: Function }} opts
   */
  constructor(opts) {
    this.adb = opts.adb || 'adb';
    this.target = opts.target;
    this.triggerApps = new Set(opts.triggerApps || []);
    this.pollMs = opts.pollMs ?? 1000;
    this.backoffMs = opts.backoffMs ?? 5000;
    this.onTrigger = opts.onTrigger || (() => {});
    this.run = opts.run || defaultRun;
    this.setTimeout = opts.setTimeout || setTimeout;
    this.clearTimeout = opts.clearTimeout || clearTimeout;
    this.env = opts.adbKey ? { ...process.env, ADB_VENDOR_KEYS: opts.adbKey } : process.env;
    this.timer = null;
    this.running = false;
    this.lastPkg = null;   // for edge-triggering; null means "re-evaluate next check"
    this.connected = false;
    this.fails = 0;
  }

  _adb(args) {
    return this.run(this.adb, args, { env: this.env, timeout: 15000 });
  }

  _shell(cmd) {
    return this._adb(['-s', this.target, 'shell', cmd]);
  }

  /** One foreground check; schedules the next itself while running. */
  async tick() {
    let nextMs = this.pollMs;
    try {
      if (!this.connected) { await this._adb(['connect', this.target]); this.connected = true; }
      const out = await this._shell(FG_CMD);
      this.fails = 0;
      if (!/mWakefulness=Awake/.test(out)) {
        this.lastPkg = null;             // asleep: reset the edge so waking into a media app fires
      } else {
        const pkg = parseForegroundPackage(out);
        if (pkg && pkg !== this.lastPkg) {
          this.lastPkg = pkg;
          if (this.triggerApps.has(pkg)) {
            log.debug(`Shield foreground → ${pkg} (a TV/media app) — handing the amp to the TV input`);
            await this.onTrigger(pkg);
          }
        }
      }
    } catch (err) {
      this.connected = false;            // force a reconnect next time
      if (++this.fails >= FAIL_BACKOFF_AFTER) nextMs = this.backoffMs; // TV likely off — stop hammering
      log.debug(`Shield foreground check failed (${this.target}): ${err.message}`);
    }
    if (this.running) {
      this.timer = this.setTimeout(() => this.tick(), nextMs);
      if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  /** Begin watching (idempotent). Checks immediately, then every pollMs. */
  start() {
    if (this.running) return;
    this.running = true;
    this.lastPkg = null;
    this.fails = 0;
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { ShieldForegroundWatcher, parseForegroundPackage, defaultRun };
