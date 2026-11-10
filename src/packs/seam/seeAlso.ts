/**
 * The SEAM pack's "See also" groups, merged by `help/seeAlso.ts` — see the note there on
 * why this is a table of groups.
 */

const groups: readonly (readonly string[])[] = [
  // The pair: a queue is read by one and worked through by the other.
  ['seam:suggestions', 'seam:review'],
  // Where the current pair is looked at full size, when the card's own frame is too small.
  ['seam:review', 'out.neuroglancer'],
  // What the verdicts come out as, and where they go next.
  ['seam:review', 'out.download'],
  // Where a suggestion is looked at and acted on: the merge is made in the Neuroglancer card.
  ['seam:suggestions', 'out.neuroglancer'],
  // The queue is a table, and narrowing it -- by `shown` or by `r` -- is a filter somebody does.
  ['seam:suggestions', 'core.filterTable'],
  // The neurons a set covers, so their meshes can be drawn beside the tips.
  ['seam:suggestions', 'neuron.meshes'],
  // Where the meshes come from, and where the suspected sites are looked at over the EM.
  ['seam:openEnds', 'neuron.meshes'],
  ['seam:openEnds', 'neuron.skeletonize'],
  ['seam:openEnds', 'seam:suggestions'],
  ['seam:openEnds', 'out.neuroglancer'],
  ['seam:findMerges', 'neuron.meshes'],
  ['seam:findMerges', 'out.neuroglancer'],
  // The two nodes in the pack, so a reader who finds one finds the other and the difference.
  ['seam:findMerges', 'seam:affinityClusters'],
  // Where the clusters are looked at, over the EM, which is the point of the Layers output.
  ['seam:affinityClusters', 'out.neuroglancer'],
  // The other way to read the answer: the per-neuron table. The 3D View is left out on purpose
  // -- its own list is already full, and the help document says how to colour by cluster there.
  ['seam:affinityClusters', 'out.table'],
  // Acting on it: a split reads the summary columns off the skeletons' attributes.
  ['seam:affinityClusters', 'neuron.splitNeurons'],
]

export default groups
