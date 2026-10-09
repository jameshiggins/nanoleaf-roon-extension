'use strict';

/**
 * LAN discovery beacon for the companion app.
 *
 * The Android wrapper used to ship with this PC's IP baked in, which broke every time DHCP
 * handed the machine a new address (Wi-Fi vs Ethernet, lease changes). Instead the app now
 * shouts a UDP broadcast and this beacon answers with where the companion server lives:
 *
 *   app ── broadcast "NANOLEAF-ROON? <nonce>" ──▶ 255.255.255.255:8788  (control.discoveryPort)
 *   app ◀─ unicast   "NANOLEAF-ROON {json}"   ─── this process
 *
 * The reply's *source address* is the one the app loads (it is the interface the datagram
 * left on, so it is routable from the app's side); the JSON carries the companion port and
 * echoes the nonce so a client can ignore answers to someone else's scan.
 *
 * Dependency-free (node:dgram) and deliberately NOT multicast: a plain broadcast receiver on
 * 0.0.0.0 has no group membership to lose when interfaces come and go, so there is nothing
 * here to throw EADDRNOTAVAIL the way SOOD discovery did on 2026-10-07.
 */

const dgram = require('node:dgram');
const os = require('node:os');
const log = require('../log')('control');

const PROBE = 'NANOLEAF-ROON?';
const REPLY = 'NANOLEAF-ROON ';
const SERVICE = 'nanoleaf-roon';
const DEFAULT_PORT = 8788;
const MAX_NONCE = 64;

/** Parse an incoming datagram. Returns { nonce } for a probe, null for anything else. */
function parseProbe(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const trimmed = text.trim();
  if (!trimmed.startsWith(PROBE)) return null;
  const nonce = trimmed.slice(PROBE.length).trim().slice(0, MAX_NONCE);
  return { nonce };
}

/** Build the reply datagram for a probe. */
function buildReply({ port, name = '', version = '', nonce = '' }) {
  const body = { service: SERVICE, port, name, version };
  if (nonce) body.nonce = nonce;
  return Buffer.from(REPLY + JSON.stringify(body), 'utf8');
}

class Beacon {
  /**
   * @param {{ port?: number, servicePort: number, name?: string, version?: string }} opts
   *   port        UDP port to listen on (default 8788)
   *   servicePort the companion app's HTTP port to advertise
   */
  constructor(opts) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.servicePort = opts.servicePort;
    this.name = opts.name ?? os.hostname();
    this.version = opts.version ?? '';
    this.socket = null;
    this.replies = 0;
  }

  /** Bind and start answering probes. Resolves with the bound UDP port. */
  start() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = sock;
      let listening = false;
      sock.on('error', (err) => {
        if (!listening) {
          this.socket = null;
          try { sock.close(); } catch { /* already closed */ }
          reject(err);
          return;
        }
        // Once up, a socket error is a LAN hiccup, not a reason to take the wall down.
        log.warn(`discovery beacon: ${err.message}`);
      });
      sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      sock.bind({ port: this.port, address: '0.0.0.0' }, () => {
        listening = true;
        try { sock.setBroadcast(true); } catch { /* not needed for unicast replies */ }
        const bound = sock.address().port;
        log.info(`discovery beacon on udp/${bound} — the Android app finds this host by broadcasting, no IP to type`);
        resolve(bound);
      });
    });
  }

  stop() {
    if (!this.socket) return;
    try { this.socket.close(); } catch { /* already closed */ }
    this.socket = null;
  }

  _onMessage(msg, rinfo) {
    const probe = parseProbe(msg);
    if (!probe || !this.socket) return;
    const reply = buildReply({ port: this.servicePort, name: this.name, version: this.version, nonce: probe.nonce });
    this.socket.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) log.debug(`discovery reply to ${rinfo.address}:${rinfo.port} failed: ${err.message}`);
      else this.replies++;
    });
  }
}

module.exports = { Beacon, parseProbe, buildReply, PROBE, REPLY, SERVICE, DEFAULT_PORT };
