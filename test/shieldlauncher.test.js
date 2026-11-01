'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ShieldLauncher } = require('../src/shield/launcher');

const ASLEEP = '  mWakefulness=Asleep\n    mResumedActivity: ActivityRecord{1 u0 com.roonshield/.MainActivity t1}\n';
const AWAKE_OTHER = '  mWakefulness=Awake\n    mResumedActivity: ActivityRecord{1 u0 com.netflix.ninja/.MainActivity t2}\n';
const AWAKE_OURS = '  mWakefulness=Awake\n    mResumedActivity: ActivityRecord{1 u0 com.roonshield/.MainActivity t1}\n';

/** Fake adb: records every shell command, answers the state probe with `state()`. */
function harness(state, opts = {}) {
  const shells = [];
  let clock = 0;
  const launcher = new ShieldLauncher({
    target: '10.0.0.5:5555',
    now: () => clock,
    run: async (file, args) => {
      if (args[0] === 'connect') return 'connected';
      const cmd = args[args.length - 1];
      shells.push(cmd);
      if (opts.fail) throw new Error('device offline');
      return cmd.startsWith('dumpsys') ? state() : '';
    },
  });
  return { launcher, shells, tick: (ms) => { clock += ms; } };
}

const launches = (shells) => shells.filter((c) => c.startsWith('am start'));

test('asleep Shield: wakes it, then opens Now Playing', async () => {
  const h = harness(() => ASLEEP);
  assert.equal(await h.launcher.onFirstPlay(), 'launched');
  assert.deepEqual(h.shells.slice(1), [
    'input keyevent KEYCODE_WAKEUP',
    'am start -n com.roonshield/.MainActivity --es start_tab nowplaying',
  ]);
});

test('awake on another app: opens ours without a wake key', async () => {
  const h = harness(() => AWAKE_OTHER);
  assert.equal(await h.launcher.onFirstPlay(), 'launched');
  assert.ok(!h.shells.includes('input keyevent KEYCODE_WAKEUP'));
  assert.equal(launches(h.shells).length, 1);
});

test('app already on screen: does nothing, and does not start the cooldown', async () => {
  let state = AWAKE_OURS;
  const h = harness(() => state);
  assert.equal(await h.launcher.onFirstPlay(), 'already-up');
  assert.equal(launches(h.shells).length, 0);
  state = AWAKE_OTHER; // user switched to Netflix, music restarts a minute later
  h.tick(60 * 1000);
  assert.equal(await h.launcher.onFirstPlay(), 'launched');
});

test('launches at most once per 30 minutes', async () => {
  const h = harness(() => AWAKE_OTHER);
  assert.equal(await h.launcher.onFirstPlay(), 'launched');
  h.tick(29 * 60 * 1000);
  assert.equal(await h.launcher.onFirstPlay(), 'cooldown');
  assert.equal(launches(h.shells).length, 1);
  h.tick(60 * 1000);
  assert.equal(await h.launcher.onFirstPlay(), 'launched');
  assert.equal(launches(h.shells).length, 2);
});

test('an unreachable Shield is swallowed and does not start the cooldown', async () => {
  const h = harness(() => ASLEEP, { fail: true });
  assert.equal(await h.launcher.onFirstPlay(), 'error');
  assert.equal(h.launcher.lastLaunch, null);
});
