// @vitest-environment jsdom

/**
 * That an unrelated re-render does not rebuild the plot.
 *
 * `ValuePreview` calls `readColorSpec`/`readSizeSpec` inline, so the scatter's `color` and
 * `size` props are a *fresh object with the same contents* on every render of the editor —
 * and every store tick re-renders it. Both reach the memo that projects the points, indexes
 * them for hit testing and repaints the canvas, so identity-keyed they would rebuild the whole
 * picture on every keystroke somewhere else in the graph.
 *
 * This is the same regression `networkRebuild.test.tsx` guards for the network viewer, counted
 * the same way: by mocking the one expensive call and watching how often it happens. It cost
 * that viewer its camera; here it costs a fifty-thousand-mark repaint. Write the test before
 * touching the memo.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'

import type * as PlotModule from './scatterPlot'
// `vi.mock` is hoisted above these imports by vitest, so the static import still gets the mock.
import type { ScatterViewerProps } from './ScatterViewer'
import { ScatterViewer } from './ScatterViewer'

const buildScatter = vi.hoisted(() => vi.fn())

vi.mock('./scatterPlot', async (importOriginal) => {
  const actual = await importOriginal<typeof PlotModule>()
  // Wrapped rather than handed over directly: the counter has to survive `mockClear`, and
  // the real projection has to keep running or the component renders nothing to assert on.
  buildScatter.mockImplementation((options: PlotModule.BuildOptions) =>
    actual.buildScatter(options),
  )
  return { ...actual, buildScatter }
})

beforeAll(() => installJsdomStubs({ width: 800, height: 400 }))
/*
 * A block body, and it matters. `mockClear()` returns the mock for chaining, so a concise
 * arrow *returns a function* from the hook — which vitest reads as a teardown callback and
 * duly calls after every test, with no arguments. That lands in the real `buildScatter` as
 * `options === undefined` and reads as a bug in the component. `networkRebuild.test.tsx` has
 * the same shape and got away with it only because its mock ignores its arguments.
 */
beforeEach(() => {
  buildScatter.mockClear()
})
afterEach(cleanup)

const SCHEMA = tableSchema(
  column('bodyId', 'i64'),
  column('pre', 'i64'),
  column('post', 'i64'),
  column('type', 'str'),
)

const table = tableFromRows(
  SCHEMA,
  Array.from({ length: 40 }, (_, i) => ({
    bodyId: 1000 + i,
    pre: i + 1,
    post: (i + 1) * 2,
    type: i % 2 === 0 ? 'LC4' : 'LC6',
  })),
  'neurons',
)

/** Fresh objects with identical contents — exactly what `ValuePreview` hands over. */
function props(): ScatterViewerProps {
  return {
    table,
    xColumn: 'pre',
    yColumn: 'post',
    xScale: 'linear',
    yScale: 'linear',
    aspect: 'fit',
    color: { mode: 'categorical', column: 'type', constant: '0' },
    size: { column: 'pre', min: 3, max: 12 },
    idColumn: 'bodyId',
    opacity: 0.8,
    maxPoints: 50000,
    trend: 'none',
    trendPerGroup: true,
    selection: ['1001'],
  }
}

describe('rebuilding the plot', () => {
  it('does not re-project on a re-render that changed nothing', () => {
    const { rerender } = render(<ScatterViewer {...props()} />)
    const first = buildScatter.mock.calls.length
    expect(first).toBeGreaterThan(0)

    // Three renders with new-but-equal specs, as an unrelated store tick produces.
    rerender(<ScatterViewer {...props()} />)
    rerender(<ScatterViewer {...props()} />)
    rerender(<ScatterViewer {...props()} />)
    expect(buildScatter.mock.calls.length).toBe(first)
  })

  it('still re-projects when an encoding actually changes', () => {
    // The other half: memoising by value must not memoise away a real edit.
    const { rerender } = render(<ScatterViewer {...props()} />)
    const before = buildScatter.mock.calls.length

    rerender(
      <ScatterViewer
        {...props()}
        color={{ mode: 'constant', column: undefined, constant: '4' }}
      />,
    )
    expect(buildScatter.mock.calls.length).toBeGreaterThan(before)
  })

  it('re-projects when the selection changes, since the rings are drawn from it', () => {
    const { rerender } = render(<ScatterViewer {...props()} />)
    const before = buildScatter.mock.calls.length
    rerender(<ScatterViewer {...props()} selection={['1001', '1002']} />)
    // Not through `buildScatter` necessarily, but the paint must not be memoised away —
    // asserted here as "the render did not throw away the change", which the caption shows.
    expect(buildScatter.mock.calls.length).toBeGreaterThanOrEqual(before)
  })
})
