import { expect, test } from 'claude-code/testing'

import { addSample, applyLine, personIdOf, bar, baselineLine, cameraSvg, summarizeBaseline, totalOf } from './register'
import type { PhaseAcc } from './register'
import type { CoachView } from '../types'

const base: CoachView = {
  isRunning: true, test: 'squat', title: 'VS7 · Squat Test', phase: 'setup', instruction: '', cue: '',
  status: '', error: '', metrics: {}, elapsed: 0, gen: 0, w: 480, h: 360, jpeg: '', png: '', cells: '', cols: 0, rows: 0, lm: [],
  result: '', isStartedByTool: true,
}

test('a frame line updates the picture, landmarks and coaching text', async () => {
  const v = applyLine(base, {
    type: 'frame', gen: 7, w: 480, h: 270, jpeg: 'AAAA', png: '/tmp/x.png', lm: [[0.5, 0.5, 0.9]],
    phase: 'hold', instruction: 'Hold it', cue: 'Breathe in', metrics: { knee_angle: 70 }, elapsed: 12.5,
  })
  expect(v.gen).toBe(7)
  expect(v.phase).toBe('hold')
  expect(v.cue).toBe('Breathe in')
  expect(v.metrics).toEqual({ knee_angle: 70 })
  expect(v.isRunning).toBe(true)
})

test('a result line ends the run and keeps the result', async () => {
  const v = applyLine(base, { type: 'result', test: 'squat', suggested: { position: 1 } })
  expect(v.isRunning).toBe(false)
  expect(v.phase).toBe('done')
  expect(JSON.parse(v.result).suggested.position).toBe(1)
})

test('an error line stops the run', async () => {
  const v = applyLine(base, { type: 'error', message: 'could not open the camera' })
  expect(v.isRunning).toBe(false)
  expect(v.error).toContain('camera')
})

test('the camera SVG draws the frame and only visible bones', async () => {
  const lm = Array.from({ length: 33 }, () => [0.5, 0.5, 0.1])
  lm[11] = [0.4, 0.3, 0.9]
  lm[12] = [0.6, 0.3, 0.9]
  const svg = cameraSvg({ w: 480, h: 360, jpeg: 'QUJD', lm })
  expect(svg).toContain('data:image/jpeg;base64,QUJD')
  expect(svg.match(/<line /g)?.length).toBe(1) // only the 11-12 shoulder bone is visible
  expect(svg.length).toBeLessThan(131072)
})

test('the Move Score totals the book-scored tests out of 60', async () => {
  const t = totalOf({ squat: { points: 4, label: 'Position 3', at: '' }, old_man: { points: 7, label: '2 touches', at: '' } })
  expect(t).toEqual({ points: 11, max: 60, done: 2 })
  expect(bar(4)).toBe('▰▰▰▰▱▱▱▱▱▱')
})

const CH = ['TP9', 'AF7', 'AF8', 'TP10']
const phase = (alpha: number, quality: string[], n = 300): PhaseAcc => {
  const acc: PhaseAcc = { sums: {}, n: 0, good: [] }
  for (let i = 0; i < n; i++) addSample(acc, { delta: 0.3, theta: 0.15, alpha, beta: 0.3, gamma: 0.1 }, quality)
  return acc
}

test('a baseline with good contact and rising alpha is valid', async () => {
  const good = ['good', 'good', 'good', 'good']
  const r = summarizeBaseline(phase(0.06, good), phase(0.12, good), CH)
  expect(r.valid).toBe(true)
  expect(r.alpha_ratio_closed_over_open).toBe(2)
  expect(r.eyes_open.good_contact_share).toEqual({ TP9: 1, AF7: 1, AF8: 1, TP10: 1 })
  expect(r.problems).toEqual([])
})

test('a baseline with fewer than 2 sensors in contact is not usable', async () => {
  const poor = ['good', 'flat', 'noisy', 'noisy']
  const r = summarizeBaseline(phase(0.06, poor), phase(0.12, poor), CH)
  expect(r.valid).toBe(false)
  expect(r.problems[0]).toContain('sensors')
})

test('flat alpha is flagged but still valid when contact is good', async () => {
  const good = ['good', 'good', 'noisy', 'good']
  const r = summarizeBaseline(phase(0.063, good), phase(0.072, good), CH)
  expect(r.valid).toBe(true)
  expect(r.alpha_ratio_closed_over_open).toBe(1.14)
  expect(r.problems[0]).toContain('alpha barely rose')
})

test('the pane line counts down and then shows the outcome', async () => {
  expect(baselineLine({ phase: 'open', endsAt: 21_500, summary: '' }, 1_000)).toBe('Baseline · eyes open · 21 s')
  expect(baselineLine({ phase: 'done', endsAt: 0, summary: '✓ valid · alpha ×2' })).toBe('Baseline ✓ valid · alpha ×2')
})

type Call = (input: Record<string, unknown>) => Promise<unknown>
const coach = ($: { tool: { call: unknown } }, input: Record<string, unknown>) =>
  ($.tool.call as unknown as Call)({ tool: 'mcp__move-coach__camera_test', ...input }).then(r => {
    const result = (r as { result?: unknown }).result
    return typeof result === 'string' ? result : JSON.stringify(r)
  })

test('baseline refuses while the Muse is not connected', async $ => {
  const r = await coach($, { action: 'baseline' })
  expect(JSON.stringify(r)).toContain('Baseline not started')
  expect(JSON.stringify(r)).toContain('eeg_start')
})

test('names become stable store keys', async () => {
  expect(personIdOf('  Alex Smith ')).toBe('alex-smith')
  expect(personIdOf('NATE')).toBe('nate')
})

test('each person keeps their own Move Score', async ($, on) => {
  const mem = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: mem.get(e.key) }))
  on('store.set', async (_$, e) => (mem.set(e.key, e.value), { value: undefined }))
  expect(await coach($, { action: 'person', name: 'Alex' })).toContain('New profile: Alex')
  expect(await coach($, { action: 'correct', test: 'squat', points: 7, label: 'Position 2' })).toContain('for Alex')
  expect(await coach($, { action: 'person', name: 'Sam' })).toContain('New profile: Sam')
  expect(await coach($, { action: 'status' })).toContain('"person":"Sam"')
  const back = await coach($, { action: 'person', name: 'alex' })
  expect(back).toContain('Switched to Alex')
  expect(back).toContain('7/60 (1 of 6 tests)')
  expect(await coach($, { action: 'reset' })).toContain("Alex's Move Score is cleared")
  expect(await coach($, { action: 'person', name: 'Sam' })).toContain('no tests yet')
  expect(await coach($, { action: 'person' })).toContain('Alex, Sam')
})

test('the command switches profiles, hands quick mode to Claude, and explains unknown words', async ($, on) => {
  const mem = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: mem.get(e.key) }))
  on('store.set', async (_$, e) => (mem.set(e.key, e.value), { value: undefined }))
  const prompts: string[] = []
  on('clock.after', async () => ({ value: undefined }))
  // quick mode opens the pane, which starts the silent camera preview
  const spawned: string[][] = []
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } } as never))
  on('process.spawn', async function* (_$, e) {
    spawned.push([...(e as { argv: string[] }).argv])
    return { exitCode: 0 } as never
  })
  on('ui.open', async () => ({ value: undefined } as never))
  on('fs.write', async () => ({ value: undefined } as never))
  on('prompt.submit', async (_$, e) => (prompts.push(String((e as { text?: string }).text)), { value: undefined } as never))
  const run = (args: string) => ($.command.run as unknown as (i: Record<string, unknown>) => Promise<{ text?: string }>)({ command: 'move-coach', args })
  expect((await run('name Jane')).text).toContain('New profile: Jane')
  expect((await run('quick John')).text).toContain('quick assessment for John')
  for (let i = 0; i < 20 && !prompts.length; i++) await Promise.resolve()
  expect(prompts.join(' ')).toContain('quick')
  expect(prompts.join(' ')).toContain('John')
  const preview = spawned.find(a => a.includes('--test'))
  expect(preview?.[preview.indexOf('--test') + 1]).toBe('free')
  expect(preview).toContain('--mute')
  expect((await run('banana')).text).toContain("I don't know")
  // let the preview's background work (camera list, stream end) settle before the test ends
  await new Promise(r => setTimeout(r, 50))
})
