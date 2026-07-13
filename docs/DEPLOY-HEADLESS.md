# Deploying headless (systemd / Docker) — the "root extension" model

Target: an always-on Linux box on the same LAN as the Roon Core — the Core host itself
(Linux/Mac Core), a NAS, or a Raspberry Pi. ROCK/Nucleus users can't run software *on* the Core
appliance, so any Pi/NAS on the LAN works identically (the extension only needs network access
to the Core and the panels).

The natural pairing here is the **`slimproto` source**: the extension registers with the Core as
a Squeezebox player ("Nanoleaf Feed" zone) and receives PCM over TCP — no audio hardware, no
drivers, no desktop session.

> **Playing to a network amp/streamer (RAAT zone)?** Squeezebox zones can't group with RAAT
> zones, so the slimproto feed only sees audio you play *to it*. If your daily listening is a
> RAAT endpoint (a Hegel, a Linn, a Roon Ready streamer…) and you want the lights synced to
> it, skip to [§5: syncing with a RAAT zone](#5-syncing-with-a-raat-zone-eg-a-hegel-or-other-network-amp)
> — a loopback RAAT zone grouped with the amp, using the `capture` source.

## 1. One-time setup

```bash
sudo useradd -r -s /usr/sbin/nologin nanoleaf-roon
sudo git clone https://github.com/jameshiggins/nanoleaf-roon-extension.git /opt/nanoleaf-roon-extension
cd /opt/nanoleaf-roon-extension
sudo npm install --omit=dev
sudo cp config.example.json config.json && sudo $EDITOR config.json   # set nanoleaf.host
sudo -u nanoleaf-roon node src/index.js --pair --host <panel-ip>      # hold power button first
sudo chown -R nanoleaf-roon: /opt/nanoleaf-roon-extension
```

In Roon: **Settings → Setup → Enable Squeezebox support**, then enable the **Nanoleaf Feed**
zone under **Settings → Audio**, and **Settings → Extensions → enable** the extension.

## 2. systemd unit

`/etc/systemd/system/nanoleaf-roon.service`:

```ini
[Unit]
Description=Nanoleaf Roon Extension
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nanoleaf-roon
WorkingDirectory=/opt/nanoleaf-roon-extension
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5
# exit code 3 = Nanoleaf token rejected (re-pair needed); restarting won't help
RestartPreventExitStatus=3
# hardening — the process needs nothing but the network
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/nanoleaf-roon-extension/logs
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nanoleaf-roon
journalctl -u nanoleaf-roon -f
```

Note it runs as a dedicated unprivileged user — "root extension" refers to running at the
system level next to the Core, not as UID 0; nothing here needs root beyond the install steps.

## 3. Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache git && npm ci --omit=dev
COPY . .
USER node
CMD ["node", "src/index.js"]
```

```bash
docker build -t nanoleaf-roon .
docker run -d --name nanoleaf-roon --restart unless-stopped \
  --network host \
  -v $(pwd)/config.json:/app/config.json \
  nanoleaf-roon
```

`--network host` matters twice over: SSDP discovery uses multicast, and the Roon Core must be
able to open a TCP connection *back* to the SlimProto player. Bridged networking breaks both.

## 4. Raspberry Pi notes

- Any Pi (Zero 2 W upward) is ample: the pipeline is an envelope follower and a UDP socket;
  CPU load is a few percent.
- Use a wired connection if possible — the UDP frame stream is small (~6 KB/s at 30 fps for
  24 panels) but Wi-Fi latency spikes are visible as stutter.

## 5. Syncing with a RAAT zone (e.g. a Hegel or other network amp)

Roon cannot group a Squeezebox zone with a RAAT zone, so the `slimproto` source only hears
audio played *to* the "Nanoleaf Feed" zone. When your listening zone is a RAAT endpoint —
a Hegel H-series, a Roon Ready streamer, Roon Bridge hardware — use the **`capture` source
with a loopback RAAT zone** instead:

```
Roon Core ──RAAT──▶ Hegel (speakers)          ← grouped, sample-synced by Roon
          └─RAAT──▶ ALSA loopback zone ──▶ extension captures it ──▶ Nanoleaf
```

The loopback zone *is* a RAAT zone, so it groups with the amp and Roon keeps the two
sample-synced — the lights track exactly what the amp is playing.

On the box that runs the extension (works great on a Raspberry Pi):

1. **Install [Roon Bridge](https://roon.app/en/downloads)** alongside the extension. It
   exposes the machine's audio devices to Roon as RAAT zones.
2. **Create the ALSA loopback device:**
   ```bash
   sudo modprobe snd-aloop
   echo snd-aloop | sudo tee /etc/modules-load.d/snd-aloop.conf   # persist across reboots
   ```
3. In Roon **Settings → Audio**, a *Loopback* device now appears under this machine (via
   Roon Bridge). Enable it and name it **Nanoleaf Feed**.
4. **Group it with the amp:** zone icon → *Group Zones* → tick the Hegel and Nanoleaf Feed.
   Play to the group.
5. Point the extension at the capture side of the loopback in `config.json`
   (playback lands on subdevice 0, capture reads subdevice 1):
   ```json
   {
     "audio": {
       "source": "capture",
       "captureArgs": ["-f", "alsa", "-i", "hw:Loopback,1,0"],
       "sampleRate": 48000,
       "channels": 2
     }
   }
   ```
   `ffmpeg` must be installed (`sudo apt install ffmpeg`).

Notes:

- Volume: fix the loopback zone's volume at 100 % (Device Setup → Fixed Volume) so the light
  intensity doesn't change when you turn the amp down.
- Latency: grouped RAAT zones are aligned by Roon; expect the lights within one frame
  (~33 ms) of the speakers. If your amp's own buffer makes lights feel early/late, nudge the
  zone's *Group Delay* in Roon's zone settings — this is the supported per-zone offset knob.
- A Windows Core can do the identical trick with VB-Audio Virtual Cable — see
  [DEPLOY-WINDOWS-SERVICE.md](DEPLOY-WINDOWS-SERVICE.md).
