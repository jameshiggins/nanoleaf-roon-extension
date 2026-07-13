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
              return reject(new NanoleafHttpError(res.statusCode, method, path));
            }
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve(null);
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new Error(`nanoleaf ${method} ${path}: invalid JSON response`));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error(`nanoleaf ${method} ${path}: timeout`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
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
}

module.exports = { NanoleafClient, NanoleafHttpError };
