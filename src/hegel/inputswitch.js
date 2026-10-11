'use strict';

/**
 * Hands the Hegel amp back to the TV when Roon goes quiet.
 *
 * The amp jumps to its Network input by itself whenever Roon starts playing, but it never
 * leaves it — so after a listening session the TV's sound stays muted until someone reaches
 * for the Hegel remote. This watches the living-room zone and, once it has been idle for
 * `idleMs` (one minute by default), selects the TV's optical input over Hegel's IP-control
 * protocol (plain ASCII on TCP 50001, CR-terminated: `-i.?` asks for the input, `-i.6`
 * selects input 6).
 *
 * Rules (the user's — don't loosen them):
 *  - act on silence, not on app exits: only a zone that has been quiet for the full window;
 *  - play resuming inside the window cancels it (track gaps and queue changes don't flap);
 *  - only ever move the amp OFF Network — if it's on any other input, someone chose that;
 *  - best-effort: an unreachable amp is logged and forgotten, never retried in a loop.
 *
 * H190 inputs: 1 Balanced, 2 Analog 1, 3 Analog 2, 4 Coaxial, 5 Optical 1, 6 Optical 2,
 * 7 Optical 3, 8 USB, 9 Network.
 */

const net = require('node:net');
const log = require('../log')('hegel');

/** One command, one reply line. Resolves with whatever arrived (possibly '') on timeout/close. */
function defaultSend(host, port, command, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buf = '';
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(null, buf), timeoutMs);
    socket.setEncoding('ascii');
    socket.on('connect', () => socket.write(`${command}\r`));
    socket.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('\r')) finish(null, buf);
    });
    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish(null, buf));
  });
}

class HegelInputSwitch {
  /**
   * @param {{ host: string, port?: number, idleMs?: number, networkInput?: number,
   *           idleInput?: number, send?: Function, setTimeout?: Function, clearTimeout?: Function }} opts
   */
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port ?? 50001;
    this.idleMs = opts.idleMs ?? 60 * 1000;
    this.networkInput = opts.networkInput ?? 9;
    this.idleInput = opts.idleInput ?? 6;
    this.send = opts.send || defaultSend;
    this.setTimeout = opts.setTimeout || setTimeout;
    this.clearTimeout = opts.clearTimeout || clearTimeout;
    this.timer = null;
    this.busy = false;
  }

  /** Watched zone started playing: whatever countdown was running is void. */
  onPlaying() {
    if (this.timer === null) return;
    this.clearTimeout(this.timer);
    this.timer = null;
    log.debug('playback resumed — hand-back cancelled');
  }

  /** Watched zone went quiet: start the countdown (idempotent while one is running). */
  onIdle() {
    if (this.timer !== null) return;
    this.timer = this.setTimeout(() => {
      this.timer = null;
      this.handBack();
    }, this.idleMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Reads the amp's input and moves it off Network to idleInput if it's still there. Called both
   * by the idle countdown and by the Shield-foreground watcher; `reason` only tags the log line.
   * @param {string} [reason] why we're handing back (defaults to the quiet-window message)
   * @returns {Promise<'switched'|'left-alone'|'unknown'|'busy'|'error'>}
   */
  async handBack(reason) {
    if (this.busy) return 'busy';
    this.busy = true;
    try {
      const reply = await this.send(this.host, this.port, '-i.?');
      const m = /-i\.(\d+)/.exec(reply || '');
      if (!m) {
        log.warn(`could not read the amp's input at ${this.host}:${this.port} (reply ${JSON.stringify(reply || '')})`);
        return 'unknown';
      }
      const current = Number(m[1]);
      if (current !== this.networkInput) {
        log.debug(`amp is on input ${current}, not Network — leaving it alone`);
        return 'left-alone';
      }
      await this.send(this.host, this.port, `-i.${this.idleInput}`);
      const why = reason || `zone quiet for ${Math.round(this.idleMs / 1000)}s`;
      log.info(`${why} — switched the Hegel from Network to input ${this.idleInput}`);
      return 'switched';
    } catch (err) {
      log.warn(`could not reach the Hegel at ${this.host}:${this.port}: ${err.message}`);
      return 'error';
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { HegelInputSwitch, defaultSend };
