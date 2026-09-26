/**
 * Skeleton to Points — the op and the card around it.
 *
 * The properties that matter are the ones a plausible cloud would hide: `cable` summing back to
 * the cable length (under both placements), no piece straddling a branch point, a point's
 * compartment being its edge's, and the schema promised at edit time being the one delivered.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { EvalContext, ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, tableSchema } from '../../core/types'
import type { PointsValue, SkeletonGeometry, SkeletonsValue } from '../../core/values'
import { cableLength, compartmentName, makeTable } from '../../core/values'
import '../index'
import type { Placement } from './skeletonPoints'
import { pointCount, skeletonPointsSchema, skeletonPointsValue } from './skeletonPoints'

const def = requireNodeDef('neuron.skeletonPoints')

/*
 * A Y in nanometres: a 3 µm trunk from the root (0) up to a branch point (2), then a 2 µm arm
 * (3, 4) and a 0.5 µm twig (5). The trunk is labelled soma → axon, the arms dendrite.
 *
 *        4       5
 *        |      /
 *        3     /
 *         \   /
 *           2
 *           |
 *           1
 *           |
 *           0
 */
function yShape(over: Partial<SkeletonGeometry> = {}): SkeletonGeometry {
  return {
    id: '7',
    positions: new Float32Array([
      0, 0, 0, 0, 1000, 0, 0, 3000, 0, 0, 4000, 0, 0, 5000, 0, 500, 3000, 0,
    ]),
    radii: new Float32Array([100, 100, 80, 60, 40, 20]),
    parents: new Int32Array([-1, 0, 1, 2, 3, 2]),
    compartments: new Uint8Array([1, 2, 2, 3, 3, 4]),
    ...over,
  }
}

const ATTRIBUTES = tableSchema(column('neuronId', 'str'), column('type', 'str'))

function skeletons(items: SkeletonGeometry[] = [yShape()]): SkeletonsValue {
  return {
    kind: 'skeletons',
    items,
    attributes: makeTable(ATTRIBUTES, {
      neuronId: items.map((s) => s.id),
      type: items.map(() => 'L2/3 IT'),
    }),
    bounds: { min: [0, 0, 0], max: [500, 5000, 0] },
    units: 'nm',
  }
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0)

/** One skeleton's cloud, columns as plain arrays. */
async function sampleSkeleton(
  skeleton: SkeletonGeometry,
  placement: Placement,
  spacingNm: number,
) {
  const value = skeletons([skeleton])
  const schema = skeletonPointsSchema(value.attributes.schema, [])
  const counts = [pointCount(skeleton, placement, spacingNm)]
  const points = await skeletonPointsValue(value, counts, placement, spacingNm, schema, {})
  const d = points.attributes.data
  return {
    positions: points.positions,
    compartment: d.compartment!,
    cable: d.cable! as number[],
    radius: d.radius! as (number | null)[],
    strahler: d.strahler!,
    rootDistance: d.rootDistance!,
  }
}

describe('the op', () => {
  it('cuts each run into equal pieces no longer than Spacing, never across a branch point', async () => {
    const s = await sampleSkeleton(yShape(), 'resample', 1000)
    // Trunk 3 µm → 3, arm 2 µm → 2, twig 0.5 µm → 1.
    expect(s.cable.length).toBe(6)
    expect(s.cable.every((c) => c <= 1 + 1e-9)).toBe(true)
    expect(s.cable.filter((c) => Math.abs(c - 0.5) < 1e-9)).toHaveLength(1)
  })

  it('sums `cable` back to the cable length under both placements', async () => {
    const skeleton = yShape()
    const total = cableLength(skeleton) / 1000
    expect(sum((await sampleSkeleton(skeleton, 'resample', 1000)).cable)).toBeCloseTo(total, 9)
    expect(sum((await sampleSkeleton(skeleton, 'resample', 700)).cable)).toBeCloseTo(total, 9)
    expect(sum((await sampleSkeleton(skeleton, 'nodes', 0)).cable)).toBeCloseTo(total, 9)
  })

  it('puts a point at the middle of its piece, with the root distance and radius there', async () => {
    const s = await sampleSkeleton(yShape(), 'resample', 1000)
    // The trunk is walked first: pieces centred at 0.5, 1.5 and 2.5 µm up the y axis.
    expect([...s.positions.slice(0, 9)]).toEqual([0, 500, 0, 0, 1500, 0, 0, 2500, 0])
    expect(s.rootDistance.slice(0, 3)).toEqual([0.5, 1.5, 2.5])
    expect(s.radius[0]).toBeCloseTo(0.1)
    // 1.5 µm is a quarter of the way along the 1 → 2 edge, radius 100 → 80 nm.
    expect(s.radius[1]).toBeCloseTo(0.095)
  })

  it('takes the compartment and Strahler order of the edge’s child node', async () => {
    const s = await sampleSkeleton(yShape(), 'resample', 1000)
    expect(s.compartment.slice(0, 3)).toEqual(['axon', 'axon', 'axon'])
    expect(new Set(s.compartment.slice(3))).toEqual(
      new Set(['basal dendrite', 'apical dendrite']),
    )
    expect(s.strahler.slice(0, 3)).toEqual([2, 2, 2])
    expect(s.strahler.slice(3)).toEqual([1, 1, 1])
  })

  it('leaves compartment and radius null where the source publishes none', async () => {
    const s = await sampleSkeleton(
      yShape({ compartments: undefined, radii: new Float32Array(6) }),
      'resample',
      1000,
    )
    expect(s.compartment.every((c) => c === null)).toBe(true)
    expect(s.radius.every((r) => r === null)).toBe(true)
  })

  it('makes no point from a skeleton with no cable, and one per node under `nodes`', async () => {
    const lone = yShape({
      positions: new Float32Array(3),
      radii: new Float32Array(1),
      parents: new Int32Array([-1]),
      compartments: undefined,
    })
    expect((await sampleSkeleton(lone, 'resample', 1000)).cable).toHaveLength(0)
    expect((await sampleSkeleton(lone, 'nodes', 0)).cable).toEqual([0])
  })

  it('counts exactly what it then writes, before allocating', async () => {
    const skeleton = yShape()
    for (const spacing of [1000, 700, 250]) {
      const made = (await sampleSkeleton(skeleton, 'resample', spacing)).cable.length
      expect(pointCount(skeleton, 'resample', spacing)).toBe(made)
    }
    expect(pointCount(skeleton, 'nodes', 0)).toBe(6)
  })

  it('keeps an unknown SWC code as its number rather than guessing', () => {
    expect(compartmentName(0)).toBeNull()
    expect(compartmentName(7)).toBe('swc 7')
  })
})

describe('the node', () => {
  async function run(value: SkeletonsValue, params: Partial<ParamValues> = {}) {
    const warnings: string[] = []
    const merged = { ...defaultParams(def), ...params } as ParamValues
    const ctx = {
      params: merged,
      input: () => value,
      columns: (id: string) => (merged[id] as string[]) ?? [],
      column: () => undefined,
      warn: (message: string) => warnings.push(message),
      progress: () => {},
    } as unknown as EvalContext
    const out = (await def.evaluate!(ctx)) as { out: PointsValue }
    return { points: out.out, warnings }
  }

  it('delivers the schema it promised before the Run, carried columns included', async () => {
    const infer = makeInferContext(
      def,
      { ...defaultParams(def), carry: ['type'] },
      { in: T.skeletons(ATTRIBUTES) },
    )
    const promised = (def.inferOutputs!(infer) as Record<string, { schema?: unknown }>).out!
      .schema
    const { points } = await run(skeletons(), { carry: ['type'] })
    expect(points.attributes.schema).toEqual(promised)
    expect(columnNames(points.attributes.schema)).toEqual([
      'neuronId',
      'type',
      'compartment',
      'cable',
      'radius',
      'strahler',
      'rootDistance',
    ])
    expect(points.positions.length).toBe(points.attributes.length * 3)
    expect(new Set(points.attributes.data.type)).toEqual(new Set(['L2/3 IT']))
    expect(points.units).toBe('nm')
  })

  it('lets a minted column win over a carried one of the same name', () => {
    const schema = skeletonPointsSchema(
      tableSchema(column('neuronId', 'str'), column('cable', 'str')),
      ['cable'],
    )
    expect(schema.columns.filter((c) => c.name === 'cable')).toEqual([
      column('cable', 'f64', 'µm'),
    ])
  })

  it('says how many skeletons carried no compartment labels', async () => {
    const { points, warnings } = await run(
      skeletons([yShape(), yShape({ id: '8', compartments: undefined })]),
    )
    expect(warnings.some((w) => w.startsWith('1 of 2 skeletons carry no compartment'))).toBe(
      true,
    )
    expect(points.attributes.data.compartment!.filter((c) => c === null)).toHaveLength(6)
  })

  it('refuses voxel geometry, where a spacing in µm means nothing', async () => {
    await expect(run({ ...skeletons(), units: 'voxels' })).rejects.toThrow(/not nanometres/)
  })
})
