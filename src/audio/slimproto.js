'use strict';

/**
 * Minimal SlimProto (Squeezebox) client — just enough to register with a Roon Core
 * (or Logitech Media Server) as a PCM-only player and receive the audio stream.
 *
 * Wire format references: the slimproto documentation on the LMS wiki and the
 * squeezelite source. Byte layouts are pinned by unit tests in test/slimproto.test.js.
 *
 *   client → server frame: [op: 4 ASCII][payloadLength: u32 BE][payload]
 *   server → client frame: [length: u16 BE][op: 4 ASCII][payload]   (length = 4 + payload)
 */

const net = require('node:net');
const { EventEmitter } = require('node:events');
const log = require('../log')('slimproto');

const SLIMPROTO_PORT = 3483;
const DEVICE_ID_SQUEEZELITE = 12;

/** Build a HELO payload announcing a PCM-only player. */
function encodeHelo({ mac, capabilities }) {
  const caps = Buffer.from(capabilities, 'ascii');
  const payload = Buffer.alloc(36 + caps.length);
  payload.writeUInt8(DEVICE_ID_SQUEEZELITE, 0); // deviceId
  payload.writeUInt8(0, 1);                     // revision
  macBytes(mac).copy(payload, 2);               // mac[6]
  // uuid[16] (offset 8), wlanChannelList u16 (24), bytesReceived u64 (26),
  // language[2] (34): all zero
  caps.copy(payload, 36);

  const frame = Buffer.alloc(8 + payload.length);
  frame.write('HELO', 0, 'ascii');
  frame.writeUInt32BE(payload.length, 4);
  payload.copy(frame, 8);
  return frame;
}

/** Build a STAT frame (53-byte payload) for the given 4-char event code. */
function encodeStat(event, state = {}) {
  if (event.length !== 4) throw new Error(`STAT event must be 4 chars, got "${event}"`);
  const p = Buffer.alloc(53);
  p.write(event, 0, 'ascii');                       // event code
  // numCrlf u8 (4), masInitialized u8 (5), masMode u8 (6): zero
  p.writeUInt32BE(state.bufferSize ?? 0, 7);
  p.writeUInt32BE(state.fullness ?? 0, 11);
  p.writeBigUInt64BE(BigInt(state.bytesReceived ?? 0), 15);
  // signalStrength u16 (23): zero
  p.writeUInt32BE((state.jiffies ?? 0) >>> 0, 25);
  p.writeUInt32BE(state.outputBufferSize ?? 0, 29);
  p.writeUInt32BE(state.outputBufferFullness ?? 0, 33);
  p.writeUInt32BE(state.elapsedSeconds ?? 0, 37);
  // voltage u16 (41): zero
  p.writeUInt32BE(state.elapsedMs ?? 0, 43);
  p.writeUInt32BE(state.serverTimestamp ?? 0, 47);
  // errorCode u16 (51): zero

  const frame = Buffer.alloc(8 + p.length);
  frame.write('STAT', 0, 'ascii');
  frame.writeUInt32BE(p.length, 4);
  p.copy(frame, 8);
  return frame;
}

/**
 * Extract complete server→client frames from a TCP accumulation buffer.
 * @returns {{ frames: Array<{op: string, payload: Buffer}>, rest: Buffer }}
 */
function parseServerFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const len = buf.readUInt16BE(off);
    if (buf.length - off < 2 + len) break;
    if (len < 4) throw new Error(`slimproto frame too short: ${len}`);
    frames.push({
      op: buf.toString('ascii', off + 2, off + 6),
      payload: buf.subarray(off + 6, off + 2 + len),
    });
    off += 2 + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** Decode an strm command payload. */
function parseStrm(payload) {
  if (payload.length < 24) throw new Error(`strm payload too short: ${payload.length}`);
  return {
    command: String.fromCharCode(payload[0]),      // s/p/u/q/t/f...
    autostart: String.fromCharCode(payload[1]),
    format: String.fromCharCode(payload[2]),       // 'p' = PCM
    pcmSampleSize: String.fromCharCode(payload[3]),
    pcmSampleRate: String.fromCharCode(payload[4]),
    pcmChannels: String.fromCharCode(payload[5]),
    pcmEndian: String.fromCharCode(payload[6]),
    replayGain: payload.readUInt32BE(14),          // server timestamp for 't' commands
    serverPort: payload.readUInt16BE(18),
    serverIp: payload.readUInt32BE(20),
    httpRequest: payload.toString('ascii', 24),
  };
}

function macBytes(mac) {
  const parts = mac.split(':').map((h) => parseInt(h, 16));
  if (parts.length !== 6 || parts.some(Number.isNaN)) throw new Error(`bad mac: ${mac}`);
  return Buffer.from(parts);
}

function ipToString(u32) {
  return [(u32 >>> 24) & 255, (u32 >>> 16) & 255, (u32 >>> 8) & 255, u32 & 255].join('.');
}

/**
 * The client. Emits:
 *   'pcm' (Buffer)   raw audio stream bytes (format as advertised: s16le PCM)
 *   'streamStart' ({sampleRate, channels})
 *   'streamStop'
 *   'error' (Error)
 *   'close'
 */
class SlimprotoClient extends EventEmitter {
  /**
   * @param {{ server: string, mac?: string, playerName?: string, port?: number }} opts
   */
  constructor(opts) {
    super();
    this.server = opts.server;
    this.port = opts.port ?? SLIMPROTO_PORT;
    this.mac = opts.mac ?? '02:4e:4c:52:4f:4e'; // locally-administered, "NLRON"
    this.playerName = opts.playerName ?? 'Nanoleaf Feed';
    this.capabilities =
      `Model=squeezelite,ModelName=${this.playerName},AccuratePlayPoints=1,pcm,MaxSampleRate=192000`;
    this.control = null;
    this.stream = null;
    this.bytesReceived = 0;
    this.startedAt = Date.now();
    this._recv = Buffer.alloc(0);
  }

  connect() {
    this.control = net.connect(this.port, this.server, () => {
      log.info(`connected to ${this.server}:${this.port}, sending HELO as "${this.playerName}"`);
      this.control.write(encodeHelo({ mac: this.mac, capabilities: this.capabilities }));
    });
    this.control.on('data', (chunk) => this._onControlData(chunk));
    this.control.on('error', (err) => this.emit('error', err));
    this.control.on('close', () => {
      this._stopStream();
      this.emit('close');
    });
  }

  close() {
    this._stopStream();
    if (this.control) this.control.destroy();
  }

  _onControlData(chunk) {
    this._recv = Buffer.concat([this._recv, chunk]);
    let parsed;
    try {
      parsed = parseServerFrames(this._recv);
    } catch (err) {
      this.emit('error', err);
      this.control.destroy();
      return;
    }
    this._recv = parsed.rest;
    for (const frame of parsed.frames) this._onFrame(frame);
  }

  _onFrame({ op, payload }) {
    if (op === 'strm') {
      this._onStrm(parseStrm(payload));
    } else if (op === 'vers' || op === 'setd' || op === 'aude' || op === 'audg') {
      log.debug(`ignoring server op ${op}`);
    } else {
      log.debug(`unknown server op ${op}`);
    }
  }

  _onStrm(strm) {
    switch (strm.command) {
      case 't': // heartbeat: echo the server timestamp back
        this._stat('STMt', { serverTimestamp: strm.replayGain });
        break;
      case 's':
        this._startStream(strm);
        break;
      case 'q':
      case 'f':
        this._stopStream();
        this._stat('STMf');
        break;
      case 'p':
        this._stat('STMp');
        break;
      case 'u':
        this._stat('STMr');
        break;
      default:
        log.debug(`unhandled strm command "${strm.command}"`);
    }
  }

  _startStream(strm) {
    this._stopStream();
    const host = strm.serverIp === 0 ? this.control.remoteAddress : ipToString(strm.serverIp);
    const port = strm.serverPort || 9000;
    log.info(`stream start: http://${host}:${port} format=${strm.format}`);
    this._stat('STMc');

    let headerDone = false;
    let headerBuf = Buffer.alloc(0);
    const sampleRate = SAMPLE_RATES[strm.pcmSampleRate] ?? 44100;
    const channels = strm.pcmChannels === '1' ? 1 : 2;

    this.stream = net.connect(port, host, () => {
      this.stream.write(strm.httpRequest);
    });
    this.stream.on('data', (chunk) => {
      if (!headerDone) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const idx = headerBuf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        headerDone = true;
        this._stat('STMh');
        this.emit('streamStart', { sampleRate, channels });
        this._stat('STMs');
        chunk = headerBuf.subarray(idx + 4);
        if (chunk.length === 0) return;
      }
      this.bytesReceived += chunk.length;
      this.emit('pcm', chunk);
    });
    this.stream.on('error', (err) => {
      log.warn('stream connection error:', err.message);
      this._stopStream();
    });
    this.stream.on('close', () => {
      if (this.stream) {
        this.stream = null;
        this.emit('streamStop');
      }
    });
  }

  _stopStream() {
    if (!this.stream) return;
    const s = this.stream;
    this.stream = null;
    s.destroy();
    this.emit('streamStop');
  }

  _stat(event, extra = {}) {
    if (!this.control || this.control.destroyed) return;
    this.control.write(
      encodeStat(event, {
        bytesReceived: this.bytesReceived,
        jiffies: (Date.now() - this.startedAt) & 0xffffffff,
        bufferSize: 2 * 1024 * 1024,
        fullness: 0,
        outputBufferSize: 2 * 1024 * 1024,
        outputBufferFullness: 0,
        ...extra,
      })
    );
  }
}

// strm pcmSampleRate character → Hz (squeezelite mapping)
const SAMPLE_RATES = {
  '0': 11025, '1': 22050, '2': 32000, '3': 44100, '4': 48000,
  '5': 8000, '6': 12000, '7': 16000, '8': 24000, '9': 96000,
  ':': 88200, ';': 176400, '<': 192000,
};

module.exports = {
  SlimprotoClient,
  encodeHelo,
  encodeStat,
  parseServerFrames,
  parseStrm,
  ipToString,
  SLIMPROTO_PORT,
};
