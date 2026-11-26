/**
 * SEAM: nodes that look for segmentation errors in a reconstruction and hand the reader somewhere
 * to fix them.
 *
 * Named for the project the models come from (`~/Github/SEAM`). The nodes here look for false
 * **splits**, a neuron cut short, and every name says the fix: a merge candidate is fixed by a
 * merge. A node for false **merges** (split candidates, fixed by a split) is expected to join it.
 *
 * The false-split half is a chain rather than one node, and the order is the pipeline's:
 * `seam:openEnds` finds where a reconstruction stops (stage 3), `seam:findMergeCandidates` searches
 * around each of those ends and ranks what it finds (stages 4-5), and `seam:proofreadMerges` is worked
 * through. `seam:loadMergeCandidates` reads a run somebody else did and publishes the same two tables, so
 * it enters that chain at the same place.
 *
 * Off by default and reached by `/seam`. It is off for a stronger reason than the other
 * optional packs: a node here downloads tens of megabytes of model weights, so it should not be
 * in the palette of somebody who has not asked for it.
 *
 * **Two false-merge nodes were dropped before the first release (2026-11-26)**: Affinity Clusters
 * (Troidl et al.'s point affinity transformer) and Find Split Candidates (SEAM's Model A). Neither
 * checkpoint worked on real merges; `docs/seam-plan.md`, "Why both nodes are retired", has the
 * numbers. What runs the models is kept for a retrained checkpoint: `affinity*.ts`, `pointCloud.ts`,
 * `labelSkeleton.ts`, `mergeTables.ts`, the window build and `models.ts`' entries, all under test
 * and driven by `probe:affinity-parity` and `probe:seam-merge`. The nodes themselves are
 * `affinityClusters.ts` and `findMerges.ts` in commit 6fcd5b5d.
 *
 * **Two writes, each on one chain.** A model only suggests; the reader decides and makes the edit,
 * with their own token. Proofread Merges' Submit merges (`ui/seam/mergeSession.ts` →
 * `mergeBatch.ts` → `src/data/cave/edits.ts`), and the split gallery, K over a false merge in the
 * Neuroglancer card, splits (`ui/seam/splitAccept.ts` → `splitWrite.ts`). Nothing else in the
 * pack writes to a segmentation: `importGraph.test.ts` (`CHAINS`) holds each write to its one
 * chain, and tests never write (`writeGuard.ts`). The verdict log is a separate, opt-in write to
 * the lab's server, never to a segmentation. See `docs/seam-merge-plan.md`,
 * `docs/split-gallery-plan.md` and `docs/seam-verdict-log-plan.md`.
 *
 * The seam the pack is built on is `src/ml` — a model is a manifest entry, and the second model
 * costs an entry in `models.ts` rather than a rewrite. See `docs/seam-plan.md` and
 * `docs/ml.md`.
 */

import type { PackDefinition } from '../../core/registry'
import { openEndsNode } from './openEnds'
import { reviewNode } from './review'
import { suggestMergesNode } from './suggestMerges'
import { suggestionsNode } from './suggestions'

export const seam: PackDefinition = {
  id: 'seam',
  label: 'SEAM',
  description: 'Nodes that run a model over a reconstruction to look for segmentation errors.',
  defaultOn: false,
  glyph: 'seam:loadMergeCandidates',
  nodes: [suggestionsNode, suggestMergesNode, reviewNode, openEndsNode],
}
