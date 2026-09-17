/**
 * The node around the op — what `pointsInMeshes.test.ts` cannot reach.
 *
 * The op is checked there. Here: the schema the card promises before anything has run, the one
 * mistake `validate` can see, and the three refusals `evaluate` makes. The frame refusal is the
 * one to hold on to — it is the only failure in this node that otherwise *succeeds*, handing
 * back an empty `Inside` port that reads as a dataset with no synapses in those regions.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { EvalContext, ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, tableSchema } from '../../core/types'
import type { MeshesValue, PointsValue, Value } from '../../core/values'
import { makeTable } from '../../core/values'
import '../index'
import { cube } from '../lib/__fixtures__/cube'

const def = requireNodeDef('neuron.pointsInVolumes')

const CLOUD_SCHEMA = tableSchema(column('neuronId', 'str'), column('polarity', 'str'))

function volumes(over: Partial<MeshesValue> = {}): MeshesValue {
  return {
    kind: 'meshes',
    items: [cube('EB', [0, 0, 0])],
    attributes: makeTable(tableSchema(column('roi', 'str')), { roi: ['EB'] }),
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    units: 'nm',
    space: 'FLYWIRE',
    ...over,
  }
}

function cloud(over: Partial<PointsValue> = {}): PointsValue {
  return {
    kind: 'points',
    positions: new Float32Array([0, 0, 0, 50, 0, 0]),
    attributes: makeTable(CLOUD_SCHEMA, {
      neuronId: ['1', '2'],
      polarity: ['pre', 'post'],
    }),
    bounds: { min: [0, 0, 0], max: [50, 0, 0] },
    units: 'nm',
    space: 'FLYWIRE',
    ...over,
  }
}

async function run(
  inputs: Record<string, Value | undefined>,
  params: Partial<ParamValues> = {},
) {
  const warnings: string[] = []
  const ctx = {
    params: { ...defaultParams(def), ...params } as ParamValues,
    input: (id: string) => inputs[id],
    warn: (message: string) => warnings.push(message),
    progress: () => {},
  } as unknown as EvalContext
  const out = (await def.evaluate!(ctx)) as { inside: PointsValue; outside: PointsValue }
  return { ...out, warnings }
}

describe('what the card promises before a Run', () => {
  /*
   * The whole reason `inferOutputs` computes the schema rather than returning `T.points()`: a
   * `Group By` on the region has to be configurable while this node is still idle. Both ports,
   * because `Outside` carries the column too.
   */
  it('publishes the minted column on both ports from the wire alone', () => {
    const ctx = makeInferContext(def, defaultParams(def), { points: T.points(CLOUD_SCHEMA) })
    const out = def.inferOutputs!(ctx) as Record<string, { schema?: typeof CLOUD_SCHEMA }>
    expect(columnNames(out.inside!.schema)).toEqual(['neuronId', 'polarity', 'roi'])
    expect(out.outside!.schema).toEqual(out.inside!.schema)
  })

  it('follows the param when the column is renamed', () => {
    const ctx = makeInferContext(
      def,
      { ...defaultParams(def), column: 'region' },
      { points: T.points(CLOUD_SCHEMA) },
    )
    const out = def.inferOutputs!(ctx) as Record<string, { schema?: typeof CLOUD_SCHEMA }>
    expect(columnNames(out.inside!.schema)).toContain('region')
  })

  /* `inferOutputs` may not throw (invariant 2), and an unwired card is not a broken one. */
  it('answers with the column alone when nothing is wired', () => {
    const ctx = makeInferContext(def, defaultParams(def), {})
    const out = def.inferOutputs!(ctx) as Record<string, { schema?: typeof CLOUD_SCHEMA }>
    expect(columnNames(out.inside!.schema)).toEqual(['roi'])
  })
})

describe('validate', () => {
  const issues = (params: ParamValues) =>
    def.validate!(
      makeInferContext(
        def,
        { ...defaultParams(def), ...params },
        {
          points: T.points(CLOUD_SCHEMA),
        },
      ),
    )

  it('says nothing about a name the cloud does not already carry', () => {
    expect(issues({})).toEqual([])
    expect(issues({ column: 'region' })).toEqual([])
    // Nothing on this cloud is called `neuronId`… except it is; see the next case. A name that
    // merely *looks* like an id but collides with nothing is fine.
    expect(issues({ column: 'root_id' })).toEqual([])
  })

  /*
   * The expensive one, and the guard asks about the **incumbent** rather than the name: the
   * column is written over in place, so `neuronId` over a real `neuronId` replaces every
   * synapse's body id with a region name, leaving a table that still has all its columns, still
   * joins, and joins wrongly (invariant 8).
   */
  it('refuses to write region names over a column of ids', () => {
    expect(issues({ column: 'neuronId' })[0]).toContain('holds ids')
  })

  /*
   * And warns for any other collision, which is the half the first version of this guard missed
   * entirely — it asked `isIdentifierColumn(name)` alone, so typing `polarity` destroyed a real
   * column in silence. A guard rail warns; it does not refuse.
   */
  it('warns rather than refusing when it replaces an ordinary column', () => {
    expect(issues({ column: 'polarity' })[0]).toContain('already carry')
  })
})

describe('evaluate', () => {
  it('labels and splits the cloud', async () => {
    const { inside, outside, warnings } = await run({
      points: cloud(),
      volumes: volumes(),
    })
    expect(inside.attributes.data.roi).toEqual(['EB'])
    expect(outside.attributes.data.roi).toEqual([null])
    expect(warnings).toEqual([])
  })

  /*
   * A run with nothing on the Volumes wire is not an error — every point is outside, which is a
   * true answer — but it is indistinguishable from a broken one, so it is said. `docs/limits.md`
   * has the tier argument: a warning goes ahead, a refusal claims there is no useful answer.
   */
  it('warns rather than refusing when no volumes arrived', async () => {
    const { inside, outside, warnings } = await run({
      points: cloud(),
      volumes: volumes({ items: [] }),
    })
    expect(inside.attributes.length).toBe(0)
    expect(outside.attributes.length).toBe(2)
    expect(warnings.join(' ')).toContain('every point is outside')
  })

  /*
   * The silent failure this node's frame check exists for. Across two template spaces every
   * point is outside every volume, so without this the run *succeeds* — an empty `Inside` port
   * and a green card.
   */
  it('refuses a space mismatch rather than returning an empty half', async () => {
    await expect(
      run({ points: cloud({ space: 'JRCFIB2022M' }), volumes: volumes() }),
    ).rejects.toThrow(/template spaces/)
  })

  it('refuses a unit mismatch', async () => {
    await expect(
      run({ points: cloud({ units: 'voxels' }), volumes: volumes() }),
    ).rejects.toThrow(/voxels/)
  })

  /* Said twice on purpose: a stored graph carrying this must not run and rewrite its own ids. */
  it('refuses an id collision at run time too', async () => {
    await expect(
      run({ points: cloud(), volumes: volumes() }, { column: 'neuronId' }),
    ).rejects.toThrow(/holds ids/)
  })

  it('warns and goes ahead when it replaces an ordinary column', async () => {
    const { inside, warnings } = await run(
      { points: cloud(), volumes: volumes() },
      { column: 'polarity' },
    )
    expect(warnings.join(' ')).toContain('already carry')
    expect(inside.attributes.data.polarity).toEqual(['EB'])
  })

  it('names what to wire when a socket is empty', async () => {
    await expect(run({ volumes: volumes() })).rejects.toThrow(/Synapses/)
    await expect(run({ points: cloud() })).rejects.toThrow(/ROI Meshes/)
  })
})
