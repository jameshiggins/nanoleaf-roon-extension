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

  // --- Popular Nanoleaf scene palettes ---------------------------------------
  // Hue sets transcribed from the Nanoleaf app's classic preset/community
  // scenes (Northern Lights, Pop Rocks, ...). Same rules as above: `swatches`
  // feed the multi-color scenes, base/accent/hit drive the 3-color ones, and
  // sat/val mute the pastel/icy looks via the tone pass.
  { name: 'Northern Lights', swatches: [140, 170, 200, 260, 290], base: 170, accent: 280, hit: 140, sat: 0.85 },
  { name: 'Waking Sea', swatches: [170, 185, 200, 215, 230], base: 210, accent: 175, hit: 190 },
  { name: 'Sundown', swatches: [15, 25, 345, 320, 280], base: 20, accent: 320, hit: 345 },
  { name: 'Forest', swatches: [80, 95, 120, 140, 160], base: 130, accent: 90, hit: 160, sat: 0.8, val: 0.9 },
  { name: 'Inner Peace', swatches: [190, 210, 250, 290, 330], base: 220, accent: 290, hit: 330, sat: 0.45 },
  { name: 'Jungle', swatches: [30, 60, 110, 140, 160], base: 120, accent: 60, hit: 30 },
  { name: 'Pop Rocks', swatches: [315, 270, 190, 120, 55], base: 315, accent: 190, hit: 55 },
  { name: 'Snowfall', swatches: [190, 200, 210, 220, 240], base: 210, accent: 195, hit: 230, sat: 0.3 },
  { name: 'Blaze', swatches: [355, 0, 15, 30, 45], base: 15, accent: 40, hit: 0 },
  { name: 'Cotton Candy', swatches: [330, 350, 280, 220, 200], base: 330, accent: 205, hit: 280, sat: 0.5 },
  { name: 'Energize', swatches: [60, 90, 140, 180, 200], base: 180, accent: 90, hit: 60 },
  { name: 'Fireplace', swatches: [5, 10, 20, 25, 40], base: 20, accent: 40, hit: 5, sat: 0.95, val: 0.9 },
  { name: 'French Riviera', swatches: [190, 205, 225, 45, 15], base: 205, accent: 45, hit: 15 },
  { name: 'Hot Sauce', swatches: [355, 0, 10, 25, 45], base: 0, accent: 25, hit: 45 },
  { name: 'Meteor Shower', swatches: [210, 220, 240, 270, 300], base: 240, accent: 280, hit: 210 },
  { name: 'Nemo', swatches: [10, 25, 35, 200, 215], base: 25, accent: 210, hit: 35 },
  { name: 'Paint Splatter', swatches: [0, 60, 120, 180, 240, 300], base: 0, accent: 120, hit: 240 },
  { name: 'Radiate', swatches: [280, 300, 320, 340, 20], base: 280, accent: 330, hit: 20 },
  { name: 'Romantic', swatches: [315, 330, 345, 355, 0], base: 345, accent: 320, hit: 0, sat: 0.8 },
  { name: 'Starlight', swatches: [220, 230, 240, 45, 50], base: 230, accent: 50, hit: 45, val: 0.9 },
  { name: 'The Great Wave', swatches: [195, 210, 220, 230, 45], base: 215, accent: 195, hit: 45, sat: 0.75 },
  { name: 'Tranquil Ocean', swatches: [170, 185, 195, 205, 215], base: 195, accent: 175, hit: 210, sat: 0.7 },
  { name: 'Vibrant Sunrise', swatches: [325, 340, 15, 45, 60], base: 340, accent: 30, hit: 60 },
  { name: 'Waterfall', swatches: [170, 180, 190, 200, 210], base: 190, accent: 175, hit: 205, sat: 0.6 },
  { name: 'Blossom', swatches: [315, 330, 345, 90, 110], base: 330, accent: 100, hit: 345, sat: 0.7 },
  { name: 'Neon Noir', swatches: [190, 210, 265, 315, 335], base: 315, accent: 190, hit: 265 },
  { name: 'Miami', swatches: [175, 195, 285, 325, 345], base: 325, accent: 180, hit: 285 },
  { name: 'Lava Lamp', swatches: [20, 40, 290, 320, 350], base: 20, accent: 320, hit: 350 },
];

/**
 * Preview colors for a palette, as [r,g,b] rows (0-255): the swatches if it has
 * them, else the base/accent/hit trio, muted by the palette's sat/val the same
 * way the tone pass does. Used by the companion app to draw true swatch bars.
 */
function previewColors(p) {
  const s = p.sat ?? 1;
  const v = p.val ?? 1;
  if (s === 0) return [[235, 235, 235], [150, 150, 150], [60, 60, 60]]; // Mono: brightness ramp
  const hues = p.swatches || [p.base, p.accent, p.hit];
  return hues.map((h) => {
    const c = hsv(h, s, v);
    return [Math.round(c.r), Math.round(c.g), Math.round(c.b)];
  });
}

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

module.exports = { hsv, mix, dim, generatePalettes, PALETTES, CURATED, resolvePalette, paletteNames, previewColors };
