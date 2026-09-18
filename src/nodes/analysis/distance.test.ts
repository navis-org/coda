/**
 * The node, end to end — including the mesh arm, which is the half no unit test reaches.
 *
 * `geometryDistance.test.ts` drives the arithmetic against stub indexes; what is left here is
 * everything between the sockets and it, and the one piece of it that has a real library
 * underneath: distances to a mesh are a `three-mesh-bvh` closest-point query, so they are to the
 * **surface** rather than to the nearest vertex. That distinction is invisible on any fixture
 * whose answer happens to lie at a corner, so the surfaces below are deliberately coarse — two
 * triangles spanning microns, probed from a point above the middle of a face.
 */

import { describe, expect, it, vi } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { MeshesValue, SkeletonsValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { chain } from '../lib/__fixtures__/chain'
import { buildTargetIndexes } from '../lib/geometryIndex'
import * as geometryIndex from '../lib/geometryIndex'
import '../index'

const def = requireNodeDef('neuron.distance')

/**
 * `count` copies of one chain, each `nodes` long and each on its own line in y.
 *
 * Exists only to be **slow** — it is what a cancellation test needs in order to catch a run in
 * the act, and nothing asserts a number about it. Branching and scattered roots were tried and
 * removed: the test that uses this forces `median`, which walks every sample of every pair, so
 * neither changed what was measured and both cost a second random generator in the file.
 */
function population(count: number, nodes: number): SkeletonsValue {
  const items = Array.from({ length: count }, (_, k) => chain(String(k), nodes, 200, k * 5_000))
  return {
    kind: 'skeletons',
    items,
    attributes: makeTable(tableSchema(column('neuronId', 'str')), {
      neuronId: items.map((item) => item.id),
    }),
    bounds: { min: [0, 0, 0], max: [nodes * 200, count * 5_000, 0] },
    units: 'nm',
  }
}

/** Two straight chains along x, `apart` nanometres apart in y. */
function skeletons(apart: number): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [chain('11', 5, 1000, 0), chain('22', 5, 1000, apart)],
    attributes: makeTable(tableSchema(column('neuronId', 'str'), column('type', 'str')), {
      neuronId: ['11', '22'],
      type: ['LC4', null],
    }),
    bounds: { min: [0, 0, 0], max: [4000, apart, 0] },
    units: 'nm',
  }
}

/**
 * A flat square in the z = `z` plane, 10 µm on a side, **tessellated** into an 8 x 8 grid.
 *
 * The grid rather than two triangles, and it is the difference between a test that holds a
 * property and one that passes for the wrong reason. `three-mesh-bvh` puts up to ten triangles
 * in a leaf, so a two-triangle surface is a single leaf the query walks unconditionally — no box
 * is ever tested against the threshold, and every assertion below about pruning is vacuous. At
 * 128 triangles the tree has interior nodes and the bound is actually applied.
 */
function meshes(z: number, id = 'm1'): MeshesValue {
  const side = 8
  const step = 10000 / side
  const positions = new Float32Array((side + 1) * (side + 1) * 3)
  for (let iy = 0; iy <= side; iy++) {
    for (let ix = 0; ix <= side; ix++) {
      const at = (iy * (side + 1) + ix) * 3
      positions[at] = ix * step
      positions[at + 1] = iy * step
      positions[at + 2] = z
    }
  }
  const indices = new Uint32Array(side * side * 6)
  let at = 0
  for (let iy = 0; iy < side; iy++) {
    for (let ix = 0; ix < side; ix++) {
      const a = iy * (side + 1) + ix
      const b = a + 1
      const c = a + side + 1
      const d = c + 1
      indices.set([a, b, d, a, d, c], at)
      at += 6
    }
  }
  return {
    kind: 'meshes',
    items: [{ id, positions, indices }],
    attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: [id] }),
    bounds: { min: [0, 0, z], max: [10000, 10000, z] },
    units: 'nm',
  }
}

const run = async (
  params: Record<string, unknown>,
  inputs: Record<string, unknown>,
  signal?: AbortSignal,
) => {
  const warnings: string[] = []
  const ctx = {
    // `defaultParams`, not a local spread of `p.default`: that is the rule the real eval context
    // applies, and a third copy of it lets a test pass on a value no run ever supplies.
    params: { ...defaultParams(def), ...params },
    input: (id: string) => inputs[id],
    inputs,
    column: () => (params.labelColumn ? String(params.labelColumn) : ''),
    columns: () => [],
    progress: () => undefined,
    warn: (m: string) => warnings.push(m),
    signal,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (def.evaluate as any)(ctx)
  return { matrix: out.matrix, warnings }
}

describe('the mesh arm measures to the surface, not to the nearest vertex', () => {
  it('answers the perpendicular distance from a point over the middle of a face', async () => {
    const [index] = await buildTargetIndexes(meshes(0))
    // Above a face's middle rather than above a vertex: 3,000 nm from the surface, and further
    // from every vertex of the grid. A vertex index answers the second, and it looks fine.
    expect(index!.nearest(5625, 5625, 3000)).toBeCloseTo(3000, 3)
    expect(index!.hasWithin(5625, 5625, 3000, 3500)).toBe(true)
    expect(index!.hasWithin(5625, 5625, 3000, 2500)).toBe(false)
  })

  it('bounds `nearest` rather than returning whatever the pruning happened to find', async () => {
    const [index] = await buildTargetIndexes(meshes(0))
    // `closestPointToPoint`'s maxThreshold prunes boxes, so a hit can come back from a box that
    // was near enough while the triangle in it is not. Past the bound the answer is Infinity.
    expect(index!.nearest(5625, 5625, 3000, 1000)).toBe(Infinity)
    expect(index!.nearest(5625, 5625, 3000, 5000)).toBeCloseTo(3000, 3)
  })

  it('counts a point exactly on the boundary as within it', async () => {
    const [index] = await buildTargetIndexes(meshes(0))
    // Exactly 3,000 away, asked for 3,000. A box is descended only while it is *strictly* nearer
    // than the threshold, so without the slack on the bound the one holding the answer is pruned
    // and this is a miss — on every axis-aligned surface, which is what a region mesh is.
    expect(index!.hasWithin(5625, 5625, 3000, 3000)).toBe(true)
  })
})

describe('the node', () => {
  it('reports the closest approach in micrometres', async () => {
    const { matrix } = await run({}, { query: skeletons(2000) })
    expect(matrix.rowLabels).toEqual(['11', '22'])
    expect(Array.from(matrix.values)).toEqual([0, 2, 2, 0])
    expect(matrix.measure).toBe('distance')
    expect(matrix.valueLabel).toBe('closest approach (µm)')
  })

  it('labels rows by a picked column, keeping ids where it is blank', async () => {
    const { matrix } = await run({ labelColumn: 'type' }, { query: skeletons(2000) })
    expect(matrix.rowLabels).toEqual(['LC4', '22'])
  })

  it('measures a skeleton against a mesh surface across the two ports', async () => {
    // The chain runs along y = 0 at z = 0; the square sits at z = 4,000 and covers it.
    const { matrix } = await run(
      { symmetry: 'query' },
      { query: skeletons(2000), target: meshes(4000) },
    )
    expect(matrix.colLabels).toEqual(['m1'])
    expect(matrix.values[0]).toBeCloseTo(4, 3)
  })

  it('counts cable within a distance, in µm, bounded by the neuron’s own', async () => {
    const { matrix } = await run(
      { method: 'within', within: 1, symmetry: 'query' },
      { query: skeletons(2000) },
    )
    // Each chain is 4,000 nm of cable, all of it within a micrometre of itself and none of it
    // within a micrometre of a chain two micrometres away.
    expect(matrix.values[0]).toBeCloseTo(4, 6)
    expect(matrix.values[1]).toBeCloseTo(0, 6)
    expect(matrix.valueLabel).toBe('cable within 1 µm (µm)')
    expect(matrix.measure).toBe('count')
  })

  it('refuses geometry that is not in nanometres rather than labelling voxels µm', async () => {
    const voxels = { ...skeletons(2000), units: 'voxels' as const }
    await expect(run({}, { query: voxels })).rejects.toThrow(/not nanometres/)
  })

  it('refuses two template spaces, which would be plausible and meaningless', async () => {
    await expect(
      run(
        {},
        {
          query: { ...skeletons(2000), space: 'FLYWIRE' },
          target: { ...skeletons(2000), space: 'JRCFIB2022M' },
        },
      ),
    ).rejects.toThrow(/Transform Neurons/)
  })

  it('refuses to average cable against surface, at edit time and at run time', async () => {
    const issues = def.validate!(
      // `withDefaults` fills the rest, which is the point: only `method` is stored here, exactly
      // as a card configured by a click would hold it.
      makeInferContext(def, { method: 'within' }, { query: T.skeletons(), target: T.meshes() }),
    )
    expect(issues.join(' ')).toMatch(/µm²/)
    await expect(
      run({ method: 'within' }, { query: skeletons(2000), target: meshes(4000) }),
    ).rejects.toThrow(/query against target only/)
  })

  it('says nothing about a mixed pair when only one direction is taken', async () => {
    const { matrix } = await run(
      { method: 'within', symmetry: 'query', within: 1 },
      { query: skeletons(2000), target: meshes(4000) },
    )
    expect(matrix.values[0]).toBeCloseTo(0, 6)
  })

  it('refuses an empty Target rather than drawing a matrix with no columns', async () => {
    /*
     * A wired-but-empty set gave an R x 0 matrix and said nothing anywhere — a blank Heatmap with
     * no message on the card. The sentence names the remedy because an empty Target and no Target
     * are different graphs, and unwiring it is very often what was meant.
     */
    const empty: SkeletonsValue = {
      kind: 'skeletons',
      items: [],
      attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: [] }),
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      units: 'nm',
    }
    await expect(run({}, { query: skeletons(2000), target: empty })).rejects.toThrow(
      /No neurons on the Target input/,
    )
    // The Query's own refusal is unchanged, and says something different.
    await expect(run({}, { query: empty })).rejects.toThrow(/No neurons on the Query input/)
  })

  it('publishes a matrix before anything has run', () => {
    const out = def.inferOutputs!(makeInferContext(def, {}, {}))
    expect(out.matrix).toEqual(T.matrix())
  })
})

/**
 * Cancel has to reach the arithmetic, which for most of this node's life it did not.
 *
 * `evaluate` is on the main thread, so the only thing that can stop it is `sliced` noticing the
 * signal between bodies — and a body here is one neuron **pair**, which is not the microsecond
 * body the shared loop was tuned for. `core/slice.test.ts` pins the loop; this pins that the node
 * is wired to it, on both of the two long stretches, since a hook passed without its signal looks
 * exactly like one passed with it until somebody presses the button.
 */
describe('cancelling a run', () => {
  const aborted = (promise: Promise<unknown>) =>
    expect(promise).rejects.toMatchObject({ name: 'AbortError' })

  it('stops the pair walk', async () => {
    const controller = new AbortController()
    controller.abort()
    await aborted(run({}, { query: skeletons(2000) }, controller.signal))
  })

  /*
   * The index pass is pinned here rather than through `evaluate`, and the difference is worth
   * saying: an aborted run is caught by the *walk* whether or not the index hooks carry the
   * signal, so a node-level assertion passes either way — mutation says so. What forgetting it
   * actually costs is latency, not correctness: every tree gets built before anything notices,
   * which on a wire of full-resolution meshes is the seconds this whole change is about.
   */
  it('stops while the indexes are still being built', async () => {
    const controller = new AbortController()
    controller.abort()
    await aborted(buildTargetIndexes(meshes(0), { signal: controller.signal }))
    await aborted(buildTargetIndexes(skeletons(2000), { signal: controller.signal }))
  })

  it('stops a running comparison when the signal arrives from the event loop', async () => {
    /*
     * The one that models what a person does: the walk is already going and the abort arrives
     * from outside it. Aborting from inside the body — which the three above do — proves the
     * signal is *read* and not that the loop ever hands the browser the turn in which the click
     * could be dispatched. `core/slice.test.ts` pins that for the loop; this pins it for a node
     * whose body is a whole neuron pair, which is the case the fixed stride was wrong for.
     */
    // Big enough that the whole comparison is seconds of work: 40 neurons of 4,000 nodes is
    // 800 mirrored pairs, each walking 8,000 samples in two directions.
    const many = population(40, 4_000)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 50)
    const started = Date.now()
    // `median` so every pair walks its samples — the dual-tree would finish this before the
    // timer fired, and then the test would be asserting nothing.
    await aborted(run({ statistic: 'median' }, { query: many }, controller.signal))
    clearTimeout(timer)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('stops a centroid run, which builds no index at all', async () => {
    const controller = new AbortController()
    controller.abort()
    await aborted(run({ method: 'centroid' }, { query: skeletons(2000) }, controller.signal))
  })
})

/**
 * The estimate has to describe the algorithm that will actually run.
 *
 * This one cannot be caught by looking at the answers: gating the query-side index on
 * `needsBothDirections` produced **identical numbers**, five times slower, while
 * `estimatedSeconds` quoted the dual tree's price — a wrong estimate of the kind that was already
 * reported once. So what is asserted is the wiring: a closest approach between two point sets
 * builds both index sets, whatever `Symmetry` says, because the descent reads both trees however
 * few directions it reports.
 */
describe('the indexes a closest approach needs', () => {
  const built = async (params: Record<string, unknown>) => {
    const spy = vi.spyOn(geometryIndex, 'buildTargetIndexes')
    try {
      await run(params, { query: skeletons(0), target: skeletons(4000) })
      return spy.mock.calls.length
    } finally {
      spy.mockRestore()
    }
  }

  it('builds both sides for a two-port closest approach, even one-directional', async () => {
    expect(await built({ statistic: 'min', symmetry: 'query' })).toBe(2)
  })

  it('builds both sides for a two-port within, whose pre-rejection descends as well', async () => {
    // One direction, so `needsBothDirections` is false — and the descent still reads both trees.
    expect(await built({ method: 'within', symmetry: 'query' })).toBe(2)
  })

  it('builds one side where only one direction is walked and no descent can happen', async () => {
    // `mean` walks samples, so the query side needs no tree of its own here.
    expect(await built({ statistic: 'mean', symmetry: 'query' })).toBe(1)
  })
})
