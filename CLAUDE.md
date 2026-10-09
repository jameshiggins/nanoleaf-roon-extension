# Nanoleaf Roon Extension

Node service on this PC (the former Roon Core machine) that turns Roon playback into music-reactive
visuals on 21 Nanoleaf Aurora panels (host `192.168.50.180`), streamed at 10 fps (`visuals.fps`, capped
at 20 — the Aurora/Light Panels controller is rated for 10 Hz) over the external control (extControl v2)
UDP API.

Pipeline: VB-Cable → ffmpeg dshow capture → DSP feature extraction (`src/dsp/features.js`, no FFT) →
visualizer engines (`src/visuals/visualizers.js`) × procedural palettes (`src/visuals/palettes.js`) →
UDP frames. A shuffle bag rotates visualizer+palette on every Roon track change. Companion web app on
`http://<host>:8787` (its Android TV / Shield WebView wrapper is a separate repo in the sibling folder
`..\nanoleaf-roon-android\`). Deeper docs: `docs/ARCHITECTURE.md`, `docs/VISUALS.md`, `docs/COMPANION-APP.md`.

## Commands

```
npm test              # node --test (full suite must pass before merging)
npm start             # run in foreground (dev only — see service notes below)
npm run visuals       # list the visualizer/palette catalogue
npm run pair          # pair with the Nanoleaf controller
npm run analyze       # tools/analyze.js track analyzer
```

## Deployment (production runs as a Windows service)

- Ops files live in the sibling folder `..\nanoleaf-roon-service\` (launchers, logs, bridge scripts).
- The companion app finds this PC by UDP broadcast (`src/control/beacon.js`, `control.discoveryPort`
  8788) — the PC's LAN IP is DHCP and has already moved (.51 → .212), so never bake it into the
  Android app again. Windows Firewall needs inbound TCP 8787 + UDP 8788 allowed for `node.exe` on
  the Private profile; the only node.exe rules found on 2026-10-07 were *Block* rules for Public.
- Extension: Task Scheduler task **"Nanoleaf Roon Extension"** (runs as SYSTEM, boot + logon
  triggers) → `run.cmd` → `node src\index.js`, logging to `service.log` there. Restart with
  `schtasks /End` then `schtasks /Run /TN "Nanoleaf Roon Extension"` (worked from a non-elevated
  shell on 2026-09-19). `/End` is a hard kill: mid-song it skips the graceful panel release, so the
  next release falls back to `nanoleaf.idleEffect` — prefer restarting while Roon is idle. (It was an NSSM service `NanoleafRoon` once; no longer.)
- Never run `node src\index.js` manually while the task is up — a second instance
  double-registers the extension in Roon. `run.cmd` kills strays before launching.
- Roon side: extension `com.jameshiggins.nanoleaf-roon`, paired to the ROCK core at
  `192.168.50.118`. Audio reaches this PC via the "CABLE Input" WASAPI zone grouped with the Hegel.
- That zone exists only while **Roon Bridge** on this PC is healthy: NSSM service `RoonBridge`
  (LocalSystem) → `RAATServer.exe`, logging to `roonbridge-service.log`. Install / upgrade / repair
  it ONLY with `setup-roonbridge-service.ps1` (elevated; `-Install` to upgrade) — it stops the
  Bridge before the installer runs and verifies every file afterwards.
- **Shield auto-launch** (`config.json` → `shield`, code in `src/shield/launcher.js`): when the
  `shield.zone` room ("Hegel") goes quiet → playing, the service opens the separate **Roon Shield**
  app (`..\roon-shield\`, `com.roonshield`) on Now Playing over adb, waking the Shield if needed.
  The user's rules, locked by `test/shieldlauncher.test.js`: first play only (never per track, never
  on our own reconnect snapshot), not if the app is already on screen, at most once per 30 min.
  The service runs as SYSTEM, so `shield.adbKey` lends adb the user's already-authorized key.
- Config: `config.json` (see `config.example.json`). `visuals.floor` is the coverage dial
  (all-panels-lit), `visuals.gain` is input level — they are not interchangeable.

## Hard rules (learned the hard way — don't regress)

1. **Panel ownership contract**: the extension *borrows* the panels. Acquire on Roon `playing`
   (snapshot selected effect + power state, then stream); release on `idle` (debounced) restoring
   the saved effect *before* restoring power; send **no frames while released**. Never stream
   always-on. Covered by `test/ownership.test.js`.
2. **All 21 panels lit**: every visualizer must light the whole wall under load (reactive `wash(f)`
   floor). Locked by `test/visualizers.test.js`.
3. **Startup order**: `roon.start()` must be called AFTER `renderer.start()` in `src/index.js`, or a
   restart mid-playback drops the first `playing` event and the panels never acquire.
5. **Frame rate is capped at 20 (`FPS_MAX` in `src/config.js`) — don't raise it.** The NL22
   controller is rated for 10 Hz with 100 ms fades (`visuals.transition`); driving it faster made
   the motion elastic (slow → catch-up → choke). Node's timers on Windows tick at 15.6 ms, so the
   renderer uses a drift-corrected timer and reports the real rate in `getState().fpsReal` and a
   once-a-minute `frame timer:` log line — trust those, not the slider.
4. **Do NOT reinstall the heartbeat watchdog** (`scripts/watchdog.ps1` / scheduled task
   `NanoleafWatchdog`) unless the running code actually writes `logs/heartbeat` (`src/health.js`).
   On code without the heartbeat it restart-looped the service 1726 times.

## Diagnostic traps

- **RDP hides audio devices.** From an RDP session, ffmpeg/device listings show only "Remote Audio" —
  that is NOT what the LocalSystem service sees. Never conclude VB-Cable is missing from an RDP
  shell; check `logs/service.log` for the real capture state.
- Panels dark but the controller's `GET /effects/select` returns `*Dynamic*` → something is actively
  streaming to them (extControl auto-reverts ~10 s after UDP stops). Liveness probes: companion
  `GET :8787/api/state` (`acquired`) + controller `GET /effects/select` (`*Dynamic*` = streaming).
- Service exit code 3 = bad Nanoleaf auth token.
- **Wall animating but not reacting / CABLE zone gone from Roon** → Roon Bridge, not this code.
  Run `..\nanoleaf-roon-service\check-roonbridge.ps1` (passive, exit code = FAIL count). The
  `RoonBridge` service showing "Running" proves nothing: on 2026-09-19 a stale `RAATServer.exe`
  (left by running the installer over a live Bridge) crash-looped for hours underneath it.
  And it hides: the Bridge borrows any RAATServer already on `127.0.0.1:9004`, so everything
  works while the Roon desktop app is open and breaks on the next reboot.
- `src/roon/feedmonitor.js` raises this itself after 45 s of Roon-playing-but-silent: WARN in
  `service.log`, pinned to the extension's status line in Roon, "⚠ no audio from Roon" badge in
  the companion app. Set `roon.feedOutput` to the cable output's name in Roon to also warn the
  moment Roon loses that output (names are listed in the playing-but-silent warning).
