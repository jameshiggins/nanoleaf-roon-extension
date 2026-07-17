'use strict';

/**
 * Derive a visualizer palette from album-art pixels.
 *
 * Input is a decoded RGBA thumbnail (Roon serves art scaled server-side; 32-64px
 * is plenty). We pick the dominant *vibrant* hues — weighting each pixel by its
 * saturation × value so a bold cover accent beats a large muddy background, and
 * averaging colors (which just yields brown) is avoided entirely. The result is
 * a `{ name, base, accent, hit, sat, val }` palette in the same shape the
 * renderer already consumes, so album colors flow through the existing pipeline.
 *
 * Returns null when the art has no usable color (grayscale/monochrome covers) so
 * the caller can fall back to the pinned/rotating palette rather than go dark.
 */

const BINS = 36;           // hue histogram resolution (10° per bin)
const MIN_SAT = 0.18;      // below this a pixel is "gray" — no reliable hue
const MIN_VAL = 0.12;      // below this a pixel is "black" — no reliable hue
const HUE_APART = 25;      // accent/hit must sit this many degrees from base

/** RGB (0-255) → { h: 0-360, s: 0-1, v: 0-1 }. */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** Circular distance between two hues in [0,180]. */
function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * @param {ArrayLike<number>} rgba  length width*height*4
 * @param {number} width
 * @param {number} height
 * @param {{ sat?: number, val?: number, name?: string }} [opts]
 *   sat/val become the palette's tone-pass mute (default a light mute so album
 *   colors stay tonally consistent with the Retro fallback).
 * @returns {{ name, base, accent, hit, sat, val }|null}
 */
function extractPalette(rgba, width, height, opts = {}) {
  const bins = new Float64Array(BINS);   // accumulated vibrancy weight per hue bin
  const binHueSum = new Float64Array(BINS); // weighted hue sum, for a precise center
  let weighted = 0;

  const n = width * height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = rgba[o + 3];
    if (a !== undefined && a < 8) continue; // skip transparent pixels
    const { h, s, v } = rgbToHsv(rgba[o], rgba[o + 1], rgba[o + 2]);
    if (s < MIN_SAT || v < MIN_VAL) continue; // gray/black — no usable hue
    const w = s * v;                          // vibrancy weight
    const bin = Math.min(BINS - 1, Math.floor(h / (360 / BINS)));
    bins[bin] += w;
    binHueSum[bin] += h * w;
    weighted += w;
  }

  if (weighted === 0) return null; // no colored pixels at all → caller falls back

  // Peak bins by weight, each collapsed to its weighted-average hue.
  const peaks = [];
  for (let b = 0; b < BINS; b++) {
    if (bins[b] > 0) peaks.push({ hue: binHueSum[b] / bins[b], weight: bins[b] });
  }
  peaks.sort((x, y) => y.weight - x.weight);

  const base = peaks[0].hue;
  // Accent + hit: the next strongest peaks that are hue-distinct from base and
  // from each other, so a busy cover yields three real colors.
  const chosen = [base];
  for (const p of peaks.slice(1)) {
    if (chosen.every((h) => hueDist(h, p.hue) >= HUE_APART)) chosen.push(p.hue);
    if (chosen.length === 3) break;
  }
  // Monochrome cover (one dominant hue): fan out so scenes still have contrast.
  while (chosen.length < 3) {
    chosen.push((base + (chosen.length === 1 ? 30 : 180)) % 360);
  }

  return {
    name: opts.name || 'Album',
    base: chosen[0],
    accent: chosen[1],
    hit: chosen[2],
    sat: opts.sat != null ? opts.sat : 0.9,
    val: opts.val != null ? opts.val : 1.0,
  };
}

module.exports = { extractPalette, rgbToHsv };
