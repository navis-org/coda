/**
 * The Cortex pack's "See also" groups, merged by `help/seeAlso.ts` — see the note there on why
 * this is a table of groups.
 */

const groups: readonly (readonly string[])[] = [
  // Browsing a dataset's cells: the gallery by depth and morphology, Explore by their table.
  ['cortex:gallery', 'neuron.explore'],
  // What the gallery's Skeletons output is, and where it is usually drawn.
  ['cortex:gallery', 'neuron.skeletons', 'out.viewer3d'],
]

export default groups
