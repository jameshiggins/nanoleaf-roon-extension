'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Written next to the service log so the external watchdog knows where to look.
const DEFAULT_HEARTBEAT = path.join(__dirname, '..', 'logs', 'heartbeat');

/**
 * Liveness heartbeat. A lifetime timer touches `file` with the current epoch-ms
 * every `intervalMs`. An external watchdog (scripts/watchdog.ps1) polls the file's
 * age and forces an NSSM restart if it goes stale — recovering the failure mode
 * where the event loop wedged (frames, Roon traffic, and logging all froze) while
 * the process stayed alive, so NSSM never saw it exit.
 *
 * This must be OUT of process to be useful: a wedged event loop can't fire its own
 * timers, so an in-process watchdog would freeze with everything else. The heartbeat
 * is only the signal; the watchdog is the separate process that acts on it.
 *
 * @returns {() => void} stop — clears the timer.
 */
function startHeartbeat({ file = DEFAULT_HEARTBEAT, intervalMs = 3000, now = Date.now } = {}) {
  const beat = () => {
    try {
      fs.writeFileSync(file, String(now()));
    } catch {
      /* transient FS error — the next beat retries; a persistent one stalls the
         heartbeat, which is exactly what the watchdog should catch */
    }
  };
  beat(); // write immediately so the file exists before the first poll
  const timer = setInterval(beat, intervalMs);
  timer.unref(); // liveness signal only — never keep the process alive on its own
  return () => clearInterval(timer);
}

module.exports = { startHeartbeat, DEFAULT_HEARTBEAT };
