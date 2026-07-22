'use strict';

/**
 * Turn a Roon album-art image_key into a visualizer palette:
 * fetch a small thumbnail → decode the JPEG → extract vibrant hues.
 *
 * Kept separate from the renderer so the whole path stays testable and the
 * jpeg-js dependency is only pulled when the feature is actually used.
 */

const { extractPalette } = require('./albumpalette');

/**
 * @param {{ getImage(key, opts): Promise<{body: Buffer}> }} roon  a RoonExtension
 * @param {string} imageKey
 * @param {{ albumSat?: number, albumVal?: number }} [opts]
 * @returns {Promise<object|null>} a palette, or null when the art has no usable
 *   color (grayscale cover) so the caller falls back to the pinned palette
 */
async function fetchAlbumPalette(roon, imageKey, opts = {}) {
  let jpeg;
  try {
    jpeg = require('jpeg-js');
  } catch (err) {
    throw new Error(`jpeg-js is not installed — run \`npm install\` (${err.message})`);
  }
  const { body } = await roon.getImage(imageKey, { width: 64, height: 64 });
  // Decode on a tiny image; cap memory so a malformed payload can't blow up.
  const img = jpeg.decode(body, { useTArray: true, maxMemoryUsageInMB: 32 });
  return extractPalette(img.data, img.width, img.height, {
    name: 'Album',
    sat: opts.albumSat,
    val: opts.albumVal,
    maxSwatches: opts.albumMaxColors,
  });
}

module.exports = { fetchAlbumPalette };
