'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  nanoleaf: {
    host: '',            // controller IP; find it with `npm run discover`
    port: 16021,
    token: '',           // create with `npm run pair`
    fps: 30,             // UDP frame rate (extControl v2)
  },
  audio: {
    source: 'slimproto', // slimproto | capture | stdin
    sampleRate: 44100,
    channels: 2,
    // slimproto
    server: 'auto',      // Roon Core host, or "auto" for SlimProto discovery broadcast
    playerName: 'Nanoleaf Feed',
    // capture
    captureCommand: 'ffmpeg',
    captureArgs: [],     // input side, e.g. ["-f","dshow","-i","audio=CABLE Output (VB-Audio Virtual Cable)"]
  },
  roon: {
    enabled: true,       // pair with Roon: reports status and drives track-change rotation
    zone: '',            // zone to follow for track changes (case-insensitive substring); '' = any
  },
  visuals: {
    include: [],         // limit to these visualizer names; empty = all
    exclude: [],         // visualizers to skip
    palettes: 36,        // how many color palettes to generate (>= 1)
    palette: '',         // pin one palette by name (e.g. "Retro"); '' = rotate colors too
    albumColors: false,  // derive the palette from Roon album art each track (falls back to `palette`)
    albumSat: 0.9,       // tone-pass saturation for album colors (1 = fully vivid)
    albumVal: 1.0,       // tone-pass brightness for album colors
    albumMaxColors: 10,  // most distinct hues to pull from a cover (3–21)
    albumPredominantChance: 0.33, // chance a track uses the cover's N most-present colors
    albumPredominantCount: 4,     // how many predominant colors when that mode fires
    rotate: 'track',     // 'track' | 'off' | <seconds>  — when to switch the look
    minSeconds: 8,       // don't rotate more often than this on rapid track skipping
    gain: 1.0,           // linear gain applied to the audio level before mapping
    attackMs: 5,         // envelope rise time constant
    releaseMs: 180,      // envelope fall time constant
    silenceFloor: 0.02,  // energy below this fades the panels to black
    flashStrength: 0.5,  // beat-flash intensity (0 = no flash, 1 = full bright)
    onsetSensitivity: 1.1, // beat-detection strictness (lower = more beats/livelier)
    releaseDebounceMs: 5000,   // how long panels are held after Roon goes idle
    extControlKeepaliveMs: 4000, // re-assert extControl this often while playing
  },
  control: {
    enabled: true,       // companion-app HTTP/SSE server (open it on your Shield)
    port: 8787,
    host: '127.0.0.1',   // localhost only by default; set to 0.0.0.0 to expose on the LAN
    frameHz: 20,         // telemetry frame rate pushed to the app
  },
};

class ConfigError extends Error {}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(defaults, overrides, prefix, errors) {
  const out = {};
  for (const [key, defVal] of Object.entries(defaults)) {
    const ovr = overrides[key];
    if (ovr === undefined) {
      out[key] = defVal;
    } else if (isPlainObject(defVal)) {
      if (!isPlainObject(ovr)) {
        errors.push(`${prefix}${key}: expected an object`);
        out[key] = defVal;
      } else {
        out[key] = merge(defVal, ovr, `${prefix}${key}.`, errors);
      }
    } else {
      out[key] = ovr;
    }
  }
  for (const key of Object.keys(overrides)) {
    if (!(key in defaults)) errors.push(`${prefix}${key}: unknown setting`);
  }
  return out;
}

function validate(cfg, errors) {
  const num = (v, name, min, max) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      errors.push(`${name}: expected a number in [${min}, ${max}], got ${JSON.stringify(v)}`);
    }
  };
  const str = (v, name) => {
    if (typeof v !== 'string') errors.push(`${name}: expected a string`);
  };
  const strArray = (v, name) => {
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
      errors.push(`${name}: expected an array of strings`);
    }
  };

  str(cfg.nanoleaf.host, 'nanoleaf.host');
  str(cfg.nanoleaf.token, 'nanoleaf.token');
  num(cfg.nanoleaf.port, 'nanoleaf.port', 1, 65535);
  num(cfg.nanoleaf.fps, 'nanoleaf.fps', 1, 60);

  if (!['slimproto', 'capture', 'stdin'].includes(cfg.audio.source)) {
    errors.push(`audio.source: expected slimproto|capture|stdin, got ${JSON.stringify(cfg.audio.source)}`);
  }
  num(cfg.audio.sampleRate, 'audio.sampleRate', 8000, 384000);
  num(cfg.audio.channels, 'audio.channels', 1, 2);
  if (!Array.isArray(cfg.audio.captureArgs) || cfg.audio.captureArgs.some((a) => typeof a !== 'string')) {
    errors.push('audio.captureArgs: expected an array of strings');
  }

  str(cfg.roon.zone, 'roon.zone');
  if (typeof cfg.roon.enabled !== 'boolean') errors.push('roon.enabled: expected true or false');
  if (cfg.visuals.rotate === 'track' && cfg.roon.enabled !== true) {
    errors.push('visuals.rotate "track" requires roon.enabled: true (track changes come from Roon)');
  }

  strArray(cfg.visuals.include, 'visuals.include');
  strArray(cfg.visuals.exclude, 'visuals.exclude');
  num(cfg.visuals.palettes, 'visuals.palettes', 1, 1000);
  str(cfg.visuals.palette, 'visuals.palette');
  if (typeof cfg.visuals.palette === 'string' && cfg.visuals.palette !== '') {
    const { resolvePalette, paletteNames } = require('./visuals/palettes');
    if (!resolvePalette(cfg.visuals.palette, cfg.visuals.palettes)) {
      errors.push(
        `visuals.palette: unknown palette ${JSON.stringify(cfg.visuals.palette)}; ` +
        `available: ${paletteNames(cfg.visuals.palettes).join(', ')}`
      );
    }
  }
  const rot = cfg.visuals.rotate;
  if (rot !== 'track' && rot !== 'off' && !(typeof rot === 'number' && rot > 0 && Number.isFinite(rot))) {
    errors.push(`visuals.rotate: expected "track", "off", or a positive number of seconds, got ${JSON.stringify(rot)}`);
  }
  num(cfg.visuals.minSeconds, 'visuals.minSeconds', 0, 3600);
  if (typeof cfg.visuals.albumColors !== 'boolean') errors.push('visuals.albumColors: expected true or false');
  if (cfg.visuals.albumColors === true && cfg.roon.enabled !== true) {
    errors.push('visuals.albumColors requires roon.enabled: true (album art comes from Roon)');
  }
  num(cfg.visuals.albumSat, 'visuals.albumSat', 0, 1);
  num(cfg.visuals.albumVal, 'visuals.albumVal', 0, 1);
  num(cfg.visuals.albumMaxColors, 'visuals.albumMaxColors', 3, 21);
  num(cfg.visuals.albumPredominantChance, 'visuals.albumPredominantChance', 0, 1);
  num(cfg.visuals.albumPredominantCount, 'visuals.albumPredominantCount', 3, 12);
  num(cfg.visuals.gain, 'visuals.gain', 0, 100);
  num(cfg.visuals.attackMs, 'visuals.attackMs', 0, 5000);
  num(cfg.visuals.releaseMs, 'visuals.releaseMs', 0, 10000);
  num(cfg.visuals.silenceFloor, 'visuals.silenceFloor', 0, 1);
  num(cfg.visuals.flashStrength, 'visuals.flashStrength', 0, 1);
  num(cfg.visuals.onsetSensitivity, 'visuals.onsetSensitivity', 0, 10);
  num(cfg.visuals.releaseDebounceMs, 'visuals.releaseDebounceMs', 0, 60000);
  num(cfg.visuals.extControlKeepaliveMs, 'visuals.extControlKeepaliveMs', 500, 60000);

  if (typeof cfg.control.enabled !== 'boolean') errors.push('control.enabled: expected true or false');
  num(cfg.control.port, 'control.port', 1, 65535);
  str(cfg.control.host, 'control.host');
  num(cfg.control.frameHz, 'control.frameHz', 1, 60);
}

/**
 * Build a full config from a plain object (already-parsed JSON).
 * Throws ConfigError listing every problem at once.
 */
function fromObject(obj) {
  if (!isPlainObject(obj)) throw new ConfigError('config root must be a JSON object');
  const errors = [];
  const cfg = merge(DEFAULTS, obj, '', errors);
  validate(cfg, errors);
  if (errors.length) throw new ConfigError(`invalid config:\n  - ${errors.join('\n  - ')}`);
  return cfg;
}

/** Load config.json from disk (missing file → pure defaults, still validated). */
function load(file) {
  const resolved = path.resolve(file || 'config.json');
  let obj = {};
  if (fs.existsSync(resolved)) {
    let raw;
    try {
      raw = fs.readFileSync(resolved, 'utf8');
      obj = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`failed to read ${resolved}: ${err.message}`);
    }
  }
  return fromObject(obj);
}

/** Persist a value (e.g. the auth token from pairing) back into config.json. */
function save(file, cfg) {
  const resolved = path.resolve(file || 'config.json');
  fs.writeFileSync(resolved, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * The `visuals.*` levers that can be changed live via the control API (POST /api/command
 * {cmd:'set'}). Each entry drives both value validation and the range the companion menu
 * reads from GET /api/config. `apply` tells the renderer how to realize the change:
 *   'set' — just store it (read live or on the next track/rotate)
 *   'gain' | 'rotate' | 'palette' — routed to the existing renderer setter
 *   'onset' — update the live onset detector
 *   'features' — rebuild the feature extractor (envelope constants)
 *   'pool' — rebuild the visualizer shuffle bag (include/exclude)
 *   'palettes' — regenerate the palette set + bag
 */
const VISUALS_LEVERS = {
  gain: { type: 'number', min: 0, max: 100, apply: 'gain' },
  rotate: { type: 'rotate', apply: 'rotate' },
  palette: { type: 'string', apply: 'palette' },
  include: { type: 'strings', apply: 'pool' },
  exclude: { type: 'strings', apply: 'pool' },
  palettes: { type: 'number', min: 1, max: 1000, apply: 'palettes' },
  minSeconds: { type: 'number', min: 0, max: 3600, apply: 'set' },
  flashStrength: { type: 'number', min: 0, max: 1, apply: 'set' },
  onsetSensitivity: { type: 'number', min: 0, max: 10, apply: 'onset' },
  silenceFloor: { type: 'number', min: 0, max: 1, apply: 'set' },
  attackMs: { type: 'number', min: 0, max: 5000, apply: 'features' },
  releaseMs: { type: 'number', min: 0, max: 10000, apply: 'features' },
  albumColors: { type: 'boolean', apply: 'set' },
  albumSat: { type: 'number', min: 0, max: 1, apply: 'set' },
  albumVal: { type: 'number', min: 0, max: 1, apply: 'set' },
  albumMaxColors: { type: 'number', min: 3, max: 21, apply: 'set' },
  albumPredominantChance: { type: 'number', min: 0, max: 1, apply: 'set' },
  albumPredominantCount: { type: 'number', min: 3, max: 12, apply: 'set' },
  releaseDebounceMs: { type: 'number', min: 0, max: 60000, apply: 'set' },
  extControlKeepaliveMs: { type: 'number', min: 500, max: 60000, apply: 'set' },
};

/**
 * Validate a single visuals lever value against VISUALS_LEVERS.
 * @returns {{ ok: true, value } | { ok: false, error: string }}
 */
function validateLever(key, value) {
  const spec = VISUALS_LEVERS[key];
  if (!spec) return { ok: false, error: `unknown or read-only lever: ${key}` };
  switch (spec.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) {
        return { ok: false, error: `${key}: expected a number in [${spec.min}, ${spec.max}]` };
      }
      return { ok: true, value };
    case 'boolean':
      if (typeof value !== 'boolean') return { ok: false, error: `${key}: expected true or false` };
      return { ok: true, value };
    case 'string':
      if (typeof value !== 'string') return { ok: false, error: `${key}: expected a string` };
      return { ok: true, value };
    case 'strings':
      if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
        return { ok: false, error: `${key}: expected an array of strings` };
      }
      return { ok: true, value };
    case 'rotate':
      if (value === 'track' || value === 'off' || (typeof value === 'number' && value > 0 && Number.isFinite(value))) {
        return { ok: true, value };
      }
      return { ok: false, error: `${key}: expected "track", "off", or a positive number` };
    default:
      return { ok: false, error: `${key}: unhandled type` };
  }
}

module.exports = { load, save, fromObject, DEFAULTS, ConfigError, VISUALS_LEVERS, validateLever };
