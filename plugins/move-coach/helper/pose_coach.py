# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["mediapipe==0.10.14", "opencv-python>=4.9", "numpy"]
# ///
"""Move Coach camera helper.

Captures the webcam, runs MediaPipe Pose Landmarker, watches one Built to Move
test, speaks coaching cues (ElevenLabs when a key is set, macOS `say`
otherwise) and streams JSON lines on stdout for the Claude Code mod:

  {"type":"frame", "jpeg":<b64>, "w":..,"h":.., "lm":[[x,y,v]..33], "png":<path>, "gen":n,
   "phase":..., "instruction":..., "cue":..., "metrics":{...}}
  {"type":"result", "test":..., ...}
  {"type":"error", "message":...}

Control: the mod writes {"cmd":"stop"|"next"} to <out-dir>/control.json.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.request
from collections import deque
from pathlib import Path

import cv2
import numpy as np

CACHE = Path.home() / ".cache" / "move-coach"
KEYS_FILE = Path.home() / ".config" / "move-coach" / "keys.env"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_full/float16/latest/pose_landmarker_full.task"
)

# MediaPipe pose landmark indices
NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR = 0, 11, 12, 13, 14, 15, 16
L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN = 23, 24, 25, 26, 27, 28
L_HEEL, R_HEEL, L_FT, R_FT = 29, 30, 31, 32
CONNECTIONS = [
    (11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24),
    (23, 25), (25, 27), (27, 29), (29, 31), (27, 31), (24, 26), (26, 28), (28, 30),
    (30, 32), (28, 32), (15, 17), (15, 19), (15, 21), (16, 18), (16, 20), (16, 22),
    (0, 1), (1, 2), (2, 3), (3, 7), (0, 4), (4, 5), (5, 6), (6, 8), (9, 10),
]


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"[pose_coach] {msg}\n")
    sys.stderr.flush()


def load_keys() -> dict:
    keys = {}
    if KEYS_FILE.exists():
        for line in KEYS_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if v.strip():
                    keys[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "GEMINI_API_KEY"):
        if os.environ.get(k):
            keys[k] = os.environ[k]
    return keys


# ---------------------------------------------------------------- voice


class Voice:
    """Speaks cues on a background thread. ElevenLabs (cached mp3) or `say`."""

    def __init__(self, keys: dict, enabled: bool = True):
        self.enabled = enabled
        self.key = keys.get("ELEVENLABS_API_KEY")
        self.voice_id = keys.get("ELEVENLABS_VOICE_ID") or "EXAVITQu4vr4xnSDxMaL"  # Sarah (premade; free-plan API ok)
        self.q: queue.Queue[str] = queue.Queue()
        self.busy = threading.Event()
        self.engine = "elevenlabs" if self.key else "say"
        (CACHE / "tts").mkdir(parents=True, exist_ok=True)
        threading.Thread(target=self._run, daemon=True).start()

    def say(self, text: str, priority: bool = True) -> None:
        """priority cues queue; others are dropped while something is speaking."""
        if not self.enabled or not text:
            return
        if not priority and (self.busy.is_set() or not self.q.empty()):
            return
        self.q.put(text)

    def prefetch(self, texts: list[str]) -> None:
        if self.key:
            threading.Thread(target=lambda: [self._mp3(t) for t in texts], daemon=True).start()

    @staticmethod
    def calm(text: str) -> bool:
        """Breathing and relaxing cues are spoken slower and steadier."""
        t = text.lower()
        return "breathe" in t or "relax" in t

    def _mp3(self, text: str) -> Path | None:
        calm = self.calm(text)
        path = CACHE / "tts" / (hashlib.sha1(f"{self.voice_id}|{'calm|' if calm else ''}{text}".encode()).hexdigest() + ".mp3")
        if path.exists():
            return path
        req = urllib.request.Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}?output_format=mp3_44100_128",
            data=json.dumps({"text": text, "model_id": "eleven_flash_v2_5",
                             **({"voice_settings": {"stability": 0.85, "similarity_boost": 0.75, "style": 0.0, "speed": 0.8}} if calm else {})}).encode(),
            headers={"xi-api-key": self.key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read()
            tmp = path.with_suffix(".part")
            tmp.write_bytes(data)
            tmp.replace(path)
            return path
        except Exception as exc:  # fall back to `say` for this cue
            log(f"elevenlabs failed: {exc}")
            return None

    def _run(self) -> None:
        while True:
            text = self.q.get()
            self.busy.set()
            try:
                mp3 = self._mp3(text) if self.key else None
                if mp3:
                    subprocess.run(["afplay", str(mp3)], check=False)
                else:
                    subprocess.run(["say", "-r", "140" if self.calm(text) else "190", text], check=False)
            finally:
                self.busy.clear()


# ---------------------------------------------------------------- geometry


class Pose:
    """One frame's landmarks in pixel space, plus helpers."""

    def __init__(self, lms, w: int, h: int):
        self.p = np.array([[l.x * w, l.y * h] for l in lms], dtype=float)
        self.v = np.array([getattr(l, "visibility", 1.0) or 0.0 for l in lms], dtype=float)

    def vis(self, *idx: int, thr: float = 0.5) -> bool:
        return all(self.v[i] >= thr for i in idx)

    def pt(self, i: int) -> np.ndarray:
        return self.p[i]

    def mid(self, a: int, b: int) -> np.ndarray:
        return (self.p[a] + self.p[b]) / 2

    def best_side(self) -> str:
        l = self.v[[L_SH, L_HIP, L_KN, L_AN]].mean()
        r = self.v[[R_SH, R_HIP, R_KN, R_AN]].mean()
        return "L" if l >= r else "R"

    def side(self, s: str) -> dict:
        if s == "L":
            return dict(sh=L_SH, el=L_EL, wr=L_WR, hip=L_HIP, kn=L_KN, an=L_AN, heel=L_HEEL, ft=L_FT)
        return dict(sh=R_SH, el=R_EL, wr=R_WR, hip=R_HIP, kn=R_KN, an=R_AN, heel=R_HEEL, ft=R_FT)

    def torso(self) -> float:
        return float(np.linalg.norm(self.mid(L_SH, R_SH) - self.mid(L_HIP, R_HIP))) or 1.0


def angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    """Angle ABC in degrees."""
    v1, v2 = a - b, c - b
    d = np.linalg.norm(v1) * np.linalg.norm(v2)
    if d == 0:
        return 180.0
    return float(math.degrees(math.acos(np.clip(np.dot(v1, v2) / d, -1, 1))))


def from_vertical(top: np.ndarray, bottom: np.ndarray) -> float:
    """Degrees a segment leans away from vertical (image y is down)."""
    dx, dy = top[0] - bottom[0], bottom[1] - top[1]
    return float(abs(math.degrees(math.atan2(dx, dy))))


class Debounce:
    """Counts rising edges of a condition that holds for `on_s` seconds."""

    def __init__(self, on_s: float = 0.25, off_s: float = 0.35):
        self.on_s, self.off_s = on_s, off_s
        self.state = False
        self.since: float | None = None
        self.count = 0

    def update(self, cond: bool, t: float) -> bool:
        if cond != self.state:
            if self.since is None:
                self.since = t
            if t - self.since >= (self.on_s if cond else self.off_s):
                self.state = cond
                self.since = None
                if cond:
                    self.count += 1
                    return True
        else:
            self.since = None
        return False


class Steady:
    """True once a point has moved less than `tol` (in torso units) for `secs`."""

    def __init__(self, secs: float = 1.0, tol: float = 0.08):
        self.secs, self.tol = secs, tol
        self.hist: deque = deque()

    def update(self, pt: np.ndarray, torso: float, t: float) -> bool:
        self.hist.append((t, pt.copy()))
        while self.hist and t - self.hist[0][0] > self.secs:
            self.hist.popleft()
        if len(self.hist) < 4 or t - self.hist[0][0] < self.secs * 0.9:
            return False
        pts = np.array([p for _, p in self.hist])
        return float(np.ptp(pts, axis=0).max()) / torso < self.tol


# ---------------------------------------------------------------- scoring

# Points out of 10 per test, from the book's bands (best band = 10). Per-side tests
# score the weaker side, since that is the one the practice prioritizes.
SQUAT_POINTS = {1: 10, 2: 7, 3: 4, 4: 1}
COUCH_POINTS = {"Floor P3": 10, "Floor P2": 8, "Floor P1": 6, "Couch P2": 4, "Couch P1": 2}
AIRPORT_POINTS = [("2+ in", 10), ("1–2 in", 7), ("Lifts but", 4), ("Can't lift", 1)]


def touch_points(touches: int) -> int:
    return {0: 10, 1: 8, 2: 7, 3: 4, 4: 3}.get(touches, 1)


def book_points(test: str, r: dict) -> tuple[int, str, str] | None:
    """(points out of 10, short label, how it was computed) for a finished test.

    None when the book has no score (Shoulder Rotation is subjective).
    """
    try:
        if test == "squat":
            pos = r["suggested"]["position"]
            m = r.get("measured", {})
            d = float(m.get("median_hip_below_knee_torso_units", 0))
            where = f"{abs(d):.2f} torso-lengths {'below' if d > 0 else 'above'} your knees"
            heels = "lifted" if m.get("heels_lifted") else "flat"
            return SQUAT_POINTS[pos], f"Position {pos}", (
                f"Over the 5-breath hold your hip crease stayed {where} (median), knee angle about "
                f"{m.get('median_knee_angle_deg', '?')}°, heels {heels}. Book: Position 1 = hip crease well below the "
                "knees, feet straight, heels flat; Position 2 = deep but heels up or toes out; Position 3 = about "
                "chair height; Position 4 = higher than that. "
                f"That's Position {pos}, worth {SQUAT_POINTS[pos]}/10 here (P1 10, P2 7, P3 4, P4 1).")
        if test == "sit_and_rise":
            sc = int(r["suggested"]["score"])
            m = r.get("measured", {})
            return sc, f"{sc} of 10", (
                f"The book starts you at 10 and takes off 1 point per assist. The camera saw "
                f"{m.get('hand_touches', 0)} hand-to-floor and {m.get('knee_touches', 0)} knee-to-floor touch(es), "
                f"so 10 − {10 - sc} = {sc}. It can't see bracing on a wall, leaning on the side of a leg, or a lost "
                "balance; each of those you report takes off one more point.")
        if test == "couch":
            sides = [x for x in r["sides"] if x.get("position")]
            if not sides:
                return None
            worst = min((x["position"] for x in sides), key=lambda l: COUCH_POINTS.get(l, 0))
            per = "; ".join(f"side {i + 1}: {x['position']} (torso lean {x.get('median_torso_lean_deg', '?')}°, "
                            f"hip extension {x.get('median_hip_extension_deg', '?')}°)" for i, x in enumerate(sides))
            return COUCH_POINTS.get(worst, 0), f"{worst} (weaker side)", (
                f"Furthest position held with glutes squeezed and 5 full breaths — {per}. Front knee down = P1; "
                "front foot planted = P2; torso upright (under 25° lean) = P3. The weaker side counts: "
                f"{worst} = {COUCH_POINTS.get(worst, 0)}/10 here (Floor P3 10, P2 8, P1 6, Couch P2 4, Couch P1 2).")
        if test == "airport_scanner":
            band = r["suggested"]["band"]
            m = r.get("measured", {})
            for prefix, pts in AIRPORT_POINTS:
                if band.startswith(prefix):
                    return pts, band.split(" — ")[0], (
                        f"Your hands lifted about {m.get('median_est_lift_in', 0)} in. above where they rested "
                        f"(median over the hold) and stayed up {round(100 * float(m.get('fraction_of_hold_lifted', 0)))}% "
                        "of the time. Book: 2+ in. held for 5 breaths = you own shoulder flexion; 1–2 in. = you can "
                        "reach it but don't own it; lifts but can't hold = some access; can't lift = well below "
                        f"baseline. → {pts}/10 here (10 / 7 / 4 / 1). Height comes from arm angle, assuming ~24 in. "
                        "shoulder-to-wrist.")
            return None
        if test in ("solec", "old_man"):
            sides = r["sides"]
            worst = max(int(x["touches"]) for x in sides)
            per = ", ".join(f"side {x['side']}: {x['touches']}" for x in sides)
            what = "20 seconds on one leg, eyes closed" if test == "solec" else "sock and shoe on and tied on one leg"
            return touch_points(worst), f"{worst} touch{'es' if worst != 1 else ''} (weaker side)", (
                f"Touches of the lifted foot during {what} — {per}. Book: 0 = mastery, 1–2 = pretty good, "
                f"3+ = needs work. The weaker side counts: {worst} → {touch_points(worst)}/10 here "
                "(0→10, 1→8, 2→7, 3→4, 4→3, 5+→1).")
    except (KeyError, TypeError, ValueError):
        return None
    return None


# ---------------------------------------------------------------- tests


class Test:
    """A test is a small state machine fed one Pose per frame."""

    title = "Free movement"
    framing = "Stand so your whole body is in view."

    def __init__(self, voice: Voice, args):
        self.voice, self.args = voice, args
        self.phase = "setup"
        self.instruction = self.framing
        self.cue = ""
        self.metrics: dict = {}
        self.done = False
        self.result: dict | None = None
        self.t0 = time.time()
        self.phase_t = self.t0
        self.script: deque = deque()
        self.last_hint = 0.0

    # helpers
    def say(self, text: str, priority: bool = True) -> None:
        self.cue = text
        self.voice.say(text, priority)

    def hint(self, text: str, t: float, every: float = 6.0) -> None:
        if t - self.last_hint >= every:
            self.last_hint = t
            self.say(text, priority=False)

    def go(self, phase: str, t: float, instruction: str | None = None, speak: str | None = None) -> None:
        self.phase, self.phase_t = phase, t
        if instruction is not None:
            self.instruction = instruction
        if speak:
            self.say(speak)

    def schedule(self, t: float, items: list[tuple[float, str]]) -> None:
        self.script = deque((t + dt, text) for dt, text in items)

    def run_script(self, t: float) -> bool:
        """Speaks due lines; True when the script has finished."""
        while self.script and self.script[0][0] <= t:
            _, text = self.script.popleft()
            self.say(text)
        return not self.script

    def breaths(self, n: int, start: float = 0.0) -> list[tuple[float, str]]:
        words = ["one", "two", "three", "four", "five", "six", "seven", "eight"]
        out = []
        for i in range(n):
            base = start + i * 5.0
            out += [(base, "Breathe in"), (base + 2.5, f"and out. {words[i].capitalize()}.")]
        return out

    def full_body(self, pose: Pose) -> bool:
        return pose.vis(NOSE, L_HIP, R_HIP, thr=0.5) and (pose.vis(L_AN, thr=0.4) or pose.vis(R_AN, thr=0.4))

    def update(self, pose: Pose | None, t: float) -> None:  # override
        self.instruction = "Camera preview. Pose detection is running."

    def finish(self, result: dict, speak: str = "Nice work. That's the test.") -> None:
        self.result = {"type": "result", "test": self.key, "title": self.title, **result}
        scored = book_points(self.key, self.result)
        if scored:
            pts, label, how = scored
            self.result.update({"points": pts, "max_points": 10, "score_label": label, "explanation": how})
            speak = f"{speak} You scored {pts} out of 10: {label}."
        if getattr(self.args, "next", ""):
            speak = f"{speak} Next up: {self.args.next}."
        self.say(speak)
        self.phase, self.done = "done", True

    key = "free"


class Squat(Test):
    key, title = "squat", "Vital Sign 7: Squat Test"
    framing = "Stand side-on to the camera, about 2–3 m away, with your whole body and feet in view."

    def __init__(self, voice, args):
        super().__init__(voice, args)
        self.steady = Steady(1.0, 0.12)
        self.hold: list[dict] = []
        self.ready_since = None
        self.stand_hip_y: float | None = None
        voice.prefetch(["Breathe in"] + [f"and out. {w}." for w in ["One", "Two", "Three", "Four", "Five"]])

    def update(self, pose, t):
        if pose is None or not self.full_body(pose):
            if self.phase in ("setup",):
                self.hint("I can't see all of you yet. " + self.framing, t, 8)
            return
        s = pose.side(pose.best_side())
        T = pose.torso()
        hip, kn, an = pose.pt(s["hip"]), pose.pt(s["kn"]), pose.pt(s["an"])
        knee_ang = angle(hip, kn, an)
        depth = (hip[1] - kn[1]) / T  # >0: hip crease below knee
        foot_len = float(np.linalg.norm(pose.pt(s["ft"]) - pose.pt(s["heel"]))) or 1.0
        heel_lift = (pose.pt(s["ft"])[1] - pose.pt(s["heel"])[1]) / foot_len  # >~0.35: heel up
        self.metrics = {"knee_angle": round(knee_ang), "hip_below_knee": round(depth, 2), "heel_lift": round(heel_lift, 2)}

        if self.phase == "setup":
            self.ready_since = self.ready_since or t
            self.stand_hip_y = hip[1] if self.stand_hip_y is None else 0.8 * self.stand_hip_y + 0.2 * hip[1]
            if t - self.ready_since > 1.5:
                self.go("descend", t,
                        "Feet hip-width or wider, toes pointing straight ahead. Reach your arms forward and squat as low as you can. Hold the bottom for 5 breaths.",
                        "Great, I can see you. Feet pointing straight ahead. Reach your arms forward and squat down as low as you comfortably can.")
        elif self.phase == "descend":
            dropped = self.stand_hip_y is not None and (hip[1] - self.stand_hip_y) / T > 0.35
            if (knee_ang < 140 or dropped) and self.steady.update(hip, T, t):
                self.go("hold", t, "Hold the bottom position. Breathe slowly through your nose.")
                self.schedule(t, [(0, "Hold it right there.")] + self.breaths(5, 1.5) + [(27, "And stand up.")])
            elif t - self.phase_t > 20:
                self.hint("Lower yourself down slowly, as deep as you can, then stay there.", t, 8)
        elif self.phase == "hold":
            self.hold.append({"depth": depth, "knee": knee_ang, "heel": heel_lift})
            if depth < 0.05 and knee_ang > 75 and t - self.phase_t > 3:
                self.hint("If you can, sink a little lower.", t, 9)
            elif heel_lift > 0.4 and t - self.phase_t > 3:
                self.hint("Try to keep your heels on the floor.", t, 9)
            if self.run_script(t):
                self.finish(self.score())

    def score(self) -> dict:
        h = self.hold or [{"depth": 0, "knee": 180, "heel": 0}]
        depth = float(np.median([x["depth"] for x in h]))
        knee = float(np.median([x["knee"] for x in h]))
        heels_up = float(np.mean([x["heel"] > 0.35 for x in h])) > 0.5
        if depth > 0.15 and not heels_up:
            pos = 1
        elif depth > 0.05:
            pos = 2
        elif knee <= 115:
            pos = 3
        else:
            pos = 4
        bands = {1: "Ninja. Maintain", 2: "Almost there", 3: "Needs work", 4: "Top priority"}
        return {
            "suggested": {"position": pos, "score": 5 - pos, "band": bands[pos]},
            "measured": {"median_hip_below_knee_torso_units": round(depth, 2), "median_knee_angle_deg": round(knee),
                         "heels_lifted": heels_up, "hold_frames": len(self.hold)},
            "confirm": ["Were your toes pointing straight ahead (not turned out)? Turned-out feet make it Position 2."],
        }


class SitAndRise(Test):
    key, title = "sit_and_rise", "Vital Sign 1: Sit-and-Rise Test"
    framing = "Stand facing the camera (or side-on), 2–3 m away, with your whole body and the floor in view."

    def __init__(self, voice, args):
        super().__init__(voice, args)
        self.floor = None
        self.stand_h = None
        self.hand = Debounce(0.25, 0.4)
        self.knee = Debounce(0.3, 0.4)
        self.ready_since = None
        self.seated_since = None
        self.up_since = None
        self.events: list[str] = []

    def update(self, pose, t):
        if pose is None or not self.full_body(pose):
            if self.phase == "setup":
                self.hint("I need to see your whole body and the floor. " + self.framing, t, 8)
            return
        T = pose.torso()
        hip = pose.mid(L_HIP, R_HIP)
        feet_y = max(pose.pt(i)[1] for i in (L_AN, R_AN, L_HEEL, R_HEEL, L_FT, R_FT) if pose.v[i] > 0.3)
        if self.phase == "setup":
            self.floor = feet_y if self.floor is None else 0.8 * self.floor + 0.2 * feet_y
            self.stand_h = (self.floor - hip[1]) / T
            self.ready_since = self.ready_since or t
            if t - self.ready_since > 2:
                self.go("down", t,
                        "Cross one foot in front of the other and lower yourself to a cross-legged sit — no hands, no knees, nothing to hold.",
                        "Okay. Cross one foot in front of the other, and sit down cross-legged without using your hands.")
            return
        hip_h = (self.floor - hip[1]) / T  # hip height above floor in torso units
        wrist_floor = any(pose.v[w] > 0.4 and pose.pt(w)[1] > self.floor - 0.15 * T for w in (L_WR, R_WR))
        knee_floor = any(pose.v[k] > 0.4 and pose.pt(k)[1] > self.floor - 0.12 * T for k in (L_KN, R_KN))
        seated = hip_h < 0.45 * self.stand_h
        self.metrics = {"hip_height": round(hip_h, 2), "hand_touches": self.hand.count, "knee_touches": self.knee.count}

        if self.phase == "down":
            if not seated and self.hand.update(wrist_floor, t):
                self.events.append("hand on floor while lowering")
                self.say("Hand down. Try it without hands next time.", priority=False)
            if seated:
                self.seated_since = self.seated_since or t
                if t - self.seated_since > 1.5:
                    self.go("up", t, "Now stand up without using your hands or knees. Lean forward and reach your arms out for balance.",
                            "Nice. Now stand back up, no hands, no knees. Lean forward and reach your arms out.")
            else:
                self.seated_since = None
        elif self.phase == "up":
            rising = not seated  # hips have left the seated position
            if self.hand.update(wrist_floor and rising, t):
                self.events.append("hand on floor while rising")
                self.say("Hand down, that counts as one.", priority=False)
            if self.knee.update(knee_floor and rising, t):
                self.events.append("knee on floor while rising")
                self.say("Knee down, that counts as one.", priority=False)
            if hip_h > 0.85 * self.stand_h:
                self.up_since = self.up_since or t
                if t - self.up_since > 1.0:
                    assists = self.hand.count + self.knee.count
                    self.finish({
                        "suggested": {"score": max(0, 10 - assists), "band": band_sit(max(0, 10 - assists))},
                        "measured": {"hand_touches": self.hand.count, "knee_touches": self.knee.count, "events": self.events},
                        "confirm": ["Did you brace on a wall or furniture, support yourself on the side of your leg, or lose your balance? Subtract 1 for each."],
                    }, "And you're up. Nice work.")
            else:
                self.up_since = None


def band_sit(score: int) -> str:
    return "Gold standard" if score == 10 else "Close" if score >= 7 else "Room to improve" if score >= 3 else "Very difficult"


class Couch(Test):
    key, title = "couch", "Vital Sign 3: Couch Test"
    framing = "Set the camera side-on to the wall or couch, low down, so your whole body is in view."

    def __init__(self, voice, args):
        super().__init__(voice, args)
        self.side_i = 0
        self.samples: list[dict] = []
        self.sides: list[dict] = []
        self.steady = Steady(2.0, 0.08)
        voice.prefetch([f"Breath {w}. Squeeze your glutes, breathe in." for w in ("one", "two", "three", "four", "five")] + ["Relax... and slowly breathe out."])

    def breath_script(self) -> list[tuple[float, str]]:
        out, t = [], 0.0
        # one numbered cue per breath (counting each half aloud sounded like 10 breaths)
        for w in ("one", "two", "three", "four", "five"):
            out += [(t, f"Breath {w}. Squeeze your glutes, breathe in."), (t + 6.0, "Relax... and slowly breathe out.")]
            t += 12.5
        return out

    def classify(self, pose: Pose) -> dict | None:
        T = pose.torso()
        legs = []
        for s in ("L", "R"):
            d = pose.side(s)
            if pose.vis(d["hip"], d["kn"], d["an"], thr=0.3):
                legs.append((s, d))
        if len(legs) < 2:
            return None
        # rear leg: the one whose ankle is above its knee (shin up the wall)
        rear = min(legs, key=lambda sd: pose.pt(sd[1]["an"])[1] - pose.pt(sd[1]["kn"])[1])
        front = [l for l in legs if l[0] != rear[0]][0]
        r, f = rear[1], front[1]
        sh = pose.mid(L_SH, R_SH)
        hip = pose.pt(r["hip"])
        torso_lean = from_vertical(sh, hip)
        hip_ext = angle(sh, hip, pose.pt(r["kn"]))
        front_knee_down = abs(pose.pt(f["kn"])[1] - pose.pt(r["kn"])[1]) < 0.25 * T
        front_knee_ang = angle(pose.pt(f["hip"]), pose.pt(f["kn"]), pose.pt(f["an"]))
        if front_knee_down:
            pos = 1
        elif torso_lean < 25:
            pos = 3
        else:
            pos = 2
        return {"rear": rear[0], "position": pos, "torso_lean": torso_lean, "hip_ext": hip_ext, "front_knee": front_knee_ang}

    def update(self, pose, t):
        variant = self.args.variant
        if self.phase == "setup":
            # first side: wait until hips, knees and ankles have been in view for 1.5 s
            if self.side_i == 0:
                if pose is None or not pose.vis(L_HIP, R_HIP, L_KN, R_KN, thr=0.4):
                    self.ready_since = None
                    self.hint("I can't see your hips and legs yet. " + self.framing, t, 8)
                    return
                self.ready_since = getattr(self, "ready_since", None) or t
                if t - self.ready_since < 1.5:
                    return
            side_name = "first" if self.side_i == 0 else "other"
            self.go("settle", t,
                    ("Floor version: back knee in the corner where the floor meets the wall, shin up the wall. "
                     if variant == "floor" else "Couch version: back to the couch, knee in the seat, shin up the back cushion. ")
                    + "Work up to the furthest position where you can still squeeze your glutes and breathe fully, then hold still.",
                    f"Set up the {side_name} leg in the furthest position where you can still squeeze your glutes and breathe. Hold still when you're there.")
            return
        if pose is None or not pose.vis(L_HIP, R_HIP, thr=0.4):
            self.hint("I can't see your hips and legs. Move the camera side-on and low.", t, 9)
            return
        c = self.classify(pose)
        if c:
            self.metrics = {"position": c["position"], "torso_lean": round(c["torso_lean"]), "hip_extension": round(c["hip_ext"])}
        if self.phase == "settle":
            if c and self.steady.update(pose.mid(L_SH, R_SH), pose.torso(), t) and t - self.phase_t > 4:
                self.go("breathe", t, "Squeeze your glutes and inhale for a slow 5, relax and exhale for a slow 5. Five times.")
                self.schedule(t, self.breath_script())
                self.samples = []
            elif t - self.phase_t > 45:
                self.hint("Take your time. Hold still once you're in position.", t, 12)
        elif self.phase == "breathe":
            if c:
                self.samples.append(c)
            if self.run_script(t):
                self.sides.append(self.summarize())
                self.side_i += 1
                if self.side_i < 2:
                    self.say("Good. Come out of it, and switch sides.")
                    self.steady = Steady(2.0, 0.08)
                    self.phase = "setup"
                    self.phase_t = t + 4  # give them a moment
                else:
                    self.finish({"sides": self.sides, "variant": variant,
                                 "confirm": ["Could you keep your glutes squeezed and get full breaths in the position recorded? If not, the result is one position lower.",
                                             "Floor P3 = excellent, Floor P2 = close to end range, Floor P1 = fairly good, Couch P2 = baseline, Couch P1 = starting point."]},
                                "Great work on both sides.")

    def summarize(self) -> dict:
        if not self.samples:
            return {"position": None, "note": "pose not detected during the hold"}
        pos = int(np.median([s["position"] for s in self.samples]))
        label = f"{self.args.variant.capitalize()} P{pos}" if self.args.variant == "floor" else f"Couch P{min(pos, 2)}"
        return {"rear_leg_landmark_side": max(set(s["rear"] for s in self.samples), key=[s["rear"] for s in self.samples].count),
                "position": label,
                "median_torso_lean_deg": round(float(np.median([s["torso_lean"] for s in self.samples]))),
                "median_hip_extension_deg": round(float(np.median([s["hip_ext"] for s in self.samples])))}


class AirportScanner(Test):
    key, title = "airport_scanner", "Vital Sign 5: Airport Scanner Arms-Raise Test"
    framing = "Put the camera on the floor side-on to you, so your whole body lying face down is in view."

    def __init__(self, voice, args):
        super().__init__(voice, args)
        self.samples: list[float] = []
        self.ready_since = None
        self.rest: list[float] = []  # arm angle while resting on the floor: the zero for the lift

    def update(self, pose, t):
        if pose is None:
            return
        s = pose.side(pose.best_side())
        if not pose.vis(s["sh"], s["wr"], s["hip"], thr=0.35):
            if self.phase in ("setup", "lift"):
                self.hint("I need to see your arms, shoulders and hips from the side.", t, 9)
            return
        sh, wr, hip = pose.pt(s["sh"]), pose.pt(s["wr"]), pose.pt(s["hip"])
        axis = sh - hip
        arm = wr - sh
        # signed angle of the arm above the body axis (image y is down; "up" is -y)
        a_axis = math.atan2(-axis[1], axis[0] if axis[0] != 0 else 1e-6)
        a_arm = math.atan2(-arm[1], arm[0] if arm[0] != 0 else 1e-6)
        elev = math.degrees(a_arm - a_axis)
        if axis[0] < 0:
            elev = -elev
        elev = (elev + 180) % 360 - 180
        base = float(np.median(self.rest)) if self.rest else 0.0
        rel = elev - base  # lift relative to arms resting on the floor
        lift_in = 24.0 * math.sin(math.radians(max(0.0, rel)))  # ~24 in shoulder-to-wrist
        self.metrics = {"arm_elevation_deg": round(elev, 1), "rest_deg": round(base, 1), "est_lift_in": round(lift_in, 1)}
        if self.phase == "setup":
            prone = abs(sh[1] - hip[1]) < 0.6 * abs(sh[0] - hip[0])
            if prone:
                if self.ready_since is None:
                    self.ready_since = t
                    self.say("Rest your arms on the floor overhead for a moment while I calibrate.")
                if t - self.ready_since > 1.0:
                    self.rest.append(elev)
                if t - self.ready_since > 4:
                    self.go("lift", t, "Arms straight overhead, thumbs up, forehead and belly on the floor. Lift your arms as high as you can and hold for 5 breaths.",
                            "Okay. Arms straight overhead, thumbs up, forehead down. Lift your arms as high as you can.")
                    self.schedule(t, [(3.0, "Hold it there.")] + self.breaths(5, 4.0) + [(29.5, "And relax.")])
            else:
                self.hint("Lie face down with your arms straight overhead.", t, 8)
        elif self.phase == "lift":
            if t - self.phase_t > 3.0:
                self.samples.append(lift_in)
                if lift_in < 0.5 and t - self.phase_t > 6:
                    self.hint("Keep lifting, and keep breathing.", t, 8)
            if self.run_script(t):
                held = float(np.mean([x > 0.5 for x in self.samples])) if self.samples else 0
                med = float(np.median(self.samples)) if self.samples else 0
                if med >= 2 and held > 0.8:
                    band = "2+ in held — flexion is fine"
                elif med >= 1 and held > 0.6:
                    band = "1–2 in — can access, don't own it"
                elif held > 0.2:
                    band = "Lifts but can't hold — some access"
                else:
                    band = "Can't lift — well below baseline"
                self.finish({"suggested": {"band": band},
                             "measured": {"median_est_lift_in": round(med, 1), "fraction_of_hold_lifted": round(held, 2)},
                             "confirm": ["The lift height is estimated from arm angle (assumes ~24 in shoulder-to-wrist). Does it match what you felt?"]},
                            "Nice. Relax your arms.")


class ShoulderRotation(Test):
    key, title = "shoulder_rotation", "Vital Sign 5: Shoulder Rotation Test"
    framing = "Lie face up, knees bent. Put the camera at your feet or head, raised about a metre and tilted down, so both arms are in view."

    def update(self, pose, t):
        if self.phase == "setup":
            # wait until shoulders, elbows and wrists have been in view for 1.5 s
            if pose is None or not pose.vis(L_SH, L_EL, L_WR, R_SH, R_EL, R_WR, thr=0.4):
                self.ready_since = None
                self.hint("I can't see your arms yet. Lie down with both arms and shoulders in view.", t, 8)
                return
            self.ready_since = getattr(self, "ready_since", None) or t
            if t - self.ready_since < 1.5:
                return
            self.go("press", t, "Arms out to the sides, elbows at 90 degrees, palms up. Roll your shoulders back and press the backs of your wrists and hands into the floor as hard as you can for 5 breaths.",
                    "Arms out to the sides, elbows bent to ninety degrees. Roll your shoulders back and press the backs of your hands into the floor, hard.")
            self.schedule(t, [(2.0, "Press.")] + self.breaths(5, 3.0) + [(28.5, "And relax.")])
            return
        if pose is not None:
            els = [angle(pose.pt(a), pose.pt(b), pose.pt(c)) for a, b, c in ((L_SH, L_EL, L_WR), (R_SH, R_EL, R_WR))
                   if pose.vis(a, b, c, thr=0.4)]
            if els:
                self.metrics = {"elbow_angles": [round(e) for e in els]}
                if any(abs(e - 90) > 30 for e in els):
                    self.hint("Bend your elbows to about ninety degrees.", t, 10)
        if self.run_script(t):
            self.finish({"suggested": {"band": "subjective"},
                         "measured": self.metrics,
                         "confirm": ["Rate the force you could press with, 1 (barely touches) to 5 (strong, hands flat), for each side. Then do one Rotator Cuff Mobilization and run this test again to compare."]},
                        "Relax. How strong did that feel?")


class OneLeg(Test):
    """SOLEC (20 s timed) and Old Man Balance (until shoe is tied)."""

    def __init__(self, voice, args, timed: bool):
        super().__init__(voice, args)
        self.timed = timed
        self.side_i = 0
        self.lifted_since = None
        self.down = Debounce(0.2, 0.3)
        self.touches = 0
        self.down_since = None
        self.results: list[dict] = []
        self.ready_since = None

    def update(self, pose, t):
        if pose is None or not pose.vis(L_AN, R_AN, L_HIP, R_HIP, thr=0.4):
            if self.phase == "setup":
                self.hint("Stand facing the camera with your whole body and both feet in view.", t, 8)
            return
        T = pose.torso()
        diff = abs(pose.pt(L_AN)[1] - pose.pt(R_AN)[1]) / T
        up = diff > 0.15
        both_down = diff < 0.07
        self.metrics = {"foot_gap": round(diff, 2), "touches": self.touches, "side": self.side_i + 1}
        if self.phase == "setup":
            self.ready_since = self.ready_since or t
            if t - self.ready_since > 1.5 and both_down:
                which = "first" if self.side_i == 0 else "other"
                if self.timed:
                    self.go("lift", t, "Close your eyes and lift one foot. Hold for 20 seconds; I'll count any time your foot touches down.",
                            f"Close your eyes, and lift your {which} foot. I'll time twenty seconds.")
                else:
                    self.go("lift", t, "Balance on one leg and put on your sock and lace-up shoe, then tie it — without putting that foot down. Put the foot down when you're finished.",
                            f"Stand on one leg and put your sock and shoe on the {which} foot, and tie it, without putting it down. Put it down when you're done.")
        elif self.phase == "lift":
            if up:
                self.lifted_since = self.lifted_since or t
                self.go("balance", t, None)
                self.touches = 0
                self.down = Debounce(0.2, 0.3)
        elif self.phase == "balance":
            elapsed = t - self.lifted_since
            if self.down.update(both_down, t):
                self.down_since = t
                if not self.timed:
                    self.say("Foot down. Keep it down to finish this side, or lift it to keep going." if elapsed > 10
                             else "Touch. Lift it again.")
            if not both_down:
                self.down_since = None
            if self.timed:
                if elapsed >= 20:
                    self.next_side(t, self.down.count)
                elif self.down.state and self.down_since and t - self.down_since < 0.1:
                    self.say("Touch. Lift it again.", priority=False)
            else:
                # finished: foot down for 2 s after at least 10 s of balancing
                if self.down.state and self.down_since and t - self.down_since > 2 and elapsed > 10:
                    self.next_side(t, max(0, self.down.count - 1))
            self.metrics["touches"] = self.down.count

    def next_side(self, t, touches):
        self.results.append({"side": self.side_i + 1, "touches": touches, "band": "Mastery" if touches == 0 else "Pretty good" if touches <= 2 else "Needs work"})
        self.side_i += 1
        self.lifted_since = None
        if self.side_i < 2:
            self.say(f"{'Time. ' if self.timed else 'Side one done. '}That side had {touches} touch{'es' if touches != 1 else ''}. "
                     f"{'Now the other leg.' if self.timed else 'Switch legs, and stand on both feet for a moment.'}")
            self.phase, self.phase_t, self.ready_since = "setup", t, t
        else:
            self.finish({"sides": self.results,
                         "confirm": ["Which leg did you stand on first? (Side 1 is the first one you did.)"]},
                        f"{'Time. ' if self.timed else ''}That side had {touches} touch{'es' if touches != 1 else ''}. All done.")


class Solec(OneLeg):
    key, title = "solec", "Vital Sign 8: SOLEC (Stand On one Leg, Eyes Closed)"
    framing = "Stand facing the camera, near a wall for safety, with both feet in view."

    def __init__(self, voice, args):
        super().__init__(voice, args, timed=True)


class OldMan(OneLeg):
    key, title = "old_man", "Vital Sign 8: Old Man Balance Test"
    framing = "Start barefoot, facing the camera, with a pair of socks and a pair of lace-up shoes on the floor in front of you."

    def __init__(self, voice, args):
        super().__init__(voice, args, timed=False)


TESTS = {c.key: c for c in (Test, Squat, SitAndRise, Couch, AirportScanner, ShoulderRotation, Solec, OldMan)}


# ---------------------------------------------------------------- main loop


def ensure_model() -> str:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / "pose_landmarker_full.task"
    if not path.exists():
        log("downloading pose model…")
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(MODEL_URL, tmp)
        tmp.replace(path)
    return str(path)


def draw(frame: np.ndarray, pose: Pose | None, thick: int = 3, radius: int = 5) -> np.ndarray:
    out = frame.copy()
    if pose is not None:
        for a, b in CONNECTIONS:
            if pose.v[a] > 0.4 and pose.v[b] > 0.4:
                cv2.line(out, tuple(int(x) for x in pose.p[a]), tuple(int(x) for x in pose.p[b]), (80, 220, 80), thick, cv2.LINE_AA)
        for i in range(len(pose.p)):
            if pose.v[i] > 0.4:
                cv2.circle(out, tuple(int(x) for x in pose.p[i]), radius, (0, 255, 0), -1, cv2.LINE_AA)
    return out


def to_cells(img_bgr: np.ndarray, cols: int, rows: int) -> str:
    """Half-block cells: each cell is '▀' with the top pixel as foreground, the bottom as background.

    Packed as Claude Code's Raster wants: little-endian u32 triplets [codePoint, fg, bg], base64.
    """
    small = cv2.resize(img_bgr, (cols, rows * 2), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB).astype(np.uint32)
    packed = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
    out = np.empty((rows, cols, 3), dtype="<u4")
    out[..., 0] = 0x2580
    out[..., 1] = packed[0::2]
    out[..., 2] = packed[1::2]
    return base64.b64encode(out.tobytes()).decode()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", default="free", choices=sorted(TESTS))
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--width", type=int, default=480)
    ap.add_argument("--variant", default="floor", choices=["floor", "couch"])
    ap.add_argument("--png", action="store_true", help="also write annotated PNG frames (terminal surface)")
    ap.add_argument("--cells", default="", help="COLSxROWS: also emit the annotated frame as half-block terminal cells (works inside tmux)")
    ap.add_argument("--mute", action="store_true")
    ap.add_argument("--next", default="", help="guided assessment: the next test's name, announced at the end")
    ap.add_argument("--max-seconds", type=float, default=300)
    ap.add_argument("--voice-file", default="", help="JSON with ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID from the plugin's settings; read, then deleted")
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    control = out / "control.json"
    if control.exists():
        control.unlink()

    keys = load_keys()
    if args.voice_file and Path(args.voice_file).exists():
        try:
            keys.update({k: v for k, v in json.loads(Path(args.voice_file).read_text()).items() if v})
        finally:
            Path(args.voice_file).unlink(missing_ok=True)
    voice = Voice(keys, enabled=not args.mute)
    emit({"type": "status", "message": f"voice: {voice.engine}"})

    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mpt
        from mediapipe.tasks.python import vision

        landmarker = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=mpt.BaseOptions(model_asset_path=ensure_model()),
            running_mode=vision.RunningMode.VIDEO, num_poses=1,
            min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5, min_tracking_confidence=0.5))
    except Exception as exc:
        emit({"type": "error", "message": f"could not start MediaPipe: {exc}"})
        return

    cap = cv2.VideoCapture(args.camera)
    # the first run asks for camera access; keep trying while the prompt is up
    deadline = time.time() + 60
    while not cap.isOpened() and time.time() < deadline:
        emit({"type": "status", "message": "waiting for camera access (allow \"Move Coach Camera\" if macOS asks)"})
        time.sleep(1)
        cap = cv2.VideoCapture(args.camera)
    # as in the ARFun tracker: small MJPG frames, always the newest one
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    if not cap.isOpened():
        emit({"type": "error", "message": "could not open the camera (check System Settings → Privacy & Security → Camera → Move Coach Camera)"})
        return

    test = TESTS[args.test](voice, args)
    voice.say(f"{test.title.split(': ', 1)[-1]}. {test.framing}")
    emit({"type": "status", "message": "camera started"})

    start = time.time()
    last_emit = 0.0
    gen = 0
    ctl_mtime = 0.0
    dark_since: float | None = None
    warned_dark = False
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                emit({"type": "error", "message": "camera read failed"})
                break
            t = time.time()
            h0, w0 = frame.shape[:2]
            scale = args.width / w0
            frame = cv2.resize(frame, (args.width, int(h0 * scale)))
            h, w = frame.shape[:2]
            if float(frame.mean()) < 8:
                dark_since = dark_since or t
                if not warned_dark and t - dark_since > 3:
                    warned_dark = True
                    emit({"type": "status", "message": f"camera {args.camera} is sending black frames: lid closed, lens covered, or camera permission missing. Try another camera index (e.g. 1 for an iPhone via Continuity Camera)."})
            else:
                dark_since = None
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            res = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), int((t - start) * 1000))
            pose = Pose(res.pose_landmarks[0], w, h) if res.pose_landmarks else None

            test.update(pose, t)

            if control.exists() and control.stat().st_mtime != ctl_mtime:
                ctl_mtime = control.stat().st_mtime
                try:
                    cmd = json.loads(control.read_text()).get("cmd")
                except Exception:
                    cmd = None
                if cmd == "stop":
                    if not test.done:
                        test.result = {"type": "result", "test": test.key, "title": test.title, "stopped": True, "partial": test.metrics}
                    break
                if cmd == "next" and isinstance(test, OneLeg) and test.phase == "balance":
                    test.next_side(t, test.down.count)

            if t - last_emit >= 1.0 / args.fps:
                last_emit = t
                gen += 1
                # selfie view: mirror the picture (landmarks mirrored to match)
                shown = cv2.flip(frame, 1)
                lm = [] if pose is None else [[round(1 - x / w, 4), round(y / h, 4), round(float(v), 2)]
                                              for (x, y), v in zip(pose.p, pose.v)]
                ok, jpg = cv2.imencode(".jpg", shown, [cv2.IMWRITE_JPEG_QUALITY, 55])
                msg = {"type": "frame", "gen": gen, "w": w, "h": h, "jpeg": base64.b64encode(jpg).decode(), "lm": lm,
                       "phase": test.phase, "instruction": test.instruction, "cue": test.cue, "metrics": test.metrics,
                       "elapsed": round(t - start, 1)}
                if args.cells:
                    cols, rows = (int(x) for x in args.cells.lower().split("x"))
                    msg["cells"] = to_cells(cv2.flip(draw(frame, pose, thick=9, radius=8), 1), cols, rows)
                    msg["cols"], msg["rows"] = cols, rows
                if args.png:
                    png = out / f"frame-{gen % 3}.png"
                    tmp = out / "frame.tmp.png"
                    cv2.imwrite(str(tmp), cv2.flip(draw(frame, pose), 1))
                    tmp.replace(png)
                    msg["png"] = str(png)
                emit(msg)

            if test.done or t - start > args.max_seconds:
                break
    finally:
        cap.release()
        if test.result is None:
            test.result = {"type": "result", "test": test.key, "title": test.title, "timed_out": True, "partial": test.metrics}
        emit(test.result)
        time.sleep(2.5)  # let the last cue finish


if __name__ == "__main__":
    main()
