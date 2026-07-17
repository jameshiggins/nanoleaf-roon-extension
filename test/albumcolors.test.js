'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jpeg = require('jpeg-js');
const { fetchAlbumPalette } = require('../src/visuals/albumcolors');
const { RoonExtension } = require('../src/roon/extension');

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** A JPEG buffer of a solid w×h color. */
function jpegOf(w, h, [r, g, b]) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, 255], i * 4);
  return jpeg.encode({ data, width: w, height: h }, 100).data;
}

/** A fake RoonExtension whose getImage returns a fixed JPEG. */
const fakeRoon = (buf) => ({ getImage: async () => ({ contentType: 'image/jpeg', body: buf }) });

test('fetchAlbumPalette decodes the art and extracts a matching palette', async () => {
  const pal = await fetchAlbumPalette(fakeRoon(jpegOf(24, 24, [220, 20, 20])), 'k', { albumSat: 0.8, albumVal: 0.95 });
  assert.ok(pal, 'palette extracted');
  assert.ok(hueDist(pal.base, 0) < 20, `red cover → red-ish base, got ${pal.base}`);
  assert.equal(pal.sat, 0.8, 'albumSat threaded into the palette');
  assert.equal(pal.val, 0.95, 'albumVal threaded into the palette');
});

test('fetchAlbumPalette returns null for a grayscale cover (caller falls back)', async () => {
  const pal = await fetchAlbumPalette(fakeRoon(jpegOf(24, 24, [96, 96, 96])), 'k');
  assert.equal(pal, null);
});

test('fetchAlbumPalette rejects when the fetch fails (never silently darkens)', async () => {
  const roon = { getImage: async () => { throw new Error('get_image failed: NotFound'); } };
  await assert.rejects(() => fetchAlbumPalette(roon, 'k'), /get_image failed/);
});

test('RoonExtension.getImage resolves via the paired core, rejects when unpaired', async () => {
  const ext = new RoonExtension({ wantImages: true });
  await assert.rejects(() => ext.getImage('k'), /image service unavailable/);

  const calls = [];
  ext.core = {
    services: {
      RoonApiImage: {
        get_image: (key, opts, cb) => { calls.push({ key, opts }); cb(false, 'image/jpeg', Buffer.from([0xff, 0xd8])); },
      },
    },
  };
  const { contentType, body } = await ext.getImage('albumkey', { width: 32, height: 32 });
  assert.equal(contentType, 'image/jpeg');
  assert.ok(Buffer.isBuffer(body));
  assert.equal(calls[0].key, 'albumkey');
  assert.deepEqual(calls[0].opts, { scale: 'fit', width: 32, height: 32, format: 'image/jpeg' });

  ext.core.services.RoonApiImage.get_image = (key, opts, cb) => cb('NotFound');
  await assert.rejects(() => ext.getImage('k'), /get_image failed: NotFound/);
});
