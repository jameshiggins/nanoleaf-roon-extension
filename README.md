# nanoleaf-roon-extension

A [Roon](https://roon.app) extension that makes Nanoleaf panels react to your music from the
**audio signal itself**, not from a microphone.

Instead of Nanoleaf listening to the room (slow, noisy, affected by conversation and speaker
placement), this extension taps the PCM audio stream directly out of Roon and drives the panels
over Nanoleaf's low-latency **external control (extControl v2) UDP streaming API**. The signal
reaches the panels at — or ahead of — the moment the speakers play it.

```
Roon Core ──PCM──▶ nanoleaf-roon-extension ──UDP frames──▶ Nanoleaf panels
                   (envelope only, no DSP)
```

> **Read this first:** Nanoleaf devices cannot ingest raw audio over the network — the
> external control API carries *panel color frames*, not PCM. The only true audio input on
> Nanoleaf hardware is the Rhythm module's 3.5&nbsp;mm aux jack. This project therefore keeps the
> on-extension processing to a minimal loudness envelope (no frequency analysis) and pushes
> frames, which is the closest the public API allows to "delivering the audio feed".
> See [docs/PLAN.md](docs/PLAN.md#feasibility) for the full analysis, including the pure-hardware
> aux-in alternative.

## Features

- **Roon extension pairing** — shows up in Roon Settings → Extensions, reports live status.
- **Two modes**
  - `stream` (default) — drives panels from Roon's audio signal via extControl UDP (below).
  - `scenes` — rotates the Nanoleaf **community/native music scenes** already installed on the
    controller, picking a different one on every Roon track change (shuffle-bag, no immediate
    repeats). The device's own Rhythm engine does the visualization. See
    [docs/SCENES.md](docs/SCENES.md), including the microphone trade-off.
- **Two audio taps** (stream mode)
  - `slimproto` — the extension registers itself with Roon as a Squeezebox player
    ("Nanoleaf Feed" zone) and receives raw PCM straight from the Core. No drivers, works on
    any OS, runs headless next to the Core.
  - `capture` — captures a loopback/virtual audio device via `ffmpeg` (ALSA `snd-aloop` +
    Roon Bridge on Linux/Pi, VB-Audio Virtual Cable on Windows). The loopback is a RAAT zone,
    so it **groups with RAAT endpoints** (Hegel, Linn, any Roon Ready streamer) and Roon keeps
    it sample-synced with the speakers — use this when your listening zone is a network amp.
    Recipe: [docs/DEPLOY-HEADLESS.md §5](docs/DEPLOY-HEADLESS.md#5-syncing-with-a-raat-zone-eg-a-hegel-or-other-network-amp).
- **Nanoleaf pairing, SSDP discovery, layout-aware streaming** at a configurable frame rate
  (default 30 fps) via extControl v2 UDP.
- **Deliberately thin mapping** (stream mode) — a peak/RMS envelope follower with
  attack/release smoothing. Frequency analysis and volume-based effects are out of scope by
  design; track-change awareness exists only as scenes-mode's rotation trigger.

## Quick start

```bash
git clone https://github.com/jameshiggins/nanoleaf-roon-extension.git
cd nanoleaf-roon-extension
npm install

# 1. Find your panels on the network
npm run discover

# 2. Hold the Nanoleaf power button 5-7s (until the LED flashes), then within 30s:
npm run pair -- --host 192.168.1.50

# 3. Copy and edit the config
cp config.example.json config.json

# 4. Run
npm start
```

Then in Roon:

1. **Settings → Extensions** — enable *Nanoleaf Roon Extension*.
2. `slimproto` source: **Settings → Setup → Enable Squeezebox support**, then enable the new
   **Nanoleaf Feed** zone under **Settings → Audio** and play to it (or group it with a zone —
   see [docs/PLAN.md](docs/PLAN.md#latency) for the trade-offs).

## Running it permanently

- **Windows service** — [docs/DEPLOY-WINDOWS-SERVICE.md](docs/DEPLOY-WINDOWS-SERVICE.md)
  (NSSM or node-windows, incl. virtual audio cable setup)
- **Headless / next to the Core** ("root extension") —
  [docs/DEPLOY-HEADLESS.md](docs/DEPLOY-HEADLESS.md) (systemd unit, Docker, Raspberry Pi)

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | Project plan: goals, feasibility analysis, architecture options, latency budget, milestones, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Component and data-flow reference for the code in `src/` |
| [docs/NANOLEAF-PROTOCOL.md](docs/NANOLEAF-PROTOCOL.md) | Pairing, REST endpoints and the extControl v2 UDP wire format used here |
| [docs/SCENES.md](docs/SCENES.md) | Scenes mode: per-track rotation of installed music scenes, config reference |
| [docs/DEPLOY-WINDOWS-SERVICE.md](docs/DEPLOY-WINDOWS-SERVICE.md) | Windows service install & audio capture setup |
| [docs/DEPLOY-HEADLESS.md](docs/DEPLOY-HEADLESS.md) | systemd / Docker deployment beside the Roon Core |

## Development

No build step, no runtime dependencies beyond the official Roon API packages; everything else is
Node.js built-ins. Tests use the built-in `node:test` runner:

```bash
npm test
```

The SlimProto and Nanoleaf wire codecs are covered by unit tests against fixed byte layouts;
HTTP and UDP behaviour is tested against in-process mock servers. See
[docs/PLAN.md](docs/PLAN.md#testing) for the testing strategy and what still needs live-hardware
integration passes.

## Status

Alpha. The Nanoleaf client/streamer and the audio pipeline are unit-tested; the SlimProto
source and Roon pairing need integration testing against a live Roon Core before this is
daily-driver ready. See the milestone table in [docs/PLAN.md](docs/PLAN.md#milestones).

## License

[MIT](LICENSE)
