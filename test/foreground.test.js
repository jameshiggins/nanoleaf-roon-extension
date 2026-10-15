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

/** Fake adb: records argv, answers `connect` with '' and `shell` with a settable dumpsys string.
 *  running stays false (start() not called) so tick() never self-reschedules in these unit checks. */
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
  await h.w.tick();
  assert.deepEqual(h.triggered, ['com.plexapp.android']);
});

test('awake + a non-watched app (the Roon visualiser) → never switches', async () => {
  const h = harness({ output: AWAKE_ROONSHIELD });
  await h.w.tick();
  assert.deepEqual(h.triggered, []);
});

test('asleep → never switches, even with a media app last in front', async () => {
  const h = harness({ output: ASLEEP_PLEX });
  await h.w.tick();
  assert.deepEqual(h.triggered, []);
});

test('edge-triggered: the same app still in front fires only once', async () => {
  const h = harness({ output: AWAKE_PLEX });
  await h.w.tick();
  await h.w.tick();
  await h.w.tick();
  assert.deepEqual(h.triggered, ['com.plexapp.android']);
});

test('a different watched app coming forward fires again', async () => {
  const h = harness({ output: AWAKE_PLEX });
  await h.w.tick();
  h.state.output = AWAKE_NETFLIX;
  await h.w.tick();
  assert.deepEqual(h.triggered, ['com.plexapp.android', 'com.netflix.ninja']);
});

test('leaving a media app for a non-watched one, then back, re-fires', async () => {
  const h = harness({ output: AWAKE_PLEX });
  await h.w.tick();                       // plex → fire
  h.state.output = AWAKE_ROONSHIELD;      // not watched → no fire, but advances the edge
  await h.w.tick();
  h.state.output = AWAKE_PLEX;            // plex again is a new edge → fire
  await h.w.tick();
  assert.deepEqual(h.triggered, ['com.plexapp.android', 'com.plexapp.android']);
});

test('going to sleep resets the edge, so waking back into a media app fires', async () => {
  const h = harness({ output: AWAKE_PLEX });
  await h.w.tick();                       // fire
  h.state.output = ASLEEP_PLEX;           // asleep → reset, no fire
  await h.w.tick();
  h.state.output = AWAKE_PLEX;            // awake plex again → fire
  await h.w.tick();
  assert.deepEqual(h.triggered, ['com.plexapp.android', 'com.plexapp.android']);
});

test('a failed adb shell is swallowed — never throws, never switches', async () => {
  const h = harness({ output: AWAKE_PLEX, shellFails: true });
  await assert.doesNotReject(h.w.tick());
  assert.deepEqual(h.triggered, []);
});

test('a failed adb connect (Shield off/unreachable) is swallowed', async () => {
  const h = harness({ output: AWAKE_PLEX, connectFails: true });
  await assert.doesNotReject(h.w.tick());
  assert.deepEqual(h.triggered, []);
});

test('repeated failures back off from pollMs to backoffMs; a success resets to fast', async () => {
  const scheduled = [];
  const state = { fail: true };
  const w = new ShieldForegroundWatcher({
    target: 't:5555', triggerApps: ['com.plexapp.android'], pollMs: 1000, backoffMs: 5000,
    run: async (_f, args) => { if (state.fail) throw new Error('offline'); return args.includes('shell') ? AWAKE_ROONSHIELD : ''; },
    onTrigger: () => {},
    setTimeout: (fn, ms) => { scheduled.push(ms); return scheduled.length; },
    clearTimeout: () => {},
  });
  w.running = true;                       // emulate being started, but drive tick() by hand
  await w.tick(); await w.tick();         // 2 fails: still fast
  assert.deepEqual(scheduled.slice(-2), [1000, 1000]);
  await w.tick();                         // 3rd consecutive fail → back off
  assert.equal(scheduled[scheduled.length - 1], 5000);
  state.fail = false;                     // Shield back
  await w.tick();                         // success → straight back to fast cadence
  assert.equal(scheduled[scheduled.length - 1], 1000);
  w.running = false;
});

test('start() checks immediately and self-schedules; stop() cancels; both idempotent', async () => {
  const scheduled = []; let cleared = 0;
  const w = new ShieldForegroundWatcher({
    target: 't:5555', triggerApps: ['com.plexapp.android'], pollMs: 1000,
    run: async (_f, args) => (args.includes('shell') ? AWAKE_ROONSHIELD : ''),
    onTrigger: () => {},
    setTimeout: (fn, ms) => { scheduled.push(ms); return scheduled.length; },
    clearTimeout: () => { cleared++; },
  });
  w.start();
  w.start();                              // idempotent — no second concurrent tick loop
  await new Promise((r) => setImmediate(r)); // let the immediate tick() resolve and reschedule
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0], 1000);
  w.stop();
  assert.equal(cleared, 1);
  w.stop();                               // idempotent
  assert.equal(cleared, 1);
});
