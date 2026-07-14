'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareLayout } = require('../src/visuals/layout');

test('prepareLayout: normalizes to [0,1], drops the controller pseudo-panel, sorts left→right', () => {
  const positionData = [
    { panelId: 0, x: 50, y: 50 },   // controller pseudo-panel — dropped
    { panelId: 3, x: 200, y: 0 },
    { panelId: 1, x: 0, y: 100 },
    { panelId: 2, x: 100, y: 50 },
  ];
  const out = prepareLayout(positionData);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((p) => p.id), [1, 2, 3]); // left→right by x
  assert.equal(out[0].nx, 0);
  assert.equal(out[2].nx, 1);
  for (const p of out) {
    assert.ok(p.nx >= 0 && p.nx <= 1 && p.ny >= 0 && p.ny <= 1);
  }
});

test('prepareLayout: single panel maps to origin, no divide-by-zero', () => {
  const out = prepareLayout([{ panelId: 5, x: 42, y: 42 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 5);
  assert.ok(Number.isFinite(out[0].nx) && Number.isFinite(out[0].ny));
});

test('prepareLayout: empty / all-controller input yields empty', () => {
  assert.deepEqual(prepareLayout([]), []);
  assert.deepEqual(prepareLayout([{ panelId: 0, x: 1, y: 1 }]), []);
});
