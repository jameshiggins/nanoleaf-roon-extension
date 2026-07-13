'use strict';

/** SSDP discovery of Nanoleaf controllers. */

const dgram = require('node:dgram');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

const M_SEARCH = [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
  'MAN: "ssdp:discover"',
  'MX: 3',
  'ST: ssdp:all',
  '', '',
].join('\r\n');

/**
 * Parse one SSDP response datagram. Returns null unless it looks like a Nanoleaf.
 * @param {string} text
 * @returns {{ host: string, port: number, name: string, st: string } | null}
 */
function parseSsdpResponse(text) {
  const headers = {};
  for (const line of text.split('\r\n').slice(1)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const signature = `${headers.st ?? ''} ${headers.usn ?? ''} ${headers.nt ?? ''}`.toLowerCase();
  if (!signature.includes('nanoleaf')) return null;

  const location = headers.location ?? '';
  let host = '';
  let port = 16021;
  try {
    const url = new URL(location);
    host = url.hostname;
    port = url.port ? Number(url.port) : 16021;
  } catch {
    return null;
  }
  return { host, port, name: headers['nl-devicename'] ?? '', st: headers.st ?? headers.nt ?? '' };
}

/**
 * Broadcast an M-SEARCH and collect Nanoleaf responses for `waitMs`.
 * @returns {Promise<Array<{host: string, port: number, name: string, st: string}>>}
 */
function discover({ waitMs = 3500 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const found = new Map();

    socket.on('message', (msg) => {
      const dev = parseSsdpResponse(msg.toString('utf8'));
      if (dev) found.set(`${dev.host}:${dev.port}`, dev);
    });
    socket.on('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.send(M_SEARCH, SSDP_PORT, SSDP_ADDR, (err) => {
        if (err) {
          socket.close();
          return reject(err);
        }
        setTimeout(() => {
          socket.close();
          resolve([...found.values()]);
        }, waitMs);
      });
    });
  });
}

module.exports = { discover, parseSsdpResponse };
