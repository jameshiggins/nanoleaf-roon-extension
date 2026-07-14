# Project Plan — Nanoleaf Roon Extension

## 1. Goal

Improve Nanoleaf music responsiveness by feeding it Roon's audio directly instead of relying on
microphone-based detection.

**In scope**

- A Roon extension (Node.js, `node-roon-api`) that pairs with the Core and reports status.
- Capturing raw PCM from Roon's output path.
- Pushing the signal to Nanoleaf via its external control API (streaming/UDP).
- Deployable as a Windows service **or** as a headless "root" extension running next to the
  Roon Core (systemd/Docker).
- Documentation and automated tests.

**Out of scope (by requirement)**

- Custom frequency analysis (FFT band splitting, beat detection, spectrum effects).
- Playback state syncing (play/pause/seek-driven scenes). *Scope change (v0.2): per-track
  scene rotation was added by request — the extension now watches Roon track changes to pick a
  different installed Nanoleaf music scene per track (see SCENES.md). Seek/pause-driven
  effects remain out of scope.*
- Volume-based effects (mapping zone volume to brightness).

<a name="feasibility"></a>
## 2. Feasibility analysis — the one constraint that shapes everything

The original idea was: *push PCM samples to Nanoleaf and let Nanoleaf do the audio analysis on
its side.* That exact shape is **not possible with Nanoleaf's public API**:

1. **The external control API does not carry audio.** extControl (v1/v2) is a UDP protocol whose
   payload is *per-panel RGBW color frames* (see
   [NANOLEAF-PROTOCOL.md](NANOLEAF-PROTOCOL.md)). There is no documented network endpoint on any
   Nanoleaf device that accepts PCM, and the on-device "Sound Scene"/Rhythm analysis engine only
   reads from the built-in microphone or the Rhythm module's 3.5 mm aux input.
2. **The only true audio input is analog.** The Rhythm module (Light Panels / Canvas) has an aux
   jack. Feeding it means physical audio, not a network API.

That leaves two viable architectures, both of which still achieve the actual goal (music
response driven by the real signal, ahead of room acoustics):

| Option | How | Analysis lives | Pros | Cons |
| --- | --- | --- | --- | --- |
| **A. Frame streaming** *(this repo)* | Tap PCM from Roon → minimal loudness envelope → extControl v2 UDP frames | Extension (envelope only, deliberately thin) | Pure software, works on all Nanoleaf gen-2+ devices, latency fully under our control | Analysis is on our side; kept to a non-frequency envelope to honor the scope |
| **B. Aux-in hardware feed** | Add a cheap USB DAC as a Roon zone, cable its line-out to the Rhythm module's aux jack, group that zone with the speakers | Nanoleaf (its native Rhythm engine) | Zero custom analysis — exactly the original intent | Requires Rhythm module hardware + a dedicated DAC; Roon zone-grouping sync applies |

**Decision: implement Option A, document Option B.** Option A needs no extra hardware and works
on Shapes/Elements/Lines which have no aux input. The envelope mapping is intentionally minimal
and isolated in one module (`src/pipeline.js`) so it stays within the "no custom frequency
analysis" boundary and so Option B users can still use the rest of the stack (Roon pairing,
capture, deployment tooling).

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
| Envelope + frame encode | < 1 ms | < 1 ms |
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
- PCM utilities (chunking, peak/RMS, envelope attack/release math) with synthetic signals.
- Config loading/validation, SSDP response parsing.

**Integration (manual, live hardware — tracked per milestone):**

- SlimProto against a real Roon Core: registration, zone appears, PCM flows, survives
  Core restart and network drop (reconnect with backoff).
- extControl v2 against real panels (Shapes + Canvas): pairing flow, sustained 30 fps, frame
  latency eyeball test against a click track.
- Windows service lifecycle: install, reboot, crash-recovery, log rotation.

**Non-goals in tests:** audio *quality* (we only measure levels), Roon API mocking beyond
pairing (the Roon connection is optional at runtime — the audio path works without it).

<a name="milestones"></a>
## 8. Milestones

| # | Deliverable | Status |
| --- | --- | --- |
| M0 | Repo, plan, docs, CI skeleton | ✅ this commit |
| M1 | Nanoleaf client + streamer + discovery, unit-tested | ✅ this commit |
| M2 | PCM pipeline + envelope mapping, unit-tested; `stdin` source end-to-end against real panels | ✅ code, ⬜ live-panel pass |
| M3 | SlimProto source: codecs unit-tested; live pass against Roon Core (register, stream, reconnect) | ✅ code, ⬜ live-Core pass |
| M4 | Roon extension pairing + status reporting in Roon UI | ✅ code, ⬜ live pass |
| M5 | `capture` source + Windows service guide validated on a Windows box | ✅ code/docs, ⬜ validation |
| M6 | Headless deployment (systemd/Docker) validated; v0.2 tag | ⬜ |
| M7 | Option B write-up validated with Rhythm hardware (community help wanted) | ⬜ |

## 9. Risks & mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Roon changes/removes Squeezebox support | slimproto source dies | `capture` source is Roon-version-independent; interface keeps sources swappable |
| SlimProto subtleties (Roon's dialect vs. LMS) | M3 slips | Codec layer unit-tested against the documented LMS wire format; live pass is an explicit milestone gate |
| Panel firmware throttles UDP frame rate | choppy visuals | fps configurable; drop-frame pacing in streamer (send newest, never queue) |
| Nanoleaf auth token invalidated (factory reset) | stream stops | Clear re-pair flow (`npm run pair`); streamer surfaces HTTP 401 distinctly |
| Envelope-only mapping feels too basic | user disappointment | Documented scope decision; mapping isolated behind one function so it can be swapped without touching transport code; Option B path for native Rhythm analysis |
| Windows loopback drivers vary | support burden | Standardize docs on VB-Audio Virtual Cable; `stdin` source as escape hatch |

## 10. Repository conventions

- Public GitHub repo, MIT license.
- Plain CommonJS Node ≥ 20, no build step, no runtime deps beyond the official
  `node-roon-api` packages (everything else is Node built-ins).
- `node --test` for tests; GitHub Actions CI on push/PR (Node 20 + 22).
- Conventional-ish commits (`feat:`, `fix:`, `docs:`); versions tagged from `main`.
