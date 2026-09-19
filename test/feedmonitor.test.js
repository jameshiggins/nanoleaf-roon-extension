'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FeedMonitor } = require('../src/roon/feedmonitor');

const out = (id, name) => ({ output_id: id, display_name: name });

function collect(monitor) {
  const warnings = [];
  monitor.on('warning', (w) => warnings.push(w));
  return warnings;
}

test('playing + silent warns only after the grace period, and names the outputs Roon has', () => {
  const m = new FeedMonitor({ graceMs: 1000 });
  const w = collect(m);
  m.handleOutputs('Subscribed', { outputs: [out('o1', 'Hegel')] });
  m.sample(true, false, 0);
  m.sample(true, false, 999);
  assert.equal(w.length, 0, 'track gaps / loading are legitimately silent');
  m.sample(true, false, 1000);
  assert.equal(w.length, 1);
  assert.match(w[0], /no audio is arriving/);
  assert.match(w[0], /Roon outputs: Hegel\./);
  m.sample(true, false, 5000);
  assert.equal(w.length, 1, 'an unchanged warning is not re-emitted');
});

test('audio returning clears the warning and resets the clock', () => {
  const m = new FeedMonitor({ graceMs: 1000 });
  const w = collect(m);
  m.sample(true, false, 0);
  m.sample(true, false, 1000);
  m.sample(true, true, 1100);
  assert.deepEqual(w.slice(1), [null]);
  m.sample(true, false, 1200);
  m.sample(true, false, 2100);
  assert.equal(w.length, 2, 'silence is timed from its own start, not the earlier episode');
});

test('silence while Roon is idle is normal', () => {
  const m = new FeedMonitor({ graceMs: 1000 });
  const w = collect(m);
  m.sample(false, false, 0);
  m.sample(false, false, 60000);
  assert.equal(w.length, 0);
});

test('configured output missing: warns after grace even while idle, clears when it returns', () => {
  const m = new FeedMonitor({ output: 'Nanoleaf', graceMs: 1000 });
  const w = collect(m);
  m.handleOutputs('Subscribed', { outputs: [out('o1', 'Hegel'), out('o2', 'Nanoleaf Feed')] });
  m.sample(false, false, 0);
  m.handleOutputs('Changed', { outputs_removed: ['o2'] });
  m.sample(false, false, 100);
  m.sample(false, false, 1099);
  assert.equal(w.length, 0, 'a bridge restart drops the output for a few seconds');
  m.sample(false, false, 1100);
  assert.match(w[0], /no "nanoleaf" output/);
  m.handleOutputs('Changed', { outputs_added: [out('o3', 'Nanoleaf Feed')] });
  m.sample(false, false, 1200);
  assert.deepEqual(w.slice(1), [null]);
});

test('no verdict on outputs before the first snapshot or after the subscription drops', () => {
  const m = new FeedMonitor({ output: 'Nanoleaf', graceMs: 1000 });
  const w = collect(m);
  m.sample(false, false, 0);
  m.sample(false, false, 5000);
  assert.equal(w.length, 0, 'not paired yet — unknown, not missing');
  m.handleOutputs('Subscribed', { outputs: [out('o2', 'Nanoleaf Feed')] });
  m.handleOutputs('NetworkError', undefined);
  m.outputNames.clear();
  m.sample(false, false, 6000);
  m.sample(false, false, 9000);
  assert.equal(w.length, 0, 'a core outage must not read as a dead bridge');
});

test('without roon.feedOutput the output list is diagnostic only', () => {
  const m = new FeedMonitor({ graceMs: 1000 });
  const w = collect(m);
  m.handleOutputs('Subscribed', { outputs: [] });
  m.sample(false, false, 0);
  m.sample(false, false, 5000);
  assert.equal(w.length, 0);
  assert.deepEqual(m.outputs(), []);
});
