'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPalette, rgbToHsv } = require('../src/visuals/albumpalette');

/** Build a w×h RGBA buffer from a per-pixel color function. */
function image(w, h, colorAt) {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b, a = 255] = colorAt(i % w, Math.floor(i / w));
    buf.set([r, g, b, a], i * 4);
  }
  return buf;
}

const hueOf = (pal) => pal.base;

test('rgbToHsv: primaries', () => {
  assert.equal(Math.round(rgbToHsv(255, 0, 0).h), 0);
  assert.equal(Math.round(rgbToHsv(0, 255, 0).h), 120);
  assert.equal(Math.round(rgbToHsv(0, 0, 255).h), 240);
  assert.equal(rgbToHsv(128, 128, 128).s, 0); // gray has no saturation
});

test('solid red cover → base hue ≈ red', () => {
  const pal = extractPalette(image(16, 16, () => [220, 20, 20]), 16, 16);
  assert.ok(pal, 'palette extracted');
  assert.ok(hueDist(hueOf(pal), 0) < 12, `base near red, got ${hueOf(pal)}`);
});

test('solid green cover → base hue ≈ green', () => {
  const pal = extractPalette(image(16, 16, () => [30, 200, 40]), 16, 16);
  assert.ok(hueDist(hueOf(pal), 120) < 15, `base near green, got ${hueOf(pal)}`);
});

test('two-tone cover yields two distinct hues (base + accent)', () => {
  // left half orange (~30°), right half blue (~220°)
  const buf = image(16, 16, (x) => (x < 8 ? [235, 130, 20] : [20, 90, 220]));
  const pal = extractPalette(buf, 16, 16);
  const hues = [pal.base, pal.accent, pal.hit];
  assert.ok(hues.some((h) => hueDist(h, 30) < 20), `has an orange hue: ${hues}`);
  assert.ok(hues.some((h) => hueDist(h, 220) < 20), `has a blue hue: ${hues}`);
  assert.ok(hueDist(pal.base, pal.accent) >= 25, 'base and accent are distinct');
});

test('a small vibrant patch beats a large muddy/gray background', () => {
  // 90% desaturated gray, a bright magenta corner — vibrancy weighting must win
  const buf = image(20, 20, (x, y) => (x < 3 && y < 3 ? [230, 20, 200] : [110, 112, 108]));
  const pal = extractPalette(buf, 20, 20);
  assert.ok(pal, 'vibrant patch is found among gray');
  assert.ok(hueDist(pal.base, 306) < 20, `base is the magenta patch, got ${pal.base}`);
});

test('monochrome (single hue) cover still fans out to 3 distinct hues', () => {
  const pal = extractPalette(image(16, 16, () => [200, 160, 40]), 16, 16); // gold only
  assert.equal(new Set([
    Math.round(pal.base), Math.round(pal.accent), Math.round(pal.hit),
  ]).size, 3, 'three distinct hues so scenes keep contrast');
});

test('grayscale cover → null (caller falls back to Retro)', () => {
  assert.equal(extractPalette(image(16, 16, () => [90, 90, 90]), 16, 16), null);
  assert.equal(extractPalette(image(16, 16, () => [0, 0, 0]), 16, 16), null); // all black
});

test('sat/val mute knobs pass through (default light mute)', () => {
  const def = extractPalette(image(8, 8, () => [200, 20, 20]), 8, 8);
  assert.equal(def.sat, 0.9);
  assert.equal(def.val, 1.0);
  const muted = extractPalette(image(8, 8, () => [200, 20, 20]), 8, 8, { sat: 0.6, val: 0.85 });
  assert.equal(muted.sat, 0.6);
  assert.equal(muted.val, 0.85);
});

test('transparent pixels are ignored', () => {
  // half fully-transparent black, half solid teal — teal must win
  const buf = image(16, 16, (x) => (x < 8 ? [0, 0, 0, 0] : [20, 200, 190]));
  const pal = extractPalette(buf, 16, 16);
  assert.ok(hueDist(pal.base, 177) < 20, `base is teal despite transparent half, got ${pal.base}`);
});

// local copy so the test file is self-contained
function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
