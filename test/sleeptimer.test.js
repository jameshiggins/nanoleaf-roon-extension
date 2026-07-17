'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SleepTimer, DEFAULT_GUARD_MS } = require('../src/roon/sleeptimer');

// A controllable fake timer: schedule() records (fn, ms); fireDue(elapsed)
// invokes callbacks whose delay has elapsed. Only one timer is ever pending
// here (the module cancels before rescheduling), which keeps this simple.
function fakeClock() {
  let handle = null; // { fn, ms }
  return {
    schedule(fn, ms) { handle = { fn, ms }; return handle; },
    cancel(h) { if (handle === h) handle = null; },
    pending() { return handle; },
    fire() { const h = handle; handle = null; if (h) h.fn(); },
  };
}

function make(guardMs = 0) {
  const clock = fakeClock();
  const stopped = [];
  const timer = new SleepTimer({
    stop: (zoneId) => stopped.push(zoneId),
    schedule: clock.schedule,
    cancel: clock.cancel,
    guardMs,
  });
  return { timer, clock, stopped };
}

test('arm binds to the given zone and schedules from the first seek tick', () => {
  const { timer, clock } = make(0);
  timer.arm({ zoneId: 'z1' });
  assert.equal(timer.armed, true);
  assert.equal(clock.pending(), null, 'nothing scheduled until a seek tick arrives');
  timer.onSeek({ zoneId: 'z1', seekPosition: 100, length: 200, state: 'playing' });
  assert.equal(clock.pending().ms, 100 * 1000, 'remaining = length - position');
});

test('reschedules earlier as the playhead advances, then fires and stops once', () => {
  const { timer, clock, stopped } = make(0);
  timer.arm({ zoneId: 'z1' });
  timer.onSeek({ zoneId: 'z1', seekPosition: 100, length: 200, state: 'playing' });
  assert.equal(clock.pending().ms, 100000);
  timer.onSeek({ zoneId: 'z1', seekPosition: 199, length: 200, state: 'playing' });
  assert.equal(clock.pending().ms, 1000, 'converges toward the end of the track');
  clock.fire();
  assert.deepEqual(stopped, ['z1']);
  assert.equal(timer.armed, false, 'one-shot: disarms after firing');
  assert.equal(clock.pending(), null);
});

test('guard fires before the natural boundary', () => {
  const { timer, clock } = make(DEFAULT_GUARD_MS);
  timer.arm({ zoneId: 'z1' });
  timer.onSeek({ zoneId: 'z1', seekPosition: 199, length: 200, state: 'playing' });
  assert.equal(clock.pending().ms, 1000 - DEFAULT_GUARD_MS);
});

test('remaining never goes negative (guard past the end clamps to 0)', () => {
  const { timer, clock } = make(2000);
  timer.arm({ zoneId: 'z1' });
  timer.onSeek({ zoneId: 'z1', seekPosition: 199.5, length: 200, state: 'playing' });
  assert.equal(clock.pending().ms, 0);
});

test('lazy binding: armed with no zone binds to the first playing tick', () => {
  const { timer, clock } = make(0);
  timer.arm({ zoneId: null });
  assert.equal(timer.zoneId, null);
  timer.onSeek({ zoneId: 'zX', seekPosition: 10, length: 60, state: 'playing' });
  assert.equal(timer.zoneId, 'zX');
  assert.equal(clock.pending().ms, 50000);
});

test('ticks from other zones are ignored once bound', () => {
  const { timer, clock } = make(0);
  timer.arm({ zoneId: 'z1' });
  timer.onSeek({ zoneId: 'z2', seekPosition: 199, length: 200, state: 'playing' });
  assert.equal(clock.pending(), null, 'wrong zone does not schedule');
  timer.onSeek({ zoneId: 'z1', seekPosition: 50, length: 200, state: 'playing' });
  assert.equal(clock.pending().ms, 150000);
});

test('a paused tick cancels the pending stop; resume reschedules', () => {
  const { timer, clock } = make(0);
  timer.arm({ zoneId: 'z1' });
  timer.onSeek({ zoneId: 'z1', seekPosition: 199, length: 200, state: 'playing' });
  assert.ok(clock.pending());
  timer.onSeek({ zoneId: 'z1', seekPosition: 199, length: 200, state: 'paused' });
  assert.equal(clock.pending(), null, 'paused cancels');
  assert.equal(timer.armed, true, 'still armed while paused');
  timer.onSeek({ zoneId: 'z1', seekPosition: 199, length: 200, state: 'playing' });
  assert.ok(clock.pending(), 'resume reschedules');
});

test('onIdle for the bound zone cancels but stays armed', () => {
  const { timer, clock } = make(0);
  timer.arm({ zoneId: 'z1' });
  timer.onSeek({ zoneId: 'z1', seekPosition: 100, length: 200, state: 'playing' });
  timer.onIdle('z1');
  assert.equal(clock.pending(), null);
  assert.equal(timer.armed, true);
});

test('onIdle for a different zone leaves the pending stop alone', () => {
  const { timer, clock } = make(0);
  timer.arm({ zoneId: 'z1' });
  timer.onSeek({ zoneId: 'z1', seekPosition: 100, length: 200, state: 'playing' });
  timer.onIdle('z2');
  assert.ok(clock.pending(), 'unrelated zone idle does not cancel');
});

test('global onIdle (no zone) cancels the pending stop', () => {
  const { timer, clock } = make(0);
  timer.arm({ zoneId: 'z1' });
  timer.onSeek({ zoneId: 'z1', seekPosition: 100, length: 200, state: 'playing' });
  timer.onIdle();
  assert.equal(clock.pending(), null);
});

test('missing / zero length does not schedule', () => {
  const { timer, clock } = make(0);
  timer.arm({ zoneId: 'z1' });
  timer.onSeek({ zoneId: 'z1', seekPosition: 0, state: 'playing' });
  assert.equal(clock.pending(), null, 'no length → no schedule');
  timer.onSeek({ zoneId: 'z1', seekPosition: 0, length: 0, state: 'playing' });
  assert.equal(clock.pending(), null, 'zero length → no schedule');
});

test('disarm cancels everything and ignores later ticks', () => {
  const { timer, clock, stopped } = make(0);
  timer.arm({ zoneId: 'z1' });
  timer.onSeek({ zoneId: 'z1', seekPosition: 100, length: 200, state: 'playing' });
  timer.disarm('user');
  assert.equal(timer.armed, false);
  assert.equal(clock.pending(), null);
  timer.onSeek({ zoneId: 'z1', seekPosition: 199, length: 200, state: 'playing' });
  assert.equal(clock.pending(), null, 'ticks ignored while disarmed');
  assert.deepEqual(stopped, []);
});

test('seek ticks are ignored entirely while disarmed', () => {
  const { timer, clock } = make(0);
  timer.onSeek({ zoneId: 'z1', seekPosition: 100, length: 200, state: 'playing' });
  assert.equal(clock.pending(), null);
  assert.equal(timer.zoneId, null, 'no binding happens while disarmed');
});

test('emits armed / fired events', () => {
  const { timer, clock } = make(0);
  const events = [];
  timer.on('armed', (e) => events.push(['armed', e.zoneId]));
  timer.on('fired', (e) => events.push(['fired', e.zoneId]));
  timer.arm({ zoneId: 'z1' });
  timer.onSeek({ zoneId: 'z1', seekPosition: 199, length: 200, state: 'playing' });
  clock.fire();
  assert.deepEqual(events, [['armed', 'z1'], ['fired', 'z1']]);
});
