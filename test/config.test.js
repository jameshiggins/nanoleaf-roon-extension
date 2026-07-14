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
  assert.equal(cfg.mapping.releaseMs, 180);
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
      mapping: { baseColor: [999] },
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /nanoleaf\.fps/);
    assert.match(err.message, /audio\.source/);
    assert.match(err.message, /mapping\.baseColor/);
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

test('fromObject: scenes mode requires roon enabled', () => {
  assert.throws(
    () => config.fromObject({ mode: 'scenes', roon: { enabled: false } }),
    /scenes.*requires roon\.enabled/
  );
  const ok = config.fromObject({ mode: 'scenes' });
  assert.equal(ok.mode, 'scenes');
});

test('fromObject: mode and scenes settings are validated', () => {
  assert.throws(() => config.fromObject({ mode: 'disco' }), /mode: expected stream\|scenes/);
  assert.throws(() => config.fromObject({ scenes: { include: 'Ripple' } }), /scenes\.include/);
  assert.throws(() => config.fromObject({ scenes: { minSeconds: -1 } }), /scenes\.minSeconds/);
  const cfg = config.fromObject({ mode: 'scenes', scenes: { exclude: ['Fireworks'], onStop: 'off' } });
  assert.deepEqual(cfg.scenes.exclude, ['Fireworks']);
  assert.equal(cfg.scenes.onStop, 'off');
  assert.equal(cfg.scenes.musicOnly, true);
});
