'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ShieldForegroundWatcher, parseForegroundPackage } = require('../src/shield/foreground');

const dump = (wake, pkg) =>
  `    mWakefulness=${wake}\n` +
  `  mResumedActivity: ActivityRecord{a1b2 u0 ${pkg}/.SomeActivity t42}`;

const AWAKE_PLEX = dump('Awake', 'com.plexapp.android');
const AWAKE_NETFLIX = dump('Awake', 'com.netflix.ninja');
const AWAKE_ROONSHIELD = dump('Awake', 'com.roonshield');      // the visualiser: NOT a trigger app
const ASLEEP_PLEX = dump('Asleep', 'com.plexapp.android');

/** Fake adb: records argv, answers `connect` with '' and `shell` with a settable dumpsys string. */
function harness(init = {}) {
  const state = { output: init.output || '', connectFails: !!init.connectFails, shellFails: !!init.shellFails };
  const triggered = [];
  const runs = [];
  const run = async (_file, args) => {
    runs.push(args);
    if (args.includes('connect')) { if (state.connectFails) throw new Error('connect refused'); return ''; }
    if (args.includes('shell')) { if (state.shellFails) throw new Error('device offline'); return state.output; }
    return '';
  };
  const w = new ShieldForegroundWatcher({
    target: 't:5555',
    triggerApps: ['com.plexapp.android', 'com.netflix.ninja'],
    run,
    onTrigger: (pkg) => { triggered.push(pkg); },
  });
  return { w, state, triggered, runs };
}

test('parseForegroundPackage pulls the package, prefers mResumedActivity, else null', () => {
  assert.equal(parseForegroundPackage(AWAKE_PLEX), 'com.plexapp.android');
  const twoLines =
    '  ResumedActivity: ActivityRecord{x u0 com.other.app/.A t1}\n' +
    '  mResumedActivity: ActivityRecord{y u0 com.plexapp.android/.B t2}';
  assert.equal(parseForegroundPackage(twoLines), 'com.plexapp.android');
  assert.equal(parseForegroundPackage('no activity line here'), null);
  assert.equal(parseForegroundPackage(''), null);
});

test('awake + a watched media app in front → onTrigger(pkg)', async () => {
  const h = harness({ output: AWAKE_PLEX });
  await h.w.poll();
  assert.deepEqual(h.triggered, ['com.plexapp.android']);
});

test('awake + a non-watched app (the Roon visualiser) → never switches', async () => {
  const h = harness({ output: AWAKE_ROONSHIELD });
  await h.w.poll();
  assert.deepEqual(h.triggered, []);
});

test('asleep → never switches, even with a media app last in front', async () => {
  const h = harness({ output: ASLEEP_PLEX });
  await h.w.poll();
  assert.deepEqual(h.triggered, []);
});

test('edge-triggered: the same app still in front fires only once', async () => {
  const h = harness({ output: AWAKE_PLEX });
  await h.w.poll();
  await h.w.poll();
  await h.w.poll();
  assert.deepEqual(h.triggered, ['com.plexapp.android']);
});

test('a different watched app coming forward fires again', async () => {
  const h = harness({ output: AWAKE_PLEX });
  await h.w.poll();
  h.state.output = AWAKE_NETFLIX;
  await h.w.poll();
  assert.deepEqual(h.triggered, ['com.plexapp.android', 'com.netflix.ninja']);
});

test('leaving a media app for a non-watched one, then back, re-fires', async () => {
  const h = harness({ output: AWAKE_PLEX });
  await h.w.poll();                       // plex → fire
  h.state.output = AWAKE_ROONSHIELD;      // not watched → no fire, but advances the edge
  await h.w.poll();
  h.state.output = AWAKE_PLEX;            // plex again is a new edge → fire
  await h.w.poll();
  assert.deepEqual(h.triggered, ['com.plexapp.android', 'com.plexapp.android']);
});

test('going to sleep resets the edge, so waking back into a media app fires', async () => {
  const h = harness({ output: AWAKE_PLEX });
  await h.w.poll();                       // fire
  h.state.output = ASLEEP_PLEX;           // asleep → reset, no fire
  await h.w.poll();
  h.state.output = AWAKE_PLEX;            // awake plex again → fire
  await h.w.poll();
  assert.deepEqual(h.triggered, ['com.plexapp.android', 'com.plexapp.android']);
});

test('a failed adb shell is swallowed — never throws, never switches', async () => {
  const h = harness({ output: AWAKE_PLEX, shellFails: true });
  await assert.doesNotReject(h.w.poll());
  assert.deepEqual(h.triggered, []);
});

test('a failed adb connect (Shield off/unreachable) is swallowed', async () => {
  const h = harness({ output: AWAKE_PLEX, connectFails: true });
  await assert.doesNotReject(h.w.poll());
  assert.deepEqual(h.triggered, []);
});

test('start()/stop() drive polling through injected timers and are idempotent', async () => {
  const intervals = [];
  let cleared = 0;
  const w = new ShieldForegroundWatcher({
    target: 't:5555',
    triggerApps: ['com.plexapp.android'],
    run: async () => '',
    setInterval: (fn, ms) => { const id = intervals.length + 1; intervals.push({ id, fn, ms }); return id; },
    clearInterval: () => { cleared++; },
    pollMs: 4000,
  });
  w.start();
  w.start();                               // idempotent: still one interval
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 4000);
  w.stop();
  assert.equal(cleared, 1);
  w.stop();                                // idempotent: no second clear
  assert.equal(cleared, 1);
});
