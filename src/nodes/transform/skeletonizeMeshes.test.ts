/**
 * Skeletonize Meshes: the request, the scattering back, the soma, the warnings, and the node.
 *
 * `cleanMeshes.test.ts`' division of labour: `scripts/probe-skeletonize.py` holds the algorithm
 * against skeletor and `scripts/probe-skeletonize.mjs` runs it in Pyodide; this owns whether the
 * right buffers went over and the right skeletons came back. The assertions that matter most are
 * the ones that *render* rather than raise — an item count that moved, and parents that are not
 * local to their own skeleton.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams, makeInferContext } from '../../core/node'
import type { ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import type { MeshesValue, SkeletonsValue } from '../../core/values'
import { SWC_SOMA, isMeshesValue, isSkeletonsValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { SkeletonizeRequest, SkeletonizeResult } from '../../pyodide/skeletonize'
import { checkCleanUnits } from '../lib/cleanOps'
import type { SkeletonizeParams } from '../lib/skeletonizeOps'
import {
  WAVEFRONT_PROVENANCE,
  emptiedMeshes,
  skeletonizeParamsFrom,
  skeletonizeRequestFrom,
  skeletonizeSeconds,
  skeletonsFromMeshes,
  somaCounts,
  somaPositionsFrom,
  usesDistance,
  warnSkeletonizeWait,
} from '../lib/skeletonizeOps'
import '../index'
import { searchFor } from '../../test/findNeurons'
import { meshesFixture } from '../../test/meshes'
import { node } from '../../test/graph'
import { mockScheduler } from '../../test/scheduler'

vi.mock('../../pyodide/skeletonize', () => ({ runSkeletonize: vi.fn() }))
const { runSkeletonize } = await import('../../pyodide/skeletonize')
const mockedRun = vi.mocked(runSkeletonize)

/** The shared mesh set, with a space and a level of detail so both rules can be seen. */
const fixture = () => meshesFixture({ detail: true, space: 'JRC2018F' })

/** The card's own defaults, read from the declaration rather than restated beside it. */
const DEFAULTS: SkeletonizeParams = skeletonizeParamsFrom(
  defaultParams(requireNodeDef('neuron.skeletonize')),
)

/**
 * A stand-in for the engine: a two-node chain per mesh with faces, from its first two vertices,
 * and an empty skeleton for a mesh with none. Parents are local, which is the contract.
 */
function chains(request: SkeletonizeRequest): SkeletonizeResult {
  const points: number[] = []
  const parents: number[] = []
  const radii: number[] = []
  const count = request.vertexOffsets.length - 1
  const offsets = new Int32Array(count + 1)
  for (let m = 0; m < count; m++) {
    const hasFaces = request.faceOffsets[m + 1]! > request.faceOffsets[m]!
    if (hasFaces) {
      const at = request.vertexOffsets[m]! * 3
      points.push(...request.positions.slice(at, at + 6))
      parents.push(-1, 0)
      radii.push(10, 20)
    }
    offsets[m + 1] = offsets[m]! + (hasFaces ? 2 : 0)
  }
  return {
    points: Float32Array.from(points),
    parents: Int32Array.from(parents),
    radii: Float32Array.from(radii),
    offsets,
    // The root of each chain is its soma, from the source, as the module reports one.
    somas: Int32Array.from({ length: count }, (_, m) =>
      offsets[m + 1]! > offsets[m]! ? 0 : -1,
    ),
  }
}

describe('skeletonizeOps — the request', () => {
  // The flattening is `packMeshes`', tested in `cleanMeshes.test.ts`; what is this node's is that
  // every control goes across, and the one distance goes across in the coordinates' units.
  it('carries every control across, the long-edge cutoff in nanometres', () => {
    const request = skeletonizeRequestFrom(fixture(), {
      waves: 3,
      stepSize: 2,
      radiusAgg: 'median',
      minFragment: 50,
      shave: 'thorough',
      shaveCutoff: 2,
      fixZeroRadii: false,
      somaCleanup: true,
      somaRadius: 4,
      detectSoma: true,
      minSomaRadius: 1.5,
    })
    expect(request).toMatchObject({
      waves: 3,
      stepSize: 2,
      radiusAgg: 'median',
      minFragment: 50,
      shave: 'thorough',
      shaveCutoff: 2000,
      fixZeroRadii: false,
      somaCleanup: true,
      somaRadius: 4000,
      detectSoma: true,
      minSomaRadius: 1500,
    })
  })
})

describe('skeletonizeOps — the soma', () => {
  const withSomas = (units: 'nm' | 'voxels' = 'nm'): MeshesValue => {
    const value = fixture()
    return {
      ...value,
      units,
      items: value.items.map((item, n) =>
        n === 1 ? { ...item, soma: [1, 2, 3] as const } : item,
      ),
    }
  }

  it('sends one position per mesh, NaN where the source gave none', () => {
    const at = somaPositionsFrom(withSomas())
    expect(at.length).toBe(9)
    expect(Array.from(at.subarray(3, 6))).toEqual([1, 2, 3])
    expect(Number.isNaN(at[0]!) && Number.isNaN(at[6]!)).toBe(true)
  })

  it('sends none on coordinates that are not nanometres, where a radius in µm means nothing', () => {
    expect(Array.from(somaPositionsFrom(withSomas('voxels'))).every(Number.isNaN)).toBe(true)
  })

  it('labels the soma node, and only it, with SWC’s soma code', () => {
    const value = fixture()
    const out = skeletonsFromMeshes(value, chains(skeletonizeRequestFrom(value, DEFAULTS)))
    expect(Array.from(out.items[0]!.compartments!)).toEqual([SWC_SOMA, 0])
    // An empty skeleton has no soma to label, and no compartments at all.
    expect(out.items[2]!.compartments).toBeUndefined()
  })

  it('counts a soma as detected exactly where no position was sent for its mesh', () => {
    const value = withSomas()
    const result = chains(skeletonizeRequestFrom(value, DEFAULTS))
    // Mesh 0 has a soma row but sent no position; mesh 1 sent one; mesh 2 is empty.
    expect(somaCounts(value, result)).toEqual({ placed: 1, detected: 1 })
  })
})

describe('skeletonizeOps — the scattering', () => {
  it('gives every mesh its own skeleton, ids and attributes carried, empty kept in place', () => {
    const value = fixture()
    const out = skeletonsFromMeshes(value, chains(skeletonizeRequestFrom(value, DEFAULTS)))
    expect(out.kind).toBe('skeletons')
    expect(out.items.map((i) => i.id)).toEqual(['11', '22', '33'])
    expect(out.items.map((i) => i.parents.length)).toEqual([2, 2, 0])
    expect(out.attributes).toBe(value.attributes)
    expect(out.items[1]!.positions[0]).toBe(5000)
  })

  it('carries units and space, names its provenance, and leaves the mesh detail behind', () => {
    const value = fixture()
    const out = skeletonsFromMeshes(value, chains(skeletonizeRequestFrom(value, DEFAULTS)))
    expect(out.units).toBe('nm')
    expect(out.space).toBe('JRC2018F')
    expect(out.provenance).toBe(WAVEFRONT_PROVENANCE)
    expect('detail' in out).toBe(false)
  })

  it('refuses a result with a different number of skeletons in it', () => {
    const value = fixture()
    const short = chains(skeletonizeRequestFrom(value, DEFAULTS))
    expect(() =>
      skeletonsFromMeshes(value, { ...short, offsets: short.offsets.slice(0, 3) }),
    ).toThrow(/no longer line up/)
  })

  it('counts a mesh that had faces and came back empty, and not one that had none', () => {
    const value = fixture()
    const result = chains(skeletonizeRequestFrom(value, DEFAULTS))
    expect(emptiedMeshes(value, result)).toBe(0)
    // The first mesh's every piece under the threshold.
    const emptied = { ...result, offsets: Int32Array.from([0, 0, 2, 2]) }
    expect(emptiedMeshes(value, emptied)).toBe(1)
  })
})

describe('skeletonizeOps — the wait', () => {
  const big = (vertices: number): MeshesValue => ({
    ...fixture(),
    items: [
      { id: '1', positions: new Float32Array(vertices * 3), indices: new Uint32Array(3) },
    ],
  })

  it('grows with vertices and with waves', () => {
    expect(skeletonizeSeconds(big(2_000_000), 3)).toBeGreaterThan(
      skeletonizeSeconds(big(2_000_000), 1),
    )
    expect(skeletonizeSeconds(big(2_000_000), 1)).toBeCloseTo(1.7, 1)
  })

  it('says nothing under five minutes', () => {
    const said: string[] = []
    warnSkeletonizeWait({ warn: (m) => said.push(m) }, big(50_000_000), 1)
    expect(said).toEqual([])
  })

  it('warns past five minutes, naming the controls upstream, and never refuses', () => {
    const said: string[] = []
    warnSkeletonizeWait({ warn: (m) => said.push(m) }, big(300_000_000), 3)
    const text = said.join(' ')
    expect(text).toMatch(/minutes/)
    expect(text).toMatch(/`Keep faces` on Clean Meshes/)
    expect(text).toMatch(/fewer `Waves`/)
    expect(text).toMatch(/Running anyway/)
  })
})

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

const source = new MockSource({ latencyMs: 0 })

/** dataset → find(LC4) → meshes → skeletonize */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('skeletonize-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(
    g,
    node('find', 'neuron.findNeurons', searchFor({ type: 'LC4', status: 'Traced' })),
  )
  g = addNode(g, node('mesh', 'neuron.meshes', { limit: 10 }))
  g = addNode(g, node('skel', 'neuron.skeletonize', params))
  for (const [from, out, to, into] of [
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'mesh', 'dataset'],
    ['find', 'neurons', 'mesh', 'neurons'],
    ['mesh', 'meshes', 'skel', 'in'],
  ] as const) {
    g = addEdge(g, { source: from, sourceHandle: out, target: to, targetHandle: into })
  }
  return g
}

beforeEach(() => {
  mockedRun.mockReset()
})

/** The node's own `evaluate`, with a warn spy — `cleanSkeletons.test.ts`' helper and reason. */
async function skeletonize(value: MeshesValue, params: Partial<SkeletonizeParams>) {
  const def = requireNodeDef('neuron.skeletonize')
  const warnings: string[] = []
  const outputs = await def.evaluate({
    params: { ...defaultParams(def), ...params } as ParamValues,
    refresh: false,
    reportFetched: () => undefined,
    warn: (message: string) => warnings.push(message),
    publish: () => undefined,
    input: () => value,
    inputKey: () => 'in-key',
    column: () => undefined,
    columns: () => [],
    inputPorts: () => [],
    outputPorts: () => [],
    resolveSource: () => new MockSource(),
    signal: new AbortController().signal,
    progress: () => {},
  })
  return { out: outputs['out'] as SkeletonsValue, warnings }
}

describe('neuron.skeletonize — the soma clean-up', () => {
  it('says how many meshes had no source soma to clean up, and that detection never merges', async () => {
    mockedRun.mockImplementation((request) => {
      const result = chains(request)
      return Promise.resolve({ ...result, somas: Int32Array.from([0, 0, -1]) })
    })
    // Only the first mesh has a source soma, so the second's was detected.
    const value = fixture()
    const firstOnly = {
      ...value,
      items: value.items.map((item, n) =>
        n === 0 ? { ...item, soma: [0, 0, 0] as const } : item,
      ),
    }
    const { warnings } = await skeletonize(firstOnly, { somaCleanup: true })
    expect(warnings.join(' ')).toMatch(/1 of 3 meshes have no soma position from the source/)
    expect(warnings.join(' ')).toMatch(/labelled but never merged/)
  })

  it('says nothing when every mesh with faces had its soma from the source', async () => {
    mockedRun.mockImplementation((request) => Promise.resolve(chains(request)))
    const value = fixture()
    const both = {
      ...value,
      items: value.items.map((item, n) =>
        n < 2 ? { ...item, soma: [0, 0, 0] as const } : item,
      ),
    }
    const { warnings } = await skeletonize(both, { somaCleanup: true })
    expect(warnings).toEqual([])
  })
})

describe('neuron.skeletonize — the node', () => {
  it('publishes skeletons with the meshes’ attribute schema', () => {
    const inference = inferGraph(pipeline())
    expect(inference.nodes.skel?.outputs.out?.kind).toBe('skeletons')
  })

  it('is expensive, so a waves slider does not fire a run per keystroke', () => {
    expect(requireNodeDef('neuron.skeletonize').cost).toBe('expensive')
  })

  it('shaves bristles and fixes zero radii on a new card, as navis does by default', () => {
    expect(defaultParams(requireNodeDef('neuron.skeletonize'))).toMatchObject({
      shave: 'bristles',
      fixZeroRadii: true,
    })
  })

  it('shows the long-edge cutoff wherever it is read: the thorough shave and the soma clean-up', () => {
    const param = requireNodeDef('neuron.skeletonize').params?.find(
      (p) => p.id === 'shaveCutoff',
    )
    expect(param?.visibleIf?.({ shave: 'bristles' })).toBe(false)
    expect(param?.visibleIf?.({ shave: 'thorough' })).toBe(true)
    // Hidden while the clean-up read it, it would leave the provenance key and an edit would
    // re-run nothing.
    expect(param?.visibleIf?.({ shave: 'bristles', somaCleanup: true })).toBe(true)
  })

  // Through `makeInferContext`, `cleanMeshes.test.ts`' reason.
  const validate = (params: ParamValues) => {
    const def = requireNodeDef('neuron.skeletonize')
    return (
      def.validate?.(makeInferContext(def, { ...defaultParams(def), ...params }, {})) ?? []
    ).join(' ')
  }

  it('flags a cutoff that looks like nanometres, but only where it is used', () => {
    expect(validate({ shave: 'thorough', shaveCutoff: 1000 })).toMatch(
      /check you did not enter/,
    )
    expect(validate({ shave: 'thorough', shaveCutoff: 1 })).toBe('')
    expect(validate({ shave: 'bristles', shaveCutoff: 1000 })).toBe('')
  })

  it('refuses a distance on voxel coordinates only where the card uses one', () => {
    // The question `evaluate` hands `checkCleanUnits`: the thorough shave's cutoff and the soma
    // radius are the card's distances in micrometres.
    const voxels = { units: 'voxels' as const }
    for (const used of [
      { shave: 'thorough' as const },
      { somaCleanup: true },
      { detectSoma: true },
    ]) {
      expect(() => checkCleanUnits(voxels, usesDistance({ ...DEFAULTS, ...used }))).toThrow(
        /cannot be applied/,
      )
    }
    expect(() => checkCleanUnits(voxels, usesDistance(DEFAULTS))).not.toThrow()
  })

  it('keeps the item count and attribute table aligned with the meshes', async () => {
    mockedRun.mockImplementation((request) => Promise.resolve(chains(request)))
    const s = mockScheduler(source)
    await s.run(pipeline({ waves: 2, minFragment: 10 }), { mode: 'full' })
    const before = s.output('mesh', 'meshes')
    const after = s.output('skel', 'out')
    if (!isMeshesValue(before) || !isSkeletonsValue(after)) throw new Error('expected both')

    expect(mockedRun).toHaveBeenCalledOnce()
    expect(mockedRun.mock.calls[0]![0]).toMatchObject({ waves: 2, minFragment: 10 })
    expect(after.items.map((i) => i.id)).toEqual(before.items.map((i) => i.id))
    expect(after.attributes).toBe(before.attributes)
    for (const item of after.items) {
      for (const parent of item.parents) expect(parent).toBeLessThan(item.parents.length)
    }
  })
})
