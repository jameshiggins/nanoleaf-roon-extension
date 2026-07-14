'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ShuffleBag, filterNames } = require('../src/visuals/shuffle');

function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('ShuffleBag: draws every item before repeating', () => {
  const items = ['a', 'b', 'c', 'd'];
  const bag = new ShuffleBag(items, { rng: seqRng([0.1, 0.9, 0.4, 0.6]) });
  const round = new Set(items.map(() => bag.next()));
  assert.deepEqual([...round].sort(), items);
});

test('ShuffleBag: never repeats back-to-back over many draws', () => {
  const bag = new ShuffleBag(['a', 'b', 'c'], { rng: Math.random });
  let prev = null;
  for (let i = 0; i < 500; i++) {
    const v = bag.next();
    assert.notEqual(v, prev, `repeat at ${i}`);
    prev = v;
  }
});

test('ShuffleBag: single item repeats, empty throws', () => {
  const bag = new ShuffleBag(['only']);
  assert.equal(bag.next(), 'only');
  assert.equal(bag.next(), 'only');
  assert.throws(() => new ShuffleBag([]));
});

test('filterNames: include wins, case-insensitive, deduped', () => {
  assert.deepEqual(filterNames(['Ripple', 'Wheel', 'Bars'], { include: ['wheel', 'WHEEL', 'bars'] }), ['Wheel', 'Bars']);
});

test('filterNames: exclude removes, empty passes through', () => {
  assert.deepEqual(filterNames(['a', 'b', 'c'], { exclude: ['B'] }), ['a', 'c']);
  assert.deepEqual(filterNames(['a', 'b'], {}), ['a', 'b']);
});
