'use strict';

/**
 * Color helpers + procedural palette generation.
 *
 * Palettes are generated, not hand-picked: base hues step around the wheel by
 * the golden angle (so consecutive palettes are far apart), crossed with six
 * color-harmony schemes (analogous, complementary, triadic, ...). The default
 * set is 36 palettes; ask for more and it keeps going without repeating names.
 * Every palette is { name, base, accent, hit } — three hues the visualizers
 * use for the background wash, the moving elements, and the beat hits.
 */

/**
 * @param {number} h hue 0-360, @param {number} s 0-1, @param {number} v 0-1
 * @returns {{ r: number, g: number, b: number }} 0-255
 */
function hsv(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** Linear blend of two {r,g,b} colors, t in [0,1]. */
function mix(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

/** Scale a color's brightness. */
function dim(c, k) {
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

const GOLDEN_ANGLE = 137.508;

// harmony schemes: hue offsets for the accent and hit colors
const SCHEMES = [
  { name: 'Drift', accent: 35, hit: 70 },     // analogous — smooth, tonal
  { name: 'Clash', accent: 180, hit: 150 },   // complementary — maximum contrast
  { name: 'Triad', accent: 120, hit: 240 },   // triadic — balanced, vivid
  { name: 'Split', accent: 150, hit: 210 },   // split-complementary
  { name: 'Cross', accent: 90, hit: 270 },    // square-ish — eclectic
  { name: 'Pop', accent: 15, hit: 180 },      // monochrome wash, opposing hits
];

const HUE_NAMES = [
  [15, 'Crimson'], [40, 'Ember'], [58, 'Gold'], [75, 'Citrus'], [105, 'Lime'],
  [140, 'Emerald'], [165, 'Teal'], [190, 'Cyan'], [215, 'Azure'], [245, 'Indigo'],
  [280, 'Violet'], [315, 'Magenta'], [342, 'Rose'], [361, 'Crimson'],
];

function hueName(h) {
  h = ((h % 360) + 360) % 360;
  for (const [limit, name] of HUE_NAMES) {
    if (h < limit) return name;
  }
  return 'Crimson';
}

/**
 * Deterministically generate `count` distinct palettes (count >= 1).
 * @returns {Array<{ name: string, base: number, accent: number, hit: number }>}
 */
function generatePalettes(count = 36) {
  const palettes = [];
  const seen = new Set();
  for (let i = 0; palettes.length < count; i++) {
    const base = Math.round((i * GOLDEN_ANGLE) % 360);
    const scheme = SCHEMES[i % SCHEMES.length];
    let name = `${hueName(base)} ${scheme.name}`;
    if (seen.has(name)) name = `${name} ${Math.floor(i / (SCHEMES.length * 12)) + 2}`;
    if (seen.has(name)) continue; // extremely unlikely; skip rather than dup
    seen.add(name);
    palettes.push({
      name,
      base,
      accent: (base + scheme.accent) % 360,
      hit: (base + scheme.hit) % 360,
    });
  }
  return palettes;
}

const PALETTES = generatePalettes(36);

/**
 * Hand-picked palettes that live outside the procedural set. Unlike the
 * generated palettes — pure hues rendered at full saturation — these may carry
 * `sat`/`val` (0..1) to mute the whole look (the renderer applies them as a
 * post-render tone pass) and a `swatches` array of hues that the multi-color
 * scenes paint through.
 *
 * `Vintage Modern` mirrors the Nanoleaf community scene of the same name
 * (dark__cake__090), read straight off the controller: six muted colors — rust,
 * sea green, olive, gold, amber, orange. We keep all six as swatches and mute
 * via the tone pass to match the scene's low-saturation, vintage feel. The
 * base/accent/hit trio (amber / green / rust) drives the 3-color scenes.
 */
const CURATED = [
  {
    name: 'Vintage Modern',
    swatches: [41, 135, 4, 23, 51, 83],
    base: 41, accent: 135, hit: 4,
    sat: 0.6, val: 0.85,
  },
  {
    // Black-and-white: sat 0 collapses every hue to gray, so the tone pass renders
    // each scene as a pure brightness gradient — the engine's motion in grayscale.
    name: 'Mono',
    base: 0, accent: 0, hit: 0,
    sat: 0, val: 1,
  },
];

/**
 * Resolve a palette by name (case-insensitive), curated set first, then a
 * generated set of `count` palettes. `count` matters because the generated
 * names depend on how many were asked for; curated palettes are always found.
 * @returns {object|null} the palette, or null if the name is unknown
 */
function resolvePalette(name, count = 36) {
  const key = String(name).toLowerCase();
  const curated = CURATED.find((p) => p.name.toLowerCase() === key);
  if (curated) return curated;
  return generatePalettes(count).find((p) => p.name.toLowerCase() === key) || null;
}

/** Every pinnable palette name at a given generated `count`, curated first. */
function paletteNames(count = 36) {
  return [...CURATED.map((p) => p.name), ...generatePalettes(count).map((p) => p.name)];
}

module.exports = { hsv, mix, dim, generatePalettes, PALETTES, CURATED, resolvePalette, paletteNames };
