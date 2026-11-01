"use strict";
/**
 * Now Playing screen — 20 full-screen audio-reactive visualizers.
 *
 * Everything here is driven by the same live SSE stream the rest of the app uses:
 * 21 panel colours (`c`) + the DSP features (`f`: rms/bass/mid/treble/energy/onset)
 * at 20 Hz. There is no FFT upstream, so `Signal` synthesises a plausible 48-band
 * spectrum from the three band envelopes (per-band drift + beat jitter, falling
 * peaks) and estimates tempo/phase from the onset train. The panel colours are the
 * palette: whatever the wall is doing, the screen is doing in the same colours.
 *
 * Pack 1 "Winamp" — classic AVS / MilkDrop era looks.
 * Pack 2 "Show"   — concert / VJ LED-wall looks.
 *
 * Exposed as window.NanoleafNP = { open, close, isOpen, feed, setState, key, list }.
 * index.html owns the SSE connection and the TV key routing; this file only draws.
 */
window.NanoleafNP = (function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var TAU = Math.PI * 2;
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var rnd = function (a, b) { return a + Math.random() * (b - a); };
  var TV = /NanoleafRoonTV/.test(navigator.userAgent) || /[?&]tv=1/.test(location.search);

  // ---------------------------------------------------------------- signal
  var N = 48;
  function Signal() {
    this.bass = 0; this.mid = 0; this.treble = 0; this.energy = 0; this.rms = 0;
    this.tb = 0; this.tm = 0; this.tt = 0; this.te = 0; this.tr = 0; // targets from the last frame
    this.beat = 0; this.onset = false; this.onsetAt = 0; this.beats = 0;
    this.spec = new Float32Array(N); this.cap = new Float32Array(N);
    this.drift = new Float32Array(N); this.jit = new Float32Array(N);
    for (var i = 0; i < N; i++) this.drift[i] = Math.random() * TAU;
    this.intervals = []; this.bpm = 0; this.phase = 0; this.lastBeatAt = 0;
    this.colors = []; this.pal = []; this.accent = [124, 204, 255];
    this.live = false;
  }
  Signal.prototype.frame = function (colors, f, now) {
    this.tb = f.bass || 0; this.tm = f.mid || 0; this.tt = f.treble || 0;
    this.te = f.energy || 0; this.tr = f.rms || 0;
    if (f.onset) {
      this.beat = 1; this.onset = true; this.beats++;
      if (this.lastBeatAt) {
        var iv = now - this.lastBeatAt;
        if (iv > 280 && iv < 1600) { this.intervals.push(iv); if (this.intervals.length > 8) this.intervals.shift(); }
      }
      this.lastBeatAt = now;
      for (var i = 0; i < N; i++) this.jit[i] = Math.random();
    }
    if (colors && colors.length) {
      this.colors = colors;
      var pal = [], br = 0, best = null;
      for (var k = 0; k < colors.length; k++) {
        var c = colors[k], m = Math.max(c[0], c[1], c[2]);
        if (m > 28) { var b = 230 / m; pal.push([Math.min(255, c[0] * b), Math.min(255, c[1] * b), Math.min(255, c[2] * b)]); }
        if (m > br) { br = m; best = c; }
      }
      if (pal.length) this.pal = pal;
      if (best && br > 20) {
        var bo = 220 / br;
        this.accent = [Math.min(255, best[0] * bo), Math.min(255, best[1] * bo), Math.min(255, best[2] * bo)];
      }
    }
    this.live = true;
  };
  Signal.prototype.tick = function (dt, now) {
    // ease the 20 Hz envelopes at 60 fps: snappy up, softer down
    var up = 1 - Math.exp(-dt * 28), dn = 1 - Math.exp(-dt * 9);
    this.bass += (this.tb - this.bass) * (this.tb > this.bass ? up : dn);
    this.mid += (this.tm - this.mid) * (this.tm > this.mid ? up : dn);
    this.treble += (this.tt - this.treble) * (this.tt > this.treble ? up : dn);
    this.energy += (this.te - this.energy) * (this.te > this.energy ? up : dn);
    this.rms += (this.tr - this.rms) * (this.tr > this.rms ? up : dn);
    this.beat *= Math.exp(-dt * 5.5);
    // tempo: median of recent onset intervals; phase runs freely between onsets
    if (this.intervals.length >= 3) {
      var s = this.intervals.slice().sort(function (a, b) { return a - b; });
      var med = s[s.length >> 1];
      this.bpm = 60000 / med;
      this.phase = ((now - this.lastBeatAt) / med) % 1;
    } else { this.bpm = 0; this.phase = (now / 500) % 1; }
    // synthesised spectrum
    var t = now / 1000;
    for (var i = 0; i < N; i++) {
      var p = i / (N - 1);
      var wb = clamp(1 - p / 0.38, 0, 1), wt = clamp((p - 0.62) / 0.38, 0, 1), wm = 1 - wb - wt;
      var base = this.bass * wb * 1.05 + this.mid * wm * 0.95 + this.treble * wt * 0.9;
      var drift = 0.72 + 0.28 * Math.sin(t * (1.3 + p * 2.1) + this.drift[i]) * Math.sin(t * 0.7 + i * 0.9);
      var v = base * drift * (0.85 + 0.45 * this.jit[i] * this.beat) + this.beat * 0.08 * wb;
      v = clamp(v, 0, 1);
      if (v > this.spec[i]) this.spec[i] = v; else this.spec[i] = Math.max(v, this.spec[i] - dt * 2.4);
      if (this.spec[i] > this.cap[i]) this.cap[i] = this.spec[i]; else this.cap[i] = Math.max(0, this.cap[i] - dt * 0.55);
    }
  };
  Signal.prototype.col = function (i, a) {
    var p = this.pal.length ? this.pal[((i % this.pal.length) + this.pal.length) % this.pal.length] : hue((i * 47) % 360);
    return "rgba(" + (p[0] | 0) + "," + (p[1] | 0) + "," + (p[2] | 0) + "," + (a == null ? 1 : a) + ")";
  };
  Signal.prototype.rgb = function (i) {
    return this.pal.length ? this.pal[((i % this.pal.length) + this.pal.length) % this.pal.length] : hue((i * 47) % 360);
  };
  Signal.prototype.acc = function (a) { var c = this.accent; return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + (a == null ? 1 : a) + ")"; };
  function hue(h) { // fallback rainbow when the wall is dark
    var s = 1, l = 0.6, c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r, g, b;
    if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; } else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; } else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }
  var S = new Signal();

  // ---------------------------------------------------------------- canvas
  var cv, ctx, fb, fctx, W = 0, H = 0, layoutRef = [];
  var MAXW = 1280; // internal resolution cap — the Shield's WebView can't push 4K 2D canvas
  function sizeCanvas() {
    var cw = innerWidth, ch = innerHeight, scale = Math.min(MAXW / cw, Math.max(1, Math.min(2, devicePixelRatio || 1)));
    W = Math.max(2, Math.round(cw * scale)); H = Math.max(2, Math.round(ch * scale));
    cv.width = W; cv.height = H; fb.width = W; fb.height = H;
    if (cur && cur.init) cur.init();
  }
  // feedback helper: fold the previous frame back in, zoomed/rotated/dimmed
  function feedback(zoom, rot, alpha, blurPx) {
    fctx.globalCompositeOperation = "copy";
    fctx.drawImage(cv, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(W / 2, H / 2); ctx.rotate(rot); ctx.scale(zoom, zoom); ctx.translate(-W / 2, -H / 2);
    if (blurPx) ctx.filter = "blur(" + blurPx + "px)";
    ctx.drawImage(fb, 0, 0);
    ctx.restore();
    ctx.filter = "none";
  }
  function fade(a) { ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = "rgba(0,0,0," + a + ")"; ctx.fillRect(0, 0, W, H); }
  function glowLine(pts, color, width, closed) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (var pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (var i = 0; i < pts.length; i++) { if (i) ctx.lineTo(pts[i][0], pts[i][1]); else ctx.moveTo(pts[i][0], pts[i][1]); }
      if (closed) ctx.closePath();
      ctx.strokeStyle = color; ctx.lineWidth = pass ? width : width * 4; ctx.globalAlpha = pass ? 1 : 0.22; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function orb(x, y, r, rgb, a) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0) + "," + a + ")");
    g.addColorStop(0.5, "rgba(" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0) + "," + (a * 0.25) + ")");
    g.addColorStop(1, "rgba(" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0) + ",0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  function vignette(a) {
    var g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0," + a + ")");
    ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // ---------------------------------------------------------------- visualizers
  // Each: { id, name, pack, init?(), draw(t, dt) } drawing on ctx at W×H with S.
  var VIS = [];
  function def(v) { VIS.push(v); }

  // ===== PACK 1: WINAMP =====

  def({ id: "spectrum", name: "Spectrum Analyzer", pack: "Winamp",
    draw: function () {
      fade(1);
      var n = N, gap = Math.max(2, W * 0.004), bw = (W - gap * (n + 1)) / n, base = H * 0.9, top = H * 0.12;
      var seg = Math.max(4, Math.round(H * 0.012));
      for (var i = 0; i < n; i++) {
        var x = gap + i * (bw + gap), h = S.spec[i] * (base - top);
        var g = ctx.createLinearGradient(0, base, 0, top);
        g.addColorStop(0, "#3dff6a"); g.addColorStop(0.55, "#f7e64a"); g.addColorStop(0.85, "#ff5a3c"); g.addColorStop(1, "#ff2d7a");
        ctx.fillStyle = g; ctx.fillRect(x, base - h, bw, h);
        // LED segmentation
        ctx.fillStyle = "rgba(0,0,0,.55)";
        for (var y = base; y > base - h; y -= seg) ctx.fillRect(x, y - 1.5, bw, 1.5);
        // peak cap
        var cy = base - S.cap[i] * (base - top);
        ctx.fillStyle = S.acc(0.95); ctx.fillRect(x, cy - 3, bw, 3);
      }
      // reflection
      ctx.save(); ctx.globalAlpha = 0.18; ctx.translate(0, base * 2 + 4); ctx.scale(1, -1);
      ctx.drawImage(cv, 0, base - H * 0.15, W, H * 0.15, 0, base - H * 0.15, W, H * 0.15); ctx.restore();
    } });

  def({ id: "scope", name: "Oscilloscope", pack: "Winamp",
    draw: function (t) {
      fade(0.42);
      ctx.globalCompositeOperation = "lighter";
      var pts = [], m = H / 2, amp = H * 0.32;
      for (var x = 0; x <= W; x += 3) {
        var p = x / W;
        var y = Math.sin(p * TAU * 2 + t * 2.1) * S.bass * 1.1
              + Math.sin(p * TAU * 9 - t * 5.3) * S.mid * 0.6
              + Math.sin(p * TAU * 31 + t * 11) * S.treble * 0.35
              + (Math.random() - 0.5) * S.treble * 0.25;
        pts.push([x, m + y * amp]);
      }
      glowLine(pts, S.acc(1), 2.5);
      var pts2 = pts.map(function (q) { return [q[0], m - (q[1] - m) * 0.6]; });
      glowLine(pts2, S.col(3, 0.7), 1.5);
      // grid
      ctx.globalAlpha = 0.08; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
      for (var gx = 0; gx < W; gx += W / 16) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(0, m); ctx.lineTo(W, m); ctx.stroke();
      ctx.globalAlpha = 1;
    } });

  def({ id: "fire", name: "Fire", pack: "Winamp",
    init: function () {
      this.w = 128; this.h = Math.max(40, Math.round(128 * H / W));
      this.heat = new Float32Array(this.w * (this.h + 2));
      this.img = document.createElement("canvas"); this.img.width = this.w; this.img.height = this.h;
      this.ictx = this.img.getContext("2d"); this.data = this.ictx.createImageData(this.w, this.h);
    },
    draw: function (t, dt) {
      var w = this.w, h = this.h, hm = this.heat, d = this.data.data;
      var fuel = clamp(0.45 + S.energy * 0.7 + S.beat * 0.6, 0, 1.3);
      for (var x = 0; x < w; x++) {
        hm[h * w + x] = rnd(0.55, 1) * fuel * (Math.random() < 0.85 ? 1 : 0.3);
        hm[(h + 1) * w + x] = hm[h * w + x];
      }
      var cool = (0.45 + (1 - S.energy) * 0.55) / h; // flames reach ~2/3 of the way up at full energy
      for (var y = 0; y < h; y++) for (x = 0; x < w; x++) {
        var l = x ? x - 1 : x, r = x < w - 1 ? x + 1 : x;
        var v = (hm[(y + 1) * w + l] + hm[(y + 1) * w + x] + hm[(y + 1) * w + r] + hm[(y + 2) * w + x]) * 0.25 - cool;
        hm[y * w + x] = v > 0 ? v : 0;
      }
      var a = S.accent, c2 = S.rgb(5);
      for (var i = 0, n = w * h; i < n; i++) {
        v = hm[i]; var o = i * 4;
        var k = v < 0.5 ? v * 2 : 1, kk = v < 0.5 ? 0 : (v - 0.5) * 2;
        d[o] = (c2[0] * (1 - k) + a[0] * k) * (1 - kk) + 255 * kk;
        d[o + 1] = (c2[1] * (1 - k) + a[1] * k) * (1 - kk) + 255 * kk;
        d[o + 2] = (c2[2] * (1 - k) + a[2] * k) * (1 - kk) + 255 * kk;
        d[o + 3] = Math.min(255, v * 420);
      }
      this.ictx.putImageData(this.data, 0, 0);
      fade(1); ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.img, 0, 0, W, H);
    } });

  def({ id: "stars", name: "Starfield", pack: "Winamp",
    init: function () {
      this.stars = [];
      for (var i = 0; i < 420; i++) this.stars.push({ x: rnd(-1, 1), y: rnd(-1, 1), z: rnd(0.05, 1), c: i });
    },
    draw: function (t, dt) {
      fade(0.5);
      ctx.globalCompositeOperation = "lighter";
      var sp = (0.25 + S.energy * 1.6 + S.beat * 2.2) * dt, f = Math.min(W, H) * 0.9, cx = W / 2, cy = H / 2;
      for (var i = 0; i < this.stars.length; i++) {
        var s = this.stars[i], pz = s.z;
        s.z -= sp * s.z + 0.0004;
        if (s.z <= 0.02) { s.x = rnd(-1, 1); s.y = rnd(-1, 1); s.z = 1; pz = 1; }
        var x0 = cx + s.x / pz * f, y0 = cy + s.y / pz * f, x1 = cx + s.x / s.z * f, y1 = cy + s.y / s.z * f;
        if (x1 < -50 || x1 > W + 50 || y1 < -50 || y1 > H + 50) { s.z = 1; continue; }
        var b = clamp((1 - s.z) * 1.4, 0.1, 1);
        ctx.strokeStyle = S.col(s.c, b); ctx.lineWidth = Math.max(1, (1 - s.z) * 3.5);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    } });

  def({ id: "milk", name: "MilkDrop Warp", pack: "Winamp",
    draw: function (t) {
      feedback(1.012 + S.bass * 0.05 + S.beat * 0.02, 0.0035 + S.mid * 0.012, 0.965, S.treble > 0.5 ? 1 : 0);
      ctx.globalCompositeOperation = "lighter";
      var cx = W / 2 + Math.sin(t * 0.7) * W * 0.12, cy = H / 2 + Math.cos(t * 0.9) * H * 0.12;
      var R = Math.min(W, H) * (0.18 + S.bass * 0.22), pts = [];
      for (var k = 0; k <= 180; k++) {
        var a = k / 180 * TAU, r = R * (1 + 0.32 * Math.sin(a * 5 + t * 3) * S.mid + 0.12 * Math.sin(a * 13 - t * 7) * S.treble);
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      glowLine(pts, S.col(Math.floor(t * 0.5), 0.9), 2.5, true);
      var pts2 = pts.map(function (p) { return [W - p[0], H - p[1]]; });
      glowLine(pts2, S.col(Math.floor(t * 0.5) + 3, 0.8), 2, true);
      if (S.beat > 0.6) orb(cx, cy, R * 1.3, S.accent, S.beat * 0.4);
    } });

  def({ id: "tunnel", name: "Tunnel", pack: "Winamp",
    init: function () { this.rings = []; this.acc = 0; },
    draw: function (t, dt) {
      fade(0.35);
      ctx.globalCompositeOperation = "lighter";
      this.acc += dt;
      if (S.onset || this.acc > 0.3) { this.rings.push({ r: 0.03, c: Math.floor(t * 3), w: S.onset ? 1 : 0.6 }); this.acc = 0; }
      var cx = W / 2 + Math.sin(t * 0.6) * W * 0.08, cy = H / 2 + Math.cos(t * 0.5) * H * 0.08, maxR = Math.hypot(W, H) * 0.6;
      var sp = 1.3 + S.energy * 2.4;
      for (var i = this.rings.length - 1; i >= 0; i--) {
        var g = this.rings[i]; g.r += g.r * sp * dt + dt * 0.08;
        if (g.r > 1.2) { this.rings.splice(i, 1); continue; }
        var r = g.r * maxR, n = 6 + ((g.c % 3) * 2), pts = [];
        for (var k = 0; k < n; k++) { var a = k / n * TAU + t * 0.3 + g.c; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
        glowLine(pts, S.col(g.c, clamp(g.w * (0.35 + g.r * 0.8), 0, 1)), 1.5 + g.r * 10 * g.w, true);
      }
      if (this.rings.length > 40) this.rings.splice(0, this.rings.length - 40);
    } });

  def({ id: "polar", name: "Polar Scope", pack: "Winamp",
    draw: function (t) {
      fade(0.3);
      ctx.globalCompositeOperation = "lighter";
      var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.22, rot = t * 0.4;
      for (var layer = 0; layer < 3; layer++) {
        var pts = [], sc = 1 + layer * 0.35;
        for (var k = 0; k <= N * 2; k++) {
          var i = k < N ? k : N * 2 - k, a = k / (N * 2) * TAU + rot * (layer % 2 ? -1 : 1);
          var r = R * sc * (0.55 + S.bass * 0.35) + S.spec[i] * R * (0.9 - layer * 0.2);
          pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
        glowLine(pts, S.col(layer * 4 + Math.floor(t * 0.3), 0.85 - layer * 0.2), 2.5 - layer * 0.5, true);
      }
      orb(cx, cy, R * (0.4 + S.bass * 0.5), S.accent, 0.35 + S.beat * 0.4);
    } });

  def({ id: "dotplane", name: "Dot Plane", pack: "Winamp",
    draw: function (t) {
      fade(1);
      ctx.globalCompositeOperation = "lighter";
      var cols = 44, rows = 22, f = H * 0.9, cx = W / 2, hor = H * 0.42, rot = Math.sin(t * 0.25) * 0.5;
      for (var r = 0; r < rows; r++) {
        var zr = r / rows, z = 0.25 + zr * 1.6, scroll = (t * (0.5 + S.energy) * 0.4) % (1.6 / rows);
        z -= scroll; if (z < 0.25) z += 1.6;
        var depth = (z - 0.25) / 1.6, band = Math.floor((1 - depth) * (N - 1));
        for (var c = 0; c < cols; c++) {
          var xi = (c / (cols - 1) - 0.5) * 3.2, h = S.spec[Math.abs(Math.floor(band - Math.abs(xi) * 6)) % N] * 0.9 + Math.sin(c * 0.6 + t * 2) * 0.08 * S.mid;
          var xr = xi * Math.cos(rot) - 0.8 * Math.sin(rot) * (1 - depth);
          var sx = cx + xr / z * f * 0.5, sy = hor + (0.9 - h * 1.4) / z * f * 0.5;
          if (sx < 0 || sx > W || sy > H) continue;
          var sz = Math.max(1, (1 - depth) * 5 * (1 + S.beat * 0.5));
          ctx.fillStyle = S.col(Math.floor(c / 4) + r, clamp((1 - depth) * 1.2, 0.08, 1));
          ctx.beginPath(); ctx.arc(sx, sy, sz, 0, TAU); ctx.fill();
        }
      }
    } });

  def({ id: "vu", name: "LED Meters", pack: "Winamp",
    init: function () { this.hold = [0, 0, 0, 0, 0, 0]; this.vel = [0, 0, 0, 0, 0, 0]; },
    draw: function (t, dt) {
      fade(1);
      var vals = [S.bass, (S.bass * 0.6 + S.mid * 0.4), S.mid, (S.mid * 0.4 + S.treble * 0.6), S.treble, S.energy];
      var labels = ["BASS", "LO-MID", "MID", "HI-MID", "TREBLE", "ENERGY"];
      var n = vals.length, segs = 28, pad = W * 0.06, gw = (W - pad * 2) / n, bw = gw * 0.56, top = H * 0.1, bot = H * 0.84;
      var sh = (bot - top) / segs;
      for (var i = 0; i < n; i++) {
        var x = pad + i * gw + (gw - bw) / 2, v = clamp(vals[i], 0, 1);
        if (v >= this.hold[i]) { this.hold[i] = v; this.vel[i] = 0; } else { this.vel[i] += dt * 1.5; this.hold[i] = Math.max(v, this.hold[i] - this.vel[i] * dt); }
        for (var s = 0; s < segs; s++) {
          var p = s / segs, on = p < v, y = bot - (s + 1) * sh;
          var col = p < 0.6 ? [70, 255, 120] : p < 0.85 ? [255, 200, 60] : [255, 70, 70];
          ctx.fillStyle = "rgba(" + col[0] + "," + col[1] + "," + col[2] + "," + (on ? 1 : 0.1) + ")";
          ctx.fillRect(x, y + sh * 0.18, bw, sh * 0.64);
        }
        var hy = bot - Math.round(this.hold[i] * segs) * sh;
        ctx.fillStyle = "#fff"; ctx.fillRect(x, hy - 2, bw, 3);
        ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.font = "600 " + Math.round(H * 0.02) + "px system-ui, sans-serif"; ctx.textAlign = "center";
        ctx.fillText(labels[i], x + bw / 2, bot + H * 0.045);
      }
      if (S.bpm) { ctx.fillStyle = S.acc(0.8); ctx.font = "700 " + Math.round(H * 0.03) + "px system-ui, sans-serif"; ctx.textAlign = "right";
        ctx.fillText(Math.round(S.bpm) + " BPM", W - pad, H * 0.075); }
    } });

  def({ id: "ribbons", name: "Ribbons", pack: "Winamp",
    draw: function (t) {
      fade(0.16);
      ctx.globalCompositeOperation = "lighter";
      var bands = [S.bass, S.mid, S.treble, S.bass * 0.7, S.mid * 0.8, S.energy];
      for (var r = 0; r < bands.length; r++) {
        var pts = [], base = H * (0.2 + r * 0.12), amp = H * 0.08 + bands[r] * H * 0.18;
        for (var x = 0; x <= W; x += 6) {
          var p = x / W;
          pts.push([x, base + Math.sin(p * TAU * (1.5 + r * 0.5) + t * (1 + r * 0.3) * (r % 2 ? -1 : 1)) * amp
                            + Math.sin(p * TAU * 7 + t * 4) * S.treble * H * 0.02]);
        }
        glowLine(pts, S.col(r * 3 + Math.floor(t * 0.2), 0.75), 2);
      }
    } });

  // ===== PACK 2: SHOW =====

  def({ id: "beams", name: "Laser Fan", pack: "Show",
    init: function () { this.beams = []; for (var i = 0; i < 14; i++) this.beams.push({ a: rnd(-1.3, 1.3), ta: rnd(-1.3, 1.3), c: i }); this.flash = 0; },
    draw: function (t, dt) {
      fade(0.3);
      if (S.onset) { for (var i = 0; i < this.beams.length; i++) this.beams[i].ta = rnd(-1.35, 1.35); this.flash = 1; }
      this.flash *= Math.exp(-dt * 8);
      ctx.globalCompositeOperation = "lighter";
      var ox = W / 2, oy = H * 1.02, L = Math.hypot(W, H) * 1.2, sw = Math.sin(t * 0.8) * 0.25 * S.mid;
      for (i = 0; i < this.beams.length; i++) {
        var b = this.beams[i]; b.a += (b.ta - b.a) * (1 - Math.exp(-dt * 6));
        var a = -Math.PI / 2 + b.a + sw, ex = ox + Math.cos(a) * L, ey = oy + Math.sin(a) * L;
        var rgb = S.rgb(b.c), col = "rgba(" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0) + ",";
        var g = ctx.createLinearGradient(ox, oy, ex, ey);
        g.addColorStop(0, col + (0.9 + this.flash * 0.1) + ")"); g.addColorStop(1, col + "0)");
        ctx.strokeStyle = g;
        ctx.lineWidth = 14 + S.bass * 26; ctx.globalAlpha = 0.12 + this.flash * 0.2;
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.lineWidth = 2; ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // haze floor + source hot spot
      orb(ox, oy, H * 0.35, S.accent, 0.25 + S.bass * 0.3);
      if (this.flash > 0.3) { ctx.fillStyle = "rgba(255,255,255," + (this.flash - 0.3) * 0.25 + ")"; ctx.fillRect(0, 0, W, H); }
    } });

  def({ id: "burst", name: "Particle Burst", pack: "Show",
    init: function () { this.p = []; },
    draw: function (t, dt) {
      fade(0.22);
      ctx.globalCompositeOperation = "lighter";
      if (S.onset || (S.energy > 0.5 && Math.random() < 0.05)) {
        var ex = rnd(W * 0.25, W * 0.75), ey = rnd(H * 0.25, H * 0.7), n = 50 + Math.round(S.energy * 90), ci = Math.floor(rnd(0, 20));
        for (var i = 0; i < n && this.p.length < 1400; i++) {
          var a = rnd(0, TAU), v = rnd(0.2, 1) * (200 + S.energy * 700) * (H / 720);
          this.p.push({ x: ex, y: ey, vx: Math.cos(a) * v, vy: Math.sin(a) * v, l: rnd(0.6, 1.6), age: 0, c: ci + (i % 3) });
        }
      }
      var g = 420 * (H / 720);
      for (i = this.p.length - 1; i >= 0; i--) {
        var q = this.p[i]; q.age += dt; if (q.age > q.l) { this.p.splice(i, 1); continue; }
        q.vy += g * dt; q.vx *= 1 - dt * 1.2; q.vy *= 1 - dt * 0.6;
        var px = q.x, py = q.y; q.x += q.vx * dt; q.y += q.vy * dt;
        var k = 1 - q.age / q.l;
        ctx.strokeStyle = S.col(q.c, k); ctx.lineWidth = 1.5 + k * 2.5;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
    } });

  def({ id: "kaleido", name: "Kaleidoscope", pack: "Show",
    init: function () { this.off = document.createElement("canvas"); this.oc = this.off.getContext("2d"); this.off.width = this.off.height = Math.round(Math.min(W, H) * 0.6); },
    draw: function (t, dt) {
      var o = this.off, oc = this.oc, s = o.width;
      oc.globalCompositeOperation = "source-over"; oc.fillStyle = "rgba(0,0,0,.18)"; oc.fillRect(0, 0, s, s);
      oc.globalCompositeOperation = "lighter";
      for (var i = 0; i < 6; i++) {
        var x = s * 0.5 + Math.sin(t * (0.7 + i * 0.21) + i) * s * 0.42, y = s * 0.5 + Math.cos(t * (0.9 + i * 0.17) * 1.3 + i * 2) * s * 0.42;
        var r = s * (0.04 + [S.bass, S.mid, S.treble][i % 3] * 0.14 + S.beat * 0.03), rgb = S.rgb(i + Math.floor(t * 0.2));
        var g = oc.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0) + ",.9)"); g.addColorStop(1, "rgba(" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0) + ",0)");
        oc.fillStyle = g; oc.beginPath(); oc.arc(x, y, r, 0, TAU); oc.fill();
      }
      oc.strokeStyle = S.acc(0.8); oc.lineWidth = 2 + S.treble * 4; oc.beginPath();
      oc.moveTo(s * 0.5, s * 0.5); oc.lineTo(s * 0.5 + Math.cos(t * 3) * s * 0.5 * S.energy, s * 0.5 + Math.sin(t * 2) * s * 0.5 * S.energy); oc.stroke();
      fade(1);
      var seg = 10, cx = W / 2, cy = H / 2, R = Math.hypot(W, H) / 2 + 4, rot = t * 0.15 + S.energy * 0.5;
      ctx.globalCompositeOperation = "lighter";
      for (var k = 0; k < seg; k++) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot + k * TAU / seg); if (k % 2) ctx.scale(1, -1);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, -TAU / seg / 2 - 0.01, TAU / seg / 2 + 0.01); ctx.closePath(); ctx.clip();
        ctx.drawImage(o, 0, -R / 2, R * 1.1, R); ctx.restore();
      }
      vignette(0.5);
    } });

  def({ id: "ledwall", name: "LED Wall", pack: "Show",
    draw: function (t) {
      fade(1);
      var cols = 40, rows = Math.max(12, Math.round(cols * H / W)), cw = W / cols, ch = H / rows, gap = Math.max(1, cw * 0.14);
      var lay = layoutRef, cols21 = S.colors;
      for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
        var nx = (c + 0.5) / cols, ny = 1 - (r + 0.5) / rows;
        // nearest real panel colours this cell
        var best = 0, bd = 9;
        for (var i = 0; i < lay.length; i++) { var dx = lay[i].nx - nx, dy = lay[i].ny - ny, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
        var pc = (cols21 && cols21[best]) || [60, 60, 80];
        var field = 0.5 + 0.5 * Math.sin(nx * 6 + t * 1.3) * Math.sin(ny * 5 - t * 1.1 + Math.sin(t * 0.3) * 3);
        var dist = Math.hypot(nx - 0.5, (ny - 0.5) * H / W), pulse = Math.max(0, 1 - Math.abs(dist * 2.2 - S.phase * 1.5) * 4) * S.beat;
        var lum = clamp(0.15 + field * S.energy * 1.1 + pulse * 0.9 + Math.exp(-bd * 40) * 0.5, 0, 1.4);
        var rr = Math.min(255, pc[0] * lum + 255 * pulse * 0.3), gg = Math.min(255, pc[1] * lum + 255 * pulse * 0.3), bb = Math.min(255, pc[2] * lum + 255 * pulse * 0.3);
        ctx.fillStyle = "rgb(" + (rr | 0) + "," + (gg | 0) + "," + (bb | 0) + ")";
        ctx.fillRect(c * cw + gap / 2, r * ch + gap / 2, cw - gap, ch - gap);
      }
      vignette(0.45);
    } });

  def({ id: "terrain", name: "Synthwave Grid", pack: "Show",
    init: function () { this.scroll = 0; },
    draw: function (t, dt) {
      fade(1);
      var hor = H * 0.55, cx = W / 2;
      // sun
      var sg = ctx.createLinearGradient(0, hor - H * 0.3, 0, hor);
      sg.addColorStop(0, S.col(0)); sg.addColorStop(1, S.col(4));
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(cx, hor - H * 0.02, H * (0.16 + S.bass * 0.08), Math.PI, 0); ctx.fill();
      ctx.fillStyle = "#000"; for (var s = 0; s < 6; s++) ctx.fillRect(0, hor - H * 0.02 - s * H * 0.035 - H * 0.01, W, H * 0.008 + s * 2);
      // mountains from the spectrum (mirrored)
      ctx.fillStyle = "#06060c"; ctx.beginPath(); ctx.moveTo(0, hor);
      for (var i = 0; i <= N * 2; i++) { var b = i < N ? N - 1 - i : i - N; ctx.lineTo(i / (N * 2) * W, hor - S.spec[b] * H * 0.22 - H * 0.02); }
      ctx.lineTo(W, hor); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = S.acc(0.9); ctx.lineWidth = 2; ctx.stroke();
      // ground grid
      this.scroll = (this.scroll + dt * (0.4 + S.energy * 1.6)) % 1;
      ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = S.col(2, 0.85); ctx.lineWidth = 1.5;
      for (var k = 0; k < 14; k++) {
        var z = (k + this.scroll) / 14, y = hor + Math.pow(z, 2.2) * (H - hor);
        ctx.globalAlpha = 0.2 + z * 0.8; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      ctx.globalAlpha = 0.7;
      for (var v = -12; v <= 12; v++) { ctx.beginPath(); ctx.moveTo(cx + v * W * 0.04, hor); ctx.lineTo(cx + v * W * 0.28, H + 10); ctx.stroke(); }
      ctx.globalAlpha = 1;
      var hg = ctx.createLinearGradient(0, hor, 0, hor + H * 0.12); hg.addColorStop(0, S.acc(0.35 + S.beat * 0.4)); hg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = hg; ctx.fillRect(0, hor, W, H * 0.12);
    } });

  def({ id: "shock", name: "Shockwave", pack: "Show",
    init: function () { this.w = []; },
    draw: function (t, dt) {
      fade(0.4);
      if (S.onset) this.w.push({ r: 0, a: 1 });
      ctx.globalCompositeOperation = "lighter";
      var cx = W / 2, cy = H / 2, split = 3 + S.treble * 10 + S.beat * 8;
      for (var i = this.w.length - 1; i >= 0; i--) {
        var w = this.w[i]; w.r += dt * (350 + S.energy * 500) * (H / 720); w.a -= dt * 0.9;
        if (w.a <= 0) { this.w.splice(i, 1); continue; }
        var chans = [["255,40,40", -split], ["40,255,80", 0], ["60,120,255", split]];
        for (var c = 0; c < 3; c++) {
          ctx.strokeStyle = "rgba(" + chans[c][0] + "," + w.a * 0.9 + ")"; ctx.lineWidth = 3 + (1 - w.a) * 14;
          ctx.beginPath(); ctx.arc(cx + chans[c][1], cy, Math.max(1, w.r), 0, TAU); ctx.stroke();
        }
      }
      orb(cx, cy, Math.min(W, H) * (0.1 + S.bass * 0.25), S.accent, 0.6 + S.beat * 0.4);
      var pts = [];
      for (var k = 0; k <= 64; k++) { var a = k / 64 * TAU, r = Math.min(W, H) * (0.12 + S.spec[k % N] * 0.1 + S.bass * 0.1); pts.push([cx + Math.cos(a + t) * r, cy + Math.sin(a + t) * r]); }
      glowLine(pts, "rgba(255,255,255,.9)", 2, true);
    } });

  def({ id: "wire", name: "Wireframe", pack: "Show",
    init: function () {
      var p = (1 + Math.sqrt(5)) / 2, v = [];
      [[-1, p, 0], [1, p, 0], [-1, -p, 0], [1, -p, 0], [0, -1, p], [0, 1, p], [0, -1, -p], [0, 1, -p], [p, 0, -1], [p, 0, 1], [-p, 0, -1], [-p, 0, 1]].forEach(function (q) { v.push(q); });
      this.v = v; this.e = [];
      for (var i = 0; i < v.length; i++) for (var j = i + 1; j < v.length; j++) {
        var d = Math.hypot(v[i][0] - v[j][0], v[i][1] - v[j][1], v[i][2] - v[j][2]);
        if (Math.abs(d - 2) < 0.01) this.e.push([i, j]);
      }
    },
    draw: function (t, dt) {
      feedback(1.004, 0.0015, 0.88, 0);
      ctx.globalCompositeOperation = "lighter";
      var cx = W / 2, cy = H / 2, R = Math.min(W, H) * (0.19 + S.bass * 0.09 + S.beat * 0.03), f = 3.2;
      var ax = t * 0.5 + S.mid, ay = t * 0.7, az = Math.sin(t * 0.3) * 0.6;
      function proj(q, sc, jit) {
        var x = q[0] * sc, y = q[1] * sc, z = q[2] * sc;
        if (jit) { x += (Math.random() - 0.5) * jit; y += (Math.random() - 0.5) * jit; z += (Math.random() - 0.5) * jit; }
        var y1 = y * Math.cos(ax) - z * Math.sin(ax), z1 = y * Math.sin(ax) + z * Math.cos(ax);
        var x2 = x * Math.cos(ay) + z1 * Math.sin(ay), z2 = -x * Math.sin(ay) + z1 * Math.cos(ay);
        var x3 = x2 * Math.cos(az) - y1 * Math.sin(az), y3 = x2 * Math.sin(az) + y1 * Math.cos(az);
        var k = f / (f + z2);
        return [cx + x3 * k * R, cy + y3 * k * R, k];
      }
      for (var pass = 0; pass < 2; pass++) {
        var sc = pass ? 0.5 : 1, jit = S.treble * 0.35, P = this.v.map(function (q) { return proj(q, sc * (pass ? -1 : 1), jit); });
        for (var i = 0; i < this.e.length; i++) {
          var a = P[this.e[i][0]], b = P[this.e[i][1]], depth = (a[2] + b[2]) / 2;
          ctx.strokeStyle = S.col(i + (pass ? 5 : 0), clamp(depth * 0.9, 0.15, 1)); ctx.lineWidth = (pass ? 1 : 2) * depth;
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        }
        for (i = 0; i < P.length; i++) { ctx.fillStyle = "rgba(255,255,255," + clamp(P[i][2] - 0.4, 0, 0.9) + ")"; ctx.beginPath(); ctx.arc(P[i][0], P[i][1], 2.5 * P[i][2], 0, TAU); ctx.fill(); }
      }
    } });

  def({ id: "haze", name: "Volumetric Haze", pack: "Show",
    init: function () { this.b = []; for (var i = 0; i < 8; i++) this.b.push({ p: rnd(0, TAU), q: rnd(0, TAU), s: rnd(0.6, 1.3), c: i });
      this.dust = []; for (i = 0; i < 140; i++) this.dust.push({ x: Math.random(), y: Math.random(), s: rnd(0.3, 1) }); },
    draw: function (t, dt) {
      fade(0.25);
      ctx.globalCompositeOperation = "lighter";
      for (var i = 0; i < this.b.length; i++) {
        var b = this.b[i];
        var x = W * (0.5 + 0.38 * Math.sin(t * 0.21 * b.s + b.p)), y = H * (0.5 + 0.36 * Math.cos(t * 0.17 * b.s + b.q));
        var r = Math.min(W, H) * (0.22 + 0.16 * [S.bass, S.mid, S.treble][i % 3]) * b.s;
        orb(x, y, r, S.rgb(b.c + Math.floor(t * 0.1)), 0.22 + S.energy * 0.25);
      }
      for (i = 0; i < this.dust.length; i++) {
        var d = this.dust[i]; d.y -= dt * (0.02 + S.treble * 0.12) * d.s; d.x += Math.sin(t + i) * dt * 0.01;
        if (d.y < 0) { d.y = 1; d.x = Math.random(); }
        ctx.fillStyle = "rgba(255,255,255," + (0.25 + S.treble * 0.5) * d.s + ")";
        ctx.beginPath(); ctx.arc(d.x * W, d.y * H, d.s * 1.6, 0, TAU); ctx.fill();
      }
      vignette(0.6);
    } });

  def({ id: "type", name: "Kinetic Type", pack: "Show",
    init: function () { this.k = []; },
    draw: function (t, dt) {
      feedback(1.01 + S.bass * 0.02, 0, 0.82, 0);
      var np = nowPlaying || {}, title = (np.title || "NANOLEAF").toUpperCase(), artist = (np.artist || "").toUpperCase();
      var size = Math.min(H * 0.22, W * 1.6 / Math.max(6, title.length));
      ctx.font = "900 " + Math.round(size) + "px system-ui, Segoe UI, Roboto, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      var widths = [], total = 0;
      for (var i = 0; i < title.length; i++) { var w = ctx.measureText(title[i]).width; widths.push(w); total += w; }
      while (this.k.length < title.length) this.k.push({ o: 0, r: 0, s: 1 });
      var x = (W - total) / 2, cy = H / 2 - size * 0.1;
      ctx.globalCompositeOperation = "lighter";
      for (i = 0; i < title.length; i++) {
        var k = this.k[i];
        if (S.onset && Math.random() < 0.5) { k.o = rnd(-1, 1) * size * 0.35; k.r = rnd(-0.3, 0.3); k.s = rnd(1.05, 1.35); }
        k.o *= Math.exp(-dt * 5); k.r *= Math.exp(-dt * 5); k.s += (1 - k.s) * (1 - Math.exp(-dt * 6));
        ctx.save(); ctx.translate(x + widths[i] / 2, cy + k.o); ctx.rotate(k.r); ctx.scale(k.s, k.s);
        var split = S.beat * 6;
        ctx.fillStyle = "rgba(255,60,80," + (0.5 + S.beat * 0.5) + ")"; ctx.fillText(title[i], -widths[i] / 2 - split, 0);
        ctx.fillStyle = "rgba(60,160,255," + (0.5 + S.beat * 0.5) + ")"; ctx.fillText(title[i], -widths[i] / 2 + split, 0);
        ctx.fillStyle = S.col(i, 0.95); ctx.fillText(title[i], -widths[i] / 2, 0);
        ctx.restore(); x += widths[i];
      }
      if (artist) { ctx.font = "600 " + Math.round(size * 0.28) + "px system-ui, Segoe UI, Roboto, sans-serif"; ctx.textAlign = "center";
        ctx.fillStyle = "rgba(255,255,255," + (0.5 + S.energy * 0.5) + ")"; ctx.fillText(artist, W / 2, cy + size * 0.75); }
      ctx.globalCompositeOperation = "source-over";
      var bar = W * 0.3, by = H * 0.86; ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.fillRect(W / 2 - bar / 2, by, bar, 3);
      ctx.fillStyle = S.acc(1); ctx.fillRect(W / 2 - bar / 2, by, bar * S.phase, 3);
    } });

  def({ id: "albumart", name: "Album Refraction", pack: "Show",
    draw: function (t, dt) {
      fade(1);
      var img = artImg && artImg.complete && artImg.naturalWidth ? artImg : null;
      var cx = W / 2, cy = H / 2, zoom = 1.08 + S.bass * 0.18 + S.beat * 0.06, rot = Math.sin(t * 0.3) * 0.06 * (1 + S.mid);
      if (img) {
        var side = Math.max(W, H) * 0.55 * zoom;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot); ctx.globalAlpha = 0.9;
        for (var sx = -1; sx <= 1; sx += 2) for (var sy = -1; sy <= 1; sy += 2) {
          ctx.save(); ctx.scale(sx, sy); ctx.drawImage(img, 0, 0, side, side); ctx.restore();
        }
        ctx.restore();
        // glass strips displaced by the spectrum
        var strips = 24, sw = W / strips;
        fctx.globalCompositeOperation = "copy"; fctx.drawImage(cv, 0, 0);
        for (var i = 0; i < strips; i++) {
          var off = (S.spec[Math.floor(i / strips * N)] - 0.3) * H * 0.12 * (i % 2 ? 1 : -1);
          ctx.drawImage(fb, i * sw, 0, sw, H, i * sw, off, sw, H);
        }
        ctx.globalCompositeOperation = "multiply"; ctx.fillStyle = S.acc(0.25 + S.beat * 0.2); ctx.fillRect(0, 0, W, H);
      } else {
        ctx.globalCompositeOperation = "lighter";
        for (i = 0; i < 9; i++) { var a = i / 9 * TAU + t * 0.4, r = Math.min(W, H) * (0.25 + S.spec[i * 5] * 0.2);
          orb(cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.min(W, H) * 0.2, S.rgb(i), 0.5); }
      }
      vignette(0.65);
      ctx.globalCompositeOperation = "lighter";
      var pts = [];
      for (var k = 0; k <= N; k++) { var ang = k / N * TAU - Math.PI / 2, rr = Math.min(W, H) * (0.3 + S.spec[k % N] * 0.12); pts.push([cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr]); }
      glowLine(pts, "rgba(255,255,255,.55)", 1.5, true);
    } });

  // ---------------------------------------------------------------- screen / HUD
  var root, hud, picker, nameEl, idxEl, titleEl, artistEl, albumEl, hintEl, autoEl, artEl, artImg = null;
  var open = false, cur = null, curIdx = 0, hudTimer = null, pickerOpen = false, pickIdx = 0;
  var nowPlaying = null, trackKey = null, auto = true, raf = 0, lastT = 0, wakeLock = null, onBack = null;
  try { auto = localStorage.getItem("np.auto") !== "0"; curIdx = clamp(+localStorage.getItem("np.vis") || 0, 0, VIS.length - 1); } catch (e) {}

  function build() {
    root = document.createElement("div"); root.id = "npScreen";
    root.innerHTML =
      '<canvas id="npCanvas"></canvas>' +
      '<div id="npHud">' +
        '<div class="npTop">' +
          '<div class="npArt"><img alt=""/></div>' +
          '<div class="npMeta"><div class="npTitle"></div><div class="npArtist"></div><div class="npAlbum"></div></div>' +
          '<div class="npRight"><div class="npVis"><span class="npPack"></span><span class="npName"></span></div><div class="npIdx"></div></div>' +
        '</div>' +
        '<div class="npBottom">' +
          '<div class="npPicker"></div>' +
          '<div class="npBar"><span class="npAuto"></span><span class="npHint"></span><span class="npClose">✕</span></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    cv = $("#npCanvas", root); ctx = cv.getContext("2d");
    fb = document.createElement("canvas"); fctx = fb.getContext("2d");
    hud = $("#npHud", root); picker = $(".npPicker", root);
    nameEl = $(".npName", root); idxEl = $(".npIdx", root); titleEl = $(".npTitle", root); artistEl = $(".npArtist", root);
    albumEl = $(".npAlbum", root); hintEl = $(".npHint", root); autoEl = $(".npAuto", root); artEl = $(".npArt", root);
    artImg = $(".npArt img", root);
    VIS.forEach(function (v, i) {
      var c = document.createElement("div"); c.className = "npChip"; c.dataset.i = i; c.textContent = v.name;
      if (i === 0 || VIS[i - 1].pack !== v.pack) { var h = document.createElement("div"); h.className = "npChipHead"; h.textContent = v.pack; picker.appendChild(h); }
      c.addEventListener("click", function (e) { e.stopPropagation(); select(i); showHud(); });
      picker.appendChild(c);
    });
    $(".npClose", root).addEventListener("click", function (e) { e.stopPropagation(); close(); });
    autoEl.addEventListener("click", function (e) { e.stopPropagation(); setAuto(!auto); showHud(); });
    hintEl.textContent = TV ? "◀ ▶ visualizer · OK picker · Back exit" : "swipe = next · tap = picker";
    // touch: tap toggles the HUD/picker, horizontal swipe changes visualizer
    var tx = 0, ty = 0, moved = false;
    root.addEventListener("pointerdown", function (e) { tx = e.clientX; ty = e.clientY; moved = false; });
    root.addEventListener("pointermove", function (e) { if (Math.abs(e.clientX - tx) > 12 || Math.abs(e.clientY - ty) > 12) moved = true; });
    root.addEventListener("pointerup", function (e) {
      var dx = e.clientX - tx;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - ty) * 1.5) { step(dx < 0 ? 1 : -1); showHud(); }
      else if (!moved) { if (hud.classList.contains("show")) hideHud(); else showHud(true); }
    });
    addEventListener("resize", function () { if (open) sizeCanvas(); });
    addEventListener("popstate", function () { if (open) close(true); });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && open) requestWake(); });
    paintAuto();
  }
  function paintAuto() { autoEl.textContent = auto ? "auto ✓" : "auto"; autoEl.classList.toggle("on", auto); }
  function setAuto(v) { auto = v; paintAuto(); try { localStorage.setItem("np.auto", v ? "1" : "0"); } catch (e) {} }
  function select(i) {
    curIdx = ((i % VIS.length) + VIS.length) % VIS.length; cur = VIS[curIdx];
    if (cur.init) cur.init();
    fade(1);
    nameEl.textContent = cur.name; $(".npPack", root).textContent = cur.pack;
    idxEl.textContent = (curIdx + 1) + " / " + VIS.length;
    pickIdx = curIdx;
    Array.prototype.forEach.call(picker.querySelectorAll(".npChip"), function (c) {
      var on = +c.dataset.i === curIdx; c.classList.toggle("sel", on); c.classList.toggle("focus", +c.dataset.i === pickIdx && pickerOpen);
      if (on) c.scrollIntoView({ inline: "center", block: "nearest" });
    });
    try { localStorage.setItem("np.vis", String(curIdx)); } catch (e) {}
  }
  function step(d) { select(curIdx + d); }
  function showHud(withPicker) {
    hud.classList.add("show"); pickerOpen = !!withPicker; hud.classList.toggle("picker", pickerOpen);
    paintPick();
    clearTimeout(hudTimer); hudTimer = setTimeout(hideHud, pickerOpen ? 8000 : 3500);
  }
  function hideHud() { hud.classList.remove("show"); hud.classList.remove("picker"); pickerOpen = false; clearTimeout(hudTimer); }
  function paintPick() {
    Array.prototype.forEach.call(picker.querySelectorAll(".npChip"), function (c) {
      var f = pickerOpen && +c.dataset.i === pickIdx; c.classList.toggle("focus", f);
      if (f) c.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    });
  }
  function renderMeta() {
    var np = nowPlaying;
    titleEl.textContent = (np && np.title) || "Nothing playing";
    artistEl.textContent = (np && np.artist) || "";
    albumEl.textContent = (np && np.album) || "";
    var key = np && np.art ? np.art : null;
    if (key !== artEl.dataset.key) {
      artEl.dataset.key = key || "";
      if (key) { artImg.src = "/api/art?k=" + encodeURIComponent(key); artEl.classList.add("has"); }
      else { artImg.removeAttribute("src"); artEl.classList.remove("has"); }
    }
  }
  function requestWake() {
    if (!navigator.wakeLock || wakeLock) return;
    navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; l.addEventListener("release", function () { wakeLock = null; }); }).catch(function () {});
  }
  function loop(ts) {
    if (!open) return;
    var now = ts || performance.now(), dt = Math.min(0.05, (now - lastT) / 1000 || 0.016); lastT = now;
    S.tick(dt, now);
    try { cur.draw(now / 1000, dt); } catch (e) { fade(1); if (!cur._err) { cur._err = true; console.error("np: " + cur.id + " threw", e); } }
    S.onset = false;
    raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- public API
  function openScreen(fromHistory) {
    if (!root) build();
    if (open) return;
    open = true; root.classList.add("open"); document.body.classList.add("npOpen");
    sizeCanvas(); select(curIdx); renderMeta(); showHud();
    lastT = performance.now(); raf = requestAnimationFrame(loop);
    requestWake();
    if (!fromHistory) { try { history.pushState({ np: 1 }, ""); } catch (e) {} }
    if (!TV && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
    if (onBack) onBack(true);
  }
  function close(fromHistory) {
    if (!open) return;
    open = false; root.classList.remove("open"); document.body.classList.remove("npOpen");
    cancelAnimationFrame(raf); hideHud();
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
    if (!fromHistory && history.state && history.state.np) { try { history.back(); } catch (e) {} }
    if (!TV && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    if (onBack) onBack(false);
  }
  // TV remote while the screen is open; returns true when consumed
  function key(name) {
    if (!open) return false;
    if (name === "back") { if (hud.classList.contains("show")) hideHud(); else close(); return true; }
    if (name === "ok") {
      if (pickerOpen) { select(pickIdx); hideHud(); } else showHud(true);
      return true;
    }
    if (name === "left" || name === "right") {
      var d = name === "right" ? 1 : -1;
      if (pickerOpen) { pickIdx = ((pickIdx + d) % VIS.length + VIS.length) % VIS.length; select(pickIdx); showHud(true); }
      else { step(d); showHud(); }
      return true;
    }
    if (name === "up") { showHud(true); return true; }
    if (name === "down") { if (hud.classList.contains("show")) hideHud(); else setAuto(!auto), showHud(); return true; }
    return false; // "next" falls through to the scene shuffle
  }
  return {
    open: openScreen, close: close, isOpen: function () { return open; }, key: key,
    list: function () { return VIS.map(function (v) { return { id: v.id, name: v.name, pack: v.pack }; }); },
    feed: function (colors, features) { S.frame(colors, features, performance.now()); },
    setLayout: function (layout) { layoutRef = layout || []; },
    setState: function (state) {
      nowPlaying = state && state.nowPlaying || null;
      var k = nowPlaying ? (nowPlaying.title || "") + "|" + (nowPlaying.artist || "") : "";
      if (trackKey !== null && k && k !== trackKey && auto && open) { step(1); showHud(); }
      if (k) trackKey = k;
      if (root) renderMeta();
    },
    onBackCapture: function (fn) { onBack = fn; },
    _debug: function () { return { vis: VIS, signal: S, cur: cur, W: W, H: H }; },
  };
})();
