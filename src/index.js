#!/usr/bin/env node
'use strict';

const config = require('./config');
const { NanoleafClient, NanoleafHttpError } = require('./nanoleaf/client');
const { Streamer } = require('./nanoleaf/streamer');
const { discover } = require('./nanoleaf/discovery');
const { createSource } = require('./audio/sources');
const { prepareLayout } = require('./visuals/layout');
const { VisualRenderer } = require('./visuals/renderer');
const { describeVisuals } = require('./visuals/visualizers');
const { generatePalettes } = require('./visuals/palettes');
const log = require('./log')('main');

const EXIT_CONFIG = 2;
const EXIT_REPAIR_NEEDED = 3; // Nanoleaf rejected the token; a restart loop won't help

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pair' || a === '--discover' || a === '--help' || a === '--list-visuals') args[a.slice(2)] = true;
    else if (a === '--host' || a === '--config') args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function runDiscover() {
  log.info('searching for Nanoleaf controllers (SSDP, ~4 s)…');
  const devices = await discover();
  if (!devices.length) {
    console.log('No Nanoleaf controllers found. Are you on the same subnet? (mDNS/SSDP does not cross VLANs by default.)');
    return;
  }
  for (const d of devices) {
    console.log(`${d.host}:${d.port}  ${d.name || '(unnamed)'}  [${d.st}]`);
  }
  console.log('\nNext: npm run pair -- --host <ip>');
}

async function runPair(args, configFile) {
  const cfg = config.load(configFile);
  const host = args.host || cfg.nanoleaf.host;
  if (!host) {
    console.error('Usage: npm run pair -- --host <controller-ip>');
    process.exit(EXIT_CONFIG);
  }
  const client = new NanoleafClient({ host, port: cfg.nanoleaf.port });
  console.log(`Pairing with ${host} — hold the controller's power button 5-7 s first.`);
  try {
    const token = await client.createToken();
    cfg.nanoleaf.host = host;
    cfg.nanoleaf.token = token;
    config.save(configFile, cfg);
    console.log(`Paired. Token saved to ${configFile || 'config.json'}.`);
  } catch (err) {
    if (err instanceof NanoleafHttpError && err.status === 403) {
      console.error('Pairing rejected (403): the controller was not in pairing mode. Hold the power button until the LED flashes, then retry within 30 s.');
    } else {
      console.error(`Pairing failed: ${err.message}`);
    }
    process.exit(1);
  }
}

function listVisuals() {
  const visuals = describeVisuals();
  const palettes = generatePalettes(36);
  console.log(`${visuals.length} visualizers × ${palettes.length} palettes = ${visuals.length * palettes.length} combinations\n`);
  console.log('Visualizers:');
  for (const v of visuals) console.log(`  ${v.name.padEnd(16)} ${v.description}`);
  console.log('\nSample palettes:');
  for (const p of palettes.slice(0, 12)) console.log(`  ${p.name}`);
  console.log(`  … and ${palettes.length - 12} more`);
}

async function runService(configFile) {
  let cfg;
  try {
    cfg = config.load(configFile);
  } catch (err) {
    console.error(err.message);
    process.exit(EXIT_CONFIG);
  }
  if (!cfg.nanoleaf.host || !cfg.nanoleaf.token) {
    console.error('nanoleaf.host / nanoleaf.token missing — run `npm run discover` then `npm run pair -- --host <ip>`.');
    process.exit(EXIT_CONFIG);
  }

  // Roon: status line + track-change rotation. The audio path works without it,
  // so a Roon outage never darkens the panels — rotation just pauses.
  let roon = null;
  let renderer = null;
  let latestArt = null; // { key, body, type } — current track's cover for the companion app
  if (cfg.roon.enabled) {
    const { RoonExtension } = require('./roon/extension');
    const { TrackWatcher } = require('./roon/trackwatcher');
    const watcher = new TrackWatcher({ zone: cfg.roon.zone });
    // Album colors: the palette follows the cover art. A fetch is async while
    // track changes are synchronous, so tag each fetch with the track key and
    // only apply it if that track is still current — a rapid skip can't let a
    // stale cover clobber the new one. Any failure falls back to the pinned
    // palette (never dark), matching the "Roon outage never darkens" ethos.
    let currentTrackKey = null;
    const { fetchAlbumPalette } = require('./visuals/albumcolors');
    const { resolvePalette } = require('./visuals/palettes');
    // Grayscale cover (no usable color): flip a coin between the Mono grayscale palette
    // and the real Vintage Modern palette, rather than always the same fallback.
    const grayscaleFallback = () =>
      resolvePalette(Math.random() < 0.5 ? 'Mono' : 'Vintage Modern', cfg.visuals.palettes);
    watcher.on('track', (track) => {
      if (!renderer) return;
      renderer.setNowPlaying({ title: track.title, artist: track.artist, album: track.album, zoneName: track.zoneName, art: track.imageKey || null });
      renderer.onTrackChange();
      currentTrackKey = track.key;
      // Companion-app cover art: cache a phone-sized copy of the current cover so the
      // control server can serve GET /api/art without a Roon round-trip per client.
      if (track.imageKey) {
        roon.getImage(track.imageKey, { width: 600, height: 600 })
          .then((img) => {
            if (track.key !== currentTrackKey) return; // a newer track won the race
            latestArt = { key: track.imageKey, body: img.body, type: img.contentType || 'image/jpeg' };
          })
          .catch(() => { if (track.key === currentTrackKey) latestArt = null; });
      } else {
        latestArt = null;
      }
      // Checked per track (not cached) so the albumColors lever can be toggled live.
      if (!cfg.visuals.albumColors) { renderer.clearLivePalette(); return; }
      if (!track.imageKey) { renderer.clearLivePalette(); return; } // no art → pinned palette
      // Sometimes derive the palette from the cover's most-present colors instead of the
      // usual vibrant spread (visuals.albumPredominantChance).
      const predominant = Math.random() < cfg.visuals.albumPredominantChance;
      fetchAlbumPalette(roon, track.imageKey, { ...cfg.visuals, predominant })
        .then((palette) => {
          if (track.key !== currentTrackKey) return; // a newer track won the race
          if (palette) renderer.setLivePalette(palette);
          else renderer.setLivePalette(grayscaleFallback()); // grayscale cover → 50/50 Mono/Vintage Modern
        })
        .catch((err) => {
          if (track.key === currentTrackKey) renderer.clearLivePalette();
          log.debug(`album colors unavailable: ${err.message}`);
        });
    });
    watcher.on('playing', () => renderer && renderer.acquire().catch((err) => log.error(err.message)));
    watcher.on('idle', () => {
      if (!renderer) return;
      renderer.setNowPlaying(null);
      renderer.release();
    });
    watcher.on('zones', ({ matched, all }) => {
      if (cfg.roon.zone && matched.length === 0) {
        setStatus(`Zone "${cfg.roon.zone}" not found — Roon zones: ${all.join(', ') || '(none)'}`, true);
      }
    });
    // Feed health: Roon playing into a dead cable looks exactly like a quiet song on
    // the wall, so say it out loud — service log, Roon's extension status, companion app.
    const { FeedMonitor } = require('./roon/feedmonitor');
    const feed = new FeedMonitor({ output: cfg.roon.feedOutput });
    let roonPlaying = false;
    watcher.on('playing', () => { roonPlaying = true; });
    watcher.on('idle', () => { roonPlaying = false; });
    feed.on('warning', (warning) => {
      feedWarning = warning;
      if (warning) log.warn(`${warning} Diagnose with nanoleaf-roon-service\\check-roonbridge.ps1`);
      else log.info('audio feed from Roon is back');
      if (renderer) renderer.setWarning(warning);
      pushStatus();
    });
    setInterval(() => {
      if (!renderer) return;
      feed.sample(roonPlaying, renderer.lastFeatures.energy > cfg.visuals.silenceFloor, Date.now());
    }, 5000).unref();
    // Shield auto-launch: its own watcher because it follows one room (shield.zone), not
    // whatever roon.zone the wall follows. A 'playing' out of a Subscribed snapshot is us
    // (re)connecting mid-song, not someone pressing play — never launch on that.
    let shieldWatcher = null;
    let inSnapshot = false;
    if (cfg.shield.enabled) {
      const { ShieldLauncher } = require('./shield/launcher');
      const launcher = new ShieldLauncher({
        adb: cfg.shield.adb,
        adbKey: cfg.shield.adbKey,
        target: cfg.shield.target,
        component: cfg.shield.component,
        cooldownMs: cfg.shield.cooldownMinutes * 60 * 1000,
      });
      shieldWatcher = new TrackWatcher({ zone: cfg.shield.zone });
      shieldWatcher.on('playing', () => { if (!inSnapshot) launcher.onFirstPlay(); });
      log.info(`shield auto-launch on: ${cfg.shield.target}, zone "${cfg.shield.zone || '(any)'}"`);
    }
    roon = new RoonExtension({
      onZoneEvent: (response, msg) => {
        watcher.handleEvent(response, msg);
        if (shieldWatcher) {
          inSnapshot = response === 'Subscribed';
          try { shieldWatcher.handleEvent(response, msg); } finally { inSnapshot = false; }
        }
      },
      onOutputEvent: (response, msg) => feed.handleOutputs(response, msg),
      wantImages: true, // always request the image service so albumColors can toggle live
    });
    // roon.start() is deferred until after the renderer exists (below). Roon can be
    // playing the instant we subscribe, and that first 'playing' must reach a live
    // renderer — starting here would fire it into a null renderer and never acquire.
  }
  // A feed warning stays pinned to Roon's status line; otherwise the next track
  // change ("▶ visual · palette") would wipe it within minutes.
  let feedWarning = null;
  let lastStatus = { msg: '', isErr: false };
  const pushStatus = () => {
    if (!roon) return;
    if (feedWarning) roon.setStatus(`${feedWarning} | ${lastStatus.msg}`, true);
    else roon.setStatus(lastStatus.msg, lastStatus.isErr);
  };
  const setStatus = (msg, isErr) => {
    log.info(`status: ${msg}`);
    lastStatus = { msg, isErr };
    pushStatus();
  };

  // Nanoleaf: validate the token and fetch the layout. We deliberately do NOT power on
  // or enter extControl here — the renderer takes the panels when Roon starts playing
  // and gives them back when it stops.
  const client = new NanoleafClient(cfg.nanoleaf);
  // Retry the first contact forever with capped backoff: at boot this process can
  // start before the network stack is up (ENETUNREACH), and the scheduled task
  // only relaunches us once — exiting here once left the wall dead for three days.
  // Only a 401 is terminal: a bad token can never fix itself, retrying would
  // hammer the controller and hide the need to re-pair.
  let layout;
  for (let delay = 5000; !layout; delay = Math.min(delay * 2, 60000)) {
    try {
      layout = await client.getLayout();
    } catch (err) {
      if (err instanceof NanoleafHttpError && err.status === 401) {
        console.error('Nanoleaf rejected the auth token (401) — re-pair with `npm run pair`.');
        process.exit(EXIT_REPAIR_NEEDED);
      }
      setStatus(`Nanoleaf unreachable (${err.message}) — retrying in ${delay / 1000}s`, true);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // The layout must be rotated by MINUS globalOrientation to match the physical
  // wall (verified against the wall itself; the API's angle is the app's view
  // rotation, not a transform to apply).
  const orientation = -(await client.getGlobalOrientation());
  const panels = prepareLayout(layout.positionData, orientation);
  if (orientation) log.info(`layout rotated ${orientation}° to match the wall (globalOrientation)`);
  const fps = cfg.visuals.fps ?? cfg.nanoleaf.fps; // visuals.fps is the live lever; nanoleaf.fps the legacy default
  log.info(`nanoleaf ready: ${panels.length} panels, ${fps} fps when playing`);

  const streamer = new Streamer({ host: cfg.nanoleaf.host, fps });
  const source = createSource(cfg.audio);
  renderer = new VisualRenderer({
    source,
    streamer,
    client,
    layout: panels,
    rawLayout: layout.positionData,
    baseOrientation: orientation,
    panelSide: layout.sideLength,
    config: cfg.visuals,
    fps,
    idleEffect: cfg.nanoleaf.idleEffect,
    onStatus: setStatus,
  });

  source.on('error', (err) => setStatus(`Audio source error: ${err.message}`, true));
  source.on('format', (fmt) => log.info(`audio: ${fmt.sampleRate} Hz ${fmt.channels}ch`));

  renderer.start();
  source.start();

  // Start Roon only now that the renderer is live, so the first 'playing' from an
  // already-playing zone triggers acquire (see the deferral note above).
  if (roon) roon.start();

  // Without Roon there is no play/idle signal, so hold the panels for the whole run.
  if (!cfg.roon.enabled) {
    log.info('roon disabled — acquiring panels for the lifetime of the process');
    await renderer.acquire();
  }

  // Companion-app control + telemetry server (open it on your Shield).
  let control = null;
  if (cfg.control.enabled) {
    const { ControlServer } = require('./control/server');
    control = new ControlServer({
      renderer,
      port: cfg.control.port,
      host: cfg.control.host,
      frameHz: cfg.control.frameHz,
      getArt: () => latestArt,
      // Persist live changes so they survive a restart. Best-effort; the server swallows errors.
      onChange: () => config.save(configFile, cfg),
    });
    try {
      await control.start();
      setStatus(`Companion app: ${control.urls.join('  ')}`);
    } catch (err) {
      log.warn(`companion app server failed to start: ${err.message}`);
      control = null;
    }
  }

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down');
    source.stop();
    if (control) control.stop();
    // Hand the panels back before exiting, rather than leaving them stuck in extControl.
    try { await renderer.releaseNow(); } catch (err) { log.error(`shutdown: ${err.message}`); }
    renderer.stop(); // sends the blackout frame
    setTimeout(() => {
      streamer.close();
      process.exit(code);
    }, 100); // give the blackout datagram a moment to leave
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  // A crash must still restore the panels rather than leave them frozen in extControl;
  // route through the same shutdown, then exit non-zero so the service manager restarts.
  process.on('uncaughtException', (err) => { log.error(`uncaughtException: ${(err && err.stack) || err}`); shutdown(1); });
  process.on('unhandledRejection', (err) => { log.error(`unhandledRejection: ${(err && err.stack) || err}`); shutdown(1); });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: nanoleaf-roon [--config <file>] [--discover] [--pair --host <ip>] [--list-visuals]');
    return;
  }
  if (args.discover) return runDiscover();
  if (args.pair) return runPair(args, args.config);
  if (args['list-visuals']) return listVisuals();
  return runService(args.config);
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
