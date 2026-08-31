/**
 * The Skeletons node's `Source` control: which of a dataset's skeleton routes to take.
 *
 * **A dataset does not have one skeleton source, and until this existed the node picked for
 * you.** `male-cns:v1.0` publishes a precomputed skeleton layer beside its segmentation *and*
 * serves SWC from neuPrint; `minnie65_public` has a chunkedgraph level-2 cache *and* a populated
 * CAVE skeleton service; FlyWire's public v783 publishes a flat bucket where its own service is
 * empty. Those are different products — tens of nodes against tens of thousands, radii or none —
 * and which one you got was a fact the card never mentioned.
 *
 * So the control does two jobs, and the second is the reason it is drawn even where there is
 * nothing to choose: with one route it reads `Automatic (neuPrint SWC)`, which is the node
 * saying where its geometry comes from. `SkeletonsValue.provenance` is the same fact after a run.
 *
 * ## Why the options are a function of the input type
 *
 * The routes are per **dataset**, discovered from whatever peeks have landed — see
 * `DataSource.skeletonSourcesFor`, which is synchronous and may not await (invariant 2). So this
 * list grows under the user: a fresh session shows `Automatic`, and a moment later the same
 * dropdown offers three entries, because `reportSourceLearned` re-ran inference. That is the
 * `peekMaterializations` arrangement the Custom CAVE version dropdown already uses, and the
 * alternative — awaiting the probes — is a control that blocks the graph.
 *
 * ## What a stored choice means when it cannot be honoured
 *
 * Kept and reported, never substituted. A Skeletons node pinned to `published` and then repointed
 * at a dataset that has none is a *question*, not a chance to quietly hand back a chunk-graph
 * skeleton in its place — that is the same substitution a column picker refuses to make, and here
 * it would silently change what a cable length means. `validate` says so at edit time and
 * `fetchSkeletons` throws at run time; the option stays in the list, labelled, so the card still
 * shows what the graph says.
 */

import type { EnumOption, InferContext, ParamDef } from '../../core/node'
import type { CodaType } from '../../core/types'
import { datasetRef } from '../../core/types'
import { skeletonRoutesOf } from '../../data/source'
import type { SkeletonProvenance } from '../../core/values'
import { sourceFromType } from './datasetParam'

/** Param id, shared by the control, the reader and `validate`. */
export const SKELETON_SOURCE_PARAM = 'skeletonSource'

/** The routes a Dataset socket's dataset has, or undefined while nothing has landed. */
function skeletonRoutesFromType(
  type: CodaType | undefined,
): readonly SkeletonProvenance[] | undefined {
  return skeletonRoutesOf(sourceFromType(type), datasetRef(type)?.datasetId)
}

/**
 * The dropdown's entries.
 *
 * Automatic first and named after the route it will actually take, because "Automatic" on its own
 * is a provenance question mark on every graph anyone shares — `resolveDatasetId`'s reasoning
 * about a version dropdown's blank entry, one node over. The named routes are listed only when
 * there is a choice to make; a lone route is already the whole of what Automatic says.
 */
function skeletonSourceOptions(type: CodaType | undefined, chosen: string): EnumOption[] {
  const routes = skeletonRoutesFromType(type)
  const best = routes?.[0]
  const options: EnumOption[] = [
    { value: '', label: best ? `Automatic (${best.label})` : 'Automatic' },
  ]
  if (routes && routes.length > 1) {
    options.push(...routes.map((r) => ({ value: r.id, label: r.label })))
  }
  if (chosen && !options.some((o) => o.value === chosen)) {
    const named = routes?.find((r) => r.id === chosen)
    options.push({
      value: chosen,
      // Two different sentences: a route this dataset simply does not have, and one whose peek
      // has not landed yet. Saying "not available" while a probe is still in flight is how a
      // perfectly good pinned choice comes to look broken for the first second of a session.
      label: named ? named.label : routes ? `${chosen} (not available here)` : chosen,
    })
  }
  return options
}

export function skeletonSourceParam(): ParamDef {
  return {
    id: SKELETON_SOURCE_PARAM,
    kind: 'enum',
    label: 'Source',
    help:
      'Where the skeletons come from. Datasets often have more than one — a published ' +
      'precomputed layer, a backend’s own traced skeletons, a chunk-graph reconstruction — and ' +
      'they differ in how detailed they are and whether they carry radii. Automatic takes the ' +
      'best one this dataset has; the result says which it used.',
    default: '',
    options: (ctx: InferContext) =>
      skeletonSourceOptions(
        ctx.inputs.dataset,
        String(ctx.params[SKELETON_SOURCE_PARAM] ?? ''),
      ),
  }
}

/**
 * The edit-time complaint for a pinned route this dataset does not have.
 *
 * Silent while the routes are unknown, which is most of a fresh session: a refusal computed from
 * an absent peek is one that clears itself a second later, and a card that flickers a red message
 * on load teaches people to ignore it.
 */
export function skeletonSourceProblem(
  type: CodaType | undefined,
  chosen: string,
): string | undefined {
  if (!chosen) return undefined
  const routes = skeletonRoutesFromType(type)
  if (!routes || routes.length === 0) return undefined
  if (routes.some((r) => r.id === chosen)) return undefined
  return (
    `This dataset has no “${chosen}” skeletons. It offers ` +
    `${routes.map((r) => r.label).join(', ')} — pick one, or Automatic.`
  )
}
