# Architecture

## Data flow

```
                 ┌────────────────────────────── nanoleaf-roon-extension ─────────────────────────────┐
                 │                                                                                     │
 Roon Core ──────┤ AudioSource            PCM (s16le)      Pipeline               frames    Streamer   │
   │             │ ┌──────────────────┐   chunks   ┌──────────────────────┐   ┌─────────────────────┐ │      UDP 60222
   ├─ slimproto ─┼▶│ SlimprotoSource  │──────────▶│ envelope follower     │──▶│ extControl v2       │─┼────▶ Nanoleaf
   ├─ loopback ──┼▶│ CaptureSource    │           │ (peak/RMS, attack/    │   │ frame encoder +     │ │      controller
   │  (ffmpeg)   │ │ StdinSource      │           │ release) → per-panel  │   │ paced UDP sender    │ │
   │             │ └──────────────────┘           │ RGBW via layout       │   └─────────────────────┘ │
   │             │                                └──────────────────────┘              ▲             │
   │             │                                                                      │ layout,     │
   └─ extension ─┼──▶ RoonExtension (pairing, status display)      NanoleafClient ──────┘ token,      │
      API        │                                                 (REST :16021)          extControl  │
                 └─────────────────────────────────────────────────────────────────────────────────────┘
```

The Roon extension connection (pairing + status in the Roon UI) is **optional at runtime**: the
audio path works without it, so a Roon API outage never darkens the panels.

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
| `src/pipeline.js` | Glue: PCM chunks → envelope → `mapEnvelopeToFrame()` → streamer at fixed fps. The **only** place audio becomes light | pcm.js |
| `src/nanoleaf/client.js` | REST: `createToken`, `getInfo`, `getLayout`, `enableExtControl`, `identify` | http |
| `src/nanoleaf/streamer.js` | `encodeFrameV2()` + `Streamer` (UDP socket, newest-frame-wins pacing) | dgram |
| `src/nanoleaf/discovery.js` | SSDP M-SEARCH + response parsing | dgram |
| `src/roon/trackwatcher.js` | Pure event logic: raw zone events → `track`/`playing`/`idle` (no Roon dependency) | — |
| `src/scenes/picker.js` | Shuffle-bag scene rotation + include/exclude filtering; pure | — |
| `src/scenes/rotator.js` | scenes mode glue: track events → power/select on the controller, 404 re-discovery, onStop policy | picker, client |

## Design rules

1. **Wire formats are pure functions.** Every encode/parse is a standalone function over
   Buffers with unit tests pinned to byte layouts. Sockets are thin shells around them.
2. **One mapping choke point.** `mapEnvelopeToFrame(panels, envelope, opts)` is the entire
   audio→light policy. Swapping the aesthetic (or, later, plugging in something smarter) touches
   nothing else. It is time-domain only — no FFT, per the project scope.
3. **Sources are interchangeable.** Everything downstream sees `pcm` events of interleaved
   s16le at a declared sample rate/channel count. Adding a source (e.g. a future RAAT tap)
   means implementing one EventEmitter.
4. **Fail toward darkness, recover loudly.** On stream loss the streamer sends one black frame
   and stops; sources reconnect with capped exponential backoff; the Roon status line reflects
   the current state.
5. **Newest frame wins.** The streamer never queues: if encode outpaces the fps budget, stale
   frames are dropped. Latency is the product's point; a backlog is worse than a skip.

## Error handling & lifecycle

- `SIGINT`/`SIGTERM` → stop source → black frame → close sockets → exit 0 (clean for
  systemd/NSSM restarts).
- Nanoleaf HTTP 401 → logged as "re-pair needed" (distinct exit code 3) so service managers
  don't hot-loop a dead credential.
- extControl streams idle out on the controller side after ~10 s without datagrams; the
  streamer sends keepalive frames (last frame re-sent at 1 Hz) during silence.
