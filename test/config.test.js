'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');

test('fromObject: empty object yields validated defaults', () => {
  const cfg = config.fromObject({});
  assert.equal(cfg.nanoleaf.port, 16021);
  assert.equal(cfg.audio.source, 'slimproto');
  assert.equal(cfg.visuals.rotate, 'track');
  assert.equal(cfg.visuals.releaseMs, 180);
});

test('fromObject: deep merge preserves untouched defaults', () => {
  const cfg = config.fromObject({ nanoleaf: { host: '10.0.0.5' } });
  assert.equal(cfg.nanoleaf.host, '10.0.0.5');
  assert.equal(cfg.nanoleaf.fps, 30);
});

test('fromObject: unknown keys are rejected (typo protection)', () => {
  assert.throws(() => config.fromObject({ nanoleaf: { hots: 'x' } }), /nanoleaf\.hots: unknown setting/);
});

test('fromObject: collects every error at once', () => {
  try {
    config.fromObject({
      nanoleaf: { fps: 999 },
      audio: { source: 'telepathy' },
      visuals: { palettes: 0 },
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /nanoleaf\.fps/);
    assert.match(err.message, /audio\.source/);
    assert.match(err.message, /visuals\.palettes/);
  }
});

test('fromObject: type errors on wrong shapes', () => {
  assert.throws(() => config.fromObject({ nanoleaf: 'yes' }), /nanoleaf: expected an object/);
  assert.throws(() => config.fromObject({ audio: { captureArgs: 'ffmpeg -i x' } }), /captureArgs/);
});

test('load/save round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-cfg-'));
  const file = path.join(dir, 'config.json');
  try {
    const cfg = config.load(file); // missing file → defaults
    cfg.nanoleaf.host = '10.1.2.3';
    cfg.nanoleaf.token = 'abc';
    config.save(file, cfg);
    const reread = config.load(file);
    assert.equal(reread.nanoleaf.host, '10.1.2.3');
    assert.equal(reread.nanoleaf.token, 'abc');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load: invalid JSON reports the file path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-cfg-'));
  const file = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(file, '{ nope');
    assert.throws(() => config.load(file), /failed to read .*config\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fromObject: rotate "track" requires roon enabled', () => {
  assert.throws(
    () => config.fromObject({ roon: { enabled: false } }),
    /rotate "track" requires roon\.enabled/
  );
  // with a non-track rotate, roon can be off
  const ok = config.fromObject({ roon: { enabled: false }, visuals: { rotate: 'off' } });
  assert.equal(ok.visuals.rotate, 'off');
});

test('fromObject: visuals.rotate accepts track|off|seconds', () => {
  assert.equal(config.fromObject({ visuals: { rotate: 'off' } }).visuals.rotate, 'off');
  assert.equal(config.fromObject({ visuals: { rotate: 120 } }).visuals.rotate, 120);
  assert.throws(() => config.fromObject({ visuals: { rotate: 'disco' } }), /visuals\.rotate/);
  assert.throws(() => config.fromObject({ visuals: { rotate: -5 } }), /visuals\.rotate/);
  assert.throws(() => config.fromObject({ visuals: { rotate: 0 } }), /visuals\.rotate/);
});

test('fromObject: visuals settings are validated', () => {
  assert.throws(() => config.fromObject({ visuals: { include: 'ripple' } }), /visuals\.include/);
  assert.throws(() => config.fromObject({ visuals: { palettes: 9999 } }), /visuals\.palettes/);
  assert.throws(() => config.fromObject({ visuals: { silenceFloor: 2 } }), /visuals\.silenceFloor/);
  const cfg = config.fromObject({ visuals: { include: ['ripple', 'wheel'], gain: 2 } });
  assert.deepEqual(cfg.visuals.include, ['ripple', 'wheel']);
  assert.equal(cfg.visuals.gain, 2);
});

test('fromObject: legacy scenes/mode keys are now rejected', () => {
  assert.throws(() => config.fromObject({ mode: 'scenes' }), /mode: unknown setting/);
  assert.throws(() => config.fromObject({ scenes: {} }), /scenes: unknown setting/);
});
