/**
 * The Meshes node's two reduction controls, and why there are two.
 *
 * `Detail` is a **triangle budget spent among levels a publisher already built**. `Downsample` is
 * an explicit **recomputation** of the geometry. They were one control, and the seam is what made
 * that untenable: `GeometryRequest.triangleBudget`'s contract has always said "a source with one
 * level ignores it", so on graphene — supervoxel fragments at one resolution, nothing coarser to
 * ask for — the CAVE source honoured the budget by quietly clustering vertices instead. The same
 * dropdown therefore picked a published level on neuPrint and rebuilt the mesh on FlyWire, which
 * is a difference a reader could only find by measuring.
 *
 * So each says one thing, and the one that cannot apply says so:
 *
 *  - `Detail` is **dead where the source has no levels**, and drawn that way rather than silently
 *    doing something else. `meshLevelsOf` is the question, asked through the seam.
 *  - `Downsample` applies everywhere, defaults to off, and is the answer to "this source has one
 *    level and that level is too big" — which is the case `Detail` used to be quietly covering.
 *
 * Both are read here rather than in the node so the two halves — the control and what `evaluate`
 * sends — cannot drift, which is the pairing `resolveSynapseUnit` makes one file over.
 */

import type { EnumOption, InferContext, ParamDef, ParamValues } from '../../core/node'
import type { CodaType } from '../../core/types'
import { datasetRef } from '../../core/types'
import { DEFAULT_TRIANGLE_BUDGET } from '../../data/precomputed'
import { meshLevelsOf } from '../../data/source'
import { sourceFromType } from './datasetParam'

export const DETAIL_PARAM = 'detail'
export const DOWNSAMPLE_PARAM = 'downsample'

/** What the dataset on a Dataset socket says about levels, or undefined while nothing has landed. */
function levelsFromType(type: CodaType | undefined): boolean | undefined {
  return meshLevelsOf(sourceFromType(type), datasetRef(type)?.datasetId)
}

/**
 * `Detail`'s entries, which are **none** where the source has no levels to spend a budget on.
 *
 * An empty list is how `ParamField` already draws a dead control — a genuinely `disabled` select
 * showing `EnumParam.empty` — which is the same rendering a column picker gets for a port with no
 * schema. It was a single inert-looking option first, and that is worse than it sounds: a `select`
 * with one entry is operable, focusable and indistinguishable from a real choice until you open
 * it.
 *
 * The stored value survives, which is why this is not `visibleIf` even setting aside that
 * `visibleIf` is handed params alone and cannot see a dataset: a hidden param leaves the
 * provenance key and its value stops being anybody's, where a dataset swapped back to one with
 * levels has to find the budget exactly as it was left.
 *
 * **Only when the answer has actually arrived.** `undefined` means no peek has landed, which is
 * most of a fresh session, and a control that greys itself out for the first second of every
 * session is one people learn to distrust.
 */
function detailOptions(ctx: InferContext): EnumOption[] {
  if (levelsFromType(ctx.inputs.dataset) === false) return []
  return DETAIL_BUDGETS
}

/** The three budgets, so the default below cannot name a value the list does not offer. */
const DETAIL_BUDGETS: EnumOption[] = [
  { value: '150000', label: 'low — many neurons' },
  { value: String(DEFAULT_TRIANGLE_BUDGET), label: 'balanced' },
  { value: '6000000', label: 'high — a few neurons' },
]

export function detailParam(): ParamDef {
  return {
    id: DETAIL_PARAM,
    kind: 'enum',
    label: 'Detail',
    default: String(DEFAULT_TRIANGLE_BUDGET),
    empty: 'Not available — this source has one level of detail',
    help:
      'Triangle budget for the whole set, spent among the levels of detail the source publishes: ' +
      'the finest level that fits is the one fetched, so asking for more neurons gets you coarser ' +
      'ones. A source that publishes one level has nothing to spend it on — use Downsample there.',
    /*
     * The vocabulary the catalogue cannot get from an options *function*, which prints
     * `(options depend on the input)` — see `skeletonRouteVocabulary`'s note, and measured there:
     * a model that cannot see the options guesses, and nothing refuses a guess on a dynamic enum.
     */
    catalogueNote: `One of ${DETAIL_BUDGETS.map((o) => o.value).join(', ')} — a triangle budget for the whole set. Offered only where the source publishes levels of detail; use downsample otherwise.`,
    /*
     * `meshLevelsOf` reaches `peekFlat` on CAVE and `meshSourceFor` on neuPrint, both of which
     * start the read they cannot answer from. Legal from `inferOutputs`, which is what those
     * methods are written for; not legal from a graph listing built because somebody typed a
     * question — so deliberately **not** `optionsWithoutPeek`, exactly as `skeletonSourceParam`.
     */
    options: detailOptions,
  }
}

export function downsampleParam(): ParamDef {
  return {
    id: DOWNSAMPLE_PARAM,
    kind: 'int',
    label: 'Downsample',
    /*
     * **1 — full resolution.** What a source publishes is what you get, which is the honest
     * default now that a full-resolution mesh actually draws: Firefox refuses a draw call past
     * 30 M index values and a 13.1 M-triangle neuron is 39.4 M of them, so these used to vanish
     * silently until `drawRanges` split them across draws. That was a *drawing* bug, and reducing
     * the geometry by default would have been papering over it.
     */
    default: 1,
    min: 0,
    /*
     * **Absence is not the default here.** A workflow saved before this control existed was drawn
     * by a build that reduced graphene meshes automatically, out of `triangleBudget` — so absence
     * means "reduction was automatic and nobody chose it", which is `0`, where the default is a
     * choice somebody makes today. Opening an old scene at full resolution would silently make it
     * several times heavier than the picture it was saved as.
     */
    absentMeans: 0,
    advanced: true,
    help:
      'How much geometry to keep. 1 is full resolution — what the source publishes. 0 is ' +
      'automatic: each mesh reduced only as far as a 3D view can draw it, and not at all where it ' +
      'already fits, which is worth setting for a large set on a source with one level of detail. ' +
      'A number above 1 is a ratio — 4 keeps about a quarter of each mesh’s triangles. It ' +
      're-fetches when changed, because the reduction happens at the source.',
  }
}

/** What `evaluate` sends, so the control and the request cannot disagree. */
export function meshDetailRequest(params: ParamValues): {
  triangleBudget: number
  downsample?: number | 'auto'
} {
  const factor = Number(params[DOWNSAMPLE_PARAM]) || 0
  return {
    triangleBudget: Number(params[DETAIL_PARAM]) || DEFAULT_TRIANGLE_BUDGET,
    /*
     * Three values and three meanings. **1 is full resolution** and the default. **0 is
     * automatic** — reduce only as far as a scene can draw — which is a third state rather than a
     * number for the reason `Reduction` records. Above 1 is a ratio.
     */
    ...(factor > 1
      ? { downsample: factor }
      : factor === 1
        ? {}
        : { downsample: 'auto' as const }),
  }
}
