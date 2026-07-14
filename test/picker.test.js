'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScenePicker, filterScenes } = require('../src/scenes/picker');

// deterministic rng from a fixed sequence
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('picker: cycles through every scene before repeating any', () => {
  const scenes = ['A', 'B', 'C', 'D', 'E'];
  const picker = new ScenePicker(scenes, { rng: seqRng([0.1, 0.9, 0.3, 0.7, 0.5]) });
  const round1 = new Set(Array.from({ length: 5 }, () => picker.next()));
  assert.deepEqual([...round1].sort(), scenes, 'first 5 picks must cover all 5 scenes');
  const round2 = new Set(Array.from({ length: 5 }, () => picker.next()));
  assert.deepEqual([...round2].sort(), scenes, 'next 5 picks must cover all 5 again');
});

test('picker: never repeats the same scene back-to-back', () => {
  const picker = new ScenePicker(['A', 'B', 'C'], { rng: Math.random });
  let prev = null;
  for (let i = 0; i < 300; i++) {
    const s = picker.next();
    assert.notEqual(s, prev, `repeat at pick ${i}`);
    prev = s;
  }
});

test('picker: single scene just keeps returning it', () => {
  const picker = new ScenePicker(['Only']);
  assert.equal(picker.next(), 'Only');
  assert.equal(picker.next(), 'Only');
});

test('picker: rejects an empty list', () => {
  assert.throws(() => new ScenePicker([]));
});

test('filterScenes: include list wins and is case-insensitive', () => {
  const out = filterScenes(['Sound Bar', 'Ripple', 'Fireworks'], { include: ['ripple', 'SOUND BAR', 'Nope'] });
  assert.deepEqual(out, ['Ripple', 'Sound Bar']);
});

test('filterScenes: exclude removes case-insensitively', () => {
  const out = filterScenes(['Sound Bar', 'Ripple', 'Fireworks'], { exclude: ['FIREWORKS'] });
  assert.deepEqual(out, ['Sound Bar', 'Ripple']);
});

test('filterScenes: no filters passes everything through', () => {
  const all = ['A', 'B'];
  assert.deepEqual(filterScenes(all, {}), all);
  assert.deepEqual(filterScenes(all), all);
});

test('filterScenes: duplicates are collapsed (they would defeat no-repeat)', () => {
  assert.deepEqual(
    filterScenes(['Ripple', 'Sound Bar'], { include: ['ripple', 'Ripple', 'RIPPLE'] }),
    ['Ripple']
  );
  assert.deepEqual(filterScenes(['A', 'A', 'B'], {}), ['A', 'B']);
});
