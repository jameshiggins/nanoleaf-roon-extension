# Scenes mode — rotate Nanoleaf music scenes on every track change

Stream mode (the default) renders a loudness envelope from Roon's audio signal. It's accurate
and low-latency, but visually it's a pulse — Nanoleaf's own **Rhythm scenes** (Sound Bar,
Ripple, Fireworks, and the thousands of community scenes in the app's Discover tab) are far
richer: high contrast, per-panel motion, palettes tuned by their authors.

Scenes mode gets you those visuals and keeps Roon in the loop: every time a new track starts
playing in your Roon zone, the extension activates a **different random music scene** on the
controller. The device's native Rhythm engine does the visualization; the extension decides
which scene shows when.

```json
{
  "mode": "scenes",
  "roon": { "enabled": true, "zone": "Living Room" }
}
```

## The trade-off you're making (read this)

Nanoleaf's Rhythm engine takes audio from the **device's own microphone** (Shapes / Elements /
Lines / Canvas — built into the controller) or, on original Light Panels, the Rhythm module's
mic **or 3.5 mm aux input**. There is no API to feed it network audio. So in scenes mode:

- The *visualization* reacts to what the mic hears — room acoustics and all. The direct
  audio feed that stream mode uses is **not** in play.
- The built-in mics are conservatively auto-gained; at low listening volumes scenes can look
  sleepy. Placing the control unit nearer a speaker helps.
- **Light Panels + Rhythm module owners** can have both worlds: cable a Roon zone's DAC into
  the module's aux jack (line-level, precise at any volume) and set the module to aux
  (`PUT /api/v1/{token}/rhythm {"rhythmMode": 1}`). Scene rotation works identically.

Roon-side responsiveness (the track-change trigger) is unaffected — it comes from the Roon
API, not the mic.

## Setup

1. In the Nanoleaf app, download music scenes you like from **Discover** (filter by
   *Rhythm*). They install onto the controller itself.
2. See what the extension will rotate through:

   ```bash
   node src/index.js --list-scenes
   ```

   Music-reactive effects are marked `♪` — those are the rotation pool (with
   `scenes.musicOnly: true`, the default).
3. Set `"mode": "scenes"` in `config.json`, enable the extension in Roon
   (**Settings → Extensions**), and play music.

## Configuration reference

```json
{
  "mode": "scenes",
  "roon": {
    "enabled": true,
    "zone": "Living Room"        // zone name (case-insensitive substring); "" = any playing zone
  },
  "scenes": {
    "include": [],                // explicit rotation list; empty = auto-discover music scenes
    "exclude": ["Fireworks"],     // drop specific scenes from auto-discovery
    "musicOnly": true,            // auto-discover only music-reactive (rhythm) effects
    "onStop": "keep",             // keep | off | "<effect name>" when playback stops
    "minSeconds": 8               // ignore track changes within this window (rapid skipping)
  }
}
```

Behavior details:

- **Rotation order** is a shuffle bag: every scene appears once before any repeats, and the
  same scene never plays twice in a row.
- **Track changes** are detected from Roon zone events by comparing track identity
  (title/artist/album/length). Seeks, pauses, resumes, volume changes and queue edits do not
  trigger a switch. Repeat-one looping does not re-trigger (Roon exposes no track ID, so an
  identical track is indistinguishable from no change).
- **Grouped zones** match by name — `"zone": "Living Room"` still matches the grouped zone
  `Living Room + 1`.
- **Deleted/renamed scenes** (404 from the controller) cause a one-shot re-discovery and a
  different pick; the pool refreshes automatically.
- **`onStop`**: `"keep"` leaves the last scene running, `"off"` powers the panels down (and
  back on at the next track), or name any installed effect (e.g. a calm static scene) to show
  while paused/stopped.
- Startup and Roon reconnects never count as track changes — the current scene is left alone
  until the next real track transition.

## Switching between modes

`mode` is a config setting, not a runtime toggle — run one instance per behavior. Note for
anyone scripting both: activating any scene silently terminates an extControl streaming
session, and streaming again requires re-sending the extControl handshake (the stream-mode
startup does this automatically).
