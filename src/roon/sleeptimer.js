'use strict';

/**
 * Sleep timer: stop Roon playback at the end of the current track.
 *
 * Pure logic — no Roon dependency, no wall clock beyond an injectable
 * setTimeout. Feed it the semantic events from TrackWatcher and it decides
 * *when* to stop; the actual transport stop is delegated to the `stop`
 * callback so this stays unit-testable.
 *
 * How "end of the current track" is timed:
 *   Roon delivers a seek tick (`zones_seek_changed`) roughly once a second
 *   while a zone is playing. On every tick we recompute
 *       remaining = length - seek_position
 *   and (re)schedule a one-shot stop for `remaining - guardMs`. As the
 *   playhead advances each reschedule lands earlier, converging on the end of
 *   the track; the guard fires us a hair *before* the natural boundary so we
 *   never bleed into the next song. Mid-song reschedules are always cancelled
 *   by the next tick, so the stop only actually fires inside the final ~second.
 *
 * Binding:
 *   Arming captures the zone that is playing (or, if nothing is playing yet,
 *   binds to the first zone that reports a playing tick — "arm it, then hit
 *   play"). We follow that zone: if the listener skips to another track the
 *   new track's ticks simply reschedule to *its* end, so we always stop at the
 *   end of whatever is playing in that zone when the timer lands.
 *
 * One-shot: after it fires it disarms itself. Pausing/stopping the zone cancels
 * the pending stop (we never fire onto a paused track); resuming re-arms it off
 * the next seek tick.
 */

const { EventEmitter } = require('node:events');

const DEFAULT_GUARD_MS = 500;

class SleepTimer extends EventEmitter {
  /**
   * @param {{ stop: (zoneId: string) => void,
   *           schedule?: (fn: () => void, ms: number) => any,
   *           cancel?: (handle: any) => void,
   *           guardMs?: number }} opts
   *   stop: issues the transport stop for a zone_id (called once, on fire).
   *   schedule/cancel: timer injection point for tests (default setTimeout).
   *   guardMs: fire this many ms before the track's natural end.
   */
  constructor(opts = {}) {
    super();
    this._stop = opts.stop;
    this._schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
    this._cancel = opts.cancel || ((h) => clearTimeout(h));
    this._guardMs = opts.guardMs ?? DEFAULT_GUARD_MS;
    this._armed = false;
    this._zoneId = null; // bound target zone_id (null = bind to next playing zone)
    this._timer = null;
  }

  get armed() { return this._armed; }
  get zoneId() { return this._zoneId; }

  /**
   * Arm "stop at end of current track".
   * @param {{ zoneId?: string|null }} [ctx] the zone currently playing, if known.
   *   Pass null to bind lazily to the next zone that reports a playing tick.
   */
  arm(ctx = {}) {
    this._armed = true;
    this._zoneId = ctx.zoneId || null;
    this._clearTimer();
    this.emit('armed', { zoneId: this._zoneId });
  }

  /** Disarm and cancel any pending stop. No-op if already idle. */
  disarm(reason = 'manual') {
    if (!this._armed && !this._timer) return;
    this._armed = false;
    this._zoneId = null;
    this._clearTimer();
    this.emit('disarmed', { reason });
  }

  /**
   * Feed an enriched seek tick.
   * @param {{ zoneId: string, seekPosition?: number, length?: number, state?: string }} s
   */
  onSeek(s) {
    if (!this._armed || !s) return;
    if (!this._zoneId) this._zoneId = s.zoneId; // late binding: first playing zone wins
    if (s.zoneId !== this._zoneId) return;
    if (s.state && s.state !== 'playing') { this._clearTimer(); return; }
    if (!Number.isFinite(s.length) || s.length <= 0) { this._clearTimer(); return; }
    const remainingMs = Math.max(0, (s.length - (s.seekPosition || 0)) * 1000 - this._guardMs);
    this._clearTimer();
    this._timer = this._schedule(() => this._fire(), remainingMs);
  }

  /**
   * The target zone paused/stopped or all watched zones went idle: cancel the
   * pending stop so we don't fire onto a paused track. Resuming reschedules off
   * the next seek tick.
   * @param {string} [zoneId] the zone that went quiet; omit for a global idle.
   */
  onIdle(zoneId) {
    if (!this._armed) return;
    if (zoneId && this._zoneId && zoneId !== this._zoneId) return;
    this._clearTimer();
  }

  _fire() {
    const zoneId = this._zoneId;
    this._armed = false;
    this._zoneId = null;
    this._timer = null;
    if (zoneId && this._stop) this._stop(zoneId);
    this.emit('fired', { zoneId });
  }

  _clearTimer() {
    if (this._timer) { this._cancel(this._timer); this._timer = null; }
  }
}

module.exports = { SleepTimer, DEFAULT_GUARD_MS };
