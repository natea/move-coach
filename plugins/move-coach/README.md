# Move Coach

A Claude Code mod that adds a camera pane: your webcam feed with MediaPipe pose landmarks drawn in green, the matching *Built to Move* illustration beside it, and spoken coaching while you do the test.

- **`/move-coach [test] [camera#]`** opens the pane. With no test it's a plain camera preview. `/move-coach stop` ends a run.
- **Tool `mcp__move-coach__camera_test`** lets Claude run a test. The `built-to-move-mobility-test` skill uses it.
- **Tests:** `sit_and_rise`, `couch`, `airport_scanner`, `shoulder_rotation`, `squat`, `solec`, `old_man`.

## Pieces
- `helper/pose_coach.py`: a uv script (mediapipe 0.10.14, opencv). It captures the camera, runs the Pose Landmarker (model cached in `~/.cache/move-coach`), and runs one state machine per test. It speaks cues and streams JSON lines to the mod.
- `hooks/register.tsx`: the pane, the slash command and the tool. Ghostty draws the camera as a PNG `Image`; the Desktop app draws it as an `Svg` that embeds the JPEG frame with a vector skeleton on top.
- `assets/book/`: illustrations, optional. The book's illustrations are copyrighted and aren't shipped; put your own in `~/.config/move-coach/book/` (see `assets/book/README.md`). The pane works without them.

## Voice
By default the coach speaks with the built-in macOS voice (`say`); nothing to set up.
For a more natural voice, add an ElevenLabs API key in the plugin's settings (`/config` → move-coach →
"ElevenLabs API key", stored in secure storage), and optionally a voice ID. The key reaches the helper
in a private file it deletes on read, never on the command line. `~/.config/move-coach/keys.env` with
`ELEVENLABS_API_KEY=...` also works. If ElevenLabs fails for a cue, that cue falls back to `say`.
Audio clips are cached in `~/.cache/move-coach/tts`.

## Requirements
macOS with a camera, [uv](https://docs.astral.sh/uv/) (the helpers are uv scripts that install their own
Python packages on first run), and the Xcode command-line tools (`xcode-select --install`, used once to
build the small "Move Coach Camera" app). Optional: `ffmpeg` (camera names), a Muse headband and liblsl
(`brew install labstreaminglayer/tap/lsl`) for EEG.

## Camera permission
The Claude app starts its sessions with camera responsibility disclaimed, so a helper spawned straight from the mod can never get camera access (and macOS can't prompt for it). `helper/launch.sh` therefore builds a tiny `Move Coach Camera.app` (in `~/Library/Application Support/move-coach/`, from `helper/camera-app/`) and runs the helper inside it with `open`, relaying its stdout through a FIFO. The first run shows the macOS camera prompt for "Move Coach Camera"; the grant then sticks across Claude updates. Revoke it in System Settings → Privacy & Security → Camera.

## Optional: brain waves from a Muse headband

`/move-coach eeg` (or the pane's **Connect Muse EEG** button, or the tool's `eeg_start` action) runs
`helper/eeg_stream.py`, which reads a Muse through [muse-lsl](https://github.com/alexandrebarachant/muse-lsl).
It attaches to an LSL EEG stream if one is already running (`muselsl stream`), and otherwise scans
Bluetooth for a Muse and starts `muselsl stream` itself. `/move-coach eeg Muse-1A2B` picks a headband
by name; `/move-coach eeg stop` ends it.

The pane draws the last 4 s of each channel (TP9, AF7, AF8, TP10), a contact dot per sensor, and
relative band power over the last second. While a test runs, its result also carries the mean band
power during the test (`eeg_mean_relative_band_power`).

The helper runs inside "Move Coach Camera.app", like the camera, so macOS asks once to allow Bluetooth.
pylsl needs liblsl: if the wheel doesn't bundle it, `brew install labstreaminglayer/tap/lsl`.
