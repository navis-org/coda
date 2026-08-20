/**
 * The clustering nodes' contract, and the seam under them.
 *
 * The Python is not testable here — vitest has no Pyodide and jsdom has no `Worker` — so the
 * bridge is mocked and what is checked is everything on this side of it: that every control
 * reaches the request, that the matrix is *copied* rather than transferred out from under the
 * node above, that the labels come back attached to the tree, and that a cut is a pure
 * arithmetic node that costs no run. `scripts/probe-linkage.mjs` covers the other side by
 * running the real `linkage.py` against the real wheel in Node.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import type { LinkageValue, MatrixValue, TableValue } from '../../core/values'
import { getColumn, isLinkageValue, isMatrixValue, isTableValue, makeMatrix } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import { clusterColor } from '../../ui/encoding'
import type { DataSource } from '../../data/source'
import type { LinkageRequest } from '../../pyodide/linkage'
import '../index'

vi.mock('../../pyodide/linkage', () => ({ runLinkage: vi.fn() }))
const { runLinkage } = await import('../../pyodide/linkage')
const mockedRun = vi.mocked(runLinkage)

const source: DataSource = new MockSource({ latencyMs: 0 })

function makeScheduler(): Scheduler {
  return new Scheduler({
    resolveSource: (id) => {
      if (id !== 'mock') throw new Error(`unexpected source ${id}`)
      return source
    },
  })
}

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/**
 * A four-neuron similarity matrix, standing in for an NBLAST all-by-all.
 *
 * Fed to the graph through a Raw Cypher node would be a fiction; instead the Adjacency node is
 * skipped entirely and the matrix is handed to the scheduler as a pre-seeded input, which is
 * what `seed` does below.
 */
function scoreMatrix(): MatrixValue {
  const labels = ['a', 'b', 'c', 'd']
  // Two tight pairs: a~b and c~d.
  const v = [1, 0.9, 0.1, 0.1, 0.9, 1, 0.1, 0.1, 0.1, 0.1, 1, 0.8, 0.1, 0.1, 0.8, 1]
  return makeMatrix(labels, labels.slice(), Float64Array.from(v), 'NBLAST score', 'similarity')
}

/** What `runLinkage` promises: two tight pairs joined at the top. */
function linkageResult() {
  return {
    merges: Float64Array.from([0, 1, 0.1, 2, 2, 3, 0.2, 2, 4, 5, 0.9, 4]),
    count: 3,
    order: Int32Array.from([0, 1, 2, 3]),
  }
}

/**
 * dataset → find(LC*) → adjacency → linkage → cut → dendrogram.
 *
 * A real matrix from the mock connectome rather than a hand-built one, because what this
 * pipeline is for is catching the things a direct `evaluate` call cannot see: that the four
 * new sockets accept what is wired to them, that inference does not drop the tree's type on
 * the way through, and that browsing a drawing costs no run.
 */
function pipeline(): CodaGraph {
  let g = emptyGraph('linkage-pipeline')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*', status: 'Traced' }))
  g = addNode(g, node('adj', 'neuron.adjacency', { groupByType: true }))
  g = addNode(g, node('lk', 'cluster.linkage', { method: 'average' }))
  g = addNode(g, node('cut', 'cluster.cut', { mode: 'count', count: 2 }))
  g = addNode(g, node('dendro', 'out.dendrogram'))
  const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) => {
    g = addEdge(g, { source, sourceHandle, target, targetHandle })
  }
  wire('ds', 'dataset', 'find', 'dataset')
  wire('ds', 'dataset', 'adj', 'dataset')
  wire('find', 'neurons', 'adj', 'sources')
  wire('find', 'neurons', 'adj', 'targets')
  wire('adj', 'matrix', 'lk', 'in')
  wire('lk', 'tree', 'cut', 'in')
  wire('cut', 'tree', 'dendro', 'in')
  return g
}

beforeEach(() => {
  mockedRun.mockReset()
})

describe('the Linkage node', () => {
  it('sends every control through to the request, and copies the matrix', async () => {
    mockedRun.mockResolvedValue(linkageResult())
    const def = requireNodeDef('cluster.linkage')
    const matrix = scoreMatrix()

    const result = await def.evaluate!({
      params: { method: 'average', symmetry: 'min', distance: 'auto' },
      input: () => matrix,
      column: () => undefined,
      columns: () => [],
      progress: () => {},
      signal: undefined,
    } as never)

    const request = mockedRun.mock.calls[0]![0] as LinkageRequest
    expect(request.method).toBe('average')
    expect(request.symmetry).toBe('min')
    // The matrix says it carries similarities, so `auto` inverts.
    expect(request.transform).toBe('one_minus')
    expect(request.n).toBe(4)

    // The load-bearing one. `callPython` transfers every typed array in a call's arguments, so
    // handing over the upstream value's own buffer would detach the cached result of the node
    // above — an empty Heatmap an inch away with nothing to connect it to this node.
    expect(request.scores).not.toBe(matrix.values)
    expect(matrix.values.length).toBe(16)

    const tree = (result as Record<string, LinkageValue>).tree!
    expect(isLinkageValue(tree)).toBe(true)
    expect(tree.labels).toEqual(['a', 'b', 'c', 'd'])
    expect(tree.method).toBe('average')
    // Printed on the axis, so a height is not a bare number.
    expect(tree.distanceLabel).toBe('1 − NBLAST score')
  })

  it('emits the matrix reordered to match the tree', async () => {
    mockedRun.mockResolvedValue({ ...linkageResult(), order: Int32Array.from([2, 3, 0, 1]) })
    const def = requireNodeDef('cluster.linkage')
    const result = await def.evaluate!({
      params: {},
      input: () => scoreMatrix(),
      column: () => undefined,
      columns: () => [],
      progress: () => {},
      signal: undefined,
    } as never)

    const ordered = (result as Record<string, MatrixValue>).ordered!
    expect(isMatrixValue(ordered)).toBe(true)
    expect(ordered.rowLabels).toEqual(['c', 'd', 'a', 'b'])
    // c against d is 0.8 — the tight pair, now sitting on the diagonal block.
    expect(ordered.values[1]).toBeCloseTo(0.8)
  })

  it('refuses a matrix comparing two different populations before calling Python', async () => {
    const def = requireNodeDef('cluster.linkage')
    const crossed = makeMatrix(['a', 'b'], ['x', 'y'], new Float64Array(4))
    await expect(
      def.evaluate!({
        params: {},
        input: () => crossed,
        column: () => undefined,
        columns: () => [],
        progress: () => {},
        signal: undefined,
      } as never),
    ).rejects.toThrow(/different things/)
    expect(mockedRun).not.toHaveBeenCalled()
  })

  it('refuses a count matrix before calling Python, rather than clustering nonsense', async () => {
    const def = requireNodeDef('cluster.linkage')
    // An Adjacency matrix: raw synapse counts, no `measure`. `1 - 77` is a negative distance,
    // which fastcore clusters happily and the viewer then draws off the card entirely.
    const counts = makeMatrix(
      ['a', 'b'],
      ['a', 'b'],
      Float64Array.from([0, 77, 12, 0]),
    )
    await expect(
      def.evaluate!({
        params: {},
        input: () => counts,
        column: () => undefined,
        columns: () => [],
        progress: () => {},
        signal: undefined,
      } as never),
    ).rejects.toThrow(/Normalize/)
    expect(mockedRun).not.toHaveBeenCalled()
  })

  it('is expensive, because a first run downloads a Python runtime', () => {
    expect(requireNodeDef('cluster.linkage').cost).toBe('expensive')
  })

  it('infers both outputs without running', () => {
    const inferred = requireNodeDef('cluster.linkage').inferOutputs!({ inputs: {} } as never)
    expect(inferred.tree?.kind).toBe('linkage')
    expect(inferred.ordered?.kind).toBe('matrix')
  })
})

describe('the Cut Tree node', () => {
  function cut(params: Record<string, unknown>, tree: LinkageValue): Record<string, unknown> {
    return requireNodeDef('cluster.cut').evaluate!({
      params: { ...defaultParams(requireNodeDef('cluster.cut')), ...params },
      input: () => tree,
      column: () => undefined,
      columns: () => [],
      progress: () => {},
      signal: undefined,
    } as never) as Record<string, unknown>
  }

  const tree: LinkageValue = {
    kind: 'linkage',
    merges: Float64Array.from([0, 1, 0.1, 2, 2, 3, 0.2, 2, 4, 5, 0.9, 4]),
    labels: ['a', 'b', 'c', 'd'],
    order: Int32Array.from([0, 1, 2, 3]),
    method: 'average',
  }

  it('costs nothing to run, which is the whole reason it is its own node', () => {
    // A spinner on an `expensive` node would fire a Python call per press of it, and with
    // auto-run on would do so automatically.
    expect(requireNodeDef('cluster.cut').cost).toBe('cheap')
  })

  it('hands back a table and the tree carrying the cut', () => {
    const out = cut({ mode: 'count', count: 2 }, tree)
    const table = out.clusters as TableValue
    expect(isTableValue(table)).toBe(true)
    expect(getColumn(table, 'cluster')).toEqual([1, 1, 2, 2])

    // The pass-through is what lets a Dendrogram downstream colour by group with no second
    // input and no column picker.
    const passed = out.tree as LinkageValue
    expect(Array.from(passed.clusters!)).toEqual([1, 1, 2, 2])
    expect(passed.method).toBe('average')
  })

  it('cuts by distance when asked to', () => {
    const out = cut({ mode: 'height', height: 0.15 }, tree)
    expect(getColumn(out.clusters as TableValue, 'cluster')).toEqual([1, 1, 2, 3])
  })

  it('refuses a value that is not a tree, naming what to wire', () => {
    expect(() => cut({}, scoreMatrix() as never)).toThrow(/wire a Linkage node/)
  })

  it('warns at edit time about a negative distance, which joins nothing', () => {
    const issues = requireNodeDef('cluster.cut').validate!({
      params: { mode: 'height', height: -1 },
      inputs: {},
      column: () => undefined,
      columns: () => [],
    } as never)
    expect(issues.join(' ')).toMatch(/negative/)
  })
})

describe('the Dendrogram node', () => {
  const tree: LinkageValue = {
    kind: 'linkage',
    merges: Float64Array.from([0, 1, 0.1, 2, 2, 3, 0.2, 2, 4, 5, 0.9, 4]),
    labels: ['a', 'b', 'c', 'd'],
    order: Int32Array.from([3, 2, 1, 0]),
  }

  function draw(params: Record<string, unknown>): Record<string, unknown> {
    return requireNodeDef('out.dendrogram').evaluate!({
      params: { ...defaultParams(requireNodeDef('out.dendrogram')), ...params },
      input: () => tree,
      column: () => undefined,
      columns: () => [],
      progress: () => {},
      signal: undefined,
    } as never) as Record<string, unknown>
  }

  it('passes the tree through, so it can sit in the middle of a chain', () => {
    expect(draw({}).out).toBe(tree)
  })

  it('carries the cluster and the colour the branch was drawn in', () => {
    /*
     * The colour is what makes a Neuroglancer segment match the bracket it came from, and it
     * cannot be recovered downstream: `resolveColor`'s categorical mode ranks by frequency
     * where a dendrogram numbers its clusters left to right, so "colour by cluster" hands the
     * biggest group the hue the first group was drawn in.
     */
    const cut: LinkageValue = { ...tree, clusters: Int32Array.from([1, 1, 2, 2]) }
    const selected = requireNodeDef('out.dendrogram').evaluate!({
      params: { ...defaultParams(requireNodeDef('out.dendrogram')), selection: ['0', '2'] },
      input: () => cut,
      column: () => undefined,
      columns: () => [],
      progress: () => {},
      signal: undefined,
    } as never) as Record<string, unknown>
    const table = selected.selected as TableValue
    expect(getColumn(table, 'cluster')).toEqual([2, 1])
    expect(getColumn(table, 'color')).toEqual([clusterColor(2, 'dark'), clusterColor(1, 'dark')])
  })

  it('keeps both columns with nothing cut, rather than dropping them from the schema', () => {
    // A schema that gained and lost columns as a Cut Tree came and went would silently empty
    // every picker downstream pointing at them.
    const selected = draw({ selection: ['0'] }).selected as TableValue
    expect(selected.schema.columns.map((c) => c.name)).toEqual([
      'label',
      'order',
      'cluster',
      'color',
    ])
    expect(getColumn(selected, 'cluster')).toEqual([0])
    // Uncut is the achromatic ink, which is exactly what the tree draws for such a branch.
    expect(getColumn(selected, 'color')).toEqual([clusterColor(0, 'dark')])
  })

  it('emits the selected leaves in drawing order', () => {
    // Observation 0 is "a" and observation 2 is "c"; the leaf order is reversed here, so c
    // (position 1) comes before a (position 3).
    const selected = draw({ selection: ['0', '2'] }).selected as TableValue
    expect(getColumn(selected, 'label')).toEqual(['c', 'a'])
    expect(getColumn(selected, 'order')).toEqual([1, 3])
  })

  it('selects by position, so a repeated label does not drag in leaves nobody picked', () => {
    // The bug this exists for, and it only shows in the drawing: `NBLAST → Label by: type`
    // makes labels repeat, and a selection held as labels lights every branch sharing a name.
    const repeated: LinkageValue = {
      kind: 'linkage',
      merges: Float64Array.from([0, 1, 0.1, 2, 2, 3, 0.2, 2, 4, 5, 0.9, 4]),
      labels: ['LC4', 'LC4', 'LC4', 'LC6'],
      order: Int32Array.from([0, 1, 2, 3]),
    }
    const out = requireNodeDef('out.dendrogram').evaluate!({
      params: { ...defaultParams(requireNodeDef('out.dendrogram')), selection: ['0'] },
      input: () => repeated,
      column: () => undefined,
      columns: () => [],
      progress: () => {},
      signal: undefined,
    } as never) as Record<string, unknown>
    expect(getColumn(out.selected as TableValue, 'label')).toEqual(['LC4'])
    expect((out.selected as TableValue).length).toBe(1)
  })

  it('carries fewer rows rather than refusing when a selection points past the tree', () => {
    // `evaluate` has no business blocking everything downstream because a control is stale —
    // see invariant 5's corollary.
    const selected = draw({ selection: ['0', '99'] }).selected as TableValue
    expect(getColumn(selected, 'label')).toEqual(['a'])
  })

  it('is a resizable viewer, so its card fills the wrapper it is given', () => {
    const def = requireNodeDef('out.dendrogram')
    expect(def.category).toBe('visualisation')
    expect(def.defaultSize).toBeDefined()
  })

  it('keeps the selection out of the presentational set, and the drawing knobs in it', () => {
    const params = requireNodeDef('out.dendrogram').params ?? []
    const byId = new Map(params.map((p) => [p.id, p]))
    // A selection is data flowing back from a viewer: it lives in the saved file and in the
    // provenance key, as it does on the Network, 3D and Scatter nodes.
    expect(byId.get('selection')?.presentational).not.toBe(true)
    expect(byId.get('orientation')?.presentational).toBe(true)
    expect(byId.get('showLabels')?.presentational).toBe(true)
  })
})

describe('the three wired together', () => {
  it('runs a real matrix through to a drawn tree', async () => {
    // The bridge is mocked, but everything either side of it is real: the mock connectome's
    // adjacency matrix goes in, and a cut tree with a cluster table comes out.
    mockedRun.mockImplementation(async (request) => {
      const n = request.n
      expect(n).toBeGreaterThan(1)
      // A chain, which is a valid tree of whatever size the matrix turned out to be.
      const merges = new Float64Array((n - 1) * 4)
      for (let i = 0; i < n - 1; i++) {
        merges[i * 4] = i === 0 ? 0 : n + i - 1
        merges[i * 4 + 1] = i + 1
        merges[i * 4 + 2] = (i + 1) / n
        merges[i * 4 + 3] = i + 2
      }
      return { merges, count: n - 1, order: Int32Array.from({ length: n }, (_, i) => i) }
    })

    const scheduler = makeScheduler()
    const summary = await scheduler.run(pipeline(), { mode: 'full' })
    expect(summary.failed).toEqual([])
    expect(summary.executed).toContain('cut')

    const tree = scheduler.output('cut', 'tree') as LinkageValue
    expect(isLinkageValue(tree)).toBe(true)
    expect(new Set(tree.clusters!).size).toBe(2)

    const clusters = scheduler.output('cut', 'clusters') as TableValue
    expect(clusters.length).toBe(tree.labels.length)
    // The labels are the matrix's row labels, which with `Group by type` on are cell types —
    // so the cluster table joins straight back onto a neuron table's `type`.
    expect(getColumn(clusters, 'label').every((l) => typeof l === 'string')).toBe(true)
  })

  it('does not stale the graph when the drawing is restyled', async () => {
    mockedRun.mockImplementation(async (request) => ({
      merges: Float64Array.from(
        Array.from({ length: request.n - 1 }, (_, i) => [
          i === 0 ? 0 : request.n + i - 1,
          i + 1,
          (i + 1) / request.n,
          i + 2,
        ]).flat(),
      ),
      count: request.n - 1,
      order: Int32Array.from({ length: request.n }, (_, i) => i),
    }))

    const scheduler = makeScheduler()
    let g = pipeline()
    await scheduler.run(g, { mode: 'full' })
    const calls = mockedRun.mock.calls.length

    // Turning the tree on its side is a fact about the picture and nothing else, so it must
    // not re-run a Python call three nodes upstream.
    g = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === 'dendro' ? { ...n, params: { ...n.params, orientation: 'down' } } : n,
      ),
    }
    await scheduler.run(g, { mode: 'full' })
    expect(mockedRun.mock.calls.length).toBe(calls)
  })
})
