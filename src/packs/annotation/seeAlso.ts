/**
 * The Cell typing/annotation pack's "See also" groups, merged by `help/seeAlso.ts` — see the note there on why
 * this is a table of groups.
 */

const groups: readonly (readonly string[])[] = [
  // What a project is for: drawing its embeddings, and computing new ones from its neighbours.
  ['annotation:bigclust', 'out.scatter', 'core.embed'],
  // Disagreeing with labels: in the graph's copy, or in the backend's own.
  ['annotation:editor', 'core.editTable', 'out.scatter'],
]

export default groups
