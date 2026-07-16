#!/usr/bin/env node
'use strict';

/**
 * Offline track analyzer — runs a real song through the *actual* DSP + renderer
 * and reports whether the visualization really spans zero-to-max across the
 * track: the dynamic range of every audio feature, the resulting on-panel
 * brightness, and a gain recommendation if the panels never reach full scale.
 *
 *   node tools/analyze.js song.flac
 *   node tools/analyze.js song.mp3 --gain 1.8 --visual bars --fps 30
 *
 * Decoding uses ffmpeg (same dependency as the capture source). The analysis
 * is the real FeatureExtractor + VisualRenderer, so what it measures is exactly
 * what the panels would do.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { VisualRenderer } = require('../src/visuals/renderer');
const { EventEmitter } = require('node:events');
const config = require('../src/config');

const SAMPLE_RATE = 44100;
const CHANNELS = 2;

/**
 * Drive the real pipeline with a PCM stream and collect per-frame stats.
 * @param {import('node:stream').Readable} pcm  s16le interleaved
 * @param {{ gain?: number, visual?: string, fps?: number, palettes?: number }} opts
 * @returns {Promise<object>} summary
 */
function analyze(pcm, opts = {}) {
  const fps = opts.fps ?? 30;
  const frameBytes = Math.round(SAMPLE_RATE / fps) * CHANNELS * 2; // ~one render frame of audio
  const brights = [];
  const streamer = {
    sendFrame(frame) {
      let mx = 0;
      for (const p of frame) { const m = Math.max(p.r, p.g, p.b); if (m > mx) mx = m; }
      brights.push(Math.min(255, mx));
    },
    blackout() {},
  };
  const source = new EventEmitter();
  const visualsCfg = {
    ...config.DEFAULTS.visuals,
    gain: opts.gain ?? 1.0,
    palettes: opts.palettes ?? 12,
    rotate: 'off',
    include: opts.visual ? [opts.visual] : [],
  };
  const renderer = new VisualRenderer({ source, streamer, layout: gridLayout(24), config: visualsCfg, fps });
  renderer.rotate(true);
  renderer.features.setFormat({ sampleRate: SAMPLE_RATE, channels: CHANNELS });

  const feat = { rms: [], bass: [], mid: [], treble: [], energy: [] };
  let onsets = 0;
  let carry = Buffer.alloc(0);

  function step(chunk) {
    renderer.features.onChunk(chunk); // feed the real DSP directly
    renderer.renderFrame();           // snapshots features + renders; streamer records brightness
    const f = renderer.lastFeatures;
    feat.rms.push(f.rms); feat.bass.push(f.bass); feat.mid.push(f.mid);
    feat.treble.push(f.treble); feat.energy.push(f.energy);
    if (f.onset) onsets++;
  }

  return new Promise((resolve, reject) => {
    pcm.on('data', (d) => {
      carry = carry.length ? Buffer.concat([carry, d]) : d;
      while (carry.length >= frameBytes) {
        step(carry.subarray(0, frameBytes));
        carry = carry.subarray(frameBytes);
      }
    });
    pcm.on('error', reject);
    pcm.on('end', () => {
      if (carry.length) step(carry);
      resolve(summarize(feat, brights, onsets, fps, visualsCfg.gain));
    });
  });
}

function summarize(feat, brights, onsets, fps, gain) {
  const seconds = brights.length / fps;
  const s = {};
  for (const k of Object.keys(feat)) s[k] = stats(feat[k]);
  const b = stats(brights);
  const peakPct = (b.max / 255) * 100;
  const nearBlack = brights.filter((v) => v < 8).length / brights.length;
  const nearFull = brights.filter((v) => v > 230).length / brights.length;
  // gain that would bring the loudest moment to full scale (energy drives brightness)
  const suggestGain = s.energy.p99 > 0 ? Math.min(8, gain * (0.98 / s.energy.p99)) : gain;
  return {
    seconds, frames: brights.length, fps, gain, onsets,
    beatsPerMin: seconds > 0 ? (onsets / seconds) * 60 : 0,
    features: s, brightness: b, peakPct, nearBlackFrac: nearBlack, nearFullFrac: nearFull,
    suggestGain, timeline: brights,
  };
}

function stats(arr) {
  if (!arr.length) return { min: 0, max: 0, mean: 0, p50: 0, p99: 0 };
  const a = [...arr].sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return {
    min: a[0], max: a[a.length - 1],
    mean: arr.reduce((s, v) => s + v, 0) / arr.length,
    p50: q(0.5), p99: q(0.99),
  };
}

function gridLayout(n) {
  const cols = Math.ceil(Math.sqrt(n)), out = [];
  for (let i = 0; i < n; i++) out.push({ id: i + 1, nx: (i % cols) / (cols - 1 || 1), ny: Math.floor(i / cols) / (Math.ceil(n / cols) - 1 || 1) });
  return out;
}

function bar(v, max, width = 28) {
  const n = Math.round((v / max) * width);
  return '█'.repeat(n) + '·'.repeat(width - n);
}

function sparkline(arr, buckets = 60) {
  const chars = ' ▁▂▃▄▅▆▇█';
  const out = [];
  const per = Math.ceil(arr.length / buckets);
  for (let i = 0; i < arr.length; i += per) {
    const slice = arr.slice(i, i + per);
    const mx = Math.max(...slice, 0);
    out.push(chars[Math.min(8, Math.round((mx / 255) * 8))]);
  }
  return out.join('');
}

function report(r) {
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  console.log(`\nAnalyzed ${r.seconds.toFixed(1)}s (${r.frames} frames @ ${r.fps} fps), gain ${r.gain}`);
  console.log(`Detected beats: ${r.onsets}  (~${r.beatsPerMin.toFixed(0)} BPM)\n`);
  console.log('Audio feature range (0=silent, 1=full scale):');
  for (const k of ['rms', 'bass', 'mid', 'treble', 'energy']) {
    const f = r.features[k];
    console.log(`  ${k.padEnd(7)} ${bar(f.p99, 1)} peak ${f.p99.toFixed(2)}  median ${f.p50.toFixed(2)}`);
  }
  console.log('\nOn-panel brightness (0-255):');
  console.log(`  peak     ${bar(r.brightness.max, 255)} ${Math.round(r.brightness.max)}  (${r.peakPct.toFixed(0)}% of full)`);
  console.log(`  median   ${bar(r.brightness.p50, 255)} ${Math.round(r.brightness.p50)}`);
  console.log(`  ${pct(r.nearBlackFrac)} of frames near-black (quiet), ${pct(r.nearFullFrac)} near-full (peaks)`);
  console.log(`\n  brightness over the track: ${sparkline(r.timeline || [], 64)}`);

  console.log('\nVerdict:');
  if (r.peakPct >= 92) {
    console.log(`  ✓ Reaches full scale — the loudest parts hit ~max brightness. Gain ${r.gain} is well matched.`);
  } else if (r.peakPct >= 70) {
    console.log(`  ~ Nearly there — peaks reach ${r.peakPct.toFixed(0)}% of full. Try gain ${r.suggestGain.toFixed(2)} to use the whole range.`);
  } else {
    console.log(`  ✗ Under-driven — peaks only reach ${r.peakPct.toFixed(0)}% of full. Set visuals.gain to ~${r.suggestGain.toFixed(2)} so loud parts hit max.`);
  }
  if (r.nearBlackFrac < 0.02) {
    console.log('  ! Quiet passages never go dark — the noise floor may be high; raise visuals.silenceFloor a touch for more contrast.');
  } else {
    console.log('  ✓ Quiet passages fade toward black — good 0-to-max contrast across the track.');
  }
  console.log();
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--gain' || t === '--visual' || t === '--fps' || t === '--ffmpeg') a[t.slice(2)] = argv[++i];
    else if (t === '--raw') a.raw = true;
    else a._.push(t);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) {
    console.error('Usage: node tools/analyze.js <audio-file> [--gain N] [--visual name] [--fps 30]');
    console.error('       node tools/analyze.js <file.raw> --raw   (already s16le 44100 stereo)');
    console.error('Runs the real analysis + render pipeline over the track and reports its 0-to-max range.');
    process.exit(2);
  }

  let pcm;
  if (args.raw !== undefined) {
    pcm = fs.createReadStream(file);
  } else {
    const ffmpeg = args.ffmpeg || process.env.FFMPEG || 'ffmpeg';
    const ff = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', file,
      '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-f', 's16le', '-',
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    ff.on('error', (err) => {
      console.error(`could not run ffmpeg (${err.message}). Install ffmpeg or pass --ffmpeg <path>.`);
      process.exit(1);
    });
    pcm = ff.stdout;
  }

  const r = await analyze(pcm, {
    gain: args.gain ? Number(args.gain) : 1.0,
    visual: args.visual,
    fps: args.fps ? Number(args.fps) : 30,
  });
  if (r.frames === 0) {
    console.error('No audio was decoded — check the file path and that ffmpeg can read it.');
    process.exit(1);
  }
  report(r);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { analyze };
