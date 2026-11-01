'use strict';

/**
 * Generates the PWA icons (icon-192.png, icon-512.png) with zero dependencies:
 * raw RGBA pixels → zlib deflate → hand-rolled PNG chunks. Rerun after changing
 * the artwork: node scripts/gen-icons.js
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

// ---- minimal PNG encoder -------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array of size w*h*4 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // scanlines, each prefixed with filter byte 0
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    rgba.copy ? rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4)
              : raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- artwork -------------------------------------------------------------

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

// the wall: a cluster of light-panel triangles on the app's dark background
const BG = hex('#06070a');
const TRIS = [
  // [cx, cy, up?, color] in unit coords of the design box
  [0.32, 0.36, true,  hex('#2dd4bf')], // teal
  [0.50, 0.36, false, hex('#38bdf8')], // sky
  [0.68, 0.36, true,  hex('#a78bfa')], // violet
  [0.41, 0.64, false, hex('#f472b6')], // pink
  [0.59, 0.64, true,  hex('#fbbf24')], // amber
];
const TRI_R = 0.155; // circumradius of each triangle, unit coords

function triPoints(cx, cy, up, r) {
  const pts = [];
  for (let i = 0; i < 3; i++) {
    const a = (up ? -Math.PI / 2 : Math.PI / 2) + (i * 2 * Math.PI) / 3;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function inTriangle(px, py, [a, b, c]) {
  const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const tris = TRIS.map(([cx, cy, up, col]) => ({ pts: triPoints(cx, cy, up, TRI_R), col }));
  const SS = 2; // 2x2 supersampling for soft edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          let col = BG;
          for (const t of tris) {
            if (inTriangle(u, v, t.pts)) { col = t.col; break; }
          }
          r += col[0]; g += col[1]; b += col[2];
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = r / (SS * SS);
      rgba[i + 1] = g / (SS * SS);
      rgba[i + 2] = b / (SS * SS);
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'src', 'control', 'webapp');
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log(`wrote ${file}`);
}
