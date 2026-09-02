/**
 * The Heatmap node's two halves: colour that never enters the key, order that always does.
 *
 * The clustering crosses the Python bridge, which vitest cannot run, so that arm is driven
 * through a stub of `runClusterOrder` — what is pinned is that the node sends a *copy* of the
 * matrix, asks per leading axis, and puts the answer through the same plan as every other
 * order. The arithmetic it stands in for is checked against SciPy by
 * `scripts/probe-heatmap-order.py`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EvalContext, ParamValues } from '../../core/node'
import { configurableParams, defaultParams, hiddenParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import type { MatrixValue } from '../../core/values'
import { isMatrixValue, makeMatrix } from '../../core/values'
import type * as LinkageBridge from '../../pyodide/linkage'
import type { ClusterOrderRequest } from '../../pyodide/linkage'
import '../index'

const runClusterOrder = vi.hoisted(() => vi.fn())
vi.mock('../../pyodide/linkage', async (importOriginal) => ({
  ...(await importOriginal<typeof LinkageBridge>()),
  runClusterOrder,
}))

const def = () => requireNodeDef('out.heatmap')

function square(): MatrixValue {
  return makeMatrix(
    ['LC4', 'LC10', 'DNp02'],
    ['LC4', 'LC10', 'DNp02'],
    Float64Array.from([1, 9, 2, 0, 0, 3, 5, 1, 0]),
    'synapses',
  )
}

function ctx(matrix: MatrixValue, params: Record<string, unknown>): EvalContext & { warnings: string[] } {
  const warnings: string[] = []
  return {
    params: { ...defaultParams(def()), ...params } as EvalContext['params'],
    warnings,
    refresh: false,
    reportFetched: () => undefined,
    warn: (m) => warnings.push(m),
    publish: () => undefined,
    input: (port) => (port === 'in' ? matrix : undefined),
    inputKey: () => 'in-key',
    column: () => undefined,
    columns: () => [],
    inputPorts: () => [],
    outputPorts: () => [],
    resolveSource: () => {
      throw new Error('no sources here')
    },
    signal: new AbortController().signal,
    progress: () => {},
  }
}

async function run(matrix: MatrixValue, params: Record<string, unknown>) {
  const c = ctx(matrix, params)
  const out = (await def().evaluate(c)).out
  if (!isMatrixValue(out)) throw new Error('not a matrix')
  return { out, warnings: c.warnings }
}

// Braces, not a bare expression: `mockReset()` returns the mock, and a hook that returns a
// function has handed vitest a *cleanup* to call after the test — with no arguments, which is
// a third call to the bridge that nothing in the node made.
beforeEach(() => {
  runClusterOrder.mockReset()
})

describe('what reaches the provenance key', () => {
  it('switches the order details off until an order is chosen, and the palette of the other scale', () => {
    /*
     * `configurableParams` is what the card counts and the key reads: a param `visibleIf` has
     * switched off is not a param the node has right now. So the details of an order do not
     * exist until there is one, and exactly one palette list exists at a time.
     */
    const base = defaultParams(def())
    const ids = (params: ParamValues) => configurableParams(def(), params).map((p) => p.id)
    const none = ids(base)
    expect(none).toContain('sortBy')
    expect(none).toContain('palette')
    for (const id of ['sortAxis', 'sortFollow', 'sortReverse', 'sortKey', 'clusterMethod', 'divergingPalette']) {
      expect(none, id).not.toContain(id)
    }
    const clustered = ids({ ...base, scale: 'diverging', sortBy: 'cluster' })
    expect(clustered).toContain('divergingPalette')
    expect(clustered).not.toContain('palette')
    expect(clustered).toContain('clusterMethod')
    expect(clustered).toContain('sortFollow')
    expect(clustered).not.toContain('sortKey')
    // Independent axes have nothing to follow.
    expect(ids({ ...base, sortBy: 'total', sortAxis: 'both' })).not.toContain('sortFollow')
    // The card draws the order picker and the key, and keeps the details for the panel.
    const advanced = hiddenParams(def(), { ...base, sortBy: 'value' }).map((p) => p.id)
    expect(advanced).toEqual(['sortAxis', 'sortFollow', 'sortReverse'])
  })

  it('declares the Order tab as changing data and the Colour tab as not', () => {
    expect(def().paramGroups).toEqual([
      { id: 'colour', label: 'Colour' },
      { id: 'order', label: 'Order', affectsData: true },
    ])
    for (const p of def().params ?? []) {
      expect(p.group === 'order' ? !p.presentational : p.presentational === true, p.id).toBe(true)
    }
  })
})

describe('evaluate', () => {
  it('passes the matrix through untouched by default', async () => {
    const m = square()
    const { out } = await run(m, {})
    expect(out).toBe(m)
  })

  it('sorts rows by total and the columns follow', async () => {
    const { out } = await run(square(), { sortBy: 'total' })
    expect(out.rowLabels).toEqual(['LC4', 'DNp02', 'LC10'])
    expect(out.colLabels).toEqual(['LC4', 'DNp02', 'LC10'])
    expect(out.valueLabel).toBe('synapses')
  })

  it('warns and leaves an axis alone when the key names nothing', async () => {
    const m = square()
    const { out, warnings } = await run(m, { sortBy: 'value', sortKey: 'nobody' })
    expect(out).toBe(m)
    expect(warnings.join('\n')).toContain('"nobody"')
  })

  it('clusters through the bridge with a copy, once per leading axis', async () => {
    const m = square()
    // Recorded and asserted after the run: an `expect` inside a mock implementation is where a
    // failure surfaces as a rejected `evaluate` rather than as the assertion that failed.
    const requests: ClusterOrderRequest[] = []
    runClusterOrder.mockImplementation(async (request: ClusterOrderRequest) => {
      requests.push(request)
      return request.axis === 'rows' ? Int32Array.from([2, 0, 1]) : Int32Array.from([1, 2, 0])
    })
    const { out } = await run(m, { sortBy: 'cluster', sortAxis: 'both' })
    expect(requests.map((r) => r.axis)).toEqual(['rows', 'columns'])
    expect(requests[0]).toMatchObject({ method: 'average', metric: 'euclidean', rows: 3, cols: 3 })
    for (const request of requests) {
      // The buffer must not be the upstream value's own: `callPython` transfers it.
      expect(request.values).not.toBe(m.values)
      expect([...request.values]).toEqual([...m.values])
    }
    expect(out.rowLabels).toEqual(['DNp02', 'LC4', 'LC10'])
    expect(out.colLabels).toEqual(['LC10', 'DNp02', 'LC4'])
  })

  it('lets the columns follow a clustered row order, reversed', async () => {
    runClusterOrder.mockResolvedValue(Int32Array.from([2, 0, 1]))
    const { out } = await run(square(), { sortBy: 'cluster', sortReverse: true })
    expect(runClusterOrder).toHaveBeenCalledTimes(1)
    expect(out.rowLabels).toEqual(['LC10', 'LC4', 'DNp02'])
    expect(out.colLabels).toEqual(out.rowLabels)
  })

  it('says which cells the clustering reads as zero', async () => {
    runClusterOrder.mockResolvedValue(Int32Array.from([0, 1, 2]))
    const m = makeMatrix(['a', 'b', 'c'], ['x'], Float64Array.from([1, Number.NaN, 3]))
    const { out, warnings } = await run(m, { sortBy: 'cluster' })
    expect(warnings.join('\n')).toContain('read as 0')
    // …and the cells themselves are not rewritten.
    expect(Number.isNaN(out.values[1])).toBe(true)
  })

  it('does not cross the bridge for an axis with one line', async () => {
    const m = makeMatrix(['only'], ['x', 'y'], Float64Array.from([1, 2]))
    const { out } = await run(m, { sortBy: 'cluster' })
    expect(runClusterOrder).not.toHaveBeenCalled()
    expect(out).toBe(m)
  })
})
