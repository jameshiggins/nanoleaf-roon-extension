'use strict';

/**
 * AudioSource factory. Every source is an EventEmitter with start()/stop() that emits:
 *   'pcm' (Buffer)                        interleaved s16le samples
 *   'format' ({sampleRate, channels})     emitted before the first pcm of a stream
 *   'error' (Error)
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { SlimprotoClient } = require('./slimproto');
const log = require('../log')('audio');

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/** Registers with the Roon Core as a Squeezebox player and streams its PCM. */
class SlimprotoSource extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.client = null;
    this.stopped = false;
    this.backoffMs = RECONNECT_MIN_MS;
    this.reconnectTimer = null;
  }

  start() {
    if (this.cfg.server === 'auto' || !this.cfg.server) {
      this.emit('error', new Error(
        'audio.server is "auto" — SlimProto server discovery is not implemented yet; ' +
        'set audio.server to your Roon Core\'s IP address'
      ));
      return;
    }
    this.stopped = false;
    this._connect();
  }

  _connect() {
    const client = new SlimprotoClient({
      server: this.cfg.server,
      playerName: this.cfg.playerName,
    });
    this.client = client;
    client.on('streamStart', (fmt) => {
      this.backoffMs = RECONNECT_MIN_MS;
      this.emit('format', fmt);
    });
    client.on('pcm', (chunk) => this.emit('pcm', chunk));
    client.on('error', (err) => log.warn('slimproto error:', err.message));
    client.on('close', () => {
      if (this.stopped) return;
      log.warn(`slimproto connection lost, reconnecting in ${this.backoffMs} ms`);
      this.reconnectTimer = setTimeout(() => this._connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    });
    client.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.client) this.client.close();
  }
}

/** Spawns a capture command (ffmpeg by default) and reads s16le PCM from its stdout. */
class CaptureSource extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.child = null;
    this.stopped = false;
  }

  start() {
    if (!this.cfg.captureArgs.length) {
      this.emit('error', new Error(
        'audio.captureArgs is empty — configure the capture input, e.g. ' +
        '["-f","dshow","-i","audio=CABLE Output (VB-Audio Virtual Cable)"]'
      ));
      return;
    }
    this.stopped = false;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...this.cfg.captureArgs,
      '-ac', String(this.cfg.channels),
      '-ar', String(this.cfg.sampleRate),
      '-f', 's16le', '-',
    ];
    log.info(`spawning: ${this.cfg.captureCommand} ${args.join(' ')}`);
    this.child = spawn(this.cfg.captureCommand, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.emit('format', { sampleRate: this.cfg.sampleRate, channels: this.cfg.channels });
    this.child.stdout.on('data', (chunk) => this.emit('pcm', chunk));
    this.child.stderr.on('data', (d) => log.warn('capture:', d.toString().trim()));
    this.child.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      log.warn(`capture process exited (${code}), restarting in 3 s`);
      this.restartTimer = setTimeout(() => this.start(), 3000);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    if (this.child) this.child.kill('SIGTERM');
  }
}

/** Reads s16le PCM from stdin. For testing and custom pipelines. */
class StdinSource extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this._onData = (chunk) => this.emit('pcm', chunk);
  }

  start() {
    this.emit('format', { sampleRate: this.cfg.sampleRate, channels: this.cfg.channels });
    process.stdin.on('data', this._onData);
    process.stdin.resume();
  }

  stop() {
    process.stdin.off('data', this._onData);
    process.stdin.pause();
  }
}

function createSource(audioCfg) {
  switch (audioCfg.source) {
    case 'slimproto': return new SlimprotoSource(audioCfg);
    case 'capture': return new CaptureSource(audioCfg);
    case 'stdin': return new StdinSource(audioCfg);
    default: throw new Error(`unknown audio source: ${audioCfg.source}`);
  }
}

module.exports = { createSource, SlimprotoSource, CaptureSource, StdinSource };
