# Deploying headless (systemd / Docker) — the "root extension" model

Target: an always-on Linux box on the same LAN as the Roon Core — the Core host itself
(Linux/Mac Core), a NAS, or a Raspberry Pi. ROCK/Nucleus users can't run software *on* the Core
appliance, so any Pi/NAS on the LAN works identically (the extension only needs network access
to the Core and the panels).

The natural pairing here is the **`slimproto` source**: the extension registers with the Core as
a Squeezebox player ("Nanoleaf Feed" zone) and receives PCM over TCP — no audio hardware, no
drivers, no desktop session.

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
