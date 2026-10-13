/**
 * The wizard's capability gates: whether a dataset family's source — or a source — can do
 * something, asked as the ceiling (`capabilityAnywhere`) because a wizard answer is a family whose
 * version is not chosen yet.
 *
 * A module of its own so a pack's `wizard.ts` can ask them: `options.ts` reads the packs'
 * contributions as it loads, so a pack importing from it would be importing a module that is
 * still loading it.
 */

import type { SourceCapabilities } from '../data/source'
import { capabilityAnywhere, getSource } from '../data/source'
import { datasetFamily } from '../nodes/lib/datasetFamilies'

/**
 * Whether the source behind a family can do something. Unknown family reads as "yes".
 *
 * Exported because `build.ts` asks it too — whether to build the synapse-points node on the
 * morphology arm is the same question with the same three steps, and it was written out longhand
 * there. Two spellings of one question is how the two halves of the wizard came to disagree about
 * which reading they wanted, with nothing type-checking the pair.
 */
export function familyCan(key: string, capability: keyof SourceCapabilities): boolean {
  const family = datasetFamily(key)
  if (!family) return true
  /*
   * `capabilityAnywhere`, not `capabilityOf` with an undefined dataset id, and the difference is
   * the whole reason that function exists.
   *
   * A wizard answer is a *family*: which dataset it resolves to is not known until the node runs,
   * and the version dropdown defaults to "Latest" off a listing that has not landed when this
   * dialog opens. So the question here is not "can this dataset do X" but "is X worth offering
   * for this source at all" — the ceiling rather than the floor.
   *
   * Asking `capabilityOf(source, undefined, …)` gave the floor, which is `source.capabilities`,
   * and CAVE's is a deliberately safe `false` for `skeletons` — the right answer for a datastack
   * nothing is known about, and the wrong one here. It hid "View morphology in 3D" and "NBLAST
   * clustering" for all three CAVE families, every one of which has skeletons. The floor is still
   * what the Skeletons node's own `validate` reads, which is why a dataset that really has none
   * says so on the card rather than being silently un-offered two screens earlier.
   */
  return sourceCan(family.sourceId, capability)
}

/**
 * `familyCan`'s ceiling asked of a source rather than a family.
 *
 * The starters' reader (`starters.ts`): a starter names a node type and a source, and a custom
 * dataset node — `dataset.neuprint`, `dataset.cave`, `dataset.catmaid` — is no family but still
 * has a source whose ceiling decides whether a Neuroglancer cell is worth putting in the graph.
 * One spelling of the reading, so the menu and the wizard cannot come to ask it two ways again.
 * `false` with no source at all, where `familyCan` says `true` for a key it does not know: that
 * one gates *offers*, and a starter with nothing to ask should not gain a viewer that can only warn.
 */
export function sourceCan(
  sourceId: string | undefined,
  capability: keyof SourceCapabilities,
): boolean {
  return sourceId ? capabilityAnywhere(getSource(sourceId), capability) : false
}
