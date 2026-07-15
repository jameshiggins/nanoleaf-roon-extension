'use strict';

/**
 * Control + telemetry server for the companion app.
 *
 * A dependency-free HTTP server that:
 *   - serves the web app (src/control/webapp/),
 *   - exposes GET /api/state and GET /api/catalogue,
 *   - accepts POST /api/command to drive the renderer live,
 *   - streams live telemetry over Server-Sent Events at GET /events
 *     (panel frames, features, state, now-playing).
 *
 * SSE (not WebSocket) keeps it dependency-free and works in the Shield's
 * WebView/Chromium out of the box. Frames are only emitted while at least one
 * client is connected, and are throttled to `frameHz`.
 *
 * No auth: intended for a trusted LAN. Bind to 127.0.0.1 if you don't want it
 * reachable from other devices.
 */

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const log = require('../log')('control');

/** Reachable http URLs for the companion app, given the bound host and port. */
function reachableUrls(host, port) {
  // when bound to all interfaces, list every non-internal IPv4 so the user
  // sees the address to type on their Shield instead of "0.0.0.0"
  if (host === '0.0.0.0' || host === '::') {
    const urls = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
      }
    }
    return urls.length ? urls : [`http://<this-host>:${port}`];
  }
  return [`http://${host}:${port}`];
}

const WEBAPP_DIR = path.join(__dirname, 'webapp');
const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
};

/**
 * Apply a command object to a renderer. Pure-ish (only touches the renderer),
 * so it's unit-testable without HTTP.
 * @returns {{ ok: boolean, error?: string, state?: object }}
 */
function applyCommand(renderer, body) {
  const cmd = body && body.cmd;
  switch (cmd) {
    case 'next':
      renderer.next();
      break;
    case 'visual': {
      const resolved = renderer.selectVisual(body.value);
      if (!resolved) return { ok: false, error: `unknown visual: ${body.value}` };
      break;
    }
    case 'palette': {
      const resolved = renderer.selectPalette(body.value);
      if (!resolved) return { ok: false, error: `unknown palette: ${body.value}` };
      break;
    }
    case 'gain':
      renderer.setGain(body.value);
      break;
    case 'rotate':
      renderer.setRotate(body.value);
      break;
    case 'lock':
      renderer.setRotate('off');
      break;
    case 'unlock':
      renderer.setRotate('track');
      break;
    default:
      return { ok: false, error: `unknown command: ${cmd}` };
  }
  return { ok: true, state: renderer.getState() };
}

class ControlServer {
  /**
   * @param {{ renderer: import('../visuals/renderer').VisualRenderer,
   *           port?: number, host?: string, frameHz?: number }} opts
   */
  constructor(opts) {
    this.renderer = opts.renderer;
    this.port = opts.port ?? 8787;
    this.host = opts.host ?? '0.0.0.0';
    this.frameInterval = 1000 / (opts.frameHz ?? 20);
    this.clients = new Set();       // Set<ServerResponse> of SSE connections
    this.lastFrameAt = 0;
    this.server = null;

    this._onFrame = (frame, features, gate) => this._broadcastFrame(frame, features, gate);
    this._onState = (state) => this._sse('state', state);
    this._onRotate = () => this._sse('state', this.renderer.getState());
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', reject);
      this.renderer.on('state', this._onState);
      this.renderer.on('rotate', this._onRotate);
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        this.urls = reachableUrls(this.host, addr.port);
        log.info(`companion app ready — open one of these on your Shield: ${this.urls.join('  ')}`);
        resolve(addr.port);
      });
    });
  }

  stop() {
    this.renderer.off('frame', this._onFrame);
    this.renderer.off('state', this._onState);
    this.renderer.off('rotate', this._onRotate);
    for (const res of this.clients) res.end();
    this.clients.clear();
    if (this.server) this.server.close();
  }

  _handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // permissive CORS so a native wrapper hitting the API cross-origin still works on a LAN
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return this._send(res, 204, '', 'text/plain');

    if (req.method === 'GET' && p === '/events') return this._openSse(req, res);
    if (req.method === 'GET' && p === '/api/state') return this._json(res, 200, this.renderer.getState());
    if (req.method === 'GET' && p === '/api/catalogue') return this._json(res, 200, this.renderer.getCatalogue());
    if (req.method === 'POST' && p === '/api/command') return this._command(req, res);
    if (req.method === 'GET' && STATIC[p]) return this._static(res, STATIC[p]);
    if (req.method === 'GET' && p === '/favicon.ico') return this._send(res, 204, '', 'image/x-icon');
    return this._send(res, 404, 'not found', 'text/plain');
  }

  _command(req, res) {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) req.destroy(); // guard against oversized bodies
      else chunks.push(c);
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return this._json(res, 400, { ok: false, error: 'invalid JSON' });
      }
      const result = applyCommand(this.renderer, body);
      this._json(res, result.ok ? 200 : 400, result);
    });
  }

  _openSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    if (this.clients.size === 1) this.renderer.on('frame', this._onFrame); // start frames on first viewer

    // greet with everything needed to render immediately
    this._writeEvent(res, 'hello', { state: this.renderer.getState(), catalogue: this.renderer.getCatalogue() });

    const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
    keepalive.unref?.();
    const cleanup = () => {
      clearInterval(keepalive);
      this.clients.delete(res);
      if (this.clients.size === 0) this.renderer.off('frame', this._onFrame); // stop frames when idle
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  }

  _broadcastFrame(frame, features, gate) {
    const now = Date.now();
    if (now - this.lastFrameAt < this.frameInterval) return; // throttle
    this.lastFrameAt = now;
    const payload = {
      g: Math.round(gate * 100) / 100,
      c: frame.map((pnl) => [Math.round(pnl.r), Math.round(pnl.g), Math.round(pnl.b)]),
      f: {
        rms: round2(features.rms), bass: round2(features.bass), mid: round2(features.mid),
        treble: round2(features.treble), energy: round2(features.energy), onset: !!features.onset,
      },
    };
    this._sse('frame', payload);
  }

  _sse(event, data) {
    for (const res of this.clients) this._writeEvent(res, event, data);
  }

  _writeEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  _static(res, entry) {
    fs.readFile(path.join(WEBAPP_DIR, entry.file), (err, buf) => {
      if (err) return this._send(res, 500, 'webapp missing', 'text/plain');
      this._send(res, 200, buf, entry.type);
    });
  }

  _json(res, status, obj) {
    this._send(res, status, JSON.stringify(obj), 'application/json');
  }

  _send(res, status, body, type) {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  }
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

module.exports = { ControlServer, applyCommand };
