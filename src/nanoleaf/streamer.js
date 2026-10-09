'use strict';

/** extControl v2 UDP frame encoding and paced sending. Port 60222, big-endian. */

const dgram = require('node:dgram');
const log = require('../log')('stream');

const EXT_CONTROL_PORT = 60222;
const KEEPALIVE_MS = 1000; // controller drops extControl after ~10 s of silence
const ERROR_LOG_EVERY_MS = 10000; // a dead route fails every datagram; don't flood the log

/**
 * Encode one v2 frame.
 * @param {Array<{id: number, r: number, g: number, b: number, w?: number, transition?: number}>} panels
 *        transition is in units of 100 ms; default 0 = instant. The renderer stamps its
 *        `transition` lever (1 by default) so the controller glides between 10 Hz frames.
 * @returns {Buffer}
 */
function encodeFrameV2(panels) {
  const buf = Buffer.alloc(2 + panels.length * 8);
  buf.writeUInt16BE(panels.length, 0);
  let o = 2;
  for (const p of panels) {
    buf.writeUInt16BE(p.id, o);
    buf[o + 2] = clamp8(p.r);
    buf[o + 3] = clamp8(p.g);
    buf[o + 4] = clamp8(p.b);
    buf[o + 5] = clamp8(p.w ?? 0);
    buf.writeUInt16BE(p.transition ?? 0, o + 6);
    o += 8;
  }
  return buf;
}

function clamp8(v) {
  v = Math.round(v);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Sends frames at most once per fps interval — newest frame wins, no queueing —
 * and re-sends the last frame as a keepalive during silence.
 */
class Streamer {
  /**
   * @param {{ host: string, port?: number, fps?: number, socket?: dgram.Socket }} opts
   */
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port ?? EXT_CONTROL_PORT;
    this.intervalMs = 1000 / (opts.fps ?? 30);
    this.socket = opts.socket ?? dgram.createSocket('udp4');
    this.ownsSocket = !opts.socket;
    // An unhandled 'error' on a dgram socket throws → uncaughtException → the service
    // restarts mid-song. Losing frames is the streamer's normal failure mode: log, carry on.
    this._lastErrorAt = -Infinity;
    this._onSocketError = (err) => this._noteError(err);
    if (typeof this.socket.on === 'function') this.socket.on('error', this._onSocketError);
    this.lastSentAt = -Infinity;
    this.lastPayload = null;
    this.pending = null;
    this.flushTimer = null;
    this.keepaliveTimer = setInterval(() => this._keepalive(), KEEPALIVE_MS);
    this.keepaliveTimer.unref();
    this.closed = false;
  }

  /** Submit a frame. Sends now if the fps budget allows, else replaces the pending frame. */
  sendFrame(panels) {
    if (this.closed) return;
    const payload = encodeFrameV2(panels);
    const now = performance.now();
    const due = this.lastSentAt + this.intervalMs;
    // Half an interval of slack: the renderer's ticks land on Windows' coarse timer clock, so
    // a frame a few ms "early" is still this period's frame and goes straight out. Without
    // the slack it would park in `pending`, its flush timer would round up to the next clock
    // tick, the following frame would be early again, and the send point would drift later
    // every frame. Genuine bursts (several frames inside half a period) still coalesce.
    if (now >= due - this.intervalMs / 2) {
      this._transmit(payload, now);
    } else {
      this.pending = payload;
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          if (this.pending && !this.closed) this._transmit(this.pending, performance.now());
        }, due - now);
      }
    }
  }

  /** Address every panel with black (used on shutdown/stream loss). */
  blackout(panelIds) {
    this.sendFrame(panelIds.map((id) => ({ id, r: 0, g: 0, b: 0, transition: 1 })));
  }

  /**
   * Stop the last-frame keepalive from re-sending stale frames. Called on release so the
   * panels aren't held frozen on the last visual after we hand them back; the next
   * sendFrame() re-arms streaming normally.
   */
  pause() {
    this.lastPayload = null;
  }

  _transmit(payload, now) {
    this.pending = null;
    this.lastSentAt = now;
    this.lastPayload = payload;
    this._send(payload);
  }

  _keepalive() {
    if (this.closed || !this.lastPayload) return;
    if (performance.now() - this.lastSentAt < KEEPALIVE_MS) return;
    this._send(this.lastPayload);
  }

  _send(payload) {
    // With a callback, send failures come here instead of as an 'error' event.
    this.socket.send(payload, this.port, this.host, (err) => { if (err) this._noteError(err); });
  }

  _noteError(err) {
    const now = performance.now();
    if (now - this._lastErrorAt < ERROR_LOG_EVERY_MS) return;
    this._lastErrorAt = now;
    log.warn(`UDP send to ${this.host}:${this.port} failed: ${err.message}`);
  }

  close() {
    this.closed = true;
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.flushTimer);
    if (this.ownsSocket) this.socket.close();
    else if (typeof this.socket.off === 'function') this.socket.off('error', this._onSocketError);
  }
}

module.exports = { Streamer, encodeFrameV2, EXT_CONTROL_PORT };
