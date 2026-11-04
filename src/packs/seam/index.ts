/**
 * SEAM: nodes that look for segmentation errors in a reconstruction and hand the reader somewhere
 * to fix them.
 *
 * Named for the project the models come from (`~/Github/SEAM`), which also plans the service-side
 * half of this pack — `seam:suggestions` and `seam:review`, a queue somebody else computed. What
 * is here is the other way in: run a model in this tab, now.
 *
 * Off by default and reached by `/seam`. It is off for a stronger reason than the other
 * optional packs: its one node downloads a few hundred megabytes of model weights, so it should
 * not be in the palette of somebody who has not asked for it.
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

export const seam: PackDefinition = {
  id: 'seam',
  label: 'SEAM',
  description: 'Nodes that run a model over a reconstruction to look for segmentation errors.',
  defaultOn: false,
  glyph: 'seam:affinityClusters',
  nodes: [affinityClustersNode],
}
