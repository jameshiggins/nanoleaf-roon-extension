# Project Plan — Nanoleaf Roon Extension

## 1. Goal

Produce good **music visualizations on Nanoleaf panels, driven by the PCM audio stream from
Roon** — never by a microphone. This is a PCM-in, no-mic pipeline: read the raw digital audio,
analyze it, render a visualization from it, stream that to the panels, and rotate the look on
every track change. The intended target is a networked amp (e.g. a Hegel) via a sample-synced
loopback zone. No room mic, no Rhythm-module mic — the panels react to the bits, not to sound in
the air.

**In scope**

- A Roon extension (Node.js, `node-roon-api`) that pairs with the Core, reports status, and
  provides track-change events for rotation.
- Capturing raw PCM from Roon's output path (SlimProto player or ffmpeg loopback capture).
- On-extension audio analysis: level/stereo envelopes, bass/mid/treble bands, beat detection.
- A library of visualizers (30+) and procedurally generated palettes (36+), rotated per track.
- Streaming the result to Nanoleaf via its external control (extControl v2 UDP) API.
- Deployable as a Windows service **or** headless next to the Core (systemd/Docker).
- Documentation and automated tests.

**Out of scope**

- Playback state syncing beyond track-change rotation (no seek/pause-driven scene scripting).
- Volume-based effects (mapping zone volume to brightness).

> **Design history.** Two earlier experiments were removed: a loudness-only envelope (no
> frequency analysis), and a mode that rotated the device's own **mic-driven** Rhythm scenes.
> The mic-based approach is explicitly rejected. The shipping design is a pure **PCM → panels**
> pipeline: the extension analyzes the digital audio itself and renders the visuals. No
> microphone is used at any point.

<a name="feasibility"></a>
## 2. PCM in, no microphone — how the audio reaches the panels

The audio source is always the **raw PCM stream tapped from Roon** (§3) — never a microphone.
The extension does the analysis and rendering, then sends the result to the panels.

One protocol detail decides *where* the analysis happens: Nanoleaf's extControl (v1/v2) is a UDP
protocol whose payload is *per-panel RGBW color frames* (see
[NANOLEAF-PROTOCOL.md](NANOLEAF-PROTOCOL.md)) — the panels render frames, they don't analyze
audio, and their on-device Rhythm engine only listens to a microphone (built-in, or the Light
Panels Rhythm module's mic/aux). Since a mic is exactly what we're avoiding, the **analysis and
the visualization both happen here, from the PCM**, and we stream finished color frames. That
keeps the visuals fully ours to design — bands, beats, motion, palettes — and works on every
extControl-capable device (Shapes, Elements, Lines, Canvas, gen-2 Light Panels) with no extra
hardware.

The audio the analysis sees is the real stream, tapped from Roon (§3). For a networked amp like
a Hegel, a loopback capture zone grouped with the amp keeps the analysis sample-synced with what
you hear — see [DEPLOY-HEADLESS.md §5](DEPLOY-HEADLESS.md#5-syncing-with-a-raat-zone-eg-a-hegel-or-other-network-amp).

## 3. How we get PCM out of Roon

Roon's public extension API (`node-roon-api`) exposes transport/metadata only — **no audio**.
Audio can only leave Roon toward an *audio device*. Two taps are implemented behind one
`AudioSource` interface:

### 3a. SlimProto endpoint (`source: "slimproto"`) — recommended for headless

Roon natively supports Squeezebox players (Settings → Setup → *Enable Squeezebox support*). The
extension implements a minimal SlimProto client (`src/audio/slimproto.js`): it registers as a
player named **"Nanoleaf Feed"**, and when Roon streams to that zone the Core sends `strm`
commands pointing at an HTTP audio stream, which we read as raw PCM (we advertise `pcm` only, so
the Core sends uncompressed samples).

- No drivers, no OS audio stack, runs anywhere Node runs (including the Core machine itself).
- We control the buffer, so samples are in hand *before* the audible playback clock — this is
  where the "light leads the speakers" latency win comes from.
- Limitation: Squeezebox zones cannot be *grouped* with RAAT zones in Roon, so this is either a
  transfer/secondary zone or you accept ungrouped playback. See §5.

### 3b. Loopback capture (`source: "capture"`) — recommended on Windows

`ffmpeg` (spawned as a child process) captures a virtual audio device:

- **Windows:** install VB-Audio Virtual Cable; Roon sees *CABLE Input* as a WASAPI zone.
  **Group it with your speaker zone** — Roon keeps grouped RAAT zones sample-synced, so the
  capture is aligned with what the speakers play. The service captures *CABLE Output* via
  `ffmpeg -f dshow`.
- **Linux:** an ALSA loopback (`snd-aloop`) or PipeWire/Pulse null-sink works the same way.

### 3c. `source: "stdin"` — testing/advanced

Reads s16le PCM from stdin (`sox`, `ffmpeg`, `arecord` pipelines). Used by tests and handy for
debugging the Nanoleaf side without Roon.

## 4. Nanoleaf delivery

- **Discovery:** SSDP M-SEARCH (Nanoleaf answers `ssdp:all`/`nanoleaf:*` searches with its REST
  location). mDNS (`_nanoleafapi._tcp`) exists too; SSDP was chosen because it needs only a UDP
  socket and no multicast-DNS stack.
- **Pairing:** `POST /api/v1/new` while the controller is in pairing mode → auth token, stored
  in `config.json`.
- **Layout:** `GET /api/v1/{token}/panelLayout/layout` → panel IDs + x/y positions, used to
  order panels spatially (left→right) for the stereo-aware mapping.
- **Streaming:** enable extControl v2 via the effects endpoint, then send one UDP datagram per
  frame to port 60222 (format in [NANOLEAF-PROTOCOL.md](NANOLEAF-PROTOCOL.md)). Frame rate is
  capped in config (default 30 fps; Nanoleaf recommends ≤ 10 Hz per-panel full refresh for v1
  but v2 devices comfortably do 30–60 fps datagrams).

<a name="latency"></a>
## 5. Latency budget

Target: light output at or before acoustic output.

| Stage | slimproto | capture (grouped zone) |
| --- | --- | --- |
| Roon → extension | negative (Core pre-buffers to players; we read ahead of the playback clock) | ~0 (sample-synced with speaker zone) + device buffer 10–50 ms |
| Analyze + render + encode | ~1 ms | ~1 ms |
| UDP → panel render | 10–20 ms (LAN + controller) | 10–20 ms |
| **Net vs. speakers** | **light leads** (tunable by how much buffer we hold back) | **≈ simultaneous** (typically within one frame) |

Compare microphone mode: sound must physically reach the device, then on-device windowed
analysis (~tens of ms) — plus it hears the room, not the mix.

## 6. Deployment models

Two first-class deployment targets, one codebase:

1. **Windows service** — for users whose Roon Core (or endpoint PC) runs Windows. Installed
   with NSSM or `node-windows`, auto-starts, restarts on crash, logs to file. Pairs naturally
   with the `capture` source. Full guide: [DEPLOY-WINDOWS-SERVICE.md](DEPLOY-WINDOWS-SERVICE.md).
2. **Headless "root" extension** — runs unattended next to the Core (ROCK/NUC users run it on
   any always-on box on the LAN, e.g. a Raspberry Pi; Linux/Mac Core users run it on the Core
   host). systemd unit and Dockerfile provided. Pairs naturally with the `slimproto` source.
   Full guide: [DEPLOY-HEADLESS.md](DEPLOY-HEADLESS.md).

<a name="testing"></a>
## 7. Testing strategy

**Unit (in repo, `npm test`, CI on Node 20/22):**

- Wire codecs against fixed byte layouts: SlimProto `HELO`/`STAT` encode and server-message
  (`strm`) parse; extControl v2 frame encode.
- Nanoleaf REST client against an in-process mock HTTP server (pairing, layout, extControl
  enable, error paths).
- UDP streamer against a local datagram socket (frame pacing, payload correctness).
- DSP: band split (bass/mid/treble separation on synthetic tones), onset detection,
  feature extractor; envelope/peak/RMS math with synthetic signals.
- Visualizers: every one renders valid, finite, per-panel frames across a simulated song, is
  dark in silence, and reacts to beats; palettes generate the requested count, all distinct.
- Renderer: rotation (shuffle-bag, rate limit), silence gate, source wiring, blackout on stop.
- TrackWatcher zone-event logic; config loading/validation; SSDP response parsing.

**Integration (manual, live hardware — tracked per milestone):**

- SlimProto against a real Roon Core: registration, zone appears, PCM flows, survives
  Core restart and network drop (reconnect with backoff).
- Roon transport: track-change events fire once per track and rotate the look.
- extControl v2 against real panels (Shapes + Canvas): pairing flow, sustained 30 fps, visual
  responsiveness against real music.
- Windows service lifecycle: install, reboot, crash-recovery, log rotation.

**Non-goals in tests:** subjective visual *quality* (validated by eye on hardware), Roon API
mocking beyond pairing (the audio path works without a Roon connection).

<a name="milestones"></a>
## 8. Milestones

| # | Deliverable | Status |
| --- | --- | --- |
| M0 | Repo, plan, docs, CI skeleton | ✅ |
| M1 | Nanoleaf client + streamer + discovery, unit-tested | ✅ |
| M2 | DSP (bands + onsets) + visualizer library (30+) + palette generator (36+) + renderer, unit-tested; end-to-end against a mock controller | ✅ code, ⬜ live-panel pass |
| M3 | SlimProto source: codecs unit-tested; live pass against Roon Core (register, stream, reconnect) | ✅ code, ⬜ live-Core pass |
| M4 | Roon extension pairing + status + track-change rotation | ✅ code, ⬜ live pass |
| M5 | `capture` source + Windows service guide validated on a Windows box | ✅ code/docs, ⬜ validation |
| M6 | Headless deployment (systemd/Docker) + Hegel/RAAT loopback validated; v0.2 tag | ⬜ |

## 9. Risks & mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Roon changes/removes Squeezebox support | slimproto source dies | `capture` source is Roon-version-independent; interface keeps sources swappable |
| SlimProto subtleties (Roon's dialect vs. LMS) | M3 slips | Codec layer unit-tested against the documented LMS wire format; live pass is an explicit milestone gate |
| Panel firmware throttles UDP frame rate | choppy visuals | fps configurable; drop-frame pacing in streamer (send newest, never queue) |
| Nanoleaf auth token invalidated (factory reset) | stream stops | Clear re-pair flow (`npm run pair`); streamer surfaces HTTP 401 distinctly |
| A visualizer looks bad on real panels | poor experience | 30+ to rotate through; `include`/`exclude` to curate; each is an isolated pure renderer, easy to tune or drop |
| Mic-quiet source or quiet mastering | dim visuals | `gain` config; silence gate keeps gaps clean; band boosts tuned so full-scale music reaches full swing |
| Windows loopback drivers vary | support burden | Standardize docs on VB-Audio Virtual Cable; `stdin` source as escape hatch |

## 10. Repository conventions

- Public GitHub repo, MIT license.
- Plain CommonJS Node ≥ 20, no build step, no runtime deps beyond the official
  `node-roon-api` packages (everything else is Node built-ins).
- `node --test` for tests; GitHub Actions CI on push/PR (Node 20 + 22).
- Conventional-ish commits (`feat:`, `fix:`, `docs:`); versions tagged from `main`.
