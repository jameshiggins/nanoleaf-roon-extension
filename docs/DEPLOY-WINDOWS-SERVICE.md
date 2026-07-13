# Deploying as a Windows service

Target: a Windows machine that either runs the Roon Core or is an always-on endpoint PC on the
same LAN. The service auto-starts at boot, restarts on failure, and needs no logged-in user.

## 1. Audio capture setup (the `capture` source)

Windows has no built-in app-to-app audio routing, so use a virtual cable:

1. Install [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) (free) and reboot.
2. Roon now shows **CABLE Input** as a WASAPI device under **Settings → Audio**. Enable it and
   name the zone e.g. `Nanoleaf Feed`.
3. In Roon, **group** the `Nanoleaf Feed` zone with your speaker zone (zone icon → *Group
   Zones*). Roon keeps grouped RAAT zones sample-synced, so the capture aligns with the
   speakers. (Grouping works between RAAT/WASAPI zones; it will not group with a Squeezebox
   zone — that's the `slimproto` source's trade-off, see PLAN.md §5.)
4. Install [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) and put it on `PATH`
   (`winget install Gyan.FFmpeg`).

`config.json`:

```json
{
  "audio": {
    "source": "capture",
    "captureArgs": ["-f", "dshow", "-i", "audio=CABLE Output (VB-Audio Virtual Cable)"],
    "sampleRate": 48000,
    "channels": 2
  }
}
```

Sanity check before installing the service:

```powershell
node src\index.js   # play music in Roon to the grouped zone; panels should react
```

## 2. Install with NSSM (recommended)

[NSSM](https://nssm.cc/) wraps any executable as a proper service with restart/rotation:

```powershell
winget install NSSM   # or download nssm.exe

nssm install NanoleafRoon "C:\Program Files\nodejs\node.exe" "C:\opt\nanoleaf-roon-extension\src\index.js"
nssm set NanoleafRoon AppDirectory "C:\opt\nanoleaf-roon-extension"
nssm set NanoleafRoon AppStdout "C:\opt\nanoleaf-roon-extension\logs\service.log"
nssm set NanoleafRoon AppStderr "C:\opt\nanoleaf-roon-extension\logs\service.log"
nssm set NanoleafRoon AppRotateFiles 1
nssm set NanoleafRoon AppRotateBytes 1048576
nssm set NanoleafRoon AppExit Default Restart
nssm set NanoleafRoon AppRestartDelay 5000
nssm set NanoleafRoon Start SERVICE_AUTO_START

nssm start NanoleafRoon
```

> **Note on exit code 3:** the app exits with code 3 when the Nanoleaf token is rejected
> (factory reset / re-pair needed) so a restart loop is pointless. Optionally tell NSSM not to
> restart on it: `nssm set NanoleafRoon AppExit 3 Exit`.

### Service account & audio

DirectShow capture of the virtual cable works from session 0 (the service session) because the
cable is a kernel driver, not a per-user endpoint. If capture returns silence, run the service
as the auto-logon desktop user instead: `nssm set NanoleafRoon ObjectName ".\yourUser" "password"`.

## 3. Alternative: node-windows

If you prefer an npm-native install (no NSSM binary):

```powershell
npm install -g node-windows
node tools\install-windows-service.js   # see tools/ in this repo
```

`tools/install-windows-service.js` registers the same entry point with
`node-windows` defaults (auto start, restart on crash, Event Log integration). Uninstall with
`node tools\install-windows-service.js --uninstall`.

## 4. Firewall

Outbound only: TCP 16021 (Nanoleaf REST) and UDP 60222 (frames) to the controller, plus TCP
9100–9200 to the Roon Core for the extension API. Windows Defender's default outbound-allow
policy needs no changes; if you run a restrictive profile, allow `node.exe` outbound on the
private profile.

## 5. Updating

```powershell
nssm stop NanoleafRoon
git -C C:\opt\nanoleaf-roon-extension pull
npm --prefix C:\opt\nanoleaf-roon-extension install
nssm start NanoleafRoon
```
