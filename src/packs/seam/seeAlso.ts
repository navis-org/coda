/**
 * The SEAM pack's "See also" groups, merged by `help/seeAlso.ts` — see the note there on
 * why this is a table of groups.
 */

const groups: readonly (readonly string[])[] = [
  // Where the clusters are looked at, over the EM, which is the point of the Layers output.
  ['seam:affinityClusters', 'out.neuroglancer'],
  // The other way to read the answer: the per-neuron table. The 3D View is left out on purpose
  // -- its own list is already full, and the help document says how to colour by cluster there.
  ['seam:affinityClusters', 'out.table'],
  // Acting on it: a split reads the summary columns off the skeletons' attributes.
  ['seam:affinityClusters', 'neuron.splitNeurons'],
]

export default groups
