/**
 * Skeletonize Meshes: the request, the scattering back, the soma's label, and the wait.
 *
 * The algorithm is `pyodide/skeletonize.py`, which is skeletor's wavefront skeletonizer trimmed to
 * numpy and fastcore and held against skeletor by `scripts/probe-skeletonize.py`. What lives here
 * is the part that is Coda's: a mesh set flattened the way every mesh call sends one, a skeleton
 * set built back item by item, and the cost of the wait in seconds.
 */

import type { Warner } from '../../core/limits'
import { warnOverWait } from '../../core/limits'
import type { EnumOption, ParamValues } from '../../core/node'
import type {
  MeshesValue,
  SkeletonGeometry,
  SkeletonProvenance,
  SkeletonsValue,
} from '../../core/values'
import { SWC_SOMA, boundsOf } from '../../core/values'
import { NM_PER_UM } from '../../data/units'
import type {
  RadiusAgg,
  Shave,
  SkeletonizeRequest,
  SkeletonizeResult,
} from '../../pyodide/skeletonize'
import { checkItemCount, emptiedItems, packMeshes } from './cleanOps'
import { geometryPointCount } from './transformOps'

export interface SkeletonizeParams {
  waves: number
  stepSize: number
  radiusAgg: RadiusAgg
  minFragment: number
  shave: Shave
  /** In micrometres, as the card asks for it. The request carries nanometres. */
  shaveCutoff: number
  fixZeroRadii: boolean
  somaCleanup: boolean
  /** Micrometres, like the cutoff. */
  somaRadius: number
  detectSoma: boolean
  /** Micrometres. */
  minSomaRadius: number
}

/** The radius aggregations, in the order the card offers them. skeletor's names. */
export const RADIUS_AGGS = [
  { value: 'mean', label: 'Mean' },
  { value: 'median', label: 'Median' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
  { value: 'percentile25', label: '25th percentile' },
  { value: 'percentile75', label: '75th percentile' },
] satisfies (EnumOption & { value: RadiusAgg })[]

/**
 * The shaves, nested rather than combined: thorough runs the bristle pass last. The labels say what
 * goes, since "bristle" is a word from the code people reading the card have not met.
 */
export const SHAVES = [
  { value: 'off', label: 'Off — skeletor’s output as it is' },
  { value: 'bristles', label: 'Bristles — one-node twigs (navis)' },
  { value: 'thorough', label: 'Thorough — short twigs, repeatedly (fafbseg)' },
] satisfies (EnumOption & { value: Shave })[]

export function skeletonizeParamsFrom(params: ParamValues): SkeletonizeParams {
  return {
    waves: Number(params.waves),
    stepSize: Number(params.stepSize),
    radiusAgg: params.radiusAgg as RadiusAgg,
    minFragment: Number(params.minFragment),
    shave: params.shave as Shave,
    shaveCutoff: Number(params.shaveCutoff),
    fixZeroRadii: params.fixZeroRadii === true,
    somaCleanup: params.somaCleanup === true,
    somaRadius: Number(params.somaRadius),
    detectSoma: params.detectSoma === true,
    minSomaRadius: Number(params.minSomaRadius),
  }
}

/**
 * Whether `Long edge` is read: by the thorough shave, and by the soma clean-up's shave around the
 * soma. One predicate for the control's visibility and its check, because a hidden param leaves
 * the provenance key (invariant 4) — read while hidden, an edit to it would re-run nothing.
 */
export function usesShaveCutoff(params: ParamValues): boolean {
  return params.shave === 'thorough' || params.somaCleanup === true
}

/**
 * Whether a distance in micrometres reaches the coordinates — `checkCleanUnits`' question. The
 * thorough shave's cutoff, and the soma radius wherever the card asks for anything soma-shaped.
 * A source's soma on its own does not count: on coordinates that are not nanometres it is simply
 * not used (`somaPositionsFrom`), labelling being something the node does unasked.
 */
export function usesDistance(params: SkeletonizeParams): boolean {
  return params.shave === 'thorough' || params.somaCleanup || params.detectSoma
}

/**
 * One xyz per mesh, NaN where the source gave no soma — and NaN throughout on coordinates that
 * are not nanometres, where a soma radius in micrometres would mean nothing.
 */
export function somaPositionsFrom(meshes: MeshesValue): Float32Array {
  const out = new Float32Array(meshes.items.length * 3).fill(Number.NaN)
  if (meshes.units !== undefined && meshes.units !== 'nm') return out
  meshes.items.forEach((item, n) => {
    if (item.soma) out.set(item.soma, n * 3)
  })
  return out
}

/** The mesh set flattened for one crossing. Buffers built rather than borrowed, `packMeshes`' rule. */
export function skeletonizeRequestFrom(
  meshes: MeshesValue,
  params: SkeletonizeParams,
): SkeletonizeRequest {
  // The card's micrometres to the nanometres the coordinates are in, `cleanRequestFrom`'s split.
  return {
    ...packMeshes(meshes),
    ...params,
    shaveCutoff: params.shaveCutoff * NM_PER_UM,
    somaRadius: params.somaRadius * NM_PER_UM,
    minSomaRadius: params.minSomaRadius * NM_PER_UM,
    somaPositions: somaPositionsFrom(meshes),
  }
}

/**
 * What every skeleton made here says it is, in the card footer and the viewer caption.
 *
 * Not one of `SKELETON_ROUTES`: those are ways a *source* serves skeletons, offered and pinned on
 * the Skeletons node, and a route nobody can pin there would be a lie in that list.
 */
export const WAVEFRONT_PROVENANCE: SkeletonProvenance = {
  id: 'wavefront',
  label: 'skeletonized from meshes',
  detail:
    "Computed here from each mesh by skeletor's wavefront method: rings of vertices at equal " +
    'distance from a seed, collapsed to their centres.',
}

/**
 * One skeleton per mesh, in the same order, with the attribute table, units and space carried.
 *
 * The id rides through unchanged: a skeleton made from a neuron's mesh is that neuron. `detail`
 * is not carried — it describes a mesh's level of detail and there is no mesh here any more.
 */
export function skeletonsFromMeshes(
  original: MeshesValue,
  result: SkeletonizeResult,
): SkeletonsValue {
  checkItemCount('Skeletonize Meshes', result.offsets, original.items.length, 'meshes')

  const items: SkeletonGeometry[] = original.items.map((item, n) => {
    const from = result.offsets[n]!
    const to = result.offsets[n + 1]!
    const soma = result.somas[n]!
    return {
      id: item.id,
      positions: result.points.slice(from * 3, to * 3),
      radii: result.radii.slice(from, to),
      parents: result.parents.slice(from, to),
      ...(soma >= 0 ? { compartments: somaLabel(to - from, soma) } : {}),
    }
  })

  return {
    kind: 'skeletons',
    items,
    attributes: original.attributes,
    bounds: boundsOf(items.map((item) => item.positions)),
    ...(original.units ? { units: original.units } : {}),
    ...(original.space ? { space: original.space } : {}),
    provenance: WAVEFRONT_PROVENANCE,
  }
}

/**
 * SWC's soma code on one node and "unlabelled" everywhere else — the form every consumer that
 * roots at a soma reads (`widestSomaNode`). Only the soma: nothing here knows an axon from a
 * dendrite, and a label it could not stand behind would be indistinguishable from a source's.
 */
function somaLabel(nodes: number, soma: number): Uint8Array {
  const codes = new Uint8Array(nodes)
  codes[soma] = SWC_SOMA
  return codes
}

/**
 * How many skeletons got their soma from the source, and how many from detection — told apart by
 * whether a position went over for the mesh (`somaPositionsFrom`), a source's always winning.
 */
export function somaCounts(
  meshes: MeshesValue,
  result: SkeletonizeResult,
): { placed: number; detected: number } {
  const sent = somaPositionsFrom(meshes)
  let placed = 0
  let detected = 0
  result.somas.forEach((soma, n) => {
    if (soma < 0) return
    if (Number.isNaN(sent[n * 3]!)) detected += 1
    else placed += 1
  })
  return { placed, detected }
}

/**
 * The cost model, measured in Pyodide on skeletor's example mesh subdivided to 26k–1.7M vertices:
 * a fixed 0.35 µs a vertex plus 0.39 µs a vertex for each wave, which fits all eight runs (one and
 * three waves at each size) to within a few percent. Rounded up rather than fitted to the middle,
 * so the estimate is never shorter than the wait — `RAYS_PER_SECOND`'s call.
 */
const MICROS_PER_VERTEX = 0.4
const MICROS_PER_VERTEX_WAVE = 0.45

/** Roughly how many seconds the set will take, single-threaded. */
export function skeletonizeSeconds(meshes: MeshesValue, waves: number): number {
  return (
    (geometryPointCount(meshes) * (MICROS_PER_VERTEX + MICROS_PER_VERTEX_WAVE * waves)) / 1e6
  )
}

/** The wait, said before it starts where it is long. A warning, never a refusal. */
export function warnSkeletonizeWait(ctx: Warner, meshes: MeshesValue, waves: number): void {
  warnOverWait(ctx, {
    seconds: skeletonizeSeconds(meshes, waves),
    what: `Skeletonizing ${geometryPointCount(meshes).toLocaleString()} vertices`,
    lever:
      'Lowering `Keep faces` on Clean Meshes, or choosing a coarser `Detail` on the Meshes node, ' +
      `makes it proportionally faster${waves > 1 ? ', and so does fewer `Waves`' : ''}.`,
  })
}

/**
 * The meshes that came in with faces and went out with no skeleton: every piece of them was under
 * `Min fragment size`. They keep their slot, so the attribute table still lines up.
 */
export function emptiedMeshes(meshes: MeshesValue, result: SkeletonizeResult): number {
  return emptiedItems(result.offsets, (n) => meshes.items[n]!.indices.length > 0)
}
