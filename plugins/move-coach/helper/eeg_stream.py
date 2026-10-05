# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["muselsl>=2.2", "pylsl>=1.16", "numpy"]
# ///
"""Move Coach EEG helper (optional).

Reads a Muse headband through muse-lsl (https://github.com/alexandrebarachant/muse-lsl)
and streams JSON lines on stdout for the Claude Code mod, about 10 per second:

  {"type":"eeg", "channels":["TP9","AF7","AF8","TP10"], "raw":[[..128 µV..] x4],
   "bands":{"delta":..,"theta":..,"alpha":..,"beta":..,"gamma":..}, "quality":[..], "device":".."}
  {"type":"status", "message":...}
  {"type":"error", "message":...}

It attaches to an LSL EEG stream if one is already running (`muselsl stream`), and
otherwise finds a Muse over Bluetooth and starts `muselsl stream` itself.
Control: the mod writes {"cmd":"stop"} to <out-dir>/control.json.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

BANDS = {"delta": (1, 4), "theta": (4, 8), "alpha": (8, 13), "beta": (13, 30), "gamma": (30, 44)}
CHANNELS = ["TP9", "AF7", "AF8", "TP10"]
WINDOW_S = 4.0  # raw trace shown in the pane
POINTS = 128  # samples per channel per message


def emit(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def import_pylsl():
    # pylsl needs liblsl; use Homebrew's when the wheel doesn't bundle it
    if "PYLSL_LIB" not in os.environ:
        for p in ("/opt/homebrew/lib/liblsl.dylib", "/usr/local/lib/liblsl.dylib"):
            if Path(p).exists():
                os.environ["PYLSL_LIB"] = p
                break
    import pylsl  # noqa: E402

    return pylsl


def band_powers(x: np.ndarray, fs: float) -> dict[str, float]:
    """Relative band power (0–1) of each band, averaged over channels. x: (n, ch)."""
    x = x - x.mean(axis=0)
    win = np.hanning(len(x))[:, None]
    spec = np.abs(np.fft.rfft(x * win, axis=0)) ** 2
    freqs = np.fft.rfftfreq(len(x), 1 / fs)
    total = spec[(freqs >= 1) & (freqs < 44)].sum(axis=0) + 1e-9
    return {k: round(float(np.mean(spec[(freqs >= lo) & (freqs < hi)].sum(axis=0) / total)), 3) for k, (lo, hi) in BANDS.items()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--name", default="", help="Muse name or address to connect to (default: the first found)")
    ap.add_argument("--fps", type=float, default=10.0)
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    control = out / "control.json"
    if control.exists():
        control.unlink()

    try:
        pylsl = import_pylsl()
    except Exception as exc:
        emit({"type": "error", "message": f"pylsl could not load liblsl ({exc}). Install it with: brew install labstreaminglayer/tap/lsl"})
        return

    streamer = None
    emit({"type": "status", "message": "looking for an EEG stream…"})
    found = pylsl.resolve_byprop("type", "EEG", timeout=2)
    found, streamer = connect(pylsl, args, found, streamer)
    if not found:
        return
    run(pylsl, args, control, found, streamer)


def connect(pylsl, args, found, streamer):
    """Returns (streams, muselsl process). Starts muselsl when no stream is up."""
    if not found:
        # no stream yet: start muselsl ourselves (it scans Bluetooth for a Muse)
        muselsl = Path(sys.executable).parent / "muselsl"
        cmd = [str(muselsl), "stream"]
        if args.name:
            # a MAC address (aa:bb:..) or a macOS Bluetooth UUID connects directly; anything else is a name
            is_address = ":" in args.name or args.name.count("-") >= 4
            cmd += ["--address" if is_address else "--name", args.name]
        emit({"type": "status", "message": "searching for a Muse over Bluetooth… (turn it on; allow Bluetooth for \"Move Coach Camera\" if macOS asks)"})
        streamer = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + 45
        while not found and time.time() < deadline:
            if streamer.poll() is not None:
                tail = (streamer.stdout.read() if streamer.stdout else "").strip().splitlines()[-3:]
                emit({"type": "error", "message": "muselsl could not connect to a Muse: " + (" / ".join(tail) or "no Muse found")})
                return [], None
            found = pylsl.resolve_byprop("type", "EEG", timeout=1)
        if not found:
            streamer.terminate()
            emit({"type": "error", "message": "No Muse found within 45 s. Turn the headband on (lights blinking) and try again."})
            return [], None
    return found, streamer


def run(pylsl, args, control, found, streamer) -> None:
    info = found[0]
    inlet = pylsl.StreamInlet(info, max_chunklen=12)
    fs = info.nominal_srate() or 256.0
    n_ch = min(info.channel_count(), len(CHANNELS))
    device = info.name()
    emit({"type": "status", "message": f"connected: {device} ({fs:.0f} Hz)"})

    buf = np.zeros((int(WINDOW_S * fs), n_ch))
    last_emit = 0.0
    last_sample = time.time()
    ctl_mtime = 0.0
    try:
        while True:
            chunk, _ = inlet.pull_chunk(timeout=0.05, max_samples=64)
            t = time.time()
            if chunk:
                last_sample = t
                c = np.asarray(chunk, dtype=float)[:, :n_ch]
                buf = np.vstack([buf[len(c):], c]) if len(c) < len(buf) else c[-len(buf):]
            elif t - last_sample > 5:
                # the stream went quiet (headband off, or the muselsl we attached to exited): find it again
                emit({"type": "status", "message": "reconnecting: no EEG samples for 5 s…"})
                if streamer and streamer.poll() is not None:
                    streamer = None
                found, streamer = connect(pylsl, args, pylsl.resolve_byprop("type", "EEG", timeout=2), streamer)
                if not found:
                    break
                info = found[0]
                inlet = pylsl.StreamInlet(info, max_chunklen=12)
                emit({"type": "status", "message": f"connected: {info.name()}"})
                last_sample = time.time()

            if control.exists() and control.stat().st_mtime != ctl_mtime:
                ctl_mtime = control.stat().st_mtime
                try:
                    if json.loads(control.read_text()).get("cmd") == "stop":
                        break
                except Exception:
                    pass

            if t - last_emit >= 1.0 / args.fps:
                last_emit = t
                step = max(1, len(buf) // POINTS)
                raw = buf[::step][-POINTS:]
                raw = raw - raw.mean(axis=0)
                second = buf[-int(fs):]
                sd = second.std(axis=0)
                # good: 2–100 µV of movement; flat means no skin contact, huge means motion or a loose sensor
                quality = ["good" if 2 < s < 100 else "flat" if s <= 2 else "noisy" for s in sd]
                emit({"type": "eeg", "channels": CHANNELS[:n_ch], "raw": [[round(float(v), 1) for v in raw[:, i]] for i in range(n_ch)],
                      "bands": band_powers(second, fs), "quality": quality, "device": device})
    finally:
        if streamer and streamer.poll() is None:
            streamer.terminate()
        emit({"type": "status", "message": "EEG stopped"})


if __name__ == "__main__":
    main()
