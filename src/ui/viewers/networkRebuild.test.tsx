// @vitest-environment jsdom

/**
 * That restyling does not rebuild the renderer.
 *
 * The network viewer runs two effects on purpose: *structure* builds the graphology graph and
 * the Sigma instance, *style* pushes colours and sizes onto what already exists. Building a
 * renderer re-runs the layout and resets the camera, so anything that slips into the structure
 * effect's dependency list costs a full layout and throws away the framing someone chose.
 *
 * jsdom has no WebGL, so the renderer itself never exists here — but `computeLayout` is awaited
 * in the same `Promise.all` as the sigma import, so counting calls to it measures exactly the
 * thing at risk: how often the structure effect ran. That is the only handle on this class of
 * regression available without a browser, and the class of regression is the expensive one.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'

import type * as LayoutModule from './networkLayout'
// `vi.mock` is hoisted above these imports by vitest, so the static import still gets the mock.
import type { NetworkViewerProps } from './NetworkViewer'
import { NetworkViewer } from './NetworkViewer'

const computeLayout = vi.hoisted(() =>
  vi.fn(async () => new Map<string, { x: number; y: number }>()),
)

vi.mock('./networkLayout', async (importOriginal) => ({
  ...(await importOriginal<typeof LayoutModule>()),
  computeLayout,
}))

beforeAll(() => installJsdomStubs({ width: 800, height: 400 }))
// Block body on purpose: `mockClear()` returns the mock, and a concise arrow would hand
// vitest a teardown callback it then invokes after every test. Harmless for this mock, which
// ignores its arguments — see `scatterRebuild.test.tsx`, where the same shape was not.
beforeEach(() => {
  computeLayout.mockClear()
})
afterEach(cleanup)

const NODE_SCHEMA = tableSchema(column('id', 'str'), column('type', 'str'), column('w', 'f64'))
const EDGE_SCHEMA = tableSchema(column('source', 'str'), column('target', 'str'))

const network: NetworkValue = {
  kind: 'network',
  directed: true,
  nodes: tableFromRows(NODE_SCHEMA, [
    { id: 'a', type: 'LC4', w: 1 },
    { id: 'b', type: 'DNp02', w: 2 },
  ]),
  edges: tableFromRows(EDGE_SCHEMA, [{ source: 'a', target: 'b' }]),
}

function props(extra: Partial<NetworkViewerProps> = {}): NetworkViewerProps {
  return {
    network,
    layout: 'circular',
    iterations: 10,
    nodeColor: { mode: 'constant', column: undefined, constant: '0' },
    nodeSize: { column: undefined, min: 4, max: 18 },
    edgeColor: { mode: 'constant', column: undefined, constant: 'muted' },
    edgeSize: { column: undefined, min: 0.5, max: 6 },
    showLabels: true,
    selection: [],
    ...extra,
  }
}

describe('the structure effect', () => {
  it('lays out once for a first render', () => {
    render(<NetworkViewer {...props()} />)
    expect(computeLayout).toHaveBeenCalledTimes(1)
  })

  it('does not lay out again when a colour encoding changes', () => {
    const { rerender } = render(<NetworkViewer {...props()} />)
    rerender(
      <NetworkViewer
        {...props({ nodeColor: { mode: 'categorical', column: 'type', constant: '0' } })}
      />,
    )
    expect(computeLayout).toHaveBeenCalledTimes(1)
  })

  it('does not lay out again for sizes, labels, arrows, opacity or a border', () => {
    const { rerender } = render(<NetworkViewer {...props()} />)
    rerender(<NetworkViewer {...props({ nodeSize: { column: 'w', min: 2, max: 30 } })} />)
    rerender(<NetworkViewer {...props({ showLabels: false })} />)
    rerender(<NetworkViewer {...props({ arrows: false })} />)
    rerender(<NetworkViewer {...props({ edgeOpacity: 0.4 })} />)
    rerender(<NetworkViewer {...props({ nodeBorderWidth: 3 })} />)
    expect(computeLayout).toHaveBeenCalledTimes(1)
  })

  it('does not lay out again when the selection changes', () => {
    // A selection is a style change. This is the specific regression that made clicking a
    // node throw the camera back to its default framing.
    const { rerender } = render(<NetworkViewer {...props()} />)
    rerender(<NetworkViewer {...props({ selection: ['a'] })} />)
    rerender(<NetworkViewer {...props({ selection: ['a', 'b'] })} />)
    expect(computeLayout).toHaveBeenCalledTimes(1)
  })

  it('survives a re-render that changes nothing at all', () => {
    // Every spec prop is a fresh object each render; `useStable` is what stops that counting.
    const { rerender } = render(<NetworkViewer {...props()} />)
    rerender(<NetworkViewer {...props()} />)
    rerender(<NetworkViewer {...props()} />)
    expect(computeLayout).toHaveBeenCalledTimes(1)
  })

  it('does lay out again when the layout itself changes', () => {
    const { rerender } = render(<NetworkViewer {...props()} />)
    rerender(<NetworkViewer {...props({ layout: 'layered' })} />)
    expect(computeLayout).toHaveBeenCalledTimes(2)
  })

  it('does lay out again for new data', () => {
    const { rerender } = render(<NetworkViewer {...props()} />)
    rerender(
      <NetworkViewer
        {...props({
          network: {
            ...network,
            nodes: tableFromRows(NODE_SCHEMA, [
              { id: 'a', type: 'LC4', w: 1 },
              { id: 'c', type: 'LC6', w: 3 },
            ]),
          },
        })}
      />,
    )
    expect(computeLayout).toHaveBeenCalledTimes(2)
  })
})

describe('the new layout options', () => {
  it('lays out again when the layered orientation flips', () => {
    const { rerender } = render(<NetworkViewer {...props({ layout: 'layered' })} />)
    rerender(<NetworkViewer {...props({ layout: 'layered', orientation: 'tb' })} />)
    expect(computeLayout).toHaveBeenCalledTimes(2)
  })

  it('lays out again when the layer or group column changes', () => {
    const { rerender } = render(<NetworkViewer {...props({ layout: 'layered' })} />)
    rerender(<NetworkViewer {...props({ layout: 'layered', layerColumn: 'type' })} />)
    rerender(<NetworkViewer {...props({ layout: 'grouped', groupColumn: 'type' })} />)
    expect(computeLayout).toHaveBeenCalledTimes(3)
  })

  it('passes the layout options through rather than dropping them', () => {
    render(
      <NetworkViewer
        {...props({ layout: 'grouped', groupColumn: 'type', orientation: 'tb' })}
      />,
    )
    expect(computeLayout).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ layout: 'grouped', groupColumn: 'type', orientation: 'tb' }),
    )
  })
})

/**
 * The Layout input.
 *
 * Two properties, and the second is the one that would rot. Positions arriving on the socket
 * have to *reach* the layout — a prop threaded to nowhere still renders a network, laid out by
 * the algorithm, which looks like the upstream node having produced a bad arrangement. And a
 * layout object rebuilt with the same contents must not rebuild the renderer, because that is
 * the camera-resetting regression this whole file exists to catch: `nodeInputs` mints a fresh
 * record on every store tick, and only the value inside it is stable.
 */
describe('positions handed in on the Layout socket', () => {
  const given = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }

  it('reaches the layout, and overrides the chosen algorithm', () => {
    render(<NetworkViewer {...props({ layout: 'circular', given })} />)
    expect(computeLayout).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ given }),
    )
  })

  it('lays out again when the positions move', () => {
    const { rerender } = render(<NetworkViewer {...props({ given })} />)
    rerender(<NetworkViewer {...props({ given: { ...given, b: { x: 250, y: 40 } } })} />)
    expect(computeLayout).toHaveBeenCalledTimes(2)
  })

  it('does not lay out again for an equal layout under a new identity', () => {
    const { rerender } = render(<NetworkViewer {...props({ given })} />)
    rerender(<NetworkViewer {...props({ given: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } })} />)
    expect(computeLayout).toHaveBeenCalledTimes(1)
  })

  it('lays out again when the wire is pulled', () => {
    const { rerender } = render(<NetworkViewer {...props({ given })} />)
    rerender(<NetworkViewer {...props()} />)
    expect(computeLayout).toHaveBeenCalledTimes(2)
    expect(computeLayout).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.not.objectContaining({ given: expect.anything() }),
    )
  })
})
