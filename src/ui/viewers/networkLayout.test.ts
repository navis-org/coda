import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import {
  FORCE_SYNC_BELOW,
  forceSettings,
  assignLayers,
  computeLayout,
  layersFromValues,
  needsForceWorker,
  readTopology,
  settleDuration,
  spectralAxes,
} from './networkLayout'

const NODE_SCHEMA = tableSchema(column('id', 'str'), column('x', 'f64'), column('y', 'f64'))
const EDGE_SCHEMA = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64'),
)

function network(
  nodes: Array<{ id: string; x?: number | null; y?: number | null }>,
  edges: Array<[string, string, number?]>,
  directed = true,
): NetworkValue {
  return {
    kind: 'network',
    directed,
    nodes: tableFromRows(
      NODE_SCHEMA,
      nodes.map((n) => ({ id: n.id, x: n.x ?? null, y: n.y ?? null })),
    ),
    edges: tableFromRows(
      EDGE_SCHEMA,
      edges.map(([source, target, weight]) => ({ source, target, weight: weight ?? 1 })),
    ),
  }
}

/** A feed-forward chain: a → b → c, plus a shortcut a → c. */
const chain = () =>
  network(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [
      ['a', 'b'],
      ['b', 'c'],
      ['a', 'c'],
    ],
  )

describe('readTopology', () => {
  it('maps ids to indices and drops edges pointing at unknown nodes', () => {
    const value = network(
      [{ id: 'a' }, { id: 'b' }],
      [
        ['a', 'b'],
        ['a', 'ghost'],
      ],
    )
    const topology = readTopology(value)
    expect(topology.ids).toEqual(['a', 'b'])
    expect(topology.edges).toEqual([[0, 1]])
    expect(topology.weights).toEqual([1])
  })
})

describe('assignLayers', () => {
  it('assigns longest-path layers in a feed-forward graph', () => {
    const layers = assignLayers(readTopology(chain()))
    expect(layers).toEqual([0, 1, 2])
  })

  it('terminates on a cycle instead of looping forever', () => {
    const cyclic = network(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    )
    // Recurrent circuits are the norm in connectomes, so this must not be a DAG-only
    // algorithm. It caps its passes and returns a usable, if arbitrary, layering.
    const layers = assignLayers(readTopology(cyclic))
    expect(layers).toHaveLength(3)
    for (const layer of layers) expect(Number.isFinite(layer)).toBe(true)
  })

  it('ignores self-loops', () => {
    const selfLoop = network([{ id: 'a' }], [['a', 'a']])
    expect(assignLayers(readTopology(selfLoop))).toEqual([0])
  })

  it('puts an isolated node in the first layer', () => {
    const withIsolate = network([{ id: 'a' }, { id: 'b' }, { id: 'lonely' }], [['a', 'b']])
    expect(assignLayers(readTopology(withIsolate))[2]).toBe(0)
  })
})

describe('computeLayout', () => {
  it('returns a position per node for every layout', async () => {
    for (const layout of [
      'forceatlas2',
      'circular',
      'layered',
      'columns',
      'grouped',
    ] as const) {
      const positions = await computeLayout(chain(), { layout, iterations: 20 })
      expect(positions.size, layout).toBe(3)
      for (const id of ['a', 'b', 'c']) {
        const position = positions.get(id)!
        expect(Number.isFinite(position.x), `${layout} ${id} x`).toBe(true)
        expect(Number.isFinite(position.y), `${layout} ${id} y`).toBe(true)
      }
    }
  })

  it('separates layers along x in the layered layout', async () => {
    const positions = await computeLayout(chain(), { layout: 'layered' })
    const a = positions.get('a')!
    const b = positions.get('b')!
    const c = positions.get('c')!
    expect(a.x).toBeLessThan(b.x)
    expect(b.x).toBeLessThan(c.x)
  })

  it('reads coordinates from the named columns', async () => {
    const spatial = network(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
      [['a', 'b']],
    )
    const positions = await computeLayout(spatial, {
      layout: 'columns',
      xColumn: 'x',
      yColumn: 'y',
    })
    // Normalised into a fixed box, so absolute values change but the relation holds.
    expect(positions.get('a')!.x).toBeLessThan(positions.get('b')!.x)
    expect(positions.get('a')!.y).toBeCloseTo(positions.get('b')!.y, 5)
  })

  it('falls back to a ring when the coordinate columns are missing', async () => {
    const positions = await computeLayout(chain(), {
      layout: 'columns',
      xColumn: 'nope',
      yColumn: 'nope',
    })
    // A bad column choice must still produce a readable picture, not a single point.
    const xs = [...positions.values()].map((p) => p.x)
    expect(new Set(xs.map((x) => Math.round(x))).size).toBeGreaterThan(1)
  })

  it('normalises the static layouts into a comparable box', async () => {
    for (const layout of ['circular', 'layered', 'columns', 'grouped'] as const) {
      const positions = await computeLayout(chain(), { layout, iterations: 20 })
      const values = [...positions.values()].flatMap((p) => [p.x, p.y])
      const extent = Math.max(...values.map(Math.abs))
      // Camera framing shouldn't depend on which layout produced the coordinates.
      expect(extent, layout).toBeLessThanOrEqual(1001)
    }
  })

  it('settles a small graph outright rather than handing back a seed to animate', async () => {
    /*
     * Animation is not free: a worker iteration is gated on a render frame, so 220 iterations
     * take some 3.7 seconds animated against 33ms synchronously at 200 nodes. Below the
     * threshold there is nothing to watch, only a wait, so the layout arrives finished.
     */
    const positions = await computeLayout(chain(), { layout: 'forceatlas2', iterations: 40 })
    const radii = [...positions.values()].map((p) => Math.hypot(p.x, p.y))
    // The seed is a circle of radius 50; a settled layout is not.
    expect(radii.every((r) => Math.abs(r - 50) < 1e-6)).toBe(false)
    expect(radii.every((r) => Number.isFinite(r))).toBe(true)
  })
})

describe('the force layout threshold', () => {
  it('keeps the worker for graphs too big to settle without blocking', () => {
    expect(needsForceWorker(FORCE_SYNC_BELOW)).toBe(false)
    expect(needsForceWorker(FORCE_SYNC_BELOW + 1)).toBe(true)
  })

  it('is set where a blocking run stops being imperceptible', () => {
    // Measured at 220 iterations on a 3-regular graph: 600 nodes ≈ 254ms, 800 ≈ 451ms.
    expect(FORCE_SYNC_BELOW).toBeGreaterThanOrEqual(200)
    expect(FORCE_SYNC_BELOW).toBeLessThanOrEqual(1000)
  })

  it('budgets a worker iteration at about a frame, since that is what gates it', () => {
    // It was 6ms, which silently delivered roughly a third of the iterations asked for.
    expect(settleDuration(220) / 220).toBeGreaterThanOrEqual(12)
  })
})

describe('layersFromValues', () => {
  it('ranks distinct values in order', () => {
    expect(layersFromValues(['b', 'a', 'b', 'c'])).toEqual([1, 0, 1, 2])
  })

  it('orders a numeric column numerically, not lexically', () => {
    // The bug this exists to avoid: 10 sorting before 2.
    expect(layersFromValues([10, 2, 1])).toEqual([2, 1, 0])
  })

  it('puts unlabelled nodes in a layer of their own, at the end', () => {
    // Not layer zero: an unlabelled node is "not placed", not "the first stage".
    expect(layersFromValues(['a', null, 'b', undefined, ''])).toEqual([0, 2, 1, 2, 2])
  })

  it('handles a column with nothing in it', () => {
    expect(layersFromValues([null, null])).toEqual([0, 0])
  })
})

describe('settleDuration', () => {
  it('scales with the iteration budget', () => {
    expect(settleDuration(100)).toBeLessThan(settleDuration(400))
  })

  it('caps, so a big budget cannot leave the picture moving forever', () => {
    expect(settleDuration(100_000)).toBe(settleDuration(2_000_000))
  })

  it('has a floor, and a default for an absent budget', () => {
    expect(settleDuration(undefined)).toBeGreaterThan(0)
    expect(settleDuration(0)).toBeGreaterThan(0)
  })
})

describe('the layered layout', () => {
  it('runs left to right by default', async () => {
    const positions = await computeLayout(chain(), { layout: 'layered' })
    const [a, b, c] = ['a', 'b', 'c'].map((id) => positions.get(id)!)
    expect(a!.x).toBeLessThan(b!.x)
    expect(b!.x).toBeLessThan(c!.x)
  })

  it('runs top to bottom when asked, swapping the axes rather than rotating', async () => {
    const positions = await computeLayout(chain(), { layout: 'layered', orientation: 'tb' })
    const [a, b, c] = ['a', 'b', 'c'].map((id) => positions.get(id)!)
    expect(a!.y).toBeLessThan(b!.y)
    expect(b!.y).toBeLessThan(c!.y)
    // Layers still spread further along their own axis than nodes do along theirs.
    expect(Math.abs(c!.y - a!.y)).toBeGreaterThan(0)
  })

  it('takes layers from a column when one is named, ignoring the topology', async () => {
    // a → b → c by edges, but the column says c and a share a stage.
    const value = network(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    )
    const labelled = {
      ...value,
      nodes: {
        ...value.nodes,
        schema: tableSchema(column('id', 'str'), column('stage', 'str')),
        data: { ...value.nodes.data, stage: ['in', 'mid', 'in'] },
      },
    }
    const positions = await computeLayout(labelled, { layout: 'layered', layerColumn: 'stage' })
    expect(positions.get('a')!.x).toBeCloseTo(positions.get('c')!.x, 6)
    expect(positions.get('b')!.x).not.toBeCloseTo(positions.get('a')!.x, 6)
  })
})

describe('the grouped layout', () => {
  const clustered = () => {
    const value = network([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], [['a', 'c']])
    return {
      ...value,
      nodes: {
        ...value.nodes,
        schema: tableSchema(column('id', 'str'), column('side', 'str')),
        data: { ...value.nodes.data, side: ['L', 'L', 'R', 'R'] },
      },
    }
  }

  const distance = (p: { x: number; y: number }, q: { x: number; y: number }) =>
    Math.hypot(p.x - q.x, p.y - q.y)

  it('puts members of a group nearer each other than members of different groups', async () => {
    const positions = await computeLayout(clustered(), {
      layout: 'grouped',
      groupColumn: 'side',
    })
    const [a, b, c] = ['a', 'b', 'c'].map((id) => positions.get(id)!)
    expect(distance(a!, b!)).toBeLessThan(distance(a!, c!))
  })

  it('is deterministic, so the same data draws the same picture twice', async () => {
    const first = await computeLayout(clustered(), { layout: 'grouped', groupColumn: 'side' })
    const second = await computeLayout(clustered(), { layout: 'grouped', groupColumn: 'side' })
    expect([...first.entries()]).toEqual([...second.entries()])
  })

  it('degrades to one cluster when no column is named, rather than throwing', async () => {
    const positions = await computeLayout(clustered(), { layout: 'grouped' })
    expect(positions.size).toBe(4)
  })

  it('handles an empty network', async () => {
    const empty = network([], [])
    expect((await computeLayout(empty, { layout: 'forceatlas2' })).size).toBe(0)
  })

  it('handles a single node without dividing by a zero extent', async () => {
    const single = network([{ id: 'only' }], [])
    const positions = await computeLayout(single, { layout: 'circular' })
    expect(Number.isFinite(positions.get('only')!.x)).toBe(true)
  })
})

describe('spectralAxes', () => {
  /*
   * Two eigenvectors of the Laplacian, by power iteration on a shifted operator. Pure
   * arithmetic over a topology, which is the sort of thing that can be pinned down exactly
   * without a renderer — and the reason it is exported.
   */

  /** Two triangles joined by a single bridge: an obvious cut for the Fiedler vector to find. */
  const barbell = () =>
    readTopology(
      network(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }],
        [
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'a'],
          ['d', 'e'],
          ['e', 'f'],
          ['f', 'd'],
          ['c', 'd'],
        ],
      ),
    )

  it('separates the two halves of a barbell along the first axis', () => {
    const axes = spectralAxes(barbell())!
    expect(axes).toBeTruthy()
    const [x] = axes
    const left = ['a', 'b', 'c'].map((_, i) => x[i]!)
    const right = [3, 4, 5].map((i) => x[i]!)
    // Every node of one clique on one side of zero, every node of the other on the far side.
    expect(Math.max(...left) < 0 || Math.min(...left) > 0).toBe(true)
    expect(Math.sign(left[0]!)).not.toBe(Math.sign(right[0]!))
  })

  it('is deterministic — a cached layout must not wander between runs', () => {
    expect(spectralAxes(barbell())).toEqual(spectralAxes(barbell()))
  })

  it('returns two axes that are not the same axis twice', () => {
    const [x, y] = spectralAxes(barbell())!
    let dot = 0
    for (let i = 0; i < x.length; i++) dot += x[i]! * y[i]!
    expect(Math.abs(dot)).toBeLessThan(1e-6)
  })

  it('centres each axis, so the embedding is an arrangement rather than an offset', () => {
    const [x, y] = spectralAxes(barbell())!
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
    expect(Math.abs(mean(x))).toBeLessThan(1e-6)
    expect(Math.abs(mean(y))).toBeLessThan(1e-6)
  })

  it('declines a graph too small to embed', () => {
    expect(
      spectralAxes(readTopology(network([{ id: 'a' }, { id: 'b' }], [['a', 'b']]))),
    ).toBeUndefined()
  })

  it('declines a graph with no edges, where every node is its own component', () => {
    const empty = readTopology(network([{ id: 'a' }, { id: 'b' }, { id: 'c' }], []))
    expect(spectralAxes(empty)).toBeUndefined()
  })
})

describe('the spectral layout', () => {
  it('places the halves of a barbell apart', async () => {
    const value = network(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
        ['d', 'e'],
        ['e', 'f'],
        ['f', 'd'],
        ['c', 'd'],
      ],
    )
    const positions = await computeLayout(value, { layout: 'spectral' })
    const distance = (p: string, q: string) =>
      Math.hypot(
        positions.get(p)!.x - positions.get(q)!.x,
        positions.get(p)!.y - positions.get(q)!.y,
      )
    expect(distance('a', 'b')).toBeLessThan(distance('a', 'e'))
  })

  it('falls back to a ring rather than collapsing when it cannot embed', async () => {
    const isolated = network([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [])
    const positions = await computeLayout(isolated, { layout: 'spectral' })
    const distinct = new Set(
      [...positions.values()].map((p) => `${Math.round(p.x)},${Math.round(p.y)}`),
    )
    expect(distinct.size).toBe(3)
  })
})

describe('the force layout seed', () => {
  const chainish = () =>
    network(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
      ],
    )

  it('offers a spectral start that differs from the default ring', async () => {
    // Offered but not the default: no benchmark here could demonstrate that it beats a circle,
    // and defaulting to an unvalidated change is the habit the palette rules exist to prevent.
    const circle = await computeLayout(chainish(), { layout: 'forceatlas2', iterations: 10 })
    const spectral = await computeLayout(chainish(), {
      layout: 'forceatlas2',
      iterations: 10,
      seed: 'spectral',
    })
    expect([...spectral.values()]).not.toEqual([...circle.values()])
  })

  it('still lands somewhere finite for a graph it cannot embed', async () => {
    const isolated = network([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [])
    const positions = await computeLayout(isolated, { layout: 'forceatlas2', iterations: 10 })
    for (const at of positions.values()) {
      expect(Number.isFinite(at.x) && Number.isFinite(at.y)).toBe(true)
    }
  })
})

describe('link weight in the force layout', () => {
  /*
   * Weights reach ForceAtlas2 through the graph's `weight` edge attribute, and graphology's
   * getter coerces a missing one to 1 without complaint. That silence is what let the worker
   * path ignore synapse counts entirely while the synchronous path used them — the same node,
   * the same params, different physics either side of `FORCE_SYNC_BELOW`.
   */

  const weighted = (w: number) =>
    network(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        ['a', 'b', w],
        ['c', 'd', 1],
        ['b', 'c', 1],
      ],
    )

  it('lays a strongly-weighted pair out differently from a weak one', async () => {
    const opts = { layout: 'forceatlas2' as const, iterations: 200, seed: 'circle' as const }
    const light = await computeLayout(weighted(1), opts)
    const heavy = await computeLayout(weighted(500), opts)
    const gap = (m: Awaited<ReturnType<typeof computeLayout>>) =>
      Math.hypot(m.get('a')!.x - m.get('b')!.x, m.get('a')!.y - m.get('b')!.y)
    // Not asserting a direction — FA2's response to weight is not monotone in any simple way.
    // What must hold is that the weight was *seen* at all.
    expect(gap(heavy)).not.toBeCloseTo(gap(light), 3)
  })

  it('changes the layout when the influence changes', async () => {
    const base = { layout: 'forceatlas2' as const, iterations: 200, seed: 'circle' as const }
    const full = await computeLayout(weighted(500), base)
    const none = await computeLayout(weighted(500), { ...base, weightInfluence: 0 })
    expect([...full.values()]).not.toEqual([...none.values()])
  })

  it('still responds to weight at zero influence, because mass is weighted degree', async () => {
    /*
     * The trap: `edgeWeightInfluence` scales *attraction* only — `ewc = pow(w, influence)`, so
     * zero flattens every edge to 1. But `graphToByteArrays` accumulates node mass as the raw
     * weighted degree, untouched by the influence, and mass drives repulsion and gravity. So
     * "0" means "weight does not pull", never "weight is ignored".
     */
    const opts = {
      layout: 'forceatlas2' as const,
      iterations: 200,
      seed: 'circle' as const,
      weightInfluence: 0,
    }
    const light = await computeLayout(weighted(1), opts)
    const heavy = await computeLayout(weighted(500), opts)
    expect([...heavy.values()]).not.toEqual([...light.values()])
  })
})

describe('forceSettings', () => {
  const infer = () => ({ barnesHutOptimize: false, gravity: 1 })
  const graph = null as never

  it('defers to graphology’s own quadtree threshold on auto', () => {
    expect(forceSettings(infer, graph, 'auto')['barnesHutOptimize']).toBe(false)
  })

  it('forces the quadtree on or off when told', () => {
    expect(forceSettings(infer, graph, 'on')['barnesHutOptimize']).toBe(true)
    expect(forceSettings(infer, graph, 'off')['barnesHutOptimize']).toBe(false)
  })

  it('leaves the weight influence at the library default unless asked', () => {
    expect(forceSettings(infer, graph, 'auto')['edgeWeightInfluence']).toBeUndefined()
  })

  it('clamps the weight influence to the range the algorithm defines', () => {
    expect(forceSettings(infer, graph, 'auto', 0.4)['edgeWeightInfluence']).toBe(0.4)
    expect(forceSettings(infer, graph, 'auto', -3)['edgeWeightInfluence']).toBe(0)
    expect(forceSettings(infer, graph, 'auto', 9)['edgeWeightInfluence']).toBe(1)
  })

  it('always asks for size adjustment, so nodes do not overlap', () => {
    expect(forceSettings(infer, graph, 'auto')['adjustSizes']).toBe(true)
  })
})

/**
 * Positions handed in from upstream.
 *
 * The failures being guarded against are the quiet ones again. Normalising a given layout
 * still draws a picture — just not the one the numbers said. Dropping the nodes it does not
 * name still draws a picture, minus whatever an upstream filter added since. And falling back
 * to the algorithm only when the record is *absent*, rather than when nothing in it matches,
 * stacks the entire graph on the origin the moment a layout outlives its node set.
 */
describe('a given layout', () => {
  it('is used verbatim, and beats the chosen algorithm', async () => {
    const given = { a: { x: -7, y: 3 }, b: { x: 1000, y: -2 }, c: { x: 4, y: 4 } }
    const positions = await computeLayout(chain(), { layout: 'circular', given })
    expect(positions.get('a')).toEqual({ x: -7, y: 3 })
    // Not normalised, unlike every computed layout here: an upstream layout is in units
    // somebody chose and sigma frames it regardless.
    expect(positions.get('b')).toEqual({ x: 1000, y: -2 })
  })

  it('places a node it does not name rather than dropping it', async () => {
    const given = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }
    const positions = await computeLayout(chain(), { layout: 'circular', given })
    expect(positions.size).toBe(3)
    const c = positions.get('c')
    expect(Number.isFinite(c?.x)).toBe(true)
    expect(Number.isFinite(c?.y)).toBe(true)
    // And not on top of one of the placed ones.
    expect(c).not.toEqual(given.a)
    expect(c).not.toEqual(given.b)
  })

  it('ignores a non-numeric coordinate rather than propagating a NaN', async () => {
    const given = { a: { x: Number.NaN, y: 0 }, b: { x: 10, y: 0 }, c: { x: 20, y: 0 } }
    const positions = await computeLayout(chain(), { layout: 'circular', given })
    expect(Number.isFinite(positions.get('a')?.x)).toBe(true)
  })

  it('falls back to the algorithm when the layout is for a different graph', async () => {
    const given = { zzz: { x: 5, y: 5 } }
    const positions = await computeLayout(chain(), { layout: 'layered', given })
    expect(positions.size).toBe(3)
    // The layered layout, not three nodes parked in a ring around nothing.
    const a = positions.get('a')
    const c = positions.get('c')
    expect(Number(a?.x)).toBeLessThan(Number(c?.x))
  })
})
