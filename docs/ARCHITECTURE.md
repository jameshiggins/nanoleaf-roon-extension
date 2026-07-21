# Architecture

## Data flow

```
              ┌───────────────────────────── nanoleaf-roon-extension ──────────────────────────────┐
              │                                                                                      │
 Roon Core ───┤ AudioSource        PCM     FeatureExtractor      VisualRenderer          Streamer    │
   │          │ ┌──────────────┐  chunks  ┌────────────────┐   ┌──────────────────┐  ┌─────────────┐ │   UDP 60222
   ├ slimproto┼▶│ SlimprotoSrc │───────▶│ bands / onset /  │─▶│ visualizer.render │─▶│ extControl  │─┼─▶ Nanoleaf
   ├ capture ─┼▶│ CaptureSource│        │ level features   │   │ (28) × palette    │  │ v2 encoder  │ │   controller
   │ (ffmpeg) │ │ StdinSource  │        └────────────────┘   │ + silence gate    │  │ + UDP pacer │ │
   │          │ └──────────────┘                             └──────────────────┘  └─────────────┘ │
   │          │                                                        ▲                            │
   ├ transport┼──▶ TrackWatcher ── 'track' ──▶ rotate visualizer+palette                            │
   └ extension┼──▶ RoonExtension (pairing, status)   NanoleafClient ──┘ layout, token, extControl   │
      API      │                                     (REST :16021)                                   │
              └────────────────────────────────────────────────────────────────────────────────────┘
```

The Roon extension connection (pairing + status + track-change rotation) is **optional to the
audio path**: the DSP and visualizer keep running from the stream even if Roon drops — only
rotation pauses.

**Panel ownership.** The renderer holds the panels *only while Roon is playing*. On the first
`playing` event it `acquire()`s — saving the panels' current effect and power, powering on, and
entering extControl — then streams; on `idle` it `release()`s after a debounce, restoring exactly
the effect (and power) it saved. While acquired it re-asserts extControl every few seconds so the
visuals reclaim the panels if anything else (the Nanoleaf app, a schedule, HomeKit) takes them.
With `roon.enabled: false` there is no play/idle signal, so it acquires once and holds the panels
for the process lifetime.

## Modules

| Path | Responsibility | Depends on |
| --- | --- | --- |
| `src/index.js` | CLI (`--pair`, `--discover`), wiring, lifecycle, shutdown | everything below |
| `src/config.js` | Load `config.json`, merge defaults, validate; pure | — |
| `src/log.js` | Leveled stderr logger | — |
| `src/roon/extension.js` | Roon pairing + status via `node-roon-api` (lazy-required so tests and non-Roon use need no install) | node-roon-api |
| `src/audio/sources.js` | `AudioSource` factory: `slimproto` \| `capture` \| `stdin`; all emit `pcm` (Buffer, s16le), `start`, `stop`, `error` | slimproto.js |
| `src/audio/slimproto.js` | Minimal Squeezebox/SlimProto client: codecs (`encodeHelo`, `encodeStat`, `parseServerFrames`, `parseStrm`) + `SlimprotoClient` (register, fetch HTTP audio stream, heartbeats, reconnect) | net |
| `src/audio/pcm.js` | Pure PCM math: interleaved s16le → peak/RMS, `EnvelopeFollower` (one-pole attack/release) | — |
| `src/dsp/features.js` | `FeatureExtractor`: PCM → bass/mid/treble bands (one-pole split, no FFT), level/stereo envelopes, `OnsetDetector` (bass-flux beat flag) | pcm.js |
| `src/visuals/palettes.js` | `hsv`/`mix`/`dim` helpers + `generatePalettes()` (golden-angle hues × harmony schemes) | — |
| `src/visuals/visualizers.js` | 11 parametric engines × variant grid → 28 named visualizers (the pulse family was cut); `createVisual`, `describeVisuals` | palettes |
| `src/visuals/layout.js` | `prepareLayout()`: panel positions → normalized nx/ny, left→right, drop pseudo-panel | — |
| `src/visuals/shuffle.js` | `ShuffleBag` (no-repeat rotation) + `filterNames` (include/exclude) | — |
| `src/visuals/renderer.js` | `VisualRenderer`: features → active visualizer → streamer at fps; silence gate; rotation on track change/timer; panel ownership (`acquire`/`release`/`releaseNow` via a single-flight `_reconcile`, debounced release, extControl keepalive) | features, visualizers, palettes, shuffle |
| `src/nanoleaf/client.js` | REST: `createToken`, `getInfo`, `getLayout`, `enableExtControl`, `setPower`, `getPower`, `getSelectedEffect`, `selectEffect`, `identify` | http |
| `src/nanoleaf/streamer.js` | `encodeFrameV2()` + `Streamer` (UDP socket, newest-frame-wins pacing) | dgram |
| `src/nanoleaf/discovery.js` | SSDP M-SEARCH + response parsing | dgram |
| `src/roon/trackwatcher.js` | Pure event logic: raw zone events → `track`/`playing`/`idle`/`zones` (no Roon dependency) | — |
| `src/control/server.js` | Companion-app HTTP + SSE server: serves the web app, `GET /api/state`, `/api/catalogue`, `POST /api/command`, live `GET /events`; `applyCommand` pure command applier | http (built-in) |
| `src/control/webapp/index.html` | Self-contained TV web app: canvas panel-mirror, now-playing, D-pad controls over the API | — |
| `android/` | Android TV WebView wrapper (Java + Gradle) that loads the web app; ships as source (no SDK here to build) | Android SDK |

## Design rules

1. **Wire formats are pure functions.** Every encode/parse is a standalone function over
   Buffers with unit tests pinned to byte layouts. Sockets are thin shells around them.
2. **Visualizers are pure, swappable renderers.** Each takes `(layout, palette, opts, rng)` and
   maps a feature snapshot to panel colors — no I/O, no state beyond its own animation. The
   registry is generated (engines × variants), so adding a look is one small class or opts row.
3. **Sources are interchangeable.** Everything downstream sees `pcm` events of interleaved
   s16le at a declared sample rate/channel count. Adding a source means implementing one EventEmitter.
4. **Fail toward darkness, recover loudly.** The silence gate fades to black when the feed goes
   quiet; on stream loss the streamer sends one black frame; sources reconnect with capped
   backoff; the Roon status line reflects the current visualizer/palette and any errors.
5. **Newest frame wins.** The streamer never queues: if rendering outpaces the fps budget, stale
   frames are dropped. Latency is the product's point; a backlog is worse than a skip.

## Error handling & lifecycle

- **Acquire / release.** `acquire()` (on Roon `playing`) saves the panels' effect + power and
  enters extControl; `release()` (on `idle`) restores them after a `releaseDebounceMs` (default
  5 s) debounce, so a brief pause or track skip doesn't flap the panels. Both only set the
  *desired* state and kick a single-flight `_reconcile()` that drives the realized state toward it,
  so an `idle` arriving mid-acquire (or an acquire during a release) can't corrupt panel state. A
  keepalive re-asserts extControl every `extControlKeepaliveMs` (default 4 s) so the visuals
  reclaim the panels if anything else grabs them.
- `SIGINT`/`SIGTERM` → stop source → `releaseNow()` (restore the saved scene, skipping the
  debounce) → black frame → close sockets → exit 0 (clean for systemd/NSSM restarts).
- `uncaughtException` / `unhandledRejection` → route through the same shutdown (restore the panels
  rather than leave them frozen in extControl), then exit **1** so the service manager restarts.
- Startup config problems (missing/invalid `config.json`, absent host/token) → exit **2**
  (`EXIT_CONFIG`).
- Nanoleaf HTTP 401 → logged as "re-pair needed", exit **3** (`EXIT_REPAIR_NEEDED`) so service
  managers don't hot-loop a dead credential.
- extControl streams idle out on the controller side after ~10 s without datagrams; the
  streamer sends keepalive frames (last frame re-sent at 1 Hz) during silence.
