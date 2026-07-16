# nanoleaf-roon-extension

A [Roon](https://roon.app) extension that turns your music into **Nanoleaf light shows rendered
from the audio stream itself** — not from a microphone.

**This is a PCM → Nanoleaf pipeline. No microphone, anywhere.** It taps the raw PCM audio
straight out of Roon, analyzes it (loudness, stereo, bass/mid/treble bands, beat detection), and
drives the panels frame-by-frame over Nanoleaf's low-latency **external control (extControl v2)
UDP API**. Every visual is computed from the digital audio itself and streamed to the panels — no
room mic, no Rhythm-module mic, no listening to speakers. On each track change it rotates to a
fresh **visualizer × palette** so the look keeps changing with the music.

```
Roon Core ──PCM──▶ nanoleaf-roon-extension ──UDP frames──▶ Nanoleaf panels
                   analyze → visualize → stream
       track change ─────▶ rotate visualizer + palette
```

- **30+ visualizers** (pulse, spectrum bars, ripples, comets, spinning hue wheels, sweeps,
  sparkle, VU meters, fire, …) — see [docs/VISUALS.md](docs/VISUALS.md) or `npm run visuals`.
- **36+ procedurally-generated palettes** (golden-angle hues × color-harmony schemes) —
  raise `visuals.palettes` for more. Together that's **1,000+ distinct looks** in rotation.
- **A shuffle-bag rotation** on every Roon track change: every combo appears before any repeats,
  never the same one twice in a row.
- **A companion app for Android TV / NVIDIA Shield** — the same visualization mirrored full-screen
  on your TV, with D-pad controls (next look, lock, palette, gain). Runs as a web app the Shield
  opens directly, or as a native APK. See [docs/COMPANION-APP.md](docs/COMPANION-APP.md).

## Works great with a networked amp (Hegel, etc.)

When your listening zone is a **RAAT endpoint** — a Hegel, Linn, or any Roon Ready streamer —
use the `capture` audio source with a loopback zone: the loopback is itself a RAAT zone, so Roon
groups it with your amp and keeps them **sample-synced**. The lights track exactly what the amp
plays, at line-level precision. Full recipe:
[docs/DEPLOY-HEADLESS.md §5](docs/DEPLOY-HEADLESS.md#5-syncing-with-a-raat-zone-eg-a-hegel-or-other-network-amp).

The other tap, `slimproto`, registers the extension with Roon as a Squeezebox player ("Nanoleaf
Feed" zone) and receives PCM directly — no audio hardware, ideal for a headless box.

## Quick start

```bash
git clone https://github.com/jameshiggins/nanoleaf-roon-extension.git
cd nanoleaf-roon-extension
npm install

npm run discover                       # find your panels' IP
npm run pair -- --host 192.168.1.50    # hold the power button 5-7s first, then within 30s
cp config.example.json config.json     # set your audio source (see below)
npm run visuals                        # (optional) list the visualizers & palettes
npm start
```

Then in Roon, **Settings → Extensions** → enable *Nanoleaf Roon Extension*, and feed it audio:

- **Hegel / network amp** — set up the loopback capture zone and group it with the amp
  ([DEPLOY-HEADLESS.md §5](docs/DEPLOY-HEADLESS.md#5-syncing-with-a-raat-zone-eg-a-hegel-or-other-network-amp)).
- **Headless, no amp hardware** — set `audio.source` to `slimproto`, enable Squeezebox support
  in Roon (**Settings → Setup**), and play to the **Nanoleaf Feed** zone.

## How it works

1. **Audio in** — `slimproto` (Squeezebox player) or `capture` (ffmpeg loopback) delivers raw
   s16le PCM. Both are Roon-native ways to get the real signal out.
2. **Analyze** — a cheap DSP stage (one-pole band filters, bass-flux onset detection; no FFT)
   turns each chunk into level/stereo/band/beat features.
3. **Visualize** — the active visualizer paints all panels from those features, using the panel
   layout for spatial motion (left/right, rings, sweeps).
4. **Stream** — frames go out at 30 fps over extControl v2 UDP; a silence gate fades to black
   between tracks.
5. **Rotate** — Roon track changes (via the transport API) trigger a switch to a new
   visualizer + palette.

## Running it permanently

- **Headless / next to the Core** — [docs/DEPLOY-HEADLESS.md](docs/DEPLOY-HEADLESS.md)
  (systemd unit, Docker, Raspberry Pi; includes the Hegel/RAAT loopback recipe).
- **Windows service** — [docs/DEPLOY-WINDOWS-SERVICE.md](docs/DEPLOY-WINDOWS-SERVICE.md)
  (NSSM or node-windows, VB-Audio Virtual Cable setup).

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/VISUALS.md](docs/VISUALS.md) | The visualizers, palettes, features they react to, and how to tune them |
| [docs/COMPANION-APP.md](docs/COMPANION-APP.md) | Android TV / Shield app + the control/telemetry API it runs on |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Component and data-flow reference for the code in `src/` |
| [docs/NANOLEAF-PROTOCOL.md](docs/NANOLEAF-PROTOCOL.md) | Pairing, REST endpoints and the extControl v2 UDP wire format |
| [docs/PLAN.md](docs/PLAN.md) | Project plan: goals, architecture, latency, milestones, risks |
| [docs/DEPLOY-HEADLESS.md](docs/DEPLOY-HEADLESS.md) | systemd / Docker beside the Core, plus the RAAT/Hegel loopback recipe |
| [docs/DEPLOY-WINDOWS-SERVICE.md](docs/DEPLOY-WINDOWS-SERVICE.md) | Windows service install & audio capture setup |

## Development

No build step, no runtime dependencies beyond the official Roon API packages; everything else is
Node.js built-ins. Tests use the built-in `node:test` runner:

```bash
npm test
```

Wire codecs (SlimProto, extControl v2, SSDP) are pinned against fixed byte layouts; HTTP/UDP
behavior runs against in-process mock servers; the DSP, visualizers, palettes, and renderer have
their own unit coverage.

## Status

Beta. The audio path, DSP, visualizers, and renderer are unit-tested and validated end-to-end
against a mock controller; the SlimProto source and Roon transport wiring still want an
integration pass against a live Roon Core. See [docs/PLAN.md](docs/PLAN.md#milestones).

## License

[MIT](LICENSE)
