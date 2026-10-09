# Companion app (Android TV / NVIDIA Shield)

A second screen for the light show: the same audio-driven visualization the panels are showing,
rendered full-screen on your TV, plus D-pad controls to switch looks, lock the rotation, cycle
palettes and adjust gain. It's driven live by the extension over a small HTTP + Server-Sent
Events API.

```
extension ──HTTP /api, SSE /events──▶ web app (browser or Shield WebView)
   renderer ── frames + now-playing + state ──▶ canvas mirror of the panels + controls
   commands ◀── POST /api/command ── remote (D-pad)
```

There are **two ways to run it**, sharing the exact same web app:

1. **Web app** — served by the extension; open the URL on the Shield (browser or a URL shortcut).
   Nothing to build.
2. **Native APK** — a thin Android TV WebView wrapper (its own repo,
   [nanoleaf-roon-android](https://github.com/jameshiggins/nanoleaf-roon-android)) that installs
   into the Shield's app row and launches full-screen. Build it in Android Studio.

## 1. Enable the server

It's on by default. Config (`config.json`):

```json
{
  "control": {
    "enabled": true,
    "port": 8787,
    "host": "0.0.0.0",   // 127.0.0.1 to keep it off the LAN
    "frameHz": 20,       // telemetry frame rate pushed to the app
    "discoveryPort": 8788 // UDP beacon the Android app uses to find this host; 0 = off
  }
}
```

On startup the extension logs the exact URL(s) to open, e.g.
`companion app ready — open one of these on your Shield: http://192.168.50.42:8787`. The
"extension IP" is just the LAN address of the machine you run `npm start` on (not the Nanoleaf,
not the Shield). If you need to find it yourself: `hostname -I` (Linux/Pi),
`ipconfig getifaddr en0` (macOS), `ipconfig` → IPv4 (Windows), or the router's client list.

**You should not need that IP for the native app.** Alongside the HTTP server the extension
runs a tiny discovery beacon (`src/control/beacon.js`, `control.discoveryPort`, UDP 8788): the
Android app broadcasts `NANOLEAF-ROON? <nonce>` on the LAN, the beacon answers
`NANOLEAF-ROON {"service":"nanoleaf-roon","port":8787,...}`, and the app loads the address the
reply came from. So when DHCP moves the PC (Wi-Fi ↔ Ethernet, lease change) the app follows it
on its next launch — nothing to retype. The beacon only runs when `control.host` is not
loopback-only. On Windows, allow inbound **TCP 8787 and UDP 8788** to `node.exe` for the
Private profile, or neither the app nor its scan will get through the firewall.

> No authentication — this is meant for a trusted home LAN. Bind to `127.0.0.1` (and use the
> native app on the same machine, or an SSH tunnel) if that's a concern.

## 2a. Just open the web app

On the Shield, open **`http://<extension-ip>:8787`** in a browser (e.g. Puffin/Firefox for
Android TV, or Chrome on a phone/tablet as a remote). You'll get the full-screen visualizer and
the controls. This is the fastest way to see it working.

## 2b. Install the native Android TV app on the Shield

**You don't need to build anything** — GitHub Actions in the
[nanoleaf-roon-android](https://github.com/jameshiggins/nanoleaf-roon-android) repo builds the APK
on every change and publishes it to a release. Two ways to get it onto the Shield:

### Easiest: the Downloader app (no PC)

1. On the Shield, install **Downloader** (by AFTVnews) from the Play Store, and in
   **Settings → Device Preferences → Security → Install unknown apps**, allow Downloader.
2. In Downloader, open this URL:
   **`https://github.com/jameshiggins/nanoleaf-roon-android/releases/download/latest/nanoleaf-roon-visualizer.apk`**
3. It downloads and offers to install. Open it: it finds the extension by broadcast and connects
   on its own. If nothing answers (firewall, different subnet) it falls back to the last address
   that worked and finally asks; long-press **Menu** any time to rescan or type a URL.

The app then appears in the Shield's **Apps** row.

### From a PC over adb

Grab the APK from the
[latest release](https://github.com/jameshiggins/nanoleaf-roon-android/releases/tag/latest)
(or from a run's **Artifacts** under the **Android APK** workflow), then:

```bash
adb connect <shield-ip>:5555        # enable Developer options → USB/Network debugging first
adb install nanoleaf-roon-visualizer.apk
```

### Build it yourself (optional)

It's a standard Android Studio project (one small Java activity around a WebView). Clone
[nanoleaf-roon-android](https://github.com/jameshiggins/nanoleaf-roon-android), open it in
Android Studio → **Build → Build APK(s)**, or run `gradlew assembleDebug` with the Android SDK
installed.

The app declares `LEANBACK_LAUNCHER`, so it shows up in the Shield's **Apps** row with a banner
(`app/src/main/res/drawable-nodpi/banner.png`, 320×180).

### Remote controls

| Button | Action |
| --- | --- |
| **▲ Up** / **OK** | Show the control bar |
| **◀ ▶** | Move between controls |
| **OK** | Activate the focused control |
| **▼ Down** / **Back** | Hide the control bar (Back again exits) |
| **Long-press Menu** | Re-enter the extension URL |

Controls: Prev/Next look, Auto (lock/unlock rotation), Palette (cycle), Gain −/+. The D-pad is
forwarded into the web app via `window.__tvKey()`, so it works regardless of WebView key quirks;
in a plain browser the same actions map to the arrow keys, Enter, and `n` (next).

## The API (for your own clients)

Small and dependency-free — build any client you like against it.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/state` | current visual, palette, gain, rotate/lock, now-playing, panel count |
| `GET /api/catalogue` | all visual names + descriptions, palette names, panel layout (id/nx/ny) |
| `GET /events` (SSE) | `hello` (state+catalogue), then live `frame` (panel colors + features), `state` |
| `POST /api/command` | `{ "cmd": ... }` — see below |

Commands (`POST /api/command`, JSON body):

```
{ "cmd": "next" }                        rotate to a new look now
{ "cmd": "visual",  "value": "ripple" }  pin a visualizer (name from /api/catalogue)
{ "cmd": "palette", "value": "Aurora Triad" }   pin a palette (name or index)
{ "cmd": "gain",    "value": 2.0 }       set input gain
{ "cmd": "rotate",  "value": "track" }   "track" | "off" | <seconds>
{ "cmd": "lock" }  / { "cmd": "unlock" } shortcut for rotate off / track
```

A `frame` SSE event carries `{ g: gate, c: [[r,g,b], …one per panel in layout order…],
f: { rms, bass, mid, treble, energy, onset } }`. Combined with `catalogue.layout` (normalized
`nx`/`ny` per panel), that's everything needed to mirror the panels or build a meter.
