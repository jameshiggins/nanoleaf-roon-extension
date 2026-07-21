'use strict';

/** extControl v2 UDP frame encoding and paced sending. Port 60222, big-endian. */

const dgram = require('node:dgram');

const EXT_CONTROL_PORT = 60222;
const KEEPALIVE_MS = 1000; // controller drops extControl after ~10 s of silence

/**
 * Encode one v2 frame.
 * @param {Array<{id: number, r: number, g: number, b: number, w?: number, transition?: number}>} panels
 *        transition is in units of 100 ms. Default 0 = instant: at 30 fps a new frame
 *        arrives every ~33 ms, so any non-zero fade leaves the panels always
 *        interpolating a few frames behind and smears beats/motion into a blur.
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
    this.lastSentAt = 0;
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
    const now = Date.now();
    const due = this.lastSentAt + this.intervalMs;
    if (now >= due) {
      this._transmit(payload, now);
    } else {
      this.pending = payload;
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          if (this.pending && !this.closed) this._transmit(this.pending, Date.now());
        }, due - now);
      }
    }
  }

  /** Address every panel with black (used on shutdown/stream loss). */
  blackout(panelIds) {
    this.sendFrame(panelIds.map((id) => ({ id, r: 0, g: 0, b: 0, transition: 1 })));
  }

  _transmit(payload, now) {
    this.pending = null;
    this.lastSentAt = now;
    this.lastPayload = payload;
    this.socket.send(payload, this.port, this.host);
  }

  _keepalive() {
    if (this.closed || !this.lastPayload) return;
    if (Date.now() - this.lastSentAt < KEEPALIVE_MS) return;
    this.socket.send(this.lastPayload, this.port, this.host);
  }

  close() {
    this.closed = true;
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.flushTimer);
    if (this.ownsSocket) this.socket.close();
  }
}

module.exports = { Streamer, encodeFrameV2, EXT_CONTROL_PORT };
