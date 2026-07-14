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
  if (cfg.roon.enabled) {
    const { RoonExtension } = require('./roon/extension');
    const { TrackWatcher } = require('./roon/trackwatcher');
    const watcher = new TrackWatcher({ zone: cfg.roon.zone });
    watcher.on('track', () => renderer && renderer.onTrackChange());
    watcher.on('zones', ({ matched, all }) => {
      if (cfg.roon.zone && matched.length === 0) {
        setStatus(`Zone "${cfg.roon.zone}" not found — Roon zones: ${all.join(', ') || '(none)'}`, true);
      }
    });
    roon = new RoonExtension({ onZoneEvent: (response, msg) => watcher.handleEvent(response, msg) });
    roon.start();
  }
  const setStatus = (msg, isErr) => {
    log.info(`status: ${msg}`);
    if (roon) roon.setStatus(msg, isErr);
  };

  // Nanoleaf: validate token, fetch layout, power on, enter streaming mode.
  const client = new NanoleafClient(cfg.nanoleaf);
  let layout;
  try {
    layout = await client.getLayout();
    await client.setPower(true);
    await client.enableExtControl();
  } catch (err) {
    if (err instanceof NanoleafHttpError && err.status === 401) {
      console.error('Nanoleaf rejected the auth token (401) — re-pair with `npm run pair`.');
      process.exit(EXIT_REPAIR_NEEDED);
    }
    throw err; // transient (controller offline) → exit 1, service manager retries
  }
  const panels = prepareLayout(layout.positionData);
  log.info(`nanoleaf ready: ${panels.length} panels, streaming at ${cfg.nanoleaf.fps} fps`);

  const streamer = new Streamer({ host: cfg.nanoleaf.host, fps: cfg.nanoleaf.fps });
  const source = createSource(cfg.audio);
  renderer = new VisualRenderer({
    source,
    streamer,
    layout: panels,
    config: cfg.visuals,
    fps: cfg.nanoleaf.fps,
    onStatus: setStatus,
  });

  source.on('error', (err) => setStatus(`Audio source error: ${err.message}`, true));
  source.on('format', (fmt) => log.info(`audio: ${fmt.sampleRate} Hz ${fmt.channels}ch`));

  renderer.start();
  source.start();

  const shutdown = () => {
    log.info('shutting down');
    source.stop();
    renderer.stop(); // sends the blackout frame
    setTimeout(() => {
      streamer.close();
      process.exit(0);
    }, 100); // give the blackout datagram a moment to leave
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
