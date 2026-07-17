'use strict';

/**
 * Procedurally generated visualizer registry.
 *
 * A dozen parametric ENGINES render panel colors from the audio features of
 * the direct Roon PCM feed (src/dsp/features.js) — no microphone anywhere.
 * The registry is built by crossing each engine with its variant grid, giving
 * 30+ named visual types; combined with the generated palettes the rotation
 * pool is > 1000 distinct looks.
 *
 * Engine interface: new Engine(layout, palette, opts, rng) with
 *   render(features, dtMs) → [{ id, r, g, b, transition }]
 * layout comes from prepareLayout() (nx/ny in [0,1], left→right order);
 * palette is { base, accent, hit } hues from palettes.js.
 *
 * Shared design rules: dark floor + bright peaks (contrast), constant motion
 * tied to the music, beats visibly land. The silence gate lives in the
 * pipeline, so engines can assume "something is playing".
 */

const { hsv, mix, dim } = require('./palettes');

const BLACK = { r: 0, g: 0, b: 0 };

function frame(layout, colorAt) {
  return layout.map((p, i) => {
    const c = colorAt(p, i) || BLACK;
    return { id: p.id, r: c.r, g: c.g, b: c.b, transition: 1 };
  });
}

class BaseEngine {
  constructor(layout, palette, opts = {}, rng = Math.random) {
    this.layout = layout;
    this.palette = palette;
    this.opts = opts;
    this.rng = rng;
    this.flash = 0;
    // Album (and Vintage Modern) palettes carry a swatch set of up to 6 hues;
    // scenes that place discrete colored elements paint through the whole set.
    // Absent for the generated palettes, so their look is unchanged.
    this.swatches = palette.swatches && palette.swatches.length ? palette.swatches : null;
    this._swatchI = 0;
  }
  decayFlash(f, dtMs, ms = 180) {
    this.flash = Math.max(0, this.flash - dtMs / ms);
    if (f.onset) this.flash = 1;
    return this.flash;
  }
  /** Next hue in the swatch set (cycles — guarantees every color is used). */
  nextSwatch() {
    const h = this.swatches[this._swatchI % this.swatches.length];
    this._swatchI++;
    return h;
  }
  /** A random hue from the swatch set. */
  randSwatch() {
    return this.swatches[Math.floor(this.rng() * this.swatches.length)];
  }
}

/** Loudness pulse. Modes: stereo placement, mono, or a center blob grown by the bass. */
class PulseEngine extends BaseEngine {
  render(f, dtMs) {
    const flash = this.decayFlash(f, dtMs);
    const base = hsv(this.palette.base, 1, 1);
    const hit = hsv(this.palette.hit, 0.6, 1);
    const n = this.layout.length;
    return frame(this.layout, (p, i) => {
      let level;
      if (this.opts.mode === 'mono') {
        level = f.rms;
      } else if (this.opts.mode === 'center') {
        const reach = 0.15 + 0.85 * f.bass;
        level = f.rms * Math.max(0, 1 - Math.hypot(p.nx - 0.5, p.ny - 0.5) / reach);
      } else {
        const pos = n === 1 ? 0.5 : i / (n - 1);
        level = f.left * (1 - pos) + f.right * pos;
      }
      if (level < 0.02 && flash === 0) return BLACK;
      return mix(dim(base, level), hit, flash * 0.7);
    });
  }
}

/** Spectrum bars: three band columns with peak-hold. Axis/mirroring variants. */
class BarsEngine extends BaseEngine {
  constructor(...args) {
    super(...args);
    this.peaks = [0, 0, 0];
  }
  render(f, dtMs) {
    const bands = [f.bass, f.mid, f.treble];
    const decay = dtMs / 700;
    this.peaks = this.peaks.map((pk, i) => Math.max(bands[i], pk - decay));
    const hues = [this.palette.base, this.palette.accent, this.palette.hit];
    const along = this.opts.axis === 'y' ? 'ny' : 'nx';
    const fillAxis = this.opts.axis === 'y' ? 'nx' : 'ny';
    return frame(this.layout, (p) => {
      let coord = p[along];
      if (this.opts.mirror) coord = Math.abs(coord - 0.5) * 2; // bass at the center
      const band = Math.min(2, Math.floor(coord * 3));
      const level = bands[band];
      const peak = this.peaks[band];
      if (level < 0.02 && peak < 0.02) return BLACK; // dark when this band is silent
      const fill = p[fillAxis];
      if (fill <= level) return dim(hsv(hues[band], 1, 1), Math.max(level, 0.25));
      if (fill <= peak) return dim(hsv(hues[band], 1, 1), 0.3); // peak-hold sparkle
      return BLACK;
    });
  }
}

/** Beats spawn rings that expand (or implode) across the layout. */
class RippleEngine extends BaseEngine {
  constructor(...args) {
    super(...args);
    this.ripples = [];
    this.hueFlip = false;
  }
  _spawn(f, cx, cy) {
    this.hueFlip = !this.hueFlip;
    this.ripples.push({
      cx, cy,
      radius: this.opts.implode ? 1.8 : 0,
      hue: this.swatches ? this.nextSwatch() : (this.hueFlip ? this.palette.accent : this.palette.hit),
      strength: 0.5 + 0.5 * f.energy,
    });
    if (this.ripples.length > 4) this.ripples.shift();
  }
  render(f, dtMs) {
    if (f.onset) {
      if (this.opts.origin === 'center') {
        this._spawn(f, 0.5, 0.5);
      } else {
        const o = this.layout[Math.floor(this.rng() * this.layout.length)];
        this._spawn(f, o.nx, o.ny);
        if (this.opts.double) this._spawn(f, 1 - o.nx, 1 - o.ny);
      }
    }
    const step = ((0.9 + f.energy) * dtMs) / 1000;
    for (const rp of this.ripples) rp.radius += this.opts.implode ? -step : step;
    this.ripples = this.ripples.filter((rp) => rp.radius > -0.1 && rp.radius < 2.2);

    const bg = dim(hsv(this.palette.base, 1, 1), f.energy * 0.25);
    return frame(this.layout, (p) => {
      let c = bg;
      for (const rp of this.ripples) {
        const d = Math.hypot(p.nx - rp.cx, p.ny - rp.cy);
        const ring = Math.exp(-((d - rp.radius) ** 2) / 0.02);
        const fade = this.opts.implode ? Math.min(1, Math.max(0, rp.radius / 1.8)) : Math.max(0, 1 - rp.radius / 2.2);
        const glow = ring * Math.max(fade, 0.15) * rp.strength;
        if (glow > 0.05) c = mix(c, hsv(rp.hue, 1, 1), Math.min(1, glow));
      }
      return c;
    });
  }
}

/** Beat-launched comets. Modes: alternate direction, both at once, or rain (falling). */
class StreaksEngine extends BaseEngine {
  constructor(...args) {
    super(...args);
    this.streaks = [];
    this.dir = 1;
  }
  _launch(f, dir) {
    this.streaks.push({
      pos: dir > 0 ? -0.15 : 1.15,
      dir,
      speed: 1.2 + 1.5 * f.energy,
      hue: this.swatches ? this.randSwatch() : (this.rng() < 0.5 ? this.palette.accent : this.palette.hit),
      lane: this.rng(), // cross-axis center for rain mode
    });
    if (this.streaks.length > 4) this.streaks.shift();
  }
  render(f, dtMs) {
    if (f.onset) {
      if (this.opts.mode === 'both') {
        this._launch(f, 1);
        this._launch(f, -1);
      } else if (this.opts.mode === 'rain') {
        this._launch(f, -1); // falls from the top (ny 1 → 0)
      } else {
        this.dir = -this.dir;
        this._launch(f, this.dir);
      }
    }
    for (const s of this.streaks) s.pos += (s.dir * s.speed * dtMs) / 1000;
    this.streaks = this.streaks.filter((s) => s.pos > -0.3 && s.pos < 1.3);

    const rain = this.opts.mode === 'rain';
    const bg = dim(hsv(this.palette.base, 1, 1), f.energy * 0.2);
    return frame(this.layout, (p) => {
      let c = bg;
      for (const s of this.streaks) {
        const along = rain ? p.ny : p.nx;
        const head = Math.exp(-((along - s.pos) ** 2) / 0.008);
        const behind = (s.pos - along) * s.dir;
        const tail = behind > 0 ? Math.exp(-behind / 0.25) * 0.5 : 0;
        let glow = Math.min(1, head + tail);
        if (rain) glow *= Math.exp(-((p.nx - s.lane) ** 2) / 0.05); // narrow column
        if (glow > 0.05) c = mix(c, hsv(s.hue, 1, 1), glow);
      }
      return c;
    });
  }
}

/** Hue wheel spinning with the energy. Direction/spread/strobe variants. */
class WheelEngine extends BaseEngine {
  constructor(...args) {
    super(...args);
    this.angle = 0;
  }
  render(f, dtMs) {
    const dir = this.opts.dir ?? 1;
    this.angle = (this.angle + dir * (30 + 240 * f.energy) * (dtMs / 1000) + 360) % 360;
    const flash = this.decayFlash(f, dtMs, this.opts.strobe ? 120 : 150);
    const v = Math.min(1, 0.1 + 0.9 * f.energy + flash * 0.4);
    return frame(this.layout, (p) => {
      const sat = this.opts.strobe && flash > 0.5 ? 0.15 : 1 - flash * 0.5;
      // rainbow variant + a swatch set → rotating bands of the cover's own colors
      if (this.swatches && this.opts.spread === 360) {
        const t = ((p.nx + this.angle / 360) % 1 + 1) % 1;
        const hue = this.swatches[Math.floor(t * this.swatches.length) % this.swatches.length];
        return hsv(hue, sat, v);
      }
      const hue = this.palette.base + this.angle + p.nx * (this.opts.spread ?? 120);
      return hsv(hue, sat, v);
    });
  }
}

/** A bright ridge sweeping along an axis; the bass widens it. */
class WaveEngine extends BaseEngine {
  constructor(...args) {
    super(...args);
    this.phase = 0;
  }
  render(f, dtMs) {
    this.phase = (this.phase + ((0.25 + 0.9 * f.energy) * dtMs) / 1000) % 1;
    const width = 0.015 + 0.05 * f.bass;
    const axis = this.opts.axis === 'y' ? 'ny' : 'nx';
    const bg = dim(hsv(this.palette.base, 1, 1), f.energy * 0.2);
    return frame(this.layout, (p) => {
      let c = bg;
      const d1 = Math.min(Math.abs(p[axis] - this.phase), 1 - Math.abs(p[axis] - this.phase));
      c = mix(c, hsv(this.palette.accent, 1, 1), Math.min(1, Math.exp(-(d1 * d1) / width)));
      if (this.opts.dual) {
        const other = this.opts.axis === 'y' ? 'nx' : 'ny';
        const ph2 = (this.phase + 0.5) % 1;
        const d2 = Math.min(Math.abs(p[other] - ph2), 1 - Math.abs(p[other] - ph2));
        c = mix(c, hsv(this.palette.hit, 1, 1), Math.min(1, Math.exp(-(d2 * d2) / width)));
      }
      return c;
    });
  }
}

/** Treble-driven glitter over a bass wash; burst mode ignites clusters on beats. */
class SparkleEngine extends BaseEngine {
  constructor(...args) {
    super(...args);
    this.glow = new Map(); // panel id → sparkle level
  }
  render(f, dtMs) {
    const decay = dtMs / (this.opts.burst ? 350 : 250);
    for (const [id, s] of this.glow) {
      s.v -= decay;
      if (s.v <= 0) this.glow.delete(id);
    }
    // Each glint takes a random swatch (so the glitter spans the cover's colors);
    // without a swatch set it's the single hit hue, exactly as before.
    const ignite = (id) => this.glow.set(id, { v: 1, hue: this.swatches ? this.randSwatch() : this.palette.hit });
    if (this.opts.burst) {
      if (f.onset) {
        const count = Math.max(1, Math.round(this.layout.length * 0.4));
        for (let i = 0; i < count; i++) ignite(this.layout[Math.floor(this.rng() * this.layout.length)].id);
      }
    } else {
      // per-tick ignition probability rides the treble
      for (const p of this.layout) {
        if (this.rng() < f.treble * 0.25) ignite(p.id);
      }
    }
    const bg = dim(hsv(this.palette.base, 1, 1), 0.1 + f.bass * 0.4);
    return frame(this.layout, (p) => {
      const s = this.glow.get(p.id);
      return s && s.v > 0.02 ? mix(bg, hsv(s.hue, 0.5, 1), s.v) : bg;
    });
  }
}

/** A lit window running across the panels — steps on beats or flows with the energy. */
class ChaseEngine extends BaseEngine {
  constructor(...args) {
    super(...args);
    this.pos = 0;
  }
  render(f, dtMs) {
    const n = this.layout.length;
    if (this.opts.onBeat) {
      if (f.onset) this.pos = (this.pos + 1) % n;
    } else {
      this.pos = (this.pos + ((0.5 + 2.5 * f.energy) * n * dtMs) / 4000) % n;
    }
    const width = Math.max(1.2, n * 0.18);
    const bg = dim(hsv(this.palette.base, 1, 1), f.energy * 0.25);
    return frame(this.layout, (p, i) => {
      let d = Math.abs(i - this.pos);
      d = Math.min(d, n - d); // wrap around
      const glow = Math.max(0, 1 - d / width) * Math.max(f.rms, 0.3);
      return glow > 0.05 ? mix(bg, hsv(this.palette.accent, 1, 1), glow) : bg;
    });
  }
}

/** Classic VU meters: left/right channels fill from the edges (or bottom-up). */
class VuEngine extends BaseEngine {
  /**
   * Auto-scale a raw level against a slowly-decaying running peak, so the bar
   * spans the FULL range — loud moments reach the top panel, quiet ones recede —
   * regardless of how hot the track is mastered. Returns a fill in [0, 1].
   */
  _fill(level, dtMs, onset) {
    const dt = dtMs || 33;
    const decay = Math.exp(-dt / 2500);                  // ~2.5 s peak memory
    this.peakRef = Math.max(level, (this.peakRef ?? 0.25) * decay, 0.06);
    let raw = Math.min(1, level / this.peakRef);         // 0..1, hits 1 on peaks
    if (onset) raw = 1;                                  // beats slam the bar to the top
    // snappy peak-hold: snap up instantly, drop away fast (~0.15 s) so it
    // reads as a sharp percussive hit.
    this.held = Math.max(raw, (this.held ?? 0) - dt / 150);
    return this.held;
  }

  render(f, dtMs) {
    if (this.opts.vertical) {
      if (f.rms < 0.02) return frame(this.layout, () => BLACK); // dark only in true silence
      const fill = this._fill(f.rms, dtMs, f.onset);
      // Bottom-up meter that reaches the top on peaks; every panel stays lit —
      // below the fill runs hot, above it gets a dim palette wash.
      return frame(this.layout, (p) => {
        if (p.ny <= fill) {
          const heat = p.ny / Math.max(fill, 0.01); // top of the fill runs hot
          return dim(hsv(heat > 0.7 ? this.palette.hit : this.palette.base, 1, 1), Math.max(f.rms, 0.35));
        }
        return dim(hsv(this.palette.base, 1, 1), 0.15 + 0.25 * f.energy); // wash above the fill
      });
    }
    const fill = this._fill(Math.max(f.left, f.right), dtMs, f.onset);
    return frame(this.layout, (p) => {
      const leftSide = p.nx < 0.5;
      const reach = leftSide ? (0.5 - p.nx) * 2 : (p.nx - 0.5) * 2; // 0 center → 1 edge
      if (f.rms < 0.02 || reach > fill) return BLACK;
      const heat = reach / Math.max(fill, 0.01);
      return dim(hsv(heat > 0.7 ? this.palette.hit : this.palette.base, 1, 1), Math.max(f.rms, 0.35));
    });
  }
}

/** A bright block bouncing side to side; the bass sets its size. */
class BounceEngine extends BaseEngine {
  constructor(...args) {
    super(...args);
    this.x = 0.5;
    this.v = 1;
  }
  render(f, dtMs) {
    this.x += (this.v * (0.4 + 1.6 * f.energy) * dtMs) / 1000;
    if (this.x > 1) { this.x = 1; this.v = -1; }
    if (this.x < 0) { this.x = 0; this.v = 1; }
    const flash = this.decayFlash(f, dtMs);
    const size = 0.06 + 0.15 * f.bass;
    const bg = dim(hsv(this.palette.base, 1, 1), f.energy * 0.2);
    const positions = this.opts.duo ? [this.x, 1 - this.x] : [this.x];
    const hues = [this.palette.accent, this.palette.hit];
    return frame(this.layout, (p) => {
      let c = bg;
      positions.forEach((x, k) => {
        const glow = Math.exp(-((p.nx - x) ** 2) / (2 * size * size));
        if (glow > 0.05) c = mix(c, hsv(hues[k % hues.length], 1 - flash * 0.5, 1), Math.min(1, glow));
      });
      return c;
    });
  }
}

/** Flames: the bass drives the height, per-panel flicker keeps it alive. */
class FireEngine extends BaseEngine {
  render(f) {
    if (f.rms < 0.02 && f.bass < 0.02) return frame(this.layout, () => BLACK);
    const height = Math.min(1, 0.1 + f.bass * 1.1);
    return frame(this.layout, (p) => {
      const y = this.opts.inverted ? 1 - p.ny : p.ny;
      const flicker = 0.75 + this.rng() * 0.25;
      if (y > height * flicker) return BLACK;
      const heat = 1 - y / Math.max(height, 0.01); // 1 at the root of the flame
      const hue = heat > 0.5 ? this.palette.hit : this.palette.accent;
      return dim(hsv(hue, 1, 1), (0.3 + 0.7 * heat) * Math.max(f.rms, 0.35) * flicker);
    });
  }
}

/** Beats light a random contiguous run of panels that then fades. */
class SectionsEngine extends BaseEngine {
  constructor(...args) {
    super(...args);
    this.sections = []; // { from, to, hue, life }
    this.hueFlip = false;
  }
  render(f, dtMs) {
    for (const s of this.sections) s.life -= dtMs / 450;
    this.sections = this.sections.filter((s) => s.life > 0);
    if (f.onset) {
      const n = this.layout.length;
      const span = Math.max(1, Math.round(n / 3));
      const from = Math.floor(this.rng() * Math.max(1, n - span));
      this.hueFlip = !this.hueFlip;
      this.sections.push({
        from,
        to: from + span,
        hue: this.swatches ? this.nextSwatch() : (this.hueFlip ? this.palette.accent : this.palette.hit),
        life: 1,
      });
      if (this.sections.length > 3) this.sections.shift();
    }
    const bg = dim(hsv(this.palette.base, 1, 1), f.energy * 0.2);
    return frame(this.layout, (p, i) => {
      let c = bg;
      for (const s of this.sections) {
        if (i >= s.from && i < s.to) c = mix(c, hsv(s.hue, 1, 1), s.life);
      }
      return c;
    });
  }
}

/** The registry is generated: engines × their variant grids. */
function buildRegistry() {
  const reg = new Map();
  const add = (name, Engine, opts, description) => reg.set(name, { Engine, opts, description });

  for (const [mode, desc] of [
    ['stereo', 'stereo loudness pulse, beats flash bright'],
    ['mono', 'whole-wall loudness pulse'],
    ['center', 'bass blob growing from the center'],
  ]) add(mode === 'stereo' ? 'pulse' : `pulse-${mode === 'center' ? 'blob' : mode}`, PulseEngine, { mode }, desc);

  add('bars', BarsEngine, { axis: 'x' }, 'bass/mid/treble columns left to right');
  add('bars-vertical', BarsEngine, { axis: 'y' }, 'bass at the bottom, treble on top');
  add('bars-center', BarsEngine, { axis: 'x', mirror: true }, 'bass at the center, treble at the edges');

  add('ripple', RippleEngine, { origin: 'random' }, 'beats spawn expanding ripples');
  add('ripple-core', RippleEngine, { origin: 'center' }, 'ripples radiate from the center');
  add('ripple-implode', RippleEngine, { origin: 'center', implode: true }, 'rings collapse inward on beats');
  add('ripple-twin', RippleEngine, { origin: 'random', double: true }, 'mirrored ripple pairs');

  add('streaks', StreaksEngine, { mode: 'alternate' }, 'comets alternate direction each beat');
  add('streaks-duel', StreaksEngine, { mode: 'both' }, 'comets launch both ways at once');
  add('streaks-rain', StreaksEngine, { mode: 'rain' }, 'beat droplets falling down the wall');

  add('wheel', WheelEngine, { dir: 1 }, 'color wheel spins with the energy');
  add('wheel-counter', WheelEngine, { dir: -1 }, 'the wheel, spinning the other way');
  add('wheel-rainbow', WheelEngine, { dir: 1, spread: 360 }, 'full rainbow spread across the panels');
  add('wheel-strobe', WheelEngine, { dir: 1, strobe: true }, 'spinning hues, beats strobe white');

  add('wave', WaveEngine, { axis: 'x' }, 'a bright ridge sweeps sideways');
  add('wave-fall', WaveEngine, { axis: 'y' }, 'the ridge rolls top to bottom');
  add('wave-cross', WaveEngine, { axis: 'x', dual: true }, 'two ridges cross on both axes');

  add('sparkle', SparkleEngine, {}, 'treble glitter over a bass wash');
  add('sparkle-burst', SparkleEngine, { burst: true }, 'beats ignite panel clusters');

  add('chase', ChaseEngine, { onBeat: true }, 'the lit window steps on every beat');
  add('chase-flow', ChaseEngine, {}, 'the window flows with the energy');

  add('vu', VuEngine, {}, 'classic L/R meters filling from the center out');
  add('vu-tower', VuEngine, { vertical: true }, 'one meter, bottom to top');

  add('bounce', BounceEngine, {}, 'a block bounces, bass sets its size');
  add('bounce-duo', BounceEngine, { duo: true }, 'two mirrored blocks bounce');

  add('fire', FireEngine, {}, 'bass-driven flames from the bottom');
  add('fire-fall', FireEngine, { inverted: true }, 'flames pour from the top');

  add('sections', SectionsEngine, {}, 'beats light random panel runs');

  return reg;
}

const REGISTRY = buildRegistry();

function visualNames() {
  return [...REGISTRY.keys()];
}

function describeVisuals() {
  return [...REGISTRY.entries()].map(([name, v]) => ({ name, description: v.description }));
}

function createVisual(name, layout, palette, rng) {
  const entry = REGISTRY.get(name);
  if (!entry) throw new Error(`unknown visual "${name}" — available: ${visualNames().join(', ')}`);
  return new entry.Engine(layout, palette, entry.opts, rng);
}

module.exports = { REGISTRY, visualNames, describeVisuals, createVisual };
