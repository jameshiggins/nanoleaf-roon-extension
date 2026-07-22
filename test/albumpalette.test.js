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

/** HSV(0-360,0-1,0-1) → [r,g,b] 0-255, for building synthetic test covers. */
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((u) => Math.round((u + m) * 255));
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

test('extracts the distinct swatches from a rich, multi-color cover', () => {
  const bands = [[220, 20, 20], [20, 200, 40], [30, 110, 240], [240, 220, 20], [200, 20, 200], [20, 220, 220]];
  const buf = image(24, 24, (x) => bands[Math.min(5, Math.floor(x / 4))]);
  const pal = extractPalette(buf, 24, 24);
  assert.ok(pal.swatches.length >= 5 && pal.swatches.length <= 6, `all 6 cover hues, got ${pal.swatches.length}`);
  for (let i = 0; i < pal.swatches.length; i++) {
    for (let j = i + 1; j < pal.swatches.length; j++) {
      assert.ok(hueDist(pal.swatches[i], pal.swatches[j]) >= 18, `swatches ${i},${j} distinct`);
    }
  }
  assert.equal(pal.base, pal.swatches[0]);
  assert.equal(pal.accent, pal.swatches[1]);
  assert.equal(pal.hit, pal.swatches[2]);
});

test('pulls more than 6 hues from a very colorful cover (raised cap)', () => {
  // 9 well-separated hues (every 40°) — the old cap of 6 would have clipped this.
  const bands = Array.from({ length: 9 }, (_, k) => hsvToRgb(k * 40, 0.9, 0.9));
  const buf = image(36, 36, (x) => bands[Math.min(8, Math.floor(x / 4))]);
  const pal = extractPalette(buf, 36, 36); // default maxSwatches now 10
  assert.ok(pal.swatches.length >= 8, `should pull most of the 9 hues, got ${pal.swatches.length}`);
});

test('maxSwatches opt caps the count', () => {
  const bands = Array.from({ length: 9 }, (_, k) => hsvToRgb(k * 40, 0.9, 0.9));
  const buf = image(36, 36, (x) => bands[Math.min(8, Math.floor(x / 4))]);
  const pal = extractPalette(buf, 36, 36, { maxSwatches: 4 });
  assert.equal(pal.swatches.length, 4, `capped to 4, got ${pal.swatches.length}`);
});

test('predominant mode picks the most-present color; default picks the most-vibrant', () => {
  // 60% low-vibrancy teal (hue ~200) + 40% vivid orange (hue ~40).
  const teal = hsvToRgb(200, 0.3, 0.6);
  const orange = hsvToRgb(40, 1.0, 1.0);
  const buf = image(20, 20, (x) => (x < 12 ? teal : orange)); // 12/20 cols teal ≈ 60%
  const vibrant = extractPalette(buf, 20, 20);                 // default: vibrancy-weighted
  const present = extractPalette(buf, 20, 20, { predominant: true }); // area-weighted
  assert.ok(hueDist(vibrant.base, 40) < 20, `default base = the vivid orange, got ${vibrant.base}`);
  assert.ok(hueDist(present.base, 200) < 20, `predominant base = the most-present teal, got ${present.base}`);
});

test('predominant mode returns the requested color count', () => {
  const bands = Array.from({ length: 6 }, (_, k) => hsvToRgb(k * 60, 0.9, 0.9));
  const buf = image(24, 24, (x) => bands[Math.min(5, Math.floor(x / 4))]);
  const pal = extractPalette(buf, 24, 24, { predominant: true, predominantCount: 4 });
  assert.equal(pal.swatches.length, 4, `4 predominant colors, got ${pal.swatches.length}`);
});

test('monochrome cover still yields 3 swatches (fanned) for the 3-color roles', () => {
  const pal = extractPalette(image(16, 16, () => [200, 160, 40]), 16, 16);
  assert.equal(pal.swatches.length, 3);
  assert.equal(new Set(pal.swatches.map(Math.round)).size, 3, 'three distinct hues');
});

test('grayscale cover → null (caller falls back to Vintage Modern)', () => {
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
