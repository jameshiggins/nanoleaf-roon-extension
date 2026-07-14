'use strict';

/**
 * Turns raw Roon zone-subscription events into clean semantic events:
 *
 *   'track' ({ zoneName, title, artist, album, key })  — a new track started playing
 *   'playing'                                          — a watched zone began playing
 *   'idle'                                             — no watched zone is playing anymore
 *   'zones' ({ matched, all })                         — zone names seen in a snapshot
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
 * - Each Subscribed snapshot REPLACES all state (the transport lib rebuilds its
 *   own zone cache the same way): keys are seeded without emitting 'track', and
 *   zones that vanished during a disconnect can't linger and wedge 'idle'.
 * - Zones are removed/re-added on grouping changes with new zone_ids, so
 *   zones_added is processed like zones_changed — but an added zone that is
 *   already showing a known track (regroup/transfer mid-song) seeds silently
 *   instead of firing a spurious 'track'.
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
      // Full snapshot: replace all state so zones that vanished while we were
      // disconnected can't linger in playingZones and suppress 'idle' forever.
      const wasPlaying = this.playingZones.size > 0;
      this.lastKey.clear();
      this.playingZones.clear();
      const matched = [];
      for (const zone of msg.zones) {
        if (!this._matches(zone)) continue;
        matched.push(zone.display_name);
        this.lastKey.set(zone.zone_id, trackKey(zone));
        if (zone.state === 'playing') this.playingZones.add(zone.zone_id);
      }
      const isPlaying = this.playingZones.size > 0;
      if (!wasPlaying && isPlaying) this.emit('playing');
      if (wasPlaying && !isPlaying) this.emit('idle');
      this.emit('zones', { matched, all: msg.zones.map((z) => z.display_name) });
    } else if (response === 'Changed' && msg) {
      // Snapshot known keys BEFORE mutating, so a removed+added pair in one
      // message (zone regrouped/transferred mid-song) is recognized below.
      const knownKeys = new Set(this.lastKey.values());
      if (Array.isArray(msg.zones_removed)) {
        for (const zoneId of msg.zones_removed) {
          this.lastKey.delete(zoneId);
          if (this.playingZones.delete(zoneId)) this._emitIdleIfQuiet();
        }
      }
      if (Array.isArray(msg.zones_added)) this._processZones(msg.zones_added, knownKeys);
      if (Array.isArray(msg.zones_changed)) this._processZones(msg.zones_changed, null);
      // msg.zones_seek_changed: playhead ticks — deliberately ignored.
    }
    // 'Unsubscribed' / 'NetworkError' (msg undefined): nothing to do; on
    // re-pair a fresh Subscribed snapshot replaces state.
  }

  /**
   * @param {object[]} zones
   * @param {Set<string>|null} silentSeedKeys  for zones_added: track keys already
   *   known under another zone_id — the same song reappearing under a new zone
   *   (grouping change, zone transfer) seeds without a spurious 'track' event.
   */
  _processZones(zones, silentSeedKeys) {
    for (const zone of zones) {
      if (!this._matches(zone)) continue;
      const key = trackKey(zone);
      if (zone.state === 'playing' && key && key !== this.lastKey.get(zone.zone_id)) {
        if (silentSeedKeys && !this.lastKey.has(zone.zone_id) && silentSeedKeys.has(key)) {
          this.lastKey.set(zone.zone_id, key);
        } else {
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
