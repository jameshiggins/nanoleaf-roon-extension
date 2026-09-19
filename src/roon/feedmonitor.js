'use strict';

/**
 * Notices when the audio feed from Roon has gone missing and says so, instead of
 * leaving the wall to animate silence:
 *
 *   'warning' (string|null)  — a human-readable problem, or null once it clears
 *
 * Two independent signals, both evaluated in sample():
 *
 * - Symptom: Roon says a watched zone is playing, yet nothing audible has arrived
 *   on the capture device for `graceMs`. Needs no configuration and catches every
 *   way the feed dies (bridge down, cable output ungrouped, capture wedged).
 * - Cause: with `output` set (roon.feedOutput — case-insensitive substring of the
 *   cable output's name in Roon), that output being absent from Roon's output
 *   list for `graceMs`. This is what a dead Roon Bridge / RAATServer looks like
 *   from here: on 2026-09-19 RAATServer crash-looped for hours while its Windows
 *   service still reported "Running".
 *
 * Pure logic, no Roon dependency and no timers — feed it subscribe_outputs
 * (response, msg) pairs and call sample() periodically with a clock.
 *
 * Both signals wait out `graceMs`: outputs vanish for a few seconds whenever the
 * bridge restarts, and track gaps / the 'loading' state are legitimately silent.
 */

const { EventEmitter } = require('node:events');

class FeedMonitor extends EventEmitter {
  /** @param {{ output?: string, graceMs?: number }} [opts] */
  constructor(opts = {}) {
    super();
    this.outputFilter = (opts.output || '').toLowerCase();
    this.graceMs = opts.graceMs ?? 45000;
    this.outputNames = new Map(); // output_id → display_name
    this.haveSnapshot = false;    // no verdict on outputs until Roon has told us what exists
    this.silentSince = null;
    this.missingSince = null;
    this.warning = null;
  }

  /** Feed the raw subscribe_outputs callback straight in. */
  handleOutputs(response, msg) {
    if (response === 'Subscribed' && msg && Array.isArray(msg.outputs)) {
      this.outputNames.clear();
      for (const o of msg.outputs) this.outputNames.set(o.output_id, o.display_name);
      this.haveSnapshot = true;
    } else if (response === 'Changed' && msg) {
      for (const id of msg.outputs_removed || []) this.outputNames.delete(id);
      for (const o of msg.outputs_added || []) this.outputNames.set(o.output_id, o.display_name);
      for (const o of msg.outputs_changed || []) this.outputNames.set(o.output_id, o.display_name);
    } else {
      // 'Unsubscribed' / 'NetworkError': the list is stale, not empty — a core
      // outage must not read as "the cable output is gone".
      this.haveSnapshot = false;
      this.missingSince = null;
    }
  }

  outputs() {
    return [...this.outputNames.values()].filter((n) => typeof n === 'string');
  }

  /**
   * @param {boolean} playing  Roon reports a watched zone playing
   * @param {boolean} audible  the capture is currently above the silence floor
   * @param {number} nowMs
   */
  sample(playing, audible, nowMs) {
    if (playing && !audible) this.silentSince ??= nowMs;
    else this.silentSince = null;

    const outputMissing = this.outputFilter !== '' && this.haveSnapshot &&
      !this.outputs().some((n) => n.toLowerCase().includes(this.outputFilter));
    if (outputMissing) this.missingSince ??= nowMs;
    else this.missingSince = null;

    const expired = (since) => since !== null && nowMs - since >= this.graceMs;
    let warning = null;
    if (expired(this.missingSince)) {
      warning = `Roon has no "${this.outputFilter}" output — is Roon Bridge / RAATServer on this PC down?`;
    } else if (expired(this.silentSince)) {
      const seen = this.haveSnapshot ? ` Roon outputs: ${this.outputs().join(', ') || '(none)'}.` : '';
      warning = `Roon is playing but no audio is arriving — cable output missing or ungrouped?${seen}`;
    }
    if (warning !== this.warning) {
      this.warning = warning;
      this.emit('warning', warning);
    }
  }
}

module.exports = { FeedMonitor };
