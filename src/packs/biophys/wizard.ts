/**
 * The Biophysics pack's answer in the Workflow Wizard — see `wizard/contribute.ts` for what a pack
 * may add and the rules it is held to.
 *
 * **Simulate synaptic input**: the chain the pack was built as — Skeletons and Synapses Between
 * with the neuron as Targets → Compartment Model → Simulate — ending on the traces. Three choices,
 * decided with the user (`docs/biophys.md`):
 *
 * - **One neuron, through Select One.** The model refuses a set and a start is usually a search,
 *   so the chosen neurons go through Select One first: the first is modelled, and its pager steps
 *   through the rest. Gating the answer on a start that names exactly one neuron would hide it
 *   from nearly every start.
 * - **Gated on skeletons and synapses**, both: the skeleton is the model, and Synapses Between is
 *   where its inputs come from. A source with skeletons and no synapses could build the model and
 *   never drive it.
 * - **Never on Demo Data.** Its neurons are miniatures — a few µm across, radii around 40 nm, no
 *   soma — so on the card's defaults every input drives the cell to the synapses' reversal and the
 *   run is a flat line at 0 mV. Plausible-looking settings tuned for it would be a demo of settings
 *   nobody would use on a real neuron.
 * - **A line chart of the traces, or the traces as a table.** The line chart is this pack's
 *   viewer row — the built-in list has none — and needs no setting: an empty Y draws every trace.
 */

import type { Wire } from '../../core/graph'
import type { WizardContribution } from '../../wizard/contribute'
import { datasetFamily } from '../../nodes/lib/datasetFamilies'
import { familyCan } from '../../wizard/gates'

const contribution: WizardContribution = {
  analyses: [
    {
      id: 'biophys:simulate',
      label: 'Simulate synaptic input',
      blurb:
        'Skeletons and Synapses Between → Compartment Model → Simulate: one neuron as a cable, driven by its partners.',
      glyph: 'biophys:simulate',
      requires: 'skeletons',
      when: (key) => familyCan(key, 'synapses') && !datasetFamily(key)?.synthetic,
      hint: {
        text: 'Every partner fires a seeded spike train. Select One picks the neuron; step it to model the next. Expand Simulate (⤢) to choose who fires, or to play the run back over the neuron.',
      },
      views: {
        'biophys:traces': { type: 'out.lineChart' },
        table: { type: 'out.table' },
      },
      body: ({ datasetId: ds, neurons, views }) => {
        const tail = views(0, (_visualisation, id): Wire[] => [['sim', 'traces', id, 'in']])
        return {
          nodes: [
            { id: 'pick', type: 'core.selectOne' },
            { id: 'skel', type: 'neuron.skeletons' },
            { id: 'syn', type: 'neuron.synapsesBetween', row: 1 },
            { id: 'model', type: 'biophys:model' },
            // One partner: every partner at once drives the cell to the synapses' reversal.
            { id: 'sim', type: 'biophys:simulate', params: { fire: 'top', top: 1 } },
            ...tail.nodes,
          ],
          links: [
            neurons('pick', 'in'),
            [ds, 'dataset', 'skel', 'dataset'],
            ['pick', 'item', 'skel', 'neurons'],
            [ds, 'dataset', 'syn', 'dataset'],
            ['pick', 'item', 'syn', 'targets'],
            ['skel', 'skeletons', 'model', 'neuron'],
            ['syn', 'points', 'model', 'synapses'],
            ['model', 'model', 'sim', 'model'],
            ...tail.links,
          ],
          viewId: tail.viewId,
        }
      },
    },
  ],

  visualisations: [
    {
      id: 'biophys:traces',
      label: 'A line chart',
      blurb: 'The voltage at the soma against time, one line per record site.',
      hint: {
        text: 'Draws every trace against `t`. Scroll to zoom in on a stretch; the Y axis rescales to what is in view.',
      },
    },
  ],
}

export default contribution
