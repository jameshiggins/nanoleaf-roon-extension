# Architecture

## Data flow

```
              ┌───────────────────────────── nanoleaf-roon-extension ──────────────────────────────┐
              │                                                                                      │
 Roon Core ───┤ AudioSource        PCM     FeatureExtractor      VisualRenderer          Streamer    │
   │          │ ┌──────────────┐  chunks  ┌────────────────┐   ┌──────────────────┐  ┌─────────────┐ │   UDP 60222
   ├ slimproto┼▶│ SlimprotoSrc │───────▶│ bands / onset /  │─▶│ visualizer.render │─▶│ extControl  │─┼─▶ Nanoleaf
   ├ capture ─┼▶│ CaptureSource│        │ level features   │   │ (30+) × palette   │  │ v2 encoder  │ │   controller
   │ (ffmpeg) │ │ StdinSource  │        └────────────────┘   │ + silence gate    │  │ + UDP pacer │ │
   │          │ └──────────────┘                             └──────────────────┘  └─────────────┘ │
   │          │                                                        ▲                            │
   ├ transport┼──▶ TrackWatcher ── 'track' ──▶ rotate visualizer+palette                            │
   └ extension┼──▶ RoonExtension (pairing, status)   NanoleafClient ──┘ layout, token, extControl   │
      API      │                                     (REST :16021)                                   │
              └────────────────────────────────────────────────────────────────────────────────────┘
```

The Roon extension connection (pairing + status + track-change rotation) is **optional to the
audio path**: visuals keep rendering from the stream even if Roon drops — only rotation pauses.

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
| `src/visuals/visualizers.js` | 12 parametric engines × variant grid → 30+ named visualizers; `createVisual`, `describeVisuals` | palettes |
| `src/visuals/layout.js` | `prepareLayout()`: panel positions → normalized nx/ny, left→right, drop pseudo-panel | — |
| `src/visuals/shuffle.js` | `ShuffleBag` (no-repeat rotation) + `filterNames` (include/exclude) | — |
| `src/visuals/renderer.js` | `VisualRenderer`: features → active visualizer → streamer at fps; silence gate; rotation on track change/timer; panel ownership (acquire on play, debounced release + restore on idle) | features, visualizers, palettes, shuffle |
| `src/nanoleaf/client.js` | REST: `createToken`, `getInfo`, `getLayout`, `enableExtControl`, `setPower`, `identify` | http |
| `src/nanoleaf/streamer.js` | `encodeFrameV2()` + `Streamer` (UDP socket, newest-frame-wins pacing) | dgram |
| `src/nanoleaf/discovery.js` | SSDP M-SEARCH + response parsing | dgram |
| `src/roon/trackwatcher.js` | Pure event logic: raw zone events → `track`/`playing`/`idle`/`zones` (no Roon dependency) | — |

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

- `SIGINT`/`SIGTERM` → stop source → black frame → close sockets → exit 0 (clean for
  systemd/NSSM restarts).
- Nanoleaf HTTP 401 → logged as "re-pair needed" (distinct exit code 3) so service managers
  don't hot-loop a dead credential.
- extControl streams idle out on the controller side after ~10 s without datagrams; the
  streamer sends keepalive frames (last frame re-sent at 1 Hz) during silence.
