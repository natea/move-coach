export type TestKey =
  | 'free'
  | 'sit_and_rise'
  | 'couch'
  | 'airport_scanner'
  | 'shoulder_rotation'
  | 'squat'
  | 'solec'
  | 'old_man'

export type CoachView = {
  isRunning: boolean
  test: TestKey
  title: string
  phase: string
  instruction: string
  cue: string
  status: string
  error: string
  metrics: Record<string, unknown>
  elapsed: number
  gen: number
  w: number
  h: number
  jpeg: string
  png: string
  cells: string
  cols: number
  rows: number
  lm: number[][]
  result: string
  isStartedByTool: boolean
  /** guided assessment progress, when the test is one step of a sequence */
  step?: number
  total?: number
  nextTitle?: string
}

/** The optional Muse EEG stream (muse-lsl), drawn under the camera. */
export type EegView = {
  isRunning: boolean
  status: string
  error: string
  device: string
  channels: string[]
  /** the last ~4 s per channel, µV, mean removed */
  raw: number[][]
  /** relative band power, 0–1, over the last second */
  bands: Record<string, number>
  /** per channel: good, flat (no skin contact) or noisy (motion, loose sensor) */
  quality: string[]
  gen: number
  /** the eyes-open / eyes-closed baseline, while it runs and after it ends */
  baseline?: BaselineView
}

export type BaselineView = {
  /** settle → open → switch → closed → done (or cancelled) */
  phase: 'settle' | 'open' | 'switch' | 'closed' | 'done' | 'cancelled'
  /** Date.now() when the current phase ends */
  endsAt: number
  /** one-line outcome once done or cancelled */
  summary: string
}

/** A test's latest book score. */
export type ScoreEntry = { points: number; label: string; at: string }

export type Scores = Partial<Record<TestKey, ScoreEntry>>

declare module 'claude-code' {
  interface PluginState {
    'move-coach': { view: CoachView; scores: Scores; eeg: EegView; person: string; cameras: { index: number; name: string }[] }
  }
}
