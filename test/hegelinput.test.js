'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HegelInputSwitch } = require('../src/hegel/inputswitch');

/** Fake amp + fake clock: records commands, answers `-i.?` with `input`, fires timers by hand. */
function harness({ input = 9, fail = false } = {}) {
  const sent = [];
  const timers = new Map();
  let nextId = 1;
  let input_ = input;
  const sw = new HegelInputSwitch({
    host: '10.0.0.9',
    idleMs: 60 * 1000,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    send: async (host, port, cmd) => {
      sent.push(cmd);
      if (fail) throw new Error('ECONNREFUSED');
      if (cmd === '-i.?') return `-i.${input_}\r-m.0\r`; // the H190 tags the mute state along
      const m = /^-i\.(\d+)$/.exec(cmd);
      if (m) input_ = Number(m[1]);
      return `${cmd}\r`;
    },
  });
  const fire = async () => {
    const pending = [...timers.entries()];
    timers.clear();
    for (const [, t] of pending) await t.fn();
    await new Promise((r) => setImmediate(r));
  };
  return { sw, sent, timers, fire, input: () => input_ };
}

test('quiet for the full window with the amp on Network: switches to Optical 2', async () => {
  const h = harness({ input: 9 });
  h.sw.onIdle();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 60 * 1000);
  await h.fire();
  assert.deepEqual(h.sent, ['-i.?', '-i.6']);
  assert.equal(h.input(), 6);
});

test('play resuming inside the window cancels the hand-back', async () => {
  const h = harness({ input: 9 });
  h.sw.onIdle();
  h.sw.onPlaying();
  assert.equal(h.timers.size, 0);
  await h.fire();
  assert.deepEqual(h.sent, []);
});

test('repeated idle events never stack a second countdown', () => {
  const h = harness();
  h.sw.onIdle();
  h.sw.onIdle();
  h.sw.onIdle();
  assert.equal(h.timers.size, 1);
});

test('amp already on another input: someone chose it — left alone', async () => {
  const h = harness({ input: 4 }); // Coaxial
  h.sw.onIdle();
  await h.fire();
  assert.deepEqual(h.sent, ['-i.?']);
  assert.equal(h.input(), 4);
});

test('amp unreachable: logged and forgotten, no retry', async () => {
  const h = harness({ fail: true });
  h.sw.onIdle();
  await h.fire();
  assert.deepEqual(h.sent, ['-i.?']);
  assert.equal(h.timers.size, 0);
});

test('garbled reply: does not guess, does not switch', async () => {
  const sent = [];
  const sw = new HegelInputSwitch({ host: 'h', send: async (_h, _p, cmd) => { sent.push(cmd); return 'ok'; } });
  assert.equal(await sw.handBack(), 'unknown');
  assert.deepEqual(sent, ['-i.?']);
});

test('a new quiet period after a hand-back starts a fresh countdown', async () => {
  const h = harness({ input: 9 });
  h.sw.onIdle();
  await h.fire();
  h.sw.onPlaying(); // music again → amp jumps back to Network by itself
  h.sw.onIdle();
  assert.equal(h.timers.size, 1);
});
