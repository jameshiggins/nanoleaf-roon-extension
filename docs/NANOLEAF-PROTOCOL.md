# Nanoleaf protocol notes (as used by this project)

Applies to Light Panels (gen 2+), Canvas, Shapes, Elements, Lines. Everything below is the
device's local LAN API — no cloud.

## Discovery (SSDP)

Send an M-SEARCH to `239.255.255.250:1900`:

```
M-SEARCH * HTTP/1.1
HOST: 239.255.255.250:1900
MAN: "ssdp:discover"
MX: 3
ST: ssdp:all
```

Nanoleaf controllers answer with `ST`/`NT` values like `nanoleaf:nl29` (Canvas),
`nanoleaf:nl42` (Shapes), `nanoleaf_aurora:light` (Light Panels), and a `Location:` header
pointing at the REST API root, e.g. `Location: http://192.168.1.50:16021`. The device name is in
`NL-DEVICENAME:`. Implementation: `src/nanoleaf/discovery.js` (we filter responses whose
`ST`/`USN` contain `nanoleaf`).

mDNS `_nanoleafapi._tcp.local` also works; this project uses SSDP to stay dependency-free.

## Pairing

Put the controller in pairing mode (hold the power button ~5–7 s until the LED flashes), then
within 30 s:

```
POST http://{host}:16021/api/v1/new     → 200 {"auth_token": "..."}
```

`403` means pairing mode wasn't active. Tokens persist until factory reset or
`DELETE /api/v1/{token}`.

## REST endpoints used

| Call | Purpose |
| --- | --- |
| `GET /api/v1/{token}` | Full device info (also validates the token) |
| `GET /api/v1/{token}/panelLayout/layout` | `numPanels`, `positionData[]` (`panelId`, `x`, `y`, `o`, `shapeType`) |
| `PUT /api/v1/{token}/identify` | Flash the panels (used by `--discover` verification) |
| `PUT /api/v1/{token}/effects` | Enable streaming, body below |
| `PUT /api/v1/{token}/state` | (not used for streaming; extControl overrides state) |

Enable external control v2:

```json
{ "write": { "command": "display", "animType": "extControl", "extControlVersion": "v2" } }
```

On success the controller listens on **UDP port 60222** for frame datagrams (v2 devices ignore
the `streamControl*` fields older docs mention — the port is fixed).

## extControl v2 UDP frame format

One datagram per frame, big-endian:

```
offset  size  field
0       2     nPanels
then per panel (8 bytes each):
+0      2     panelId
+2      1     red
+3      1     green
+4      1     blue
+5      1     white (send 0; panels ignore it)
+6      2     transitionTime, in units of 100 ms (0 or 1 for streaming)
```

So a 24-panel frame is `2 + 24×8 = 194` bytes. Implementation + pinned-layout tests:
`src/nanoleaf/streamer.js`, `test/streamer.test.js`.

Notes learned the hard way (encoded in the streamer):

- **Keepalive:** if no datagram arrives for ~10 s the controller drops out of extControl mode.
  The streamer re-sends the last frame at 1 Hz during silence.
- **Rate:** 30 fps is safe on Canvas/Shapes; 60 fps generally works but gains little for an
  envelope effect. Configurable via `nanoleaf.fps`.
- **Panels not in the frame keep their last color** — always address every panel.
- v1 (`extControlVersion` omitted, 1-byte panel IDs) is required only by original Aurora
  firmware < 3.1; not supported here.

## What the API can NOT do

There is no endpoint that accepts audio (PCM or compressed) over the network. On-device music
analysis ("Sound Scenes"/Rhythm) reads only the built-in microphone or — on Light
Panels/Canvas Rhythm hardware — the 3.5 mm aux input. This is why the extension maps audio to
frames on the sender side; see the feasibility section of [PLAN.md](PLAN.md#feasibility).
