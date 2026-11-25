/**
 * Roots an edit has just replaced, in one chunkedgraph — said to whoever is following them
 * (`docs/seam-split-review-plan.md`, phase 3). **A result, never a way to write**: the split
 * gallery says what its write made (`splitAccept.ts`), and a Neuroglancer card says what its
 * frame's report suggests — Neuroglancer's own multicut takes the old root out of the layer and
 * puts the new ones in. A review card whose neuron is among the roots follows the edit: at once
 * where it is certain, and after asking the chunkedgraph where it is only suggested, since a
 * reader can swap neurons in a layer by hand.
 *
 * Here rather than in the SEAM pack: it is a fact about a chunkedgraph, and one of its two
 * sources is the generic viewer. With the pack off nothing listens, and saying it does nothing.
 */

import { channel } from '../channel'

/** An edit's replaced roots, in one chunkedgraph. */
export interface RootEdit {
  readonly deployment: string
  readonly datastack: string
  /** The roots the edit retired. */
  readonly roots: readonly string[]
  /** Said by the writer (`true`), or read off a viewer's report and to be checked (`false`). */
  readonly certain: boolean
}

const edits = channel<RootEdit>()

/** Say an edit to every listener, at once; an edit of no roots is not said. */
export function announceEdit(edit: RootEdit): void {
  if (edit.roots.length > 0) edits.notify(edit)
}

/** Hear every edit said from now on, until the returned function is called. */
export const onEdit = edits.subscribe
