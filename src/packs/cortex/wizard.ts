/**
 * The Cortex pack's answers in the Workflow Wizard — see `wizard/contribute.ts` for what a pack
 * may add and the rules it is held to.
 *
 * Two, both gated on **every chosen dataset having a cortical frame** (`frames.ts`), which is a
 * fact about coordinates rather than anything a source advertises — the template space's reason
 * for being a gate of its own, and why this is `when` rather than a capability. Only minnie65 has
 * one, so neither answer appears for a fly dataset, and neither appears while the pack is off: the
 * dialog keeps only combinations whose nodes are offered.
 *
 * - **The gallery is a way of choosing neurons**, beside Explore, Find Neurons and pasted ids — it
 *   is a browsing surface, and what it hands on is the cells selected on the wall. Every analysis
 *   reads its `Selected`, so the gallery composes with the wizard's whole third question.
 * - **The laminar synapse profile is a technique**: Synapses → Cortical Depth → Laminar Profile,
 *   the chain the pack's two nodes were built as, split by partner type with the layers wired in.
 */

import type { Wire } from '../../core/graph'
import { datasetFamily } from '../../nodes/lib/datasetFamilies'
import type { WizardContribution } from '../../wizard/contribute'
import { frameFor } from './frames'

/**
 * Whether a dataset has a cortical frame — asked of the family, before any version is chosen. A
 * key naming no family has none: the answers here need the frame, where the wizard's built-in
 * gates read an unknown family as able.
 */
function framed(key: string): boolean {
  const family = datasetFamily(key)
  return !!family && !!frameFor(family.sourceId, family.family)
}

const contribution: WizardContribution = {
  starts: [
    {
      id: 'cortex:gallery',
      label: 'Cortex Gallery',
      blurb:
        'Uses the `Cortex Gallery` node: cells drawn against depth with the layers behind them, grouped by type. Click the ones you want.',
      glyph: 'cortex:gallery',
      requires: 'neuronIndex',
      when: framed,
      hint: {
        text: '**Click cells on the wall to select them**, then Run. Everything downstream reads the selected cells — a card further along with no neurons is the graph waiting for you.',
        tone: 'tip',
      },
      head: ({ id, datasetId, row }) => ({
        node: { id: id('gallery'), type: 'cortex:gallery', row },
        port: [id('gallery'), 'selected'],
        links: [[datasetId, 'dataset', id('gallery'), 'dataset']],
      }),
    },
  ],

  analyses: [
    {
      id: 'cortex:laminar',
      label: 'Laminar synapse profile',
      blurb:
        'Synapses → Cortical Depth → Laminar Profile: where their inputs land against the layers, split by partner type.',
      glyph: 'cortex:depth',
      requires: 'synapses',
      when: framed,
      hint: {
        text: 'Inputs by default: set Polarity on Synapses to outputs for the other end. Cortical Depth reads each partner’s type from the same tables the Cortex Gallery offers.',
      },
      // The profile first: it is what the technique is named for.
      views: {
        'cortex:laminarProfile': { type: 'cortex:laminarProfile' },
        table: { type: 'out.table' },
      },
      body: ({ datasetId: ds, neurons, views }) => {
        const tail = views(0, (visualisation, id) => {
          const fed: Wire = ['depth', 'table', id, 'in']
          // The profile takes the Dataset for the layers; a table has none to take.
          return visualisation === 'cortex:laminarProfile'
            ? [fed, [ds, 'dataset', id, 'dataset']]
            : [fed]
        })
        return {
          nodes: [
            { id: 'syn', type: 'neuron.synapses', params: { polarity: 'post' } },
            { id: 'depth', type: 'cortex:depth' },
            ...tail.nodes,
          ],
          links: [
            [ds, 'dataset', 'syn', 'dataset'],
            neurons('syn', 'neurons'),
            ['syn', 'points', 'depth', 'points'],
            [ds, 'dataset', 'depth', 'dataset'],
            ...tail.links,
          ],
          viewId: tail.viewId,
        }
      },
    },
  ],

  visualisations: [
    {
      id: 'cortex:laminarProfile',
      label: 'A laminar profile',
      blurb:
        'Depth running down the cortex with the layers behind it, a count per layer beside them.',
      hint: {
        text: 'Split by partner type, with the untyped partners — most of them — muted and last. `Facet by` gives each neuron or type a panel of its own.',
      },
    },
  ],
}

export default contribution
