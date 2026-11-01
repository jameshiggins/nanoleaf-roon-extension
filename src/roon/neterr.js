'use strict';

/**
 * Classifies the errors a network blip throws at us so the service can ride them out.
 *
 * The one that actually happened (2026-10-10, the router's weekly 03:00 reboot): while the
 * NIC was between addresses, node-roon-api's SOOD discovery re-scanned the interfaces, bound
 * a socket to an IP that was already gone and threw `addMembership EADDRNOTAVAIL` inside a
 * dgram callback — an uncaughtException, which used to shut the whole service down. The
 * panels, the Shield launcher and the Hegel hand-back all stayed dead until someone noticed.
 *
 * These are transient by nature: the interface comes back within seconds. The right response
 * is to restart discovery, not the process.
 */

const TRANSIENT_CODES = new Set(['EADDRNOTAVAIL', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EADDRINUSE']);
const SOCKET_SYSCALLS = /^(addMembership|dropMembership|bind|setBroadcast|setMulticastTTL|setMulticastInterface|send)$/;

/** @param {unknown} err  @returns {boolean} true when this looks like the network changing under a UDP socket */
function isTransientNetworkError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = /** @type {{ code?: string }} */ (err).code;
  if (!code || !TRANSIENT_CODES.has(code)) return false;
  const syscall = /** @type {{ syscall?: string }} */ (err).syscall;
  if (syscall) return SOCKET_SYSCALLS.test(syscall);
  // Node formats these as "<syscall> <code>" even when .syscall is missing.
  return new RegExp(`^(${SOCKET_SYSCALLS.source.slice(2, -2)}) ${code}`).test(String(err.message || ''));
}

module.exports = { isTransientNetworkError };
