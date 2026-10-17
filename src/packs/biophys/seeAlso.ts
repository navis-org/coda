/**
 * The Biophysics pack's "See also" groups, merged by `help/seeAlso.ts` — see the note there on why
 * this is a table of groups.
 */

const groups: readonly (readonly string[])[] = [
  // Building a model and running it, and the chart its traces are drawn on.
  ['biophys:model', 'biophys:simulate', 'out.lineChart'],
  // What the model's synapses usually come from.
  ['biophys:model', 'neuron.synapsesBetween'],
  // Where to record, or where to put synapses by hand.
  ['biophys:simulate', 'neuron.skeletonPoints'],
  // A recording beside a simulation: read it, line the two up, draw them.
  ['biophys:loadRecording', 'biophys:combineTraces', 'biophys:simulate', 'out.lineChart'],
  // The arbour without a model: electrotonic distance on the dendrogram.
  ['biophys:model', 'out.neuronDendrogram'],
]

export default groups
