'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  mode: 'stream',        // stream = drive panels from Roon's audio signal (extControl UDP)
                         // scenes = rotate installed Nanoleaf music scenes on each track change
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
    enabled: true,       // pair with Roon and report status (audio path works without it)
    zone: '',            // zone to watch for track changes (case-insensitive substring of the
                         // zone name); empty = any playing zone. Used by scenes mode.
  },
  scenes: {
    include: [],         // explicit scene names to rotate through; empty = auto-discover
    exclude: [],         // scenes to skip when auto-discovering
    musicOnly: true,     // auto-discover only music-reactive (rhythm) effects
    onStop: 'keep',      // keep | off | "<effect name>"  — what to show when playback stops
    minSeconds: 8,       // don't switch scenes more often than this (rapid track skipping)
  },
  mapping: {
    attackMs: 5,         // envelope rise time constant
    releaseMs: 180,      // envelope fall time constant
    gain: 1.0,           // linear gain applied to the envelope before mapping
    baseColor: [80, 0, 255],   // RGB at full envelope
    floor: 0.02,         // envelope below this renders black (noise gate)
    stereo: true,        // split panels left/right by layout x-position
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

  if (!['stream', 'scenes'].includes(cfg.mode)) {
    errors.push(`mode: expected stream|scenes, got ${JSON.stringify(cfg.mode)}`);
  }
  if (cfg.mode === 'scenes' && cfg.roon.enabled !== true) {
    errors.push('mode "scenes" requires roon.enabled: true (track changes come from Roon)');
  }
  str(cfg.roon.zone, 'roon.zone');

  const strArray = (v, name) => {
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
      errors.push(`${name}: expected an array of strings`);
    }
  };
  strArray(cfg.scenes.include, 'scenes.include');
  strArray(cfg.scenes.exclude, 'scenes.exclude');
  if (typeof cfg.scenes.musicOnly !== 'boolean') errors.push('scenes.musicOnly: expected true or false');
  str(cfg.scenes.onStop, 'scenes.onStop');
  num(cfg.scenes.minSeconds, 'scenes.minSeconds', 0, 3600);

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

  num(cfg.mapping.attackMs, 'mapping.attackMs', 0, 5000);
  num(cfg.mapping.releaseMs, 'mapping.releaseMs', 0, 10000);
  num(cfg.mapping.gain, 'mapping.gain', 0, 100);
  num(cfg.mapping.floor, 'mapping.floor', 0, 1);
  const c = cfg.mapping.baseColor;
  if (!Array.isArray(c) || c.length !== 3 || c.some((x) => typeof x !== 'number' || x < 0 || x > 255)) {
    errors.push('mapping.baseColor: expected [r, g, b] with 0-255 values');
  }
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

module.exports = { load, save, fromObject, DEFAULTS, ConfigError };
