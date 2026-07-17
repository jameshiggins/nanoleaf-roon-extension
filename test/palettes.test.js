'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hsv, mix, dim, generatePalettes, PALETTES, resolvePalette, paletteNames } = require('../src/visuals/palettes');

test('hsv: primary colors', () => {
  const red = hsv(0, 1, 1);
  assert.deepEqual([Math.round(red.r), Math.round(red.g), Math.round(red.b)], [255, 0, 0]);
  const green = hsv(120, 1, 1);
  assert.deepEqual([Math.round(green.r), Math.round(green.g), Math.round(green.b)], [0, 255, 0]);
  const blue = hsv(240, 1, 1);
  assert.deepEqual([Math.round(blue.r), Math.round(blue.g), Math.round(blue.b)], [0, 0, 255]);
});

test('hsv: value 0 is black, saturation 0 is grey, hue wraps', () => {
  assert.deepEqual(hsv(180, 1, 0), { r: 0, g: 0, b: 0 });
  const grey = hsv(123, 0, 0.5);
  assert.ok(Math.abs(grey.r - grey.g) < 1e-9 && Math.abs(grey.g - grey.b) < 1e-9);
  assert.deepEqual(hsv(360, 1, 1), hsv(0, 1, 1));
  assert.deepEqual(hsv(-360, 1, 1), hsv(0, 1, 1));
});

test('mix and dim', () => {
  assert.deepEqual(mix({ r: 0, g: 0, b: 0 }, { r: 100, g: 200, b: 40 }, 0.5), { r: 50, g: 100, b: 20 });
  assert.deepEqual(dim({ r: 100, g: 80, b: 40 }, 0.5), { r: 50, g: 40, b: 20 });
});

test('generatePalettes: produces the requested count, all distinct', () => {
  for (const count of [1, 12, 36, 60, 200]) {
    const ps = generatePalettes(count);
    assert.equal(ps.length, count, `count ${count}`);
    const names = new Set(ps.map((p) => p.name));
    assert.equal(names.size, count, `names distinct for ${count}`);
    for (const p of ps) {
      for (const hue of [p.base, p.accent, p.hit]) {
        assert.ok(hue >= 0 && hue < 360, `hue in range: ${hue}`);
      }
    }
  }
});

test('generatePalettes: deterministic', () => {
  assert.deepEqual(generatePalettes(20), generatePalettes(20));
});

test('default PALETTES set has at least 30', () => {
  assert.ok(PALETTES.length >= 30, `got ${PALETTES.length}`);
});

test('consecutive palettes differ in base hue (golden-angle spread)', () => {
  const ps = generatePalettes(10);
  for (let i = 1; i < ps.length; i++) {
    const d = Math.abs(ps[i].base - ps[i - 1].base);
    const wrapped = Math.min(d, 360 - d);
    assert.ok(wrapped > 20, `palettes ${i - 1}/${i} too close: ${wrapped}`);
  }
});

// --- curated palettes + pin resolution ---

test('resolvePalette finds the curated Retro palette (case-insensitive)', () => {
  assert.equal(resolvePalette('Retro').name, 'Retro');
  assert.equal(resolvePalette('retro').name, 'Retro');
  assert.equal(resolvePalette('RETRO').name, 'Retro');
});

test('Retro carries muting sat/val and warm harvest hues', () => {
  const retro = resolvePalette('Retro');
  assert.ok(retro.sat < 1, `sat should be < 1, got ${retro.sat}`);
  assert.ok(retro.val > 0 && retro.val <= 1, `val in (0,1], got ${retro.val}`);
  assert.ok(retro.base >= 30 && retro.base <= 60, `base is a gold hue, got ${retro.base}`);
});

test('generated palettes carry no sat/val (unchanged full-saturation behavior)', () => {
  for (const p of generatePalettes(36)) {
    assert.equal(p.sat, undefined, `${p.name} must not define sat`);
    assert.equal(p.val, undefined, `${p.name} must not define val`);
  }
});

test('resolvePalette: generated names resolve; Retro resolves at any count', () => {
  assert.ok(resolvePalette('Citrus Pop', 36), 'generated name resolves at count 36');
  assert.ok(resolvePalette('Retro', 1), 'curated Retro resolves even at count 1');
});

test('resolvePalette returns null for unknown names', () => {
  assert.equal(resolvePalette('Nonexistent Sparkle'), null);
  assert.equal(resolvePalette(''), null);
});

test('paletteNames lists curated first, no duplicates', () => {
  const names = paletteNames(36);
  assert.equal(names[0], 'Retro', 'curated Retro leads the list');
  assert.ok(names.includes('Citrus Pop'), 'generated names included');
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
});
