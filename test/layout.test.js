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

test('prepareLayout: globalOrientation rotates the layout to match the wall', () => {
  // a horizontal 3-panel row; rotated 90° it must become a vertical column
  const row = [
    { panelId: 1, x: 0, y: 0 },
    { panelId: 2, x: 100, y: 0 },
    { panelId: 3, x: 200, y: 0 },
  ];
  const out = prepareLayout(row, 90);
  // after a 90° rotation, x-spread becomes y-spread: all nx equal, ny spans 0..1
  const nxs = out.map((p) => p.nx), nys = out.map((p) => p.ny).sort((a, b) => a - b);
  assert.ok(Math.max(...nxs) - Math.min(...nxs) < 1e-9, 'row collapses to one column');
  assert.deepEqual(nys, [0, 0.5, 1], 'panels now span bottom to top');
  // panel 1 (x=0) rotates to the bottom, panel 3 (x=200) to the top
  const byId = {};
  out.forEach((p) => { byId[p.id] = p; });
  assert.ok(byId[1].ny < byId[3].ny, 'rotation direction is counter-clockwise');
  // rotateDeg omitted → identical to the unrotated call
  assert.deepEqual(prepareLayout(row), prepareLayout(row, 0));
});

test('prepareLayout: carries shape, per-panel orientation, and mm coordinates for the preview', () => {
  const out = prepareLayout([
    { panelId: 1, x: 0, y: 0, o: 60, shapeType: 0 },
    { panelId: 2, x: 100, y: 0, o: 120, shapeType: 0 },
  ], 90);
  const byId = {};
  out.forEach((p) => { byId[p.id] = p; });
  assert.equal(byId[1].o, 150, 'panel orientation rotates with the layout');
  assert.equal(byId[1].shape, 0, 'shapeType passes through');
  assert.ok(Math.abs(byId[2].my - 100) < 1e-6, 'mm coords preserve true distances');
  assert.ok(Math.abs(byId[2].mx) < 1e-6, 'rotated row is a true mm column');
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
