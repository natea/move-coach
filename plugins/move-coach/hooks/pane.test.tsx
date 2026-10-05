import { expect, test } from 'claude-code/testing'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the idle pane draws on ${surface}`, async $ => {
    const mounted = await $.ui.mount({ plugin: 'move-coach', surface, component: 'Pane', props: {} as never, requestId: 'move-coach' })
    const tree = await mounted.drawn()
    expect(JSON.stringify(tree)).toContain('Camera preview')
  })
}
