'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TrackWatcher, trackKey } = require('../src/roon/trackwatcher');

function zone(id, name, state, track) {
  return {
    zone_id: id,
    display_name: name,
    state,
    now_playing: track
      ? { three_line: { line1: track.title, line2: track.artist, line3: track.album }, length: track.length ?? 200 }
      : undefined,
  };
}

function collect(watcher) {
  const events = { track: [], playing: 0, idle: 0 };
  watcher.on('track', (t) => events.track.push(t));
  watcher.on('playing', () => events.playing++);
  watcher.on('idle', () => events.idle++);
  return events;
}

test('trackKey: derived from lines + length, null without now_playing', () => {
  const z = zone('z1', 'Study', 'playing', { title: 'Song', artist: 'Band', album: 'LP', length: 123 });
  assert.equal(trackKey(z), 'Song|Band|LP|123');
  assert.equal(trackKey(zone('z1', 'Study', 'stopped', null)), null);
});

test('startup snapshot seeds without emitting', () => {
  const w = new TrackWatcher();
  const ev = collect(w);
  w.handleEvent('Subscribed', { zones: [zone('z1', 'Study', 'playing', { title: 'A', artist: 'B', album: 'C' })] });
  assert.equal(ev.track.length, 0, 'no track event on startup');
  assert.equal(ev.playing, 1, 'playing state is still reported');
});

test('new track while playing emits exactly once', () => {
  const w = new TrackWatcher();
  const ev = collect(w);
  w.handleEvent('Subscribed', { zones: [zone('z1', 'Study', 'playing', { title: 'A', artist: 'B', album: 'C' })] });
  const next = zone('z1', 'Study', 'playing', { title: 'D', artist: 'B', album: 'C' });
  w.handleEvent('Changed', { zones_changed: [next] });
  w.handleEvent('Changed', { zones_changed: [next] }); // duplicate delivery (e.g. volume move)
  assert.equal(ev.track.length, 1);
  assert.deepEqual(ev.track[0], { zoneName: 'Study', title: 'D', artist: 'B', album: 'C', key: 'D|B|C|200' });
});

test('pause and resume of the same track never emit', () => {
  const w = new TrackWatcher();
  const ev = collect(w);
  const t = { title: 'A', artist: 'B', album: 'C' };
  w.handleEvent('Subscribed', { zones: [zone('z1', 'Study', 'playing', t)] });
  w.handleEvent('Changed', { zones_changed: [zone('z1', 'Study', 'paused', t)] });
  w.handleEvent('Changed', { zones_changed: [zone('z1', 'Study', 'playing', t)] });
  assert.equal(ev.track.length, 0);
  assert.equal(ev.idle, 1, 'pause reports idle');
  assert.equal(ev.playing, 2, 'resume reports playing again');
});

test('skipping tracks while paused, then play → exactly one emit', () => {
  const w = new TrackWatcher();
  const ev = collect(w);
  w.handleEvent('Subscribed', { zones: [zone('z1', 'Study', 'playing', { title: 'A', artist: 'B', album: 'C' })] });
  w.handleEvent('Changed', { zones_changed: [zone('z1', 'Study', 'paused', { title: 'X', artist: 'B', album: 'C' })] });
  w.handleEvent('Changed', { zones_changed: [zone('z1', 'Study', 'paused', { title: 'Y', artist: 'B', album: 'C' })] });
  assert.equal(ev.track.length, 0, 'paused skips emit nothing');
  w.handleEvent('Changed', { zones_changed: [zone('z1', 'Study', 'playing', { title: 'Y', artist: 'B', album: 'C' })] });
  assert.equal(ev.track.length, 1);
  assert.equal(ev.track[0].title, 'Y');
});

test('zone filter matches case-insensitive substring, other zones ignored', () => {
  const w = new TrackWatcher({ zone: 'study' });
  const ev = collect(w);
  w.handleEvent('Subscribed', { zones: [] });
  w.handleEvent('Changed', { zones_changed: [zone('z2', 'Kitchen', 'playing', { title: 'K', artist: '', album: '' })] });
  assert.equal(ev.track.length, 0, 'non-matching zone ignored');
  w.handleEvent('Changed', { zones_changed: [zone('z1', 'The Study + 1', 'playing', { title: 'S', artist: '', album: '' })] });
  assert.equal(ev.track.length, 1, 'grouped-zone name still substring-matches');
});

test('zones_added is processed like zones_changed (grouping re-adds zones)', () => {
  const w = new TrackWatcher();
  const ev = collect(w);
  w.handleEvent('Subscribed', { zones: [] });
  w.handleEvent('Changed', { zones_added: [zone('z9', 'Study + 1', 'playing', { title: 'G', artist: 'B', album: 'C' })] });
  assert.equal(ev.track.length, 1);
});

test('zones_removed cleans state and can end playback', () => {
  const w = new TrackWatcher();
  const ev = collect(w);
  w.handleEvent('Subscribed', { zones: [zone('z1', 'Study', 'playing', { title: 'A', artist: 'B', album: 'C' })] });
  w.handleEvent('Changed', { zones_removed: ['z1'] });
  assert.equal(ev.idle, 1);
  assert.equal(w.lastKey.size, 0);
});

test('NetworkError / Unsubscribed with undefined msg are safe', () => {
  const w = new TrackWatcher();
  const ev = collect(w);
  w.handleEvent('NetworkError', undefined);
  w.handleEvent('Unsubscribed', {});
  w.handleEvent('Changed', undefined);
  assert.equal(ev.track.length, 0);
});

test('stopped zone (no now_playing) never emits, missing lines are guarded', () => {
  const w = new TrackWatcher();
  const ev = collect(w);
  w.handleEvent('Subscribed', { zones: [] });
  w.handleEvent('Changed', { zones_changed: [zone('z1', 'Study', 'stopped', null)] });
  const bare = { zone_id: 'z1', display_name: 'Study', state: 'playing', now_playing: { length: 100 } };
  w.handleEvent('Changed', { zones_changed: [bare] });
  assert.equal(ev.track.length, 1, 'sparse now_playing still keys on length');
  assert.equal(ev.track[0].key, '|||100');
});

test('two zones playing: idle only when both stop', () => {
  const w = new TrackWatcher();
  const ev = collect(w);
  const t = { title: 'A', artist: 'B', album: 'C' };
  w.handleEvent('Subscribed', { zones: [zone('z1', 'Study', 'playing', t), zone('z2', 'Kitchen', 'playing', t)] });
  w.handleEvent('Changed', { zones_changed: [zone('z1', 'Study', 'stopped', null)] });
  assert.equal(ev.idle, 0);
  w.handleEvent('Changed', { zones_changed: [zone('z2', 'Kitchen', 'paused', t)] });
  assert.equal(ev.idle, 1);
});
