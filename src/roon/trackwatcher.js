'use strict';

/**
 * Turns raw Roon zone-subscription events into clean semantic events:
 *
 *   'track' ({ zoneId, zoneName, title, artist, album, imageKey, key })  — a new track started
 *   'seek'  ({ zoneId, zoneName, seekPosition, length, state })  — a playhead tick while playing
 *   'playing'                                          — a watched zone began playing
 *   'idle'                                             — no watched zone is playing anymore
 *   'zones' ({ matched, all })                         — zone names seen in a snapshot
 *
 * Pure logic, no Roon dependency — feed it the (response, msg) pairs from
 * RoonApiTransport.subscribe_zones. Design notes (verified against the
 * node-roon-api-transport source):
 *
 * - now_playing has no track id; identity is derived from three_line + length.
 * - Seek ticks arrive only in zones_seek_changed (~1/s while playing) and carry
 *   just { zone_id, seek_position }; the track length lives on now_playing, so
 *   we cache per-zone {name,length,state} from the zone snapshots and enrich the
 *   'seek' event with it. Track-change rotation never needed these ticks (hence
 *   the original design ignored them), but the sleep timer needs precise
 *   end-of-track timing, so they are surfaced as a 'seek' event now.
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
    this.zoneInfo = new Map();     // zone_id → { name, length, state } for enriching seek ticks
  }

  /** Cache the fields a bare seek tick lacks (name, track length, state). */
  _recordZone(zone) {
    this.zoneInfo.set(zone.zone_id, {
      name: zone.display_name,
      length: (zone.now_playing && zone.now_playing.length) ?? null,
      state: zone.state,
    });
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
      this.zoneInfo.clear();
      const matched = [];
      for (const zone of msg.zones) {
        if (!this._matches(zone)) continue;
        matched.push(zone.display_name);
        this.lastKey.set(zone.zone_id, trackKey(zone));
        this._recordZone(zone);
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
          this.zoneInfo.delete(zoneId);
          if (this.playingZones.delete(zoneId)) this._emitIdleIfQuiet();
        }
      }
      if (Array.isArray(msg.zones_added)) this._processZones(msg.zones_added, knownKeys);
      if (Array.isArray(msg.zones_changed)) this._processZones(msg.zones_changed, null);
      // Playhead ticks: enrich with the cached length/name and surface as 'seek'
      // for the sleep timer. Only known (matched) zones are in zoneInfo, so
      // ticks from filtered-out zones are naturally dropped.
      if (Array.isArray(msg.zones_seek_changed)) {
        for (const e of msg.zones_seek_changed) {
          const info = this.zoneInfo.get(e.zone_id);
          if (!info) continue;
          this.emit('seek', {
            zoneId: e.zone_id,
            zoneName: info.name,
            seekPosition: e.seek_position,
            length: info.length,
            state: info.state,
          });
        }
      }
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
      this._recordZone(zone);
      const key = trackKey(zone);
      if (zone.state === 'playing' && key && key !== this.lastKey.get(zone.zone_id)) {
        if (silentSeedKeys && !this.lastKey.has(zone.zone_id) && silentSeedKeys.has(key)) {
          this.lastKey.set(zone.zone_id, key);
        } else {
          this.lastKey.set(zone.zone_id, key);
          const t = (zone.now_playing && zone.now_playing.three_line) || {};
          this.emit('track', {
            zoneId: zone.zone_id,
            zoneName: zone.display_name,
            title: t.line1 || '',
            artist: t.line2 || '',
            album: t.line3 || '',
            imageKey: (zone.now_playing && zone.now_playing.image_key) || null,
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
