'use strict';

/** Nanoleaf REST client (port 16021). Only the calls this project needs. */

const http = require('node:http');

class NanoleafHttpError extends Error {
  constructor(status, method, path) {
    super(`nanoleaf ${method} ${path} → HTTP ${status}`);
    this.status = status;
  }
}

class NanoleafClient {
  /**
   * @param {{ host: string, port?: number, token?: string, timeoutMs?: number }} opts
   */
  constructor(opts) {
    if (!opts.host) throw new Error('nanoleaf.host is required');
    this.host = opts.host;
    this.port = opts.port ?? 16021;
    this.token = opts.token ?? '';
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          method,
          path,
          timeout: this.timeoutMs,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new NanoleafHttpError(res.statusCode, method, this._redact(path)));
            }
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve(null);
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new Error(`nanoleaf ${method} ${this._redact(path)}: invalid JSON response`));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error(`nanoleaf ${method} ${this._redact(path)}: timeout`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Strip the auth token out of a path so it never lands in error messages / logs. */
  _redact(path) {
    return this.token ? String(path).split(this.token).join('<token>') : path;
  }

  _authed(path) {
    if (!this.token) throw new Error('nanoleaf.token is empty — run `npm run pair` first');
    return `/api/v1/${this.token}${path}`;
  }

  /** Pairing: the controller must be in pairing mode (hold power 5-7 s). */
  async createToken() {
    const res = await this._request('POST', '/api/v1/new');
    if (!res || !res.auth_token) throw new Error('pairing response had no auth_token');
    this.token = res.auth_token;
    return res.auth_token;
  }

  /** Full device info; also serves as a token validity check. */
  async getInfo() {
    return this._request('GET', this._authed(''));
  }

  /** @returns {Promise<{numPanels: number, positionData: Array<{panelId:number,x:number,y:number}>}>} */
  async getLayout() {
    return this._request('GET', this._authed('/panelLayout/layout'));
  }

  /** Flash the panels to identify the device. */
  async identify() {
    return this._request('PUT', this._authed('/identify'));
  }

  /** Put the controller into extControl v2 streaming mode (UDP 60222). */
  async enableExtControl() {
    return this._request('PUT', this._authed('/effects'), {
      write: { command: 'display', animType: 'extControl', extControlVersion: 'v2' },
    });
  }

  /** Turn the panels on or off. */
  async setPower(on) {
    return this._request('PUT', this._authed('/state'), { on: { value: !!on } });
  }

  /** Whether the panels are currently powered on. */
  async getPower() {
    const res = await this._request('GET', this._authed('/state/on'));
    return !!(res && res.value);
  }

  /**
   * Name of the currently selected effect. The controller reports `*Dynamic*` while
   * something is streaming to it, which is not a restorable effect.
   */
  async getSelectedEffect() {
    return this._request('GET', this._authed('/effects/select'));
  }

  /** Re-select a named effect, handing the panels back to whatever had them before. */
  async selectEffect(name) {
    return this._request('PUT', this._authed('/effects'), { select: name });
  }
}

module.exports = { NanoleafClient, NanoleafHttpError };
