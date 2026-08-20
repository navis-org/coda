/**
 * The Description node: what a dataset is, who made it, and how to cite it.
 *
 * Every dataset node arrives with one of these attached (`NodeDefinition.companion`), because a
 * connectome is not a commodity — it is years of somebody's reconstruction work, published with
 * a request for attribution that a picker labelled "MaleCNS" gives no hint of. Putting the credit
 * on the canvas by default means it has to be *dismissed* rather than sought out, and it is an
 * ordinary node, so dismissing it is one Delete.
 *
 * The text is not written here. neuPrint publishes a markdown blurb per dataset at
 * `/api/dbmeta/datasets` — a summary, links to the project's landing page and companion viewers,
 * and the papers to cite — which `DatasetInfo.description` already carries. Restating any of that
 * in Coda would mean a second copy that goes stale the day a dataset adds a citation, and would
 * silently be wrong for the Custom neuPrint node, which can point at a deployment this build has
 * never heard of.
 *
 * **No outputs, and that is the one deliberate departure from the `out.*` viewers.** Those pass
 * their input through so they can be dropped mid-chain; this is an annotation card hanging off a
 * dataset node, and an output socket on it would invite wiring a pipeline through the credits.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isDatasetValue } from '../../core/values'

export const datasetDescriptionNode = registerNode({
  type: 'dataset.description',
  label: 'Description',
  category: 'dataset',
  description:
    'What a dataset covers, who made it and how to cite it, as its publisher states it.',
  /*
   * Cheap despite reaching the network: the listing is one small JSON per deployment, it is
   * already in hand whenever the dataset node upstream has run, and `evaluate` only asks for it
   * when it is not. Everything else here is a synchronous cache read.
   */
  cost: 'cheap',
  inputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  outputs: [],
  params: [],

  /*
   * Running this node fetches nothing that the card does not already draw — the body reads
   * `peekDataset` and renders as soon as the listing lands, whether or not anything has been
   * run. What `evaluate` adds is the guarantee: a Description node wired up on a fresh tab with
   * no dataset node yet run has somewhere to get its text from, and a source that cannot be
   * reached says so as a node error rather than as an empty card.
   */
  evaluate: async (ctx) => {
    const dataset = ctx.input('dataset')
    if (!isDatasetValue(dataset)) throw new Error('Input is not a dataset')
    const source = ctx.resolveSource(dataset.sourceId)
    // Only when the answer is not already cached: `listDatasets` re-fetches on every call, and
    // this node runs on the cheap pass alongside the dataset node that has just done it.
    if (!source.peekDataset(dataset.datasetId)) await source.listDatasets(ctx.signal)
    return {}
  },
})
