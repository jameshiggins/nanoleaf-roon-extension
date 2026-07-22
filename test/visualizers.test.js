'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { visualNames, describeVisuals, createVisual } = require('../src/visuals/visualizers');
const { generatePalettes } = require('../src/visuals/palettes');
const { rgbToHsv } = require('../src/visuals/albumpalette');

const PALETTE = generatePalettes(1)[0];

// a 4x3-ish grid of panels
const LAYOUT = [];
for (let y = 0; y < 3; y++) {
  for (let x = 0; x < 4; x++) {
    LAYOUT.push({ id: y * 4 + x + 1, nx: x / 3, ny: y / 2 });
  }
}

const LOUD = { rms: 0.8, peak: 0.9, left: 0.8, right: 0.6, bass: 0.7, mid: 0.5, treble: 0.4, energy: 0.7, onset: true };
const QUIET = { rms: 0, peak: 0, left: 0, right: 0, bass: 0, mid: 0, treble: 0, energy: 0, onset: false };

// deterministic rng
function seqRng() {
  let s = 12345;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

test('registry exposes a healthy catalogue, all with descriptions', () => {
  const described = describeVisuals();
  assert.ok(described.length >= 25, `got ${described.length}`);
  assert.ok(!described.some((v) => v.name.startsWith('pulse')), 'pulse family is cut');
  for (const v of described) {
    assert.equal(typeof v.name, 'string');
    assert.ok(v.description.length > 0);
  }
});

test('every visualizer renders a valid frame for every panel', () => {
  for (const name of visualNames()) {
    const viz = createVisual(name, LAYOUT, PALETTE, seqRng());
    const frame = viz.render(LOUD, 33);
    assert.equal(frame.length, LAYOUT.length, `${name}: frame length`);
    const ids = new Set();
    for (const p of frame) {
      ids.add(p.id);
      for (const ch of ['r', 'g', 'b']) {
        assert.ok(Number.isFinite(p[ch]) && p[ch] >= 0, `${name}: ${ch}=${p[ch]}`);
      }
      assert.equal(p.transition, 0);
    }
    assert.equal(ids.size, LAYOUT.length, `${name}: covers every panel exactly once`);
  }
});

test('every visualizer stays finite across a simulated song', () => {
  const rng = seqRng();
  for (const name of visualNames()) {
    const viz = createVisual(name, LAYOUT, PALETTE, rng);
    for (let i = 0; i < 200; i++) {
      const f = {
        rms: Math.abs(Math.sin(i * 0.3)) * 0.9,
        peak: 0.9,
        left: Math.abs(Math.sin(i * 0.3)) * 0.9,
        right: Math.abs(Math.cos(i * 0.3)) * 0.9,
        bass: Math.abs(Math.sin(i * 0.5)) * 0.8,
        mid: Math.abs(Math.cos(i * 0.4)) * 0.6,
        treble: Math.abs(Math.sin(i * 0.9)) * 0.5,
        energy: Math.abs(Math.sin(i * 0.3)) * 0.8,
        onset: i % 8 === 0,
      };
      const frame = viz.render(f, 33);
      for (const p of frame) {
        assert.ok(Number.isFinite(p.r + p.g + p.b), `${name} went non-finite at frame ${i}`);
      }
    }
  }
});

test('level-driven visualizers are dark when silent', () => {
  // these map brightness to level, so silence should be (near) black
  for (const name of ['bars', 'vu', 'vu-tower', 'fire']) {
    const viz = createVisual(name, LAYOUT, PALETTE, seqRng());
    const frame = viz.render(QUIET, 33);
    const maxBright = Math.max(...frame.map((p) => Math.max(p.r, p.g, p.b)));
    assert.ok(maxBright < 5, `${name} should be dark when silent, got ${maxBright}`);
  }
});

test('a beat visibly brightens a beat-reactive visualizer', () => {
  const viz = createVisual('sections', LAYOUT, PALETTE, seqRng());
  const noBeat = viz.render({ ...LOUD, onset: false }, 33);
  const beat = viz.render({ ...LOUD, onset: true }, 33);
  const sum = (fr) => fr.reduce((s, p) => s + p.r + p.g + p.b, 0);
  assert.ok(sum(beat) > sum(noBeat), 'onset should add brightness');
});

test('flashStrength scales the onset flash peak (calmer beats)', () => {
  const soft = createVisual('wheel', LAYOUT, PALETTE, seqRng(), { flashStrength: 0.3 });
  soft.render({ ...LOUD, onset: true }, 33);
  assert.ok(Math.abs(soft.flash - 0.3) < 1e-9, `flash should peak at flashStrength, got ${soft.flash}`);

  const full = createVisual('wheel', LAYOUT, PALETTE, seqRng()); // default 1
  full.render({ ...LOUD, onset: true }, 33);
  assert.ok(full.flash > soft.flash, 'default flash is stronger than the reduced one');
});

test('beat-driven scenes keep moving without beats (fallback spawn, no solid frames)', () => {
  // With onset never firing, streaks/ripple used to render only a uniform background.
  for (const name of ['streaks', 'ripple', 'streaks-rain', 'ripple-core']) {
    const viz = createVisual(name, LAYOUT, PALETTE, seqRng());
    let maxSpread = 0;
    for (let i = 0; i < 90; i++) { // ~3s of loud audio, zero beats
      const fr = viz.render({ ...LOUD, onset: false }, 33);
      const ch = (k) => fr.map((p) => [p.r, p.g, p.b][k]);
      const spread = Math.max(
        Math.max(...ch(0)) - Math.min(...ch(0)),
        Math.max(...ch(1)) - Math.min(...ch(1)),
        Math.max(...ch(2)) - Math.min(...ch(2))
      );
      maxSpread = Math.max(maxSpread, spread);
    }
    assert.ok(maxSpread > 20, `${name} should not go solid without beats, max spread ${maxSpread}`);
  }
});

test('createVisual rejects an unknown name', () => {
  assert.throws(() => createVisual('nope', LAYOUT, PALETTE), /unknown visual/);
});

test('multi-color scenes paint the whole swatch set; without swatches they stay few', () => {
  // distinct strongly-colored hues a scene paints over a run of beats, bucketed to 30°
  const distinctHues = (name, palette) => {
    const viz = createVisual(name, LAYOUT, palette, seqRng());
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const frame = viz.render({ ...LOUD, onset: i % 2 === 0 }, 33);
      for (const p of frame) {
        const { h, s, v } = rgbToHsv(p.r, p.g, p.b);
        if (s > 0.35 && v > 0.2) seen.add(Math.round(h / 30) * 30 % 360);
      }
    }
    return seen;
  };
  const swatched = { name: 'S', base: 0, accent: 60, hit: 120, swatches: [0, 60, 120, 180, 240, 300] };
  const plain = { name: 'P', base: 0, accent: 60, hit: 120 }; // no swatches → old accent/hit behavior
  for (const scene of ['sections', 'ripple', 'streaks', 'sparkle']) {
    const rich = distinctHues(scene, swatched);
    const few = distinctHues(scene, plain);
    assert.ok(rich.size > few.size, `${scene}: swatched (${rich.size}) should use more hues than plain (${few.size})`);
    assert.ok(rich.size >= 4, `${scene}: swatched should paint >=4 distinct hues, got ${rich.size}`);
  }
});

test('single-panel layout is handled by every visualizer', () => {
  const one = [{ id: 7, nx: 0, ny: 0 }];
  for (const name of visualNames()) {
    const viz = createVisual(name, one, PALETTE, seqRng());
    const frame = viz.render(LOUD, 33);
    assert.equal(frame.length, 1, `${name}`);
    assert.equal(frame[0].id, 7);
  }
});
