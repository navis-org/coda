/**
 * SEAM: nodes that look for segmentation errors in a reconstruction and hand the reader somewhere
 * to fix them.
 *
 * Named for the project the models come from (`~/Github/SEAM`). Two directions of error live
 * here and they are easy to confuse: `seam:findMerges` and `seam:affinityClusters` look for false
 * **merges**, and their fix is a split; `seam:suggestions` reads SEAM's merge candidates, which
 * are false **splits**, and their fix is a merge, and `seam:review` is the queue a proofreader
 * works through to make them.
 *
 * The false-split half is a chain rather than one node, and the order is the pipeline's:
 * `seam:openEnds` finds where a reconstruction stops (stage 3), `seam:suggestMerges` searches
 * around each of those ends and ranks what it finds (stages 4-5), and `seam:review` is worked
 * through. `seam:suggestions` reads a run somebody else did and publishes the same two tables, so
 * it enters that chain at the same place.
 *
 * Off by default and reached by `/seam`. It is off for a stronger reason than the other
 * optional packs: a node here downloads tens of megabytes of model weights, so it should not be
 * in the palette of somebody who has not asked for it.
 *
 * **The two false-merge nodes are retired as of 2026-11-09 — `hidden: true`, and still listed
 * here.** Listing them is what keeps them registered, which is what keeps old files loading and
 * the whole input path under test; `hidden` is what keeps them out of the palette. The
 * checkpoints are the reason, not the code — `docs/seam-plan.md`, "Why both nodes are retired",
 * has the numbers. The Plugins dialog still lists them, which is a deliberate choice
 * (2026-11-09) rather than an oversight.
 *
 * **Read-only, in every phase.** Coda draws what a model predicts and links into the dataset's own
 * proofreading viewer; nothing here writes to a live segmentation. That is the standing rule, and
 * also the honest answer now that the first checkpoint has been measured at chance on real merges.
 *
 * The seam the pack is built on is `src/ml` — a model is a manifest entry, and the second model
 * costs an entry in `models.ts` rather than a rewrite. See `docs/seam-plan.md` and
 * `docs/ml.md`.
 */

import type { PackDefinition } from '../../core/registry'
import { affinityClustersNode } from './affinityClusters'
import { findMergesNode } from './findMerges'
import { openEndsNode } from './openEnds'
import { reviewNode } from './review'
import { suggestMergesNode } from './suggestMerges'
import { suggestionsNode } from './suggestions'

export const seam: PackDefinition = {
  id: 'seam',
  label: 'SEAM',
  description: 'Nodes that run a model over a reconstruction to look for segmentation errors.',
  defaultOn: false,
  glyph: 'seam:suggestions',
  nodes: [
    suggestionsNode,
    suggestMergesNode,
    reviewNode,
    openEndsNode,
    findMergesNode,
    affinityClustersNode,
  ],
}
