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
2. **Native APK** — a thin Android TV WebView wrapper (in [`android/`](../android)) that installs
   into the Shield's app row and launches full-screen. Build it in Android Studio.

## 1. Enable the server

It's on by default. Config (`config.json`):

```json
{
  "control": {
    "enabled": true,
    "port": 8787,
    "host": "0.0.0.0",   // 127.0.0.1 to keep it off the LAN
    "frameHz": 20        // telemetry frame rate pushed to the app
  }
}
```

On startup the extension logs the address, e.g. `companion app API on http://0.0.0.0:8787`. From
another device use the extension host's LAN IP: `http://<extension-ip>:8787`.

> No authentication — this is meant for a trusted home LAN. Bind to `127.0.0.1` (and use the
> native app on the same machine, or an SSH tunnel) if that's a concern.

## 2a. Just open the web app

On the Shield, open **`http://<extension-ip>:8787`** in a browser (e.g. Puffin/Firefox for
Android TV, or Chrome on a phone/tablet as a remote). You'll get the full-screen visualizer and
the controls. This is the fastest way to see it working.

## 2b. Build the native Android TV app

The wrapper is a standard Android Studio project — no Kotlin, one small Java activity around a
WebView, so it builds with just the Android SDK.

```
1. Open the android/ folder in Android Studio (Giraffe or newer).
   It will sync Gradle and generate the Gradle wrapper on first import.
2. Build → Build APK(s)   (or Run onto the Shield over adb).
3. First launch prompts for the extension URL (e.g. http://192.168.1.10:8787);
   it's remembered. Long-press MENU on the remote to change it later.
```

Command-line build (SDK installed, `local.properties` pointing at it):

```bash
cd android
./gradlew assembleDebug          # after Android Studio has created the wrapper
adb connect <shield-ip>
adb install app/build/outputs/apk/debug/app-debug.apk
```

The app declares `LEANBACK_LAUNCHER`, so it shows up in the Shield's **Apps** row with a banner
(replace `app/src/main/res/drawable/banner.xml` with real 320×180 art when you like).

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
