import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CoachView, EegView, Scores, TestKey } from '../types'

const PANE = 'move-coach'
const TOOL = 'camera_test'

const TESTS: Record<TestKey, { title: string; images: { file: string; caption: string }[] }> = {
  free: { title: 'Camera preview', images: [] },
  sit_and_rise: {
    title: 'VS1 · Sit-and-Rise Test',
    images: [{ file: 'sit-and-rise', caption: 'Cross one foot in front, sit cross-legged, stand up: no hands, no knees' }],
  },
  couch: {
    title: 'VS3 · Couch Test',
    images: [
      { file: 'couch-floor-p1', caption: 'Floor P1: knee in the corner, shin up the wall, hands down' },
      { file: 'couch-floor-p2', caption: 'Floor P2: front foot planted, knee at 90°' },
      { file: 'couch-floor-p3', caption: 'Floor P3: torso upright' },
      { file: 'couch-couch-p1', caption: 'Couch P1: knee in the seat, shin up the back' },
      { file: 'couch-couch-p2', caption: 'Couch P2: front foot up on the seat' },
    ],
  },
  airport_scanner: {
    title: 'VS5 · Airport Scanner Arms-Raise Test',
    images: [{ file: 'airport-scanner', caption: 'Face down, thumbs up, lift the pipe and hold 5 breaths' }],
  },
  shoulder_rotation: {
    title: 'VS5 · Shoulder Rotation Test',
    images: [{ file: 'shoulder-rotation', caption: 'Elbows at 90°, press the backs of your wrists down for 5 breaths' }],
  },
  squat: {
    title: 'VS7 · Squat Test',
    images: [
      { file: 'squat-p1', caption: 'Position 1: deep, feet straight, heels down' },
      { file: 'squat-p3', caption: 'Position 3: about chair height' },
      { file: 'squat-p4', caption: 'Position 4: as low as you can go' },
    ],
  },
  solec: {
    title: 'VS8 · SOLEC (Stand On one Leg, Eyes Closed)',
    images: [{ file: 'solec', caption: 'Eyes closed, one foot up, 20 seconds per side' }],
  },
  old_man: {
    title: 'VS8 · Old Man Balance Test',
    images: [{ file: 'old-man', caption: 'On one leg: sock on, shoe on, tie it' }],
  },
}

const EMPTY: CoachView = {
  isRunning: false,
  test: 'free',
  title: TESTS.free.title,
  phase: 'idle',
  instruction: '',
  cue: '',
  status: '',
  error: '',
  metrics: {},
  elapsed: 0,
  gen: 0,
  w: 480,
  h: 360,
  jpeg: '',
  png: '',
  cells: '',
  cols: 0,
  rows: 0,
  lm: [],
  result: '',
  isStartedByTool: false,
}

const view = atom({ plugin: 'move-coach', key: 'view' } as const, EMPTY)
const scores = atom({ plugin: 'move-coach', key: 'scores' } as const, {} as Scores)
/** who is being tested; scores, history and the EEG baseline are kept per person */
const person = atom({ plugin: 'move-coach', key: 'person' } as const, '')
/** before profiles there was one unnamed set of results; it becomes this person's */
const LEGACY_PERSON = 'Nate'

const EEG_EMPTY: EegView = { isRunning: false, status: '', error: '', device: '', channels: [], raw: [], bands: {}, quality: [], gen: 0 }
const eeg = atom({ plugin: 'move-coach', key: 'eeg' } as const, EEG_EMPTY)
const BAND_ORDER = ['delta', 'theta', 'alpha', 'beta', 'gamma'] as const
const BAND_COLORS: Record<string, string> = { delta: '#7b61ff', theta: '#2f9bff', alpha: '#1fbf75', beta: '#f2a900', gamma: '#ef5b5b' }
const TRACE_COLORS = ['#2f9bff', '#1fbf75', '#f2a900', '#ef5b5b']

/** The tests the book scores (Shoulder Rotation is subjective), 10 points each. */
export const SCORED: { key: TestKey; short: string }[] = [
  { key: 'sit_and_rise', short: 'Sit-and-Rise' },
  { key: 'couch', short: 'Couch' },
  { key: 'airport_scanner', short: 'Arms Raise' },
  { key: 'squat', short: 'Squat' },
  { key: 'solec', short: 'SOLEC' },
  { key: 'old_man', short: 'Old Man' },
]

export function totalOf(s: Scores): { points: number; max: number; done: number } {
  const done = SCORED.filter(t => s[t.key] !== undefined)
  return { points: done.reduce((n, t) => n + s[t.key]!.points, 0), max: SCORED.length * 10, done: done.length }
}

/** ▰▰▰▰▱▱▱▱▱▱ for points out of 10. */
export function bar(points: number): string {
  const n = Math.max(0, Math.min(10, Math.round(points)))
  return '▰'.repeat(n) + '▱'.repeat(10 - n)
}

/** Band sums and per-channel good-contact counts over one baseline phase. */
export type PhaseAcc = { sums: Record<string, number>; n: number; good: number[] }

const emptyAcc = (): PhaseAcc => ({ sums: {}, n: 0, good: [] })

/** Adds one EEG message (bands over the last second, per-channel quality) to a phase. */
export function addSample(acc: PhaseAcc, bands: Record<string, number>, quality: string[]): void {
  for (const b of BAND_ORDER) acc.sums[b] = (acc.sums[b] ?? 0) + (bands[b] ?? 0)
  quality.forEach((q, i) => (acc.good[i] = (acc.good[i] ?? 0) + (q === 'good' ? 1 : 0)))
  acc.n++
}

const r3 = (x: number) => Math.round(x * 1000) / 1000

/**
 * Mean relative band power per phase, the share of samples with good contact per channel,
 * and whether it's usable: at least 2 channels in good contact ≥70% of each phase.
 * Alpha should rise with the eyes closed (typically 1.5–3×); under 1.2× usually means
 * poor contact, eyes not actually closed, or tension.
 */
export function summarizeBaseline(open: PhaseAcc, closed: PhaseAcc, channels: string[]) {
  const side = (a: PhaseAcc) => ({
    ...Object.fromEntries(BAND_ORDER.map(b => [b, a.n ? r3((a.sums[b] ?? 0) / a.n) : 0])),
    good_contact_share: Object.fromEntries(channels.map((c, i) => [c, a.n ? Math.round(((a.good[i] ?? 0) / a.n) * 100) / 100 : 0])),
    samples: a.n,
  }) as Record<string, number> & { good_contact_share: Record<string, number>; samples: number }
  const eyes_open = side(open)
  const eyes_closed = side(closed)
  const goodChannels = (s: typeof eyes_open) => Object.values(s.good_contact_share).filter(g => g >= 0.7).length
  const alpha_ratio = eyes_open.alpha ? Math.round(((eyes_closed.alpha ?? 0) / eyes_open.alpha) * 100) / 100 : 0
  const problems: string[] = []
  if (open.n < 50 || closed.n < 50) problems.push('too few EEG samples (the stream dropped)')
  if (goodChannels(eyes_open) < 2 || goodChannels(eyes_closed) < 2) problems.push('fewer than 2 sensors in good contact for most of a phase')
  const valid = problems.length === 0
  if (valid && alpha_ratio < 1.2) problems.push(`alpha barely rose with the eyes closed (${alpha_ratio}×): check the eyes were closed and the jaw relaxed`)
  return { eyes_open, eyes_closed, alpha_ratio_closed_over_open: alpha_ratio, valid, problems }
}

const BONES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
]

type Run = { dir: string; stream: AsyncGenerator<unknown, unknown> & { return: (v?: unknown) => unknown } }
let current: Run | undefined
/** ElevenLabs settings from the plugin's options; blank key = macOS `say` */
let voiceOpts = { key: '', voiceId: '' }
let homeDir: string | undefined
const bookPaths = new Map<string, string | null>()

/** An illustration: your own copy in ~/.config/move-coach/book wins, then the plugin's assets; missing is fine. */
async function bookFile($: EngineInterface, name: string): Promise<string | undefined> {
  if (bookPaths.has(name)) return bookPaths.get(name) ?? undefined
  if (homeDir === undefined) homeDir = (await $.process.run(['/usr/bin/printenv', 'HOME'])).stdout.trim()
  let hit: string | null = null
  for (const dir of [`${homeDir}/.config/move-coach/book`, `${$.plugin.root}/assets/book`]) {
    if ((await $.process.run(['/bin/test', '-f', `${dir}/${name}`])).exitCode === 0) {
      hit = `${dir}/${name}`
      break
    }
  }
  bookPaths.set(name, hit)
  return hit ?? undefined
}
let eegRun: Run | undefined
/** band power summed over the running camera test, for the result message */
let eegAcc: { sums: Record<string, number>; n: number } = { sums: {}, n: 0 }
/** when the last EEG sample arrived, to tell a live stream from a stalled one */
let lastEegAt = 0
type Timer = ReturnType<EngineInterface['clock']['after']>
type BaselineRun = { phase: 'settle' | 'open' | 'switch' | 'closed'; open: PhaseAcc; closed: PhaseAcc; timers: Timer[]; seconds: number; audio: string }
let baselineRun: BaselineRun | undefined
/** the latest valid baseline's eyes-open bands, the reference for each test's EEG */
let lastBaseline: { at: string; eyes_open: Record<string, number> } | undefined
/** the current person's store-key suffix */
let personId = ''

/** "Alex Smith" → "alex-smith": the store-key form of a name. */
export function personIdOf(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** A store key scoped to the current person. */
const pkey = (base: 'scores' | 'history' | 'baseline' | 'baselines') => `${base}:${personId}`

type People = Record<string, { name: string; createdAt: string }>

/** Switches the profile: loads that person's scores and baseline. New names start empty. */
async function switchPerson($: EngineInterface, name: string): Promise<{ name: string; isNew: boolean; scores: Scores }> {
  const id = personIdOf(name)
  const people = ((await $.store.get('people')) as People | undefined) ?? {}
  const isNew = !people[id]
  const display = isNew ? name.trim() : people[id]!.name
  if (isNew) await $.store.set('people', { ...people, [id]: { name: display, createdAt: new Date().toISOString() } })
  personId = id
  await $.store.set('person', display)
  const saved = ((await $.store.get(pkey('scores'))) as Scores | undefined) ?? {}
  await update($, scores, () => saved)
  await update($, person, () => display)
  lastBaseline = ((await $.store.get(pkey('baseline'))) as typeof lastBaseline) ?? undefined
  return { name: display, isNew, scores: saved }
}

/** Moves the pre-profile results (unscoped keys) to the legacy person, once. */
async function migrateLegacy($: EngineInterface): Promise<void> {
  if (await $.store.get('people')) return
  const id = personIdOf(LEGACY_PERSON)
  for (const base of ['scores', 'history', 'baseline', 'baselines'] as const) {
    const v = await $.store.get(base)
    if (v !== undefined) await $.store.set(`${base}:${id}`, v)
  }
  await $.store.set('people', { [id]: { name: LEGACY_PERSON, createdAt: new Date().toISOString() } })
  await $.store.set('person', LEGACY_PERSON)
}

/** Person switch from the tool or command: refuses mid-test, else switches and describes the profile. */
async function changePerson($: EngineInterface, name: string | undefined): Promise<string> {
  const people = ((await $.store.get('people')) as People | undefined) ?? {}
  if (!name?.trim() || !personIdOf(name)) {
    const list = Object.values(people).map(p => p.name).join(', ') || 'none'
    return `Testing ${await read($, person)}. People with results: ${list}. Give a name to switch.`
  }
  if ((await read($, view)).isRunning || baselineRun) return 'Not switched: a test or baseline is running. Stop it first.'
  const r = await switchPerson($, name)
  return r.isNew ? `New profile: ${r.name}. Their Move Score starts empty, and they need their own EEG baseline.` : `Switched to ${r.name}. ${scoreLine(r.name, r.scores)}.${lastBaseline ? '' : ' No EEG baseline yet.'}`
}

/** "Alex: 28/60 (3 of 6 tests)" or "Alex: no tests yet". */
function scoreLine(name: string, s: Scores): string {
  const t = totalOf(s)
  return t.done ? `${name}: Move Score ${t.points}/${t.max} (${t.done} of ${SCORED.length} tests)` : `${name}: no tests yet`
}
let uvPath: string | undefined
const imageCache = new Map<string, string>()

/** Camera frame plus the green pose skeleton, as one SVG (remote surfaces). */
export function cameraSvg(v: Pick<CoachView, 'w' | 'h' | 'jpeg' | 'lm'>): string {
  const { w, h } = v
  const pt = (i: number) => v.lm[i]
  const ok = (i: number) => pt(i) !== undefined && pt(i)![2]! > 0.4
  const lines = BONES.filter(([a, b]) => ok(a) && ok(b))
    .map(([a, b]) => `<line x1="${(pt(a)![0]! * w).toFixed(1)}" y1="${(pt(a)![1]! * h).toFixed(1)}" x2="${(pt(b)![0]! * w).toFixed(1)}" y2="${(pt(b)![1]! * h).toFixed(1)}"/>`)
    .join('')
  const dots = v.lm
    .map((p, i) => (ok(i) && i > 10 ? `<circle cx="${(p[0]! * w).toFixed(1)}" cy="${(p[1]! * h).toFixed(1)}" r="4"/>` : ''))
    .join('')
  const img = v.jpeg && v.jpeg.length < 120_000 ? `<image href="data:image/jpeg;base64,${v.jpeg}" width="${w}" height="${h}"/>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#111"/>${img}` +
    `<g stroke="#39ff5a" stroke-width="3" stroke-linecap="round">${lines}</g>` +
    `<g fill="#00ff3c" stroke="#063" stroke-width="1">${dots}</g></svg>`
  )
}

function bookSvg(b64: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 520" width="260" height="260">` +
    `<rect width="520" height="520" fill="#fff"/>` +
    `<image href="data:image/jpeg;base64,${b64}" width="520" height="520" preserveAspectRatio="xMidYMid meet"/></svg>`
  )
}

/** One line of the helper's stdout, applied to the view. */
export function applyLine(v: CoachView, msg: Record<string, unknown>): CoachView {
  switch (msg.type) {
    case 'frame':
      return {
        ...v,
        gen: Number(msg.gen),
        w: Number(msg.w),
        h: Number(msg.h),
        jpeg: String(msg.jpeg ?? ''),
        png: String(msg.png ?? ''),
        cells: String(msg.cells ?? ''),
        cols: Number(msg.cols ?? 0),
        rows: Number(msg.rows ?? 0),
        lm: (msg.lm as number[][]) ?? [],
        phase: String(msg.phase ?? v.phase),
        instruction: String(msg.instruction ?? v.instruction),
        cue: String(msg.cue ?? v.cue),
        metrics: (msg.metrics as Record<string, unknown>) ?? {},
        elapsed: Number(msg.elapsed ?? 0),
      }
    case 'status':
      return { ...v, status: String(msg.message ?? '') }
    case 'error':
      return { ...v, error: String(msg.message ?? ''), isRunning: false }
    case 'result':
      return { ...v, result: JSON.stringify(msg, null, 2), phase: 'done', isRunning: false }
    default:
      return v
  }
}

async function findUv($: EngineInterface): Promise<string> {
  if (uvPath) return uvPath
  const found = await $.process.run(['/bin/zsh', '-lc', 'command -v uv'], { timeoutMs: 10_000 })
  uvPath = found.exitCode === 0 && found.stdout.trim() ? found.stdout.trim() : 'uv'
  return uvPath
}

const CAMERA_ALIASES: Record<string, string> = { logitech: 'c920|logitech|webcam', iphone: 'iphone', mac: 'macbook pro camera', macbook: 'macbook pro camera' }

/** Video devices as macOS lists them, in the index order OpenCV uses. */
async function listCameras($: EngineInterface): Promise<{ index: number; name: string }[]> {
  const listed = await $.process.run(['/bin/zsh', '-lc', 'ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1'], { timeoutMs: 15_000 })
  const video = listed.stdout.split('AVFoundation audio devices')[0] ?? ''
  return [...video.matchAll(/\[(\d+)\] (.+)/g)].map(m => ({ index: Number(m[1]), name: m[2]!.trim() })).filter(c => !/Capture screen/.test(c.name))
}

/** A camera number, or a name ("logitech", "iphone", "c920") matched against the device list. */
async function resolveCamera($: EngineInterface, camera: string | number | undefined): Promise<number> {
  if (camera === undefined || camera === '') return 0
  if (/^\d+$/.test(String(camera))) return Number(camera)
  const want = String(camera).toLowerCase()
  const pattern = new RegExp(CAMERA_ALIASES[want] ?? want.replace(/[^a-z0-9 ]/g, ''), 'i')
  const hit = (await listCameras($)).find(c => pattern.test(c.name) && !/desk view/i.test(c.name))
  return hit ? hit.index : 0
}

/** Brain waves as an SVG: one trace per channel, plus relative band power bars. */
export function eegSvg(v: EegView): string {
  const W = 480, rowH = 34, bandsH = 46
  const H = v.channels.length * rowH + bandsH
  const traces = v.raw
    .map((ch, i) => {
      if (!ch.length) return ''
      const mid = i * rowH + rowH / 2
      const scale = (rowH / 2 - 2) / 100 // ±100 µV fills the row
      const pts = ch.map((y, j) => `${((j / (ch.length - 1)) * (W - 52) + 50).toFixed(1)},${(mid - Math.max(-100, Math.min(100, y)) * scale).toFixed(1)}`).join(' ')
      const q = v.quality[i] ?? ''
      const qc = q === 'good' ? '#1fbf75' : q === 'flat' ? '#999' : '#ef5b5b'
      return (
        `<text x="2" y="${mid + 4}" font-size="11" fill="#bbb" font-family="monospace">${v.channels[i]}</text>` +
        `<circle cx="42" cy="${mid}" r="3.5" fill="${qc}"/>` +
        `<polyline points="${pts}" fill="none" stroke="${TRACE_COLORS[i % 4]}" stroke-width="1.3"/>`
      )
    })
    .join('')
  const y0 = v.channels.length * rowH + 6
  const bw = (W - 20) / BAND_ORDER.length
  const bars = BAND_ORDER.map((b, i) => {
    const frac = Math.max(0, Math.min(1, v.bands[b] ?? 0))
    const x = 10 + i * bw
    return (
      `<rect x="${x}" y="${y0}" width="${bw - 8}" height="12" rx="3" fill="#333"/>` +
      `<rect x="${x}" y="${y0}" width="${((bw - 8) * frac).toFixed(1)}" height="12" rx="3" fill="${BAND_COLORS[b]}"/>` +
      `<text x="${x}" y="${y0 + 28}" font-size="11" fill="#ccc" font-family="sans-serif">${b} ${Math.round(frac * 100)}%</text>`
    )
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#111"/>${traces}${bars}</svg>`
}

const SPARK = '▁▂▃▄▅▆▇█'
/** One channel as a terminal sparkline, ±100 µV. */
export function sparkline(ch: number[], width = 48): string {
  if (!ch.length) return ''
  const step = ch.length / width
  return Array.from({ length: width }, (_, i) => {
    const y = ch[Math.floor(i * step)] ?? 0
    return SPARK[Math.max(0, Math.min(7, Math.round(((Math.max(-100, Math.min(100, y)) + 100) / 200) * 7)))]
  }).join('')
}

/** A test's band power next to the latest valid baseline (eyes open), as ratios. */
function vsBaseline(brain: Record<string, number>): Record<string, unknown> {
  if (!lastBaseline) return { eeg_baseline: 'none: run action "baseline" for a resting reference' }
  const ref = lastBaseline.eyes_open
  return {
    eeg_baseline_eyes_open: ref,
    eeg_baseline_at: lastBaseline.at,
    eeg_vs_baseline: Object.fromEntries(BAND_ORDER.map(b => [b, ref[b] ? Math.round(((brain[b] ?? 0) / ref[b]!) * 100) / 100 : null])),
  }
}

const BASELINE_PHASE = { settle: 'get still', open: 'eyes open', switch: 'close your eyes', closed: 'eyes closed' } as const

/** The pane's baseline line: the phase and seconds left while it runs, the outcome after. */
export function baselineLine(b: NonNullable<EegView['baseline']>, now = Date.now()): string {
  if (b.phase === 'done' || b.phase === 'cancelled') return `Baseline ${b.summary}`
  return `Baseline · ${BASELINE_PHASE[b.phase]} · ${Math.max(0, Math.ceil((b.endsAt - now) / 1000))} s`
}

function eegSummary(): Record<string, number> | undefined {
  if (!eegAcc.n) return undefined
  return Object.fromEntries(BAND_ORDER.map(b => [b, Math.round(((eegAcc.sums[b] ?? 0) / eegAcc.n) * 1000) / 1000]))
}

async function stopEeg($: EngineInterface): Promise<void> {
  if (!eegRun) return
  const run = eegRun
  await $.fs.write(`${run.dir}/control.json`, JSON.stringify({ cmd: 'stop', at: Date.now() }))
  $.clock.after(4000, () => {
    if (eegRun === run) void run.stream.return(undefined)
  })
}

/** Why the EEG can't be used right now, or '' when a Muse is connected and samples are flowing. */
async function eegNotReady($: EngineInterface): Promise<string> {
  const ev = await read($, eeg)
  if (!eegRun || !ev.isRunning) return 'EEG is off. Start it first with action "eeg_start" (or /move-coach eeg), turn the Muse on, and wait for "connected" in the pane.'
  if (ev.error) return `EEG has an error: ${ev.error}`
  if (!ev.device || Date.now() - lastEegAt > 3000) return `The Muse isn't streaming yet (${ev.status || 'no samples'}). Wait until the pane shows the brain waves moving, then try again.`
  return ''
}

/** The Mac's default output device, so the person knows where the spoken cues go. */
async function audioOutput($: EngineInterface): Promise<string> {
  const out = await $.process.run(['/bin/zsh', '-lc', "system_profiler SPAudioDataType 2>/dev/null | grep -B8 'Default Output Device: Yes' | grep -E '^ {8}[^ ]' | head -1"], { timeoutMs: 15_000 })
  return out.stdout.trim().replace(/:$/, '') || 'unknown'
}

function speak($: EngineInterface, text: string): void {
  void $.process.run(['/usr/bin/say', '-r', '150', text], { timeoutMs: 30_000 })
}

async function setBaseline($: EngineInterface, b: EegView['baseline']): Promise<void> {
  await update($, eeg, v => ({ ...v, baseline: b }))
}

async function cancelBaseline($: EngineInterface, reason: string): Promise<boolean> {
  if (!baselineRun) return false
  for (const t of baselineRun.timers) t.cancel()
  baselineRun = undefined
  speak($, 'Baseline cancelled.')
  await setBaseline($, { phase: 'cancelled', endsAt: Date.now(), summary: `cancelled: ${reason}` })
  return true
}

/**
 * Resting EEG reference: settle 5 s, eyes open for `seconds`, 3 s to close the eyes,
 * eyes closed for `seconds`. Spoken cues; the result arrives as a message.
 * Only runs with the Muse connected and streaming, and no camera test running.
 */
async function startBaseline($: EngineInterface, seconds = 30): Promise<string> {
  const notReady = await eegNotReady($)
  if (notReady) return `Baseline not started. ${notReady}`
  if (baselineRun) return 'A baseline is already running.'
  if ((await read($, view)).isRunning) return 'Baseline not started: a camera test is running. Stop it first, or wait until it ends.'
  const s = Math.max(10, Math.min(120, Math.round(seconds)))
  const audio = await audioOutput($)
  const run: BaselineRun = { phase: 'settle', open: emptyAcc(), closed: emptyAcc(), timers: [], seconds: s, audio }
  baselineRun = run
  const at = (ms: number, fn: () => Promise<void>) => run.timers.push($.clock.after(ms, () => void (baselineRun === run && fn())))
  const t0 = Date.now()
  await setBaseline($, { phase: 'settle', endsAt: t0 + 5000, summary: '' })
  await $.ui.open({ id: PANE, title: 'Move Coach' })
  speak($, `Baseline. Sit still and relax your jaw. Eyes open, soft gaze, for ${s} seconds.`)
  at(5000, async () => {
    run.phase = 'open'
    await setBaseline($, { phase: 'open', endsAt: Date.now() + s * 1000, summary: '' })
  })
  at(5000 + s * 1000, async () => {
    run.phase = 'switch'
    speak($, 'Now close your eyes and stay still.')
    await setBaseline($, { phase: 'switch', endsAt: Date.now() + 3000, summary: '' })
  })
  at(8000 + s * 1000, async () => {
    run.phase = 'closed'
    await setBaseline($, { phase: 'closed', endsAt: Date.now() + s * 1000, summary: '' })
  })
  at(8000 + 2 * s * 1000, async () => {
    baselineRun = undefined
    speak($, 'Baseline done. Open your eyes.')
    const result = summarizeBaseline(run.open, run.closed, (await read($, eeg)).channels)
    const when = new Date().toISOString()
    if (result.valid) {
      lastBaseline = { at: when, eyes_open: Object.fromEntries(BAND_ORDER.map(b => [b, result.eyes_open[b] ?? 0])) }
      await $.store.set(pkey('baseline'), lastBaseline)
    }
    const history = ((await $.store.get(pkey('baselines'))) as unknown[] | undefined) ?? []
    await $.store.set(pkey('baselines'), [...history, { at: when, ...result }].slice(-100))
    await setBaseline($, {
      phase: 'done',
      endsAt: Date.now(),
      summary: `${result.valid ? '✓ valid' : '✗ not usable'} · alpha ×${result.alpha_ratio_closed_over_open} with eyes closed${result.problems.length ? ` · ${result.problems[0]}` : ''}`,
    })
    await $.prompt.submit({
      text:
        `Move Coach finished the EEG baseline (${s} s eyes open, ${s} s eyes closed; cues spoken on "${run.audio}"):\n\n\`\`\`json\n${JSON.stringify({ type: 'baseline', person: await read($, person), at: when, ...result }, null, 2)}\n\`\`\`\n\n` +
        'Report whether it is valid, what the alpha change with the eyes closed shows, and which sensors had poor contact. ' +
        'Log it as step 0 (baseline-eyes-open and baseline-eyes-closed rows) in built-to-move-eeg-log.csv. Later test results compare against it (alpha_vs_baseline).',
    })
  })
  return (
    `Baseline started: 5 s to settle, ${s} s eyes open, then ${s} s eyes closed (about ${Math.round((8 + 2 * s) / 5) * 5} s in all). ` +
    `Cues are spoken through "${audio}"; if the person can't hear that device, stop with action "stop" and fix the audio first. ` +
    'Tell the person to sit still with a relaxed jaw, then end your turn; the result arrives as a message.'
  )
}

/** Optional: stream a Muse headband through muse-lsl into the pane. */
async function startEeg($: EngineInterface, muse?: string): Promise<void> {
  if (eegRun && (await read($, eeg)).isRunning && !muse) {
    await $.ui.open({ id: PANE, title: 'Move Coach' })
    return
  }
  await stopEeg($)
  const uv = await findUv($)
  const dir = `/tmp/move-coach/eeg-${Date.now()}`
  await $.process.run(['/bin/mkdir', '-p', dir])
  // same app wrapper as the camera, so macOS asks about (and remembers) Bluetooth for it
  const argv = [`${$.plugin.root}/helper/launch.sh`, dir, uv, 'run', '--script', `${$.plugin.root}/helper/eeg_stream.py`, '--out-dir', dir, ...(muse ? ['--name', muse] : [])]
  await update($, eeg, () => ({ ...EEG_EMPTY, isRunning: true, status: 'starting EEG…' }))
  await $.ui.open({ id: PANE, title: 'Move Coach' })
  const stream = $.process.spawn({ argv }) as unknown as Run['stream']
  const run: Run = { dir, stream }
  eegRun = run
  void (async () => {
    let buf = ''
    let errTail = ''
    try {
      for await (const chunk of stream as AsyncIterable<{ stream: string; text: string }>) {
        if (chunk.stream === 'stderr') {
          errTail = (errTail + chunk.text).slice(-600)
          continue
        }
        buf += chunk.text
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (eegRun !== run) continue
          if (msg.type === 'eeg') {
            const bands = (msg.bands as Record<string, number>) ?? {}
            lastEegAt = Date.now()
            if (baselineRun?.phase === 'open') addSample(baselineRun.open, bands, (msg.quality as string[]) ?? [])
            if (baselineRun?.phase === 'closed') addSample(baselineRun.closed, bands, (msg.quality as string[]) ?? [])
            if ((await read($, view)).isRunning) {
              for (const b of BAND_ORDER) eegAcc.sums[b] = (eegAcc.sums[b] ?? 0) + (bands[b] ?? 0)
              eegAcc.n++
            }
            await update($, eeg, v => ({
              ...v,
              gen: v.gen + 1,
              device: String(msg.device ?? v.device),
              channels: (msg.channels as string[]) ?? v.channels,
              raw: (msg.raw as number[][]) ?? [],
              bands,
              quality: (msg.quality as string[]) ?? [],
              status: v.status.startsWith('no EEG samples') || v.status.startsWith('reconnecting') ? 'streaming' : v.status,
            }))
          } else if (msg.type === 'status') {
            await update($, eeg, v => ({ ...v, status: String(msg.message ?? '') }))
          } else if (msg.type === 'error') {
            await update($, eeg, v => ({ ...v, error: String(msg.message ?? ''), isRunning: false }))
          }
        }
      }
    } catch (err) {
      if (eegRun === run) await update($, eeg, v => ({ ...v, error: `EEG helper failed: ${String(err)} ${errTail}`, isRunning: false }))
    } finally {
      if (eegRun === run) {
        eegRun = undefined
        await update($, eeg, v => ({ ...v, isRunning: false }))
        await cancelBaseline($, 'the EEG stream stopped')
      }
    }
  })()
}

async function stop($: EngineInterface): Promise<void> {
  if (!current) return
  const run = current
  await $.fs.write(`${run.dir}/control.json`, JSON.stringify({ cmd: 'stop', at: Date.now() }))
  // the helper emits its result and exits; force it after a grace period
  $.clock.after(4000, () => {
    if (current === run) void run.stream.return(undefined)
  })
}

type Sequence = { step?: number; total?: number; next?: string }

async function start($: EngineInterface, test: TestKey, opts: { variant?: string; camera?: string | number; isStartedByTool: boolean } & Sequence): Promise<string> {
  await stop($)
  await cancelBaseline($, 'a camera test started')
  const cameraIndex = await resolveCamera($, opts.camera)
  // inside tmux the terminal can't draw images, so the helper also sends half-block cells
  const inTmux = (await $.process.run(['/usr/bin/printenv', 'TMUX'])).exitCode === 0
  const uv = await findUv($)
  const dir = `/tmp/move-coach/${Date.now()}`
  await $.process.run(['/bin/mkdir', '-p', dir])
  // the key goes in a private file the helper reads and deletes, never on the command line
  const voiceFile = `${dir}/voice.json`
  if (voiceOpts.key) {
    await $.fs.write(voiceFile, JSON.stringify({ ELEVENLABS_API_KEY: voiceOpts.key, ...(voiceOpts.voiceId ? { ELEVENLABS_VOICE_ID: voiceOpts.voiceId } : {}) }))
    await $.process.run(['/bin/chmod', '600', voiceFile])
  }
  // launch.sh runs the helper inside "Move Coach Camera.app": the Claude app starts this
  // session with camera responsibility disclaimed, so a direct child can never get a grant
  const argv = [
    `${$.plugin.root}/helper/launch.sh`, dir,
    uv, 'run', '--script', `${$.plugin.root}/helper/pose_coach.py`,
    '--test', test, '--out-dir', dir, '--png',
    '--variant', opts.variant ?? 'floor',
    '--camera', String(cameraIndex),
    ...(opts.next ? ['--next', opts.next] : []),
    ...(voiceOpts.key ? ['--voice-file', voiceFile] : []),
    ...(inTmux ? ['--cells', '80x23'] : []),
  ]
  eegAcc = { sums: {}, n: 0 }
  await update($, view, () => ({
    ...EMPTY,
    isRunning: true,
    test,
    title: TESTS[test].title,
    phase: 'starting',
    status: 'starting camera…',
    isStartedByTool: opts.isStartedByTool,
    step: opts.step,
    total: opts.total,
    nextTitle: opts.next,
  }))
  await $.ui.open({ id: PANE, title: 'Move Coach' })

  const stream = $.process.spawn({ argv }) as unknown as Run['stream']
  const run: Run = { dir, stream }
  current = run
  void (async () => {
    let buf = ''
    let errTail = ''
    try {
      for await (const chunk of stream as AsyncIterable<{ stream: string; text: string }>) {
        if (chunk.stream === 'stderr') {
          errTail = (errTail + chunk.text).slice(-600)
          continue
        }
        buf += chunk.text
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (current !== run) continue // replaced by a newer test
          await update($, view, v => applyLine(v, msg))
          if (msg.type === 'result' && typeof msg.points === 'number' && !msg.stopped) {
            const entry = { points: msg.points, label: String(msg.score_label ?? ''), at: new Date().toISOString() }
            const next = await update($, scores, s => ({ ...s, [test]: entry }))
            await $.store.set(pkey('scores'), next)
            const history = ((await $.store.get(pkey('history'))) as unknown[] | undefined) ?? []
            await $.store.set(pkey('history'), [...history, { test, ...entry }].slice(-500))
          }
          if (msg.type === 'result' && test !== 'free' && !msg.stopped) {
            const brain = eegSummary()
            msg = { ...msg, person: await read($, person) }
            if (brain) msg = { ...msg, eeg_mean_relative_band_power: brain, eeg_samples: eegAcc.n, ...vsBaseline(brain) }
            await $.prompt.submit({
              text:
                `Move Coach finished "${TESTS[test].title}" for ${await read($, person)}` +
                (typeof msg.points === 'number' ? ` — ${msg.points}/10 (${String(msg.score_label ?? '')})` : '') +
                `. Measured by camera:\n\n\`\`\`json\n${JSON.stringify(msg, null, 2)}\n\`\`\`\n\n` +
                'Use the built-to-move-mobility-test skill: report the score, explain how it was computed (from "explanation"), ask me each "confirm" question, adjust the score if my answers change it, then log it.',
            })
          }
        }
      }
    } catch (err) {
      if (current === run) await update($, view, v => ({ ...v, error: `helper failed: ${String(err)} ${errTail}`, isRunning: false }))
    } finally {
      if (current === run) {
        current = undefined
        await update($, view, v => (v.isRunning ? { ...v, isRunning: false, error: v.error || errTail.trim().split('\n').pop() || '' } : v))
      }
    }
  })()
  return dir
}


export const register: Register = (on, options) => {
  voiceOpts = { key: String(options.elevenlabs_api_key ?? '').trim(), voiceId: String(options.elevenlabs_voice_id ?? '').trim() }
  on('session.start', async ($, e, next) => {
    await migrateLegacy($)
    await switchPerson($, ((await $.store.get('person')) as string | undefined) || LEGACY_PERSON)
    await $.command.register({
      name: 'move-coach',
      description: 'Open the Move Coach camera pane (pose landmarks + spoken coaching)',
      argumentHint: "[free|squat|sit_and_rise|couch|airport_scanner|shoulder_rotation|solec|old_man|stop|cameras|eeg|baseline|person|reset] [camera # or name | Muse name | stop | seconds per phase | a person's name]",
    })
    await $.tool.register({
      name: TOOL,
      description:
        'Runs one Built to Move mobility test with the camera: opens a pane showing the live camera with MediaPipe pose landmarks and the book illustration, and coaches the person by voice. ' +
        'action "start" returns immediately; when the test ends, the measured result arrives as a new message from the move-coach plugin. Do not poll. ' +
        'action "snapshot" returns the latest camera frame so you can see the person. action "stop" ends the test. ' +
        'For a guided assessment, pass step, total and next (the next test\'s name) on each start: the pane shows the progress and the coach announces what\'s next. ' +
        'Optional EEG: action "eeg_start" (muse: a Muse name or address, default the first found) streams a Muse headband through muse-lsl and shows the brain waves live in the pane; ' +
        'while it runs, each test result also carries the mean relative band power during the test. action "eeg_stop" ends it. ' +
        'action "baseline" (seconds: per phase, default 30) records a resting EEG reference: 5 s to settle, eyes open, then eyes closed, with spoken cues; it only runs while the Muse is connected and streaming and no camera test runs, and refuses otherwise. ' +
        'Its result arrives as a message (alpha with eyes closed vs open, contact per sensor, valid or not); later test results then carry eeg_vs_baseline. Run it before the first test of an EEG session. action "stop" also cancels a running baseline. ' +
        'Profiles: scores, history and the EEG baseline belong to the person being tested. action "person" (name) switches to that person, creating an empty profile for a new name (no name: says who is current and lists everyone); ' +
        'do it before the first test with someone new. action "reset" clears the current person\'s Move Score (history is kept). Each result carries "person". ' +
        'action "correct" (test, points, label) overwrites a test\'s Move Score after the person\'s answers to the confirm questions change it. ' +
        'Tests: sit_and_rise (VS1), couch (VS3), airport_scanner and shoulder_rotation (VS5), squat (VS7), solec and old_man (VS8). ' +
        'camera takes a number or a name ("logitech", "iphone"); device numbers shift when cameras are plugged in, so prefer names.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'snapshot', 'status', 'correct', 'eeg_start', 'eeg_stop', 'baseline', 'person', 'reset'] },
          name: { type: 'string', description: 'person only: the name of the person being tested' },
          seconds: { type: 'integer', description: 'baseline only: seconds per phase (eyes open, eyes closed), 10–120, default 30' },
          muse: { type: 'string', description: 'eeg_start only: Muse name (e.g. "Muse-1A2B") or address; default the first found' },
          test: { type: 'string', enum: Object.keys(TESTS) },
          variant: { type: 'string', enum: ['floor', 'couch'], description: 'couch test only' },
          camera: { type: ['integer', 'string'], description: 'camera number, or a name such as "logitech", "iphone", "c920"' },
          step: { type: 'integer', description: 'guided assessment: this test\'s position (1-based)' },
          total: { type: 'integer', description: 'guided assessment: number of tests in the sequence' },
          next: { type: 'string', description: 'guided assessment: name of the next test, announced at the end ("" for the last)' },
          points: { type: 'number', description: 'correct only: corrected points out of 10' },
          label: { type: 'string', description: 'correct only: corrected score label' },
        },
        required: ['action'],
      },
    })
    return next(e)
  })

  on('command.run', { command: 'move-coach' }, async ($, e) => {
    const [arg, cam, ...rest] = String((e as { args?: string }).args ?? '').trim().split(/\s+/)
    if (arg === 'person') return { text: `Move Coach: ${await changePerson($, [cam, ...rest].filter(Boolean).join(' '))}` }
    if (arg === 'reset') {
      const who = await read($, person)
      await update($, scores, () => ({}))
      await $.store.set(pkey('scores'), {})
      return { text: `Move Coach: ${who}'s Move Score is cleared.` }
    }
    if (arg === 'cameras') {
      const cams = await listCameras($)
      return { text: cams.length ? `Cameras (use the number or a name, e.g. /move-coach squat logitech):\n${cams.map(c => `${c.index}: ${c.name}`).join('\n')}` : 'Could not list cameras (is ffmpeg installed?).' }
    }
    if (arg === 'stop') {
      await stop($)
      await cancelBaseline($, 'stopped')
      return { text: 'Move Coach stopped.' }
    }
    if (arg === 'baseline') {
      const started = await startBaseline($, cam ? Number(cam) || 30 : 30)
      return { text: started.startsWith('Baseline started') ? 'Move Coach: EEG baseline started. Sit still with a relaxed jaw and follow the spoken cues.' : `Move Coach: ${started}` }
    }
    if (arg === 'eeg') {
      if (cam === 'stop') {
        await stopEeg($)
        return { text: 'Move Coach: EEG stopped.' }
      }
      await startEeg($, cam)
      return { text: 'Move Coach: EEG starting. Turn your Muse on; your brain waves appear under the camera.' }
    }
    const test = (arg && arg in TESTS ? arg : 'free') as TestKey
    await start($, test, { camera: cam, isStartedByTool: false })
    return { text: `Move Coach: ${TESTS[test].title} started.` }
  })

  on('tool.call', { tool: `mcp__move-coach__${TOOL}` }, async ($, e) => {
    const input = e as { action?: string; test?: string; variant?: string; camera?: string | number; points?: number; label?: string; muse?: string; seconds?: number; name?: string } & Sequence
    const text = (t: string) => ({ result: t })
    if (input.action === 'eeg_start') {
      await startEeg($, input.muse)
      return text('EEG starting: the helper attaches to a running muse-lsl stream or finds a Muse over Bluetooth (up to 45 s). Brain waves appear under the camera in the pane. Check action "status" for the connection.')
    }
    if (input.action === 'baseline') return text(await startBaseline($, input.seconds ?? 30))
    if (input.action === 'person') return text(await changePerson($, input.name))
    if (input.action === 'reset') {
      if ((await read($, view)).isRunning) return text('Not reset: a test is running.')
      const who = await read($, person)
      await update($, scores, () => ({}))
      await $.store.set(pkey('scores'), {})
      return text(`${who}'s Move Score is cleared (their history is kept).`)
    }
    if (input.action === 'eeg_stop') {
      await stopEeg($)
      return text('EEG stopping.')
    }
    if (input.action === 'correct') {
      const key = input.test as TestKey | undefined
      if (!key || !SCORED.some(t => t.key === key)) return text(`correct needs a scored test: ${SCORED.map(t => t.key).join(', ')}`)
      if (typeof input.points !== 'number' || input.points < 0 || input.points > 10) return text('correct needs points between 0 and 10')
      const entry = { points: input.points, label: `${input.label ?? ''} (confirmed)`.trim(), at: new Date().toISOString() }
      const next = await update($, scores, s => ({ ...s, [key]: entry }))
      await $.store.set(pkey('scores'), next)
      const history = ((await $.store.get(pkey('history'))) as unknown[] | undefined) ?? []
      await $.store.set(pkey('history'), [...history, { test: key, ...entry, corrected: true }].slice(-500))
      const total = totalOf(next)
      return text(`Corrected ${key} to ${input.points}/10 for ${await read($, person)}. Move Score ${total.points}/${total.max} (${total.done} of ${SCORED.length} tests).`)
    }
    if (input.action === 'stop') {
      if (await cancelBaseline($, 'stopped') && !(await read($, view)).isRunning) return text('Baseline cancelled; nothing was recorded.')
      await stop($)
      return text('Stopping. The partial result will arrive as a message.')
    }
    if (input.action === 'snapshot' || input.action === 'status') {
      const v = await read($, view)
      const ev = await read($, eeg)
      const summary = JSON.stringify({ person: await read($, person), isRunning: v.isRunning, test: v.test, phase: v.phase, cue: v.cue, metrics: v.metrics, status: v.status, error: v.error, result: v.result ? JSON.parse(v.result) : undefined,
        eeg: ev.isRunning || ev.error ? { isRunning: ev.isRunning, status: ev.status, error: ev.error, device: ev.device, bands: ev.bands, quality: ev.quality, baseline: ev.baseline } : undefined })
      if (input.action === 'snapshot' && v.jpeg) {
        return { result: [{ type: 'text', text: summary }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: v.jpeg } }] }
      }
      return text(summary)
    }
    const test = input.test as TestKey | undefined
    if (!test || !(test in TESTS)) return text(`Unknown test. Use one of: ${Object.keys(TESTS).join(', ')}`)
    await start($, test, { variant: input.variant, camera: input.camera, isStartedByTool: true, step: input.step, total: input.total, next: input.next })
    return text(
      `Started ${TESTS[test].title}. The Move Coach pane shows the book illustration and the live camera with pose landmarks, and the coach is speaking. ` +
        'Tell the person briefly how to set up, then end your turn; the result arrives as a new message when the test finishes.',
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as any
    const { Box, Text, Button } = els
    const v = await read($, view)
    const meta = TESTS[v.test]
    const isTerminal = e.surface === 'terminal'

    const pictures = []
    for (const img of meta.images.slice(0, isTerminal ? 2 : 3)) {
      if (isTerminal && v.cells) {
        // inside tmux: the pre-rendered half-block version of the illustration
        let art = imageCache.get(`${img.file}.cells`)
        if (!art) {
          const path = await bookFile($, `${img.file}.cells.json`)
          if (!path) continue
          art = await $.fs.read(path)
          imageCache.set(`${img.file}.cells`, art)
        }
        const { cols, rows, cells } = JSON.parse(art) as { cols: number; rows: number; cells: string }
        pictures.push(
          <Box flexDirection="column" width={32}>
            <els.Raster key={`book-${img.file}`} columns={cols} rows={rows} cells={cells} />
            <Text dimColor>{img.caption}</Text>
          </Box>,
        )
      } else if (isTerminal) {
        const path = await bookFile($, `${img.file}.png`)
        if (!path) continue
        pictures.push(
          <Box flexDirection="column" width={32}>
            <els.Image source={{ file: path, format: 'png' }} columns={30} rows={14} alt={img.caption} />
            <Text dimColor>{img.caption}</Text>
          </Box>,
        )
      } else if (els.Svg) {
        let b64 = imageCache.get(img.file)
        if (!b64) {
          const path = await bookFile($, `${img.file}.jpg`)
          if (!path) continue
          const bytes = await $.fs.read(path, { as: 'bytes' })
          b64 = (bytes as { base64: string }).base64
          imageCache.set(img.file, b64)
        }
        pictures.push(
          <Box flexDirection="column" width={30}>
            <els.Svg source={bookSvg(b64)} alt={img.caption} width={200} height={200} />
            <Text dimColor>{img.caption}</Text>
          </Box>,
        )
      }
    }

    let camera
    if (isTerminal) {
      camera = v.cells ? (
        <els.Raster key="cam" columns={v.cols} rows={v.rows} cells={v.cells} />
      ) : v.png ? (
        <els.Image key="cam" source={{ file: v.png, format: 'png', generation: v.gen }} columns={64} rows={20} alt="camera with pose landmarks" />
      ) : (
        <Text dimColor>{v.isRunning ? 'waiting for the camera…' : 'camera off'}</Text>
      )
    } else if (els.Svg) {
      camera = <els.Svg source={cameraSvg(v)} alt="camera with pose landmarks" width={480} />
    } else {
      camera = <Text dimColor>This surface can't draw the camera.</Text>
    }

    const metrics = Object.entries(v.metrics)
      .map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`)
      .join('  ·  ')

    const ev = await read($, eeg)
    const board = await read($, scores)
    const who = await read($, person)
    const total = totalOf(board)
    let last: { points?: number; score_label?: string; explanation?: string; stopped?: boolean } = {}
    try {
      last = v.result ? JSON.parse(v.result) : {}
    } catch {}

    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
          <Text bold color="green">
            MOVE SCORE{who ? ` · ${who}` : ''}  {total.points} / {total.max}   ({total.done} of {SCORED.length} tests)
          </Text>
          {SCORED.map(t => (
            <Text dimColor={board[t.key] === undefined}>
              {t.short.padEnd(13)} {board[t.key] ? `${bar(board[t.key]!.points)} ${String(board[t.key]!.points).padStart(2)}/10  ${board[t.key]!.label}` : '▱▱▱▱▱▱▱▱▱▱  –  not tested'}
            </Text>
          ))}
        </Box>
        {!v.isRunning && typeof last.points === 'number' && (
          <Box borderStyle="double" borderColor="yellow" paddingX={1} flexDirection="column">
            <Text bold color="yellow">
              ✓ {meta.title}: {last.score_label} → {last.points}/10 points
            </Text>
            {last.explanation && <Text>How it was scored: {last.explanation}</Text>}
          </Box>
        )}
        {v.step && v.total ? (
          <Text bold color="cyan">
            Test {v.step} of {v.total}: {v.title}{v.nextTitle ? `  ·  next: ${v.nextTitle}` : '  ·  last test'}
          </Text>
        ) : (
          <Text bold>{v.title}</Text>
        )}
        {v.instruction && <Text>{v.instruction}</Text>}
        {v.isRunning && v.cue && <Text color="green">🗣 {v.cue}</Text>}
        <Box flexDirection="row" gap={2}>
          {camera}
          {pictures.length > 0 && <Box flexDirection="column">{pictures}</Box>}
        </Box>
        {metrics && <Text dimColor>{metrics}</Text>}
        {(ev.isRunning || ev.error || ev.raw.length > 0) && (
          <Box flexDirection="column">
            <Text bold color="magenta">
              🧠 Brain waves{ev.device ? ` · ${ev.device}` : ''}{ev.status ? `  ·  ${ev.status}` : ''}
            </Text>
            {ev.raw.length > 0 &&
              (!isTerminal && els.Svg ? (
                <els.Svg source={eegSvg(ev)} alt="EEG traces per channel and relative band power" width={480} />
              ) : (
                <Box flexDirection="column">
                  {ev.channels.map((c, i) => (
                    <Text>
                      {c.padEnd(5)} {sparkline(ev.raw[i] ?? [])} {ev.quality[i] ?? ''}
                    </Text>
                  ))}
                  <Text>{BAND_ORDER.map(b => `${b} ${Math.round((ev.bands[b] ?? 0) * 100)}%`).join('  ')}</Text>
                </Box>
              ))}
            {ev.error && <Text color="red">{ev.error}</Text>}
            {ev.baseline && <Text color={ev.baseline.phase === 'done' ? 'green' : ev.baseline.phase === 'cancelled' ? 'yellow' : 'cyan'}>{baselineLine(ev.baseline)}</Text>}
          </Box>
        )}
        <Text dimColor>
          {v.isRunning ? `● ${v.phase} · ${v.elapsed}s` : v.phase === 'done' ? (last.stopped ? '■ stopped. The camera is off; nothing was scored.' : '✓ done') : '○ idle'}
          {v.status ? `  ·  ${v.status}` : ''}
        </Text>
        {v.error && <Text color="red">{v.error}</Text>}
        {!v.isRunning && (last as { confirm?: string[] }).confirm?.length ? (
          <Box flexDirection="column">
            <Text bold>Questions to confirm the score (answer in the chat):</Text>
            {(last as { confirm?: string[] }).confirm!.map(q => (
              <Text>• {q}</Text>
            ))}
          </Box>
        ) : null}
        <Box flexDirection="row" gap={2}>
          {v.isRunning && <Button key="stop" label="Stop" onPress={async () => stop($)} />}
          {ev.isRunning && !v.isRunning && !baselineRun && <Button key="eeg-baseline" label="EEG baseline" onPress={async () => void (await startBaseline($))} />}
          {ev.isRunning ? (
            <Button key="eeg-stop" label="Stop EEG" onPress={async () => stopEeg($)} />
          ) : (
            <Button key="eeg-start" label="Connect Muse EEG" onPress={async () => startEeg($)} />
          )}
          {v.isRunning && v.test === 'old_man' && (
            <Button key="next" label="Done with this side" onPress={async () => $.fs.write(`${current?.dir}/control.json`, JSON.stringify({ cmd: 'next', at: Date.now() }))} />
          )}
        </Box>
      </Box>
    )
  })
}
