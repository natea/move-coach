---
name: built-to-move-mobility-test
description: "Guided self-assessment of the physical-mobility and strength Vital Signs from \"Built to Move\" (Kelly & Juliet Starrett): VS1 Sit-and-Rise Test, VS3 Couch Test, VS5 Airport Scanner Arms-Raise + Shoulder Rotation Test, VS7 Squat Test, VS8 SOLEC + Old Man Balance Test. Use when the user wants to test their vital signs, run a mobility assessment, retest mobility/balance/squat/hips/shoulders, score Built to Move tests, or track mobility scores over time. Walks through each test, scores it with the book's rubric, logs results to CSV, and prescribes the matching practice."
---

<!-- argument-hint: [all | quick | 1 | 3 | 5 | 7 | 8 | history] [person's name] -->

# Built to Move: Mobility & Strength Vital Signs Test

This skill runs the five **movement-quality** Vital Signs in one session (about 15–20 min). The lifestyle inventories (VS2 breath, VS4 steps, VS6 food, VS9 sitting, VS10 sleep) take days to measure and are covered in the book itself (or the `starrett-built-to-move` skill, if installed).

| VS | Test | What it measures |
|---|---|---|
| 1 | Sit-and-Rise | Hip range, leg and trunk strength, balance, coordination |
| 3 | Couch Test | Hip extension and quad length, with glute control |
| 5 | Airport Scanner Arms-Raise + Shoulder Rotation | Shoulder flexion and external rotation |
| 7 | Squat Test | Hip flexion, hip external rotation, knee flexion, ankle dorsiflexion |
| 8 | SOLEC + Old Man Balance | Static balance without vision; dynamic single-leg balance |

## How to run a session

1. **Arguments.** `all` (default) runs all five Vital Signs. `quick` runs the 5-minute demo (Sit-and-Rise, Squat, SOLEC; see Quick mode). `1`, `3`, `5`, `7` or `8` runs one. `history` shows past results from the log and trends. A name after the argument (`quick Alex`) says who is being tested.
2. **Who's being tested (ask once).** If no name was given, ask "Who's taking the test?" Results, the Move Score and the EEG baseline belong to that person. With the camera, call `{action: "person", name}` before anything else; its reply says whether they're new or returning (and their current score). Log every row with their name.
3. **Safety check (ask once).** "Any current injury, recent surgery, dizziness, or pain that's sharp rather than achy?" If yes, skip tests that load that area and suggest a clinician (book ch07 red flags: fever, night sweats, dizziness, nausea, unexplained weight change). Tell the user to stop at any sharp pain, keep breathing, and stay near a wall for the balance tests.
4. **Equipment checklist.** Barefoot, clear floor, a wall next to the floor, a couch (fallback for VS3), a ~2 ft pipe, broomstick or rolled towel (VS5), a timer (VS8), a pair of socks and a pair of lace-up shoes (VS8). A helper is useful for timing and counting touches.
5. **One test at a time.** Give the steps from the protocol below in a short numbered list. Wait for the user to do it and report back. Ask only the questions needed to score it. Never guess a result.
6. **Score it** with the rubric, state the band in a single line, and log it (see Logging).
7. **After all tests, summarize**: a table of scores and bands, a comparison with the previous session if the log has one, the **two or three highest-priority practices** (worst bands first; if bands tie, put hip extension first, since it's the book's pick if you could do only one mobilization), and when to retest each.

Keep the coaching short. The user is mid-movement, so give one test per message.

## Camera mode (Move Coach mod)

When the tool `mcp__move-coach__camera_test` is available, use it for each test instead of asking the person to count:

1. Ask once which camera to use. 0 is the built-in camera; 1 is usually an iPhone through Continuity Camera, which is best because it can sit across the room and see the whole body. Ask which side of the body to show (side-on for squat, couch and airport scanner; facing the camera for sit-and-rise and the balance tests; for shoulder rotation, camera at the feet or head, raised about a metre and tilted down, or overhead, so both arms are in view).
2. Call `camera_test` with `{action: "start", test, camera}`. For the Couch Test add `variant: "floor"` or `"couch"`. Test keys: `sit_and_rise`, `couch`, `airport_scanner`, `shoulder_rotation`, `squat`, `solec`, `old_man`. The pane shows the book illustration and the live camera with the green pose landmarks, and the coach talks them through it out loud. Give a one-line setup reminder, then **end your turn**. Don't poll.
3. The result arrives as a message from the move-coach plugin containing `points`, `score_label`, `explanation`, `measured` and `confirm`. Reply in this order:
   1. **Score first**, in one line: `<Test>: <score_label> → <points>/10`, plus the running Move Score if known.
   2. **How it was computed:** restate `explanation` in plain words. Cover what the camera measured (the numbers), which book rule or band that falls into, and how the band maps to points. Say the 60-point total and the band-to-points mapping are the mod's convention, not the book's.
   3. **Confirm:** ask each `confirm` question. If an answer changes the band, say so and give the corrected score.
   4. **Log it** (CSV below; put `camera` in `notes`).
   The camera's numbers are estimates. Say so whenever the measurement looks implausible.
4. `{action: "snapshot"}` returns the current frame, useful when someone asks "am I doing it right?" or when framing looks wrong. `{action: "stop"}` ends a test early.

**Optional EEG (Muse headband).** If the person wants it, start `{action: "eeg_start"}` (optionally `muse: "<name>"`) once at the beginning. It's independent of the camera tests. The pane shows live traces for TP9/AF7/AF8/TP10, a contact dot per sensor (green good, grey flat = no skin contact, red noisy), and relative band power (delta, theta, alpha, beta, gamma). While it runs, each test result carries `eeg_mean_relative_band_power`. Mention it in one line after the score, as an observation ("alpha was higher during the breathing holds"), never as a diagnosis or as part of the score. Movement makes EEG noisy, so treat readings from the moving tests (sit-and-rise, squat, balance) with caution. Right after the EEG connects, and before the first test, run `{action: "baseline"}` (30 s eyes open, then 30 s eyes closed, with spoken cues). It refuses unless the Muse is connected and streaming, and while a camera test runs. Its result arrives as a message: report whether it's valid and the alpha change with eyes closed, and log it as step 0 in `built-to-move-eeg-log.csv`. Later test results carry `eeg_vs_baseline` (each band as a ratio to the eyes-open baseline); use those ratios in the one-line EEG note. Before the baseline, make sure the person can hear the cues: the tool reply names the audio output device. Use `{action: "eeg_stop"}` at the end.

Without the tool, use the manual protocol below.

### Guided assessment (`all` with the camera)

Run the seven camera tests back to back, without the person choosing the next one:

| Step | Test key | Name to announce | Camera |
|---|---|---|---|
| 1 | `sit_and_rise` | Sit-and-Rise | facing, whole body and floor |
| 2 | `squat` | Squat Test | side-on, whole body (turn 90°; the camera stays put) |
| 3 | `solec` | SOLEC | facing, near a wall |
| 4 | `old_man` | Old Man Balance | facing, hips to feet, a pair of socks and lace-up shoes |
| 5 | `airport_scanner` | Airport Scanner | move the camera to the floor, side-on, lying face down |
| 6 | `shoulder_rotation` | Shoulder Rotation | at the feet or head, raised ~1 m, tilted down |
| 7 | `couch` (`variant: "floor"`) | Couch Test | side-on, low, 2–3 m from the wall |

The standing tests come first and share one camera spot; the camera moves only for the floor tests, and the Couch Test (which needs a wall) is last.

1. Set the person (`{action: "person", name}`), then do the safety check and the equipment list once, at the start. Ask which camera once.
2. Start step 1 with `{action: "start", test, camera, step: 1, total: 7, next: "<name of step 2>"}`. Pass `next: ""` on the last step. The pane shows "Test N of 7 · next: …" and the coach says "Next up: …" when the test ends. Every test waits until it can see the person before it starts counting.
3. When a result arrives, reply in the usual order: score, how it was computed, confirm questions. Then **stop and wait for the answers**. They are the only thing the person has to type.
4. Once the answers are in, log the result. Correct the pane score with `{action: "correct", test, points, label}` if the answers changed it. Then, **in the same reply**, give the one-line camera setup for the next test and start it right away. Don't wait for "ready"; the test waits until it can see them.
5. Between tests, "skip" moves on without logging, "redo" restarts the same step, and "stop" ends the assessment and goes to the summary.
6. After step 7, give the session summary (see "How to run a session", step 7).

### Quick mode (`quick`, about 5 minutes, for demos)

Three tests that need no camera move and no equipment beyond a wall:

| Step | Test key | Name to announce | Camera |
|---|---|---|---|
| 1 | `sit_and_rise` | Sit-and-Rise | facing, whole body and floor |
| 2 | `squat` | Squat Test | side-on, whole body (turn 90°) |
| 3 | `solec` | SOLEC | facing, near a wall |

1. Ask who's being tested and call `{action: "person", name}`. For a demo volunteer, use their first name: a new name starts an empty profile, and the presenter's results stay untouched. If they've been tested before and want a fresh board, `{action: "reset"}` clears their Move Score (history is kept).
2. Keep the setup to one breath: "No injuries, dizziness or sharp pain? Barefoot, clear floor." Ask which camera once.
3. If a Muse is connected and streaming, run `{action: "baseline", seconds: 15}` first (a shorter baseline suits a demo). Without a Muse, skip it.
4. Run the three steps exactly like the guided assessment, with `total: 3`.
5. Summary: their three scores, a **Quick score out of 30** (the 60-point Move Score covers all six scored tests), one practice to keep, and an invitation to run `all` for the full picture.



---

## Test protocols & scoring

### VS1: Sit-and-Rise Test
1. Barefoot. Cross one foot in front of the other.
2. Lower into a cross-legged sit without touching anything.
3. Stand back up without hands or knees. Leaning forward with arms out is allowed.

**Ask:** "Count each time you did any of these, going down and coming up: hand on a wall or furniture, hand on the floor, knee on the floor, side of the leg on the floor, lost your balance."
**Score** = 10 − number of assists (minimum 0).

| Score | Band |
|---|---|
| 10 | Gold standard. Maintain |
| 7–9 | Close |
| 3–6 | Room to improve. Prioritize |
| 0–2 | Very difficult. Top priority |

**Practice:** ≥30 min/day of floor sitting (cross-legged, 90/90, long sit, one-leg-up). Do 2 of these 4 every couple of days: Seated Hamstring Mob (2–5 min/side), Hamstring Lockouts (2 → 4–5 min/side), Hip Opener (2–3 min/leg), Elevated Pigeon (2–5 min/side). The practice is the same at every score. **Retest:** daily, whenever you get up off the floor.

### VS3: Couch Test (each side separately)
Use the floor/wall version if possible; it's the truer test. Breathing protocol in every position: **squeeze the glutes hard and inhale for a slow 5, relax and exhale for a slow 5, 5 times.** Move to the next position only if the current one is easy, the glutes stay firm (reach back and check), and you can breathe fully.
- **Floor P1:** Knee in the corner where the floor meets the wall, shin up the wall, toes pointed. Other knee on the floor, hands on the floor, torso leaning forward.
- **Floor P2:** From P1, plant the front foot with that knee at 90°. Torso still forward.
- **Floor P3:** From P2, bring the torso upright, parallel to the wall.
- Couch fallback, **Couch P1:** back to the couch, knee where the seat meets the back cushion, shin up the back, other foot on the floor, torso upright. **Couch P2:** front foot up on the seat.

**Ask:** "On each side, what's the furthest position where you kept your glutes firm and got all 5 full breaths?"

| Result | Band |
|---|---|
| Floor P3 | Excellent. Maintain |
| Floor P2 | Close to end range |
| Floor P1 | Fairly good |
| Couch P2 | Baseline. Build up |
| Couch P1 / can't | Starting point. Top priority |

A difference between sides is normal; log both. **Practice:** Couch Stretch at your current position, 3 min/side, ideally daily (do 1-min bouts if needed). Quad-Thigh roll, 2–3 → 4–5 min/side. Extra: Kneeling Isometric 1 min/side, Standing and Couch Isometrics 30 s/side, glute squeezes 15 min/day. **Retest:** every Couch Stretch session.

### VS5 Part 1: Airport Scanner Arms-Raise Test
1. Lie face down, arms straight overhead, holding the pipe in the crook between thumb and forefinger, **thumbs up**.
2. Keep your forehead and belly on the floor and your elbows straight.
3. Lift your arms as high as possible and **hold for 5 breaths**, without holding your breath.

**Ask:** "Could you lift off the floor? Roughly how high: under 1 inch, 1–2 inches, or more than 2? Did you hold it for all 5 breaths?"

| Result | Band |
|---|---|
| 2+ in., held 5 breaths | Flexion is fine. Maintain |
| 1–2 in. | You can reach it but don't own it |
| Lifts but can't hold or breathe | Some access |
| Can't lift | Well below baseline. Top priority |

### VS5 Part 2: Shoulder Rotation Test
1. Lie face up, knees bent, arms out to the sides, **elbows at 90°**, palms up. No ball for the test itself; the ball is only for the Rotator Cuff Mobilization afterward (a lacrosse or tennis ball).
2. Roll your shoulders back in their sockets and press the backs of your wrists and hands into the floor as hard as you can. **Hold for 5 breaths.**

**Ask:** "Rate the force from 1 (barely touches) to 5 (strong press, hands flat on the floor), each side." The book doesn't score this; the 1–5 rating is this skill's convention so it can be tracked. Note in the log that it's subjective.
**Then:** have the user do one **Rotator Cuff Mobilization** (ball where the shoulder meets the upper arm, elbow at 90°, 10 contract/relax + 10 rotations per side) and **retest right away**. Log both the before and after ratings.

**VS5 practice:** Wall Hang (10 breaths), T-Spine Mob 2 (10 arm raises × 3 ball positions per side), Rotator Cuff Mob (10 + 10 per side). Use external-rotation cues during the day. **Retest:** weekly.

### VS7: Squat Test
1. Feet straight ahead, hip-width or wider, weight balanced between heel and ball.
2. Lower as deep as you can. Arms forward and torso leaning are fine; a rounded back is fine.
3. Hold the deepest position for **5 breaths**.

**Ask:** "Which matches best?"

| Position | Description | Band |
|---|---|---|
| 1 | Butt a few inches off the floor, hip crease well below the knees, feet straight, heels flat | Ninja. Maintain |
| 2 | Deep, but toes turned out or heels lifted | Almost there |
| 3 | Hips at about chair height (about 90°) | Needs work |
| 4 | As low as you can go, above chair height | Top priority |

**Practice:** P1: Deep Squat Hang-Out ≥3 min/day, at least 3×/week. P2: hang-outs, working toward straight feet and heels down. P3–4: Sit-Stands (arms forward, 2–3 s down, touch the seat 1 s, stand), 1 rep on day 1 and +1 per day up to 20 at chair height, then coffee-table height, then a full squat. Extra: Tabata Squats (20 s on / 10 s off × 8; score is your lowest round). **Retest:** daily for hang-out people, weekly for Sit-Stand people.

### VS8 Part 1: SOLEC (Stand On one Leg, Eyes Closed)
Near a wall. Barefoot, eyes closed, lift one foot. **Hold for 20 s**, counting how many times the foot touches down. Then the other side.

### VS8 Part 2: Old Man Balance Test
Start barefoot with a pair of socks and a pair of lace-up shoes on the floor in front of you, so nothing has to come off between sides. Stand on your right leg. Pick up a sock, put it on your left foot, then put on the shoe and tie it, all without the left foot touching down. Put both feet down to switch sides (this doesn't count as a touch). Then stand on your left leg and do the same with the other sock and shoe on your right foot. Count the touches on each side.

**Score (both parts, each side)** = number of touches.

| Touches | Band |
|---|---|
| 0 | Mastery |
| 1–2 | Pretty good |
| 3+ | Needs work. Do the full practice |

**Practice:** do both tests daily (SOLEC while brushing your teeth; shoes on Old Man style). Y-Balance (3 breaths per reach, 3 directions per leg). Jump rope 100–200 on both feet + 50–100 on each foot, or bounce 50 + 25 per foot. Bone Saw 3–5 min/side. Calf Stretch Crossover 5–10 breaths. Foot Play. **Retest:** daily.

---

## Logging

Append one row per measurement to a CSV. Use the path the user names; otherwise use `./built-to-move-mobility-log.csv` in the current working directory. Create it with this header if it doesn't exist:

```
date,person,vital_sign,test,side,result,score,best,points,band,notes
```

- `date`: ISO date (YYYY-MM-DD).
- `person`: the name of the person being tested, as set at the start (the `person` field in a camera result).
- `side`: `left`, `right` or `both`.
- `result`: the raw observation (e.g. `floor P2`, `1-2 in held`, `3 touches`, `position 3`).
- `score`: a number where one exists. Sit-and-Rise 0–10. Couch: Couch P1 = 1, Couch P2 = 2, Floor P1 = 3, Floor P2 = 4, Floor P3 = 5. Airport Scanner: can't lift = 0, lift-no-hold = 1, 1–2 in = 2, 2+ in = 3. Shoulder Rotation 1–5 (subjective). Squat: 5 − position (P1 = 4 … P4 = 1). SOLEC/Old Man = touches (lower is better).
- `best`: the best possible `score` for that test, so each row shows what you're aiming for: sit-and-rise 10, couch 5, airport-scanner 3, shoulder-rotation 5, squat 4, solec / old-man 0 (touches, lower is better).
- `points`: Move Coach's 0–10 points for that row (10 is always best), the mod's convention rather than the book's. Couch P1 2 / P2 4 / Floor P1 6 / P2 8 / P3 10; squat P1 10 / P2 7 / P3 4 / P4 1; airport scanner 2+ in 10 / 1–2 in 7 / lift-no-hold 4 / can't lift 1; touches 0→10, 1→8, 2→7, 3→4, 4→3, 5+→1; sit-and-rise = score. Leave blank for shoulder-rotation (not scored).
- `band`: the band label from the tables above.

Example rows:
```
2026-10-04,Nate,1,sit-and-rise,both,hand on floor + knee down,8,10,8,close,
2026-10-04,Nate,3,couch,left,floor P2,4,5,8,close to end range,
2026-10-04,Alex,3,couch,right,floor P1,3,5,6,fairly good,
2026-10-04,Alex,5,shoulder-rotation,left,before 2 / after 4,4,5,,subjective,after 1 RC mob
2026-10-04,Alex,8,solec,right,3 touches,3,0,4,needs work,
```

If an existing log has no `person` column, add it after `date` and fill the old rows with the name the user gives for them before appending.

**EEG log** (`./built-to-move-eeg-log.csv`, only when a Muse is used): one row per test or baseline phase.

```
date,time,person,step,test,side,delta,theta,alpha,beta,gamma,contact_TP9,contact_AF7,contact_AF8,contact_TP10,notes
```

Baseline phases are step 0 (`baseline-eyes-open`, `baseline-eyes-closed`) with their `good_contact_share` per sensor; tests leave the contact columns blank and put `eeg_vs_baseline` alpha in `notes`.

**`history` mode:** read the CSV for one person (ask whose history if more than one person is logged), show the latest score for each test and side next to the previous one and the first one, and flag any band that improved or worsened.

## Boundaries

- These are the book's self-screens, not a clinical exam. Present bands as "where you are today," never as a diagnosis.
- Always use the book's exact numbers. For background, mechanisms or the other five Vital Signs, load `starrett-built-to-move` if it's installed (chapter files: ch01, ch03, ch05, ch08, ch09); otherwise point to the book.
