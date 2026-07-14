'use strict';

/**
 * Turns raw Roon zone-subscription events into clean semantic events:
 *
 *   'track' ({ zoneName, title, artist, album, key })  — a new track started playing
 *   'playing'                                          — a watched zone began playing
 *   'idle'                                             — no watched zone is playing anymore
 *
 * Pure logic, no Roon dependency — feed it the (response, msg) pairs from
 * RoonApiTransport.subscribe_zones. Design notes (verified against the
 * node-roon-api-transport source):
 *
 * - now_playing has no track id; identity is derived from three_line + length.
 * - Seek ticks arrive only in zones_seek_changed, which we never look at.
 * - Pauses, volume moves and queue edits arrive as zones_changed with an
 *   unchanged track key, so the key comparison filters them.
 * - The last-emitted key updates only on emit: skipping tracks while paused and
 *   then pressing play yields exactly one 'track' event.
 * - The Subscribed snapshot seeds keys without emitting, so startup (and
 *   re-pairing after a connection drop) is never treated as a track change.
 * - Zones are removed/re-added on grouping changes with new zone_ids, so
 *   zones_added is processed like zones_changed and matching is by name.
 */

const { EventEmitter } = require('node:events');

function trackKey(zone) {
  const np = zone.now_playing;
  if (!np) return null;
  const t = np.three_line || {};
  return [t.line1 || '', t.line2 || '', t.line3 || '', np.length || 0].join('|');
}

class TrackWatcher extends EventEmitter {
  /** @param {{ zone?: string }} [opts]  case-insensitive substring of the zone name; '' = all */
  constructor(opts = {}) {
    super();
    this.zoneFilter = (opts.zone || '').toLowerCase();
    this.lastKey = new Map();      // zone_id → last emitted (or seeded) track key
    this.playingZones = new Set(); // watched zone_ids currently in state 'playing'
  }

  _matches(zone) {
    return zone && typeof zone.display_name === 'string' &&
      zone.display_name.toLowerCase().includes(this.zoneFilter);
  }

  /** Feed the raw subscribe_zones callback straight in. */
  handleEvent(response, msg) {
    if (response === 'Subscribed' && msg && Array.isArray(msg.zones)) {
      for (const zone of msg.zones) {
        if (!this._matches(zone)) continue;
        this.lastKey.set(zone.zone_id, trackKey(zone));
        this._updatePlaying(zone);
      }
    } else if (response === 'Changed' && msg) {
      if (Array.isArray(msg.zones_added)) this._processZones(msg.zones_added);
      if (Array.isArray(msg.zones_changed)) this._processZones(msg.zones_changed);
      if (Array.isArray(msg.zones_removed)) {
        for (const zoneId of msg.zones_removed) {
          this.lastKey.delete(zoneId);
          if (this.playingZones.delete(zoneId)) this._emitIdleIfQuiet();
        }
      }
      // msg.zones_seek_changed: playhead ticks — deliberately ignored.
    }
    // 'Unsubscribed' / 'NetworkError' (msg undefined): nothing to do; on
    // re-pair a fresh Subscribed snapshot re-seeds state.
  }

  _processZones(zones) {
    for (const zone of zones) {
      if (!this._matches(zone)) continue;
      const key = trackKey(zone);
      if (zone.state === 'playing' && key && key !== this.lastKey.get(zone.zone_id)) {
        this.lastKey.set(zone.zone_id, key);
        const t = (zone.now_playing && zone.now_playing.three_line) || {};
        this.emit('track', {
          zoneName: zone.display_name,
          title: t.line1 || '',
          artist: t.line2 || '',
          album: t.line3 || '',
          key,
        });
      }
      this._updatePlaying(zone);
    }
  }

  _updatePlaying(zone) {
    const wasQuiet = this.playingZones.size === 0;
    if (zone.state === 'playing') {
      this.playingZones.add(zone.zone_id);
      if (wasQuiet) this.emit('playing');
    } else {
      if (this.playingZones.delete(zone.zone_id)) this._emitIdleIfQuiet();
    }
  }

  _emitIdleIfQuiet() {
    if (this.playingZones.size === 0) this.emit('idle');
  }
}

module.exports = { TrackWatcher, trackKey };
