/**
 * The SEAM pack's "See also" groups, merged by `help/seeAlso.ts` — see the note there on
 * why this is a table of groups.
 */

const groups: readonly (readonly string[])[] = [
  // The pair: a queue is read by one and worked through by the other.
  ['seam:loadMergeCandidates', 'seam:proofreadMerges'],
  // Where the current pair is looked at full size, when the card's own frame is too small.
  ['seam:proofreadMerges', 'out.neuroglancer'],
  // What the verdicts come out as, and where they go next.
  ['seam:proofreadMerges', 'out.download'],
  // Where a suggestion is looked at and acted on: the merge is made in the Neuroglancer card.
  ['seam:loadMergeCandidates', 'out.neuroglancer'],
  // The queue is a table, and narrowing it -- by `shown` or by `r` -- is a filter somebody does.
  ['seam:loadMergeCandidates', 'core.filterTable'],
  // The neurons a set covers, so their meshes can be drawn beside the tips.
  ['seam:loadMergeCandidates', 'neuron.meshes'],
  // Where the meshes come from, and where the suspected sites are looked at over the EM.
  ['seam:openEnds', 'neuron.meshes'],
  ['seam:openEnds', 'neuron.skeletonize'],
  ['seam:openEnds', 'seam:loadMergeCandidates'],
  ['seam:openEnds', 'out.neuroglancer'],
  // The chain: open ends found, then searched, then worked through.
  ['seam:openEnds', 'seam:findMergeCandidates'],
  ['seam:findMergeCandidates', 'seam:proofreadMerges'],
  // The other node that publishes this shape -- one computes the lists, the other reads them.
  ['seam:findMergeCandidates', 'seam:loadMergeCandidates'],
  // Which ends to search is a cut somebody makes, above this node and not inside it.
  ['seam:findMergeCandidates', 'core.filterTable'],
  // Which datastack's segmentation the boxes are read out of.
  ['seam:findMergeCandidates', 'dataset.cave'],
]

export default groups
