/**
 * What a guide borrows from the app, and the graph it opens when there is nothing to point at.
 *
 * Lifted out of `tour.ts` when the Screen Map arrived, and the split is the same one
 * `tourState.ts` already made: `tour.ts`'s first import is `driver.js`, so anything that lives
 * there is behind the dynamic `import()`. The map is mounted in `App.tsx` and cannot reach it —
 * which left it re-writing all three of these inline, including the content-not-identity
 * selection compare and the sentence announcing the graph it opened, the latter in a second
 * wording. A rule that says "a persisted preference is lent, not taken" is exactly the kind that
 * decays once it exists twice.
 *
 * Nothing here knows what a step is, and nothing here imports driver.
 */

import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'

/**
 * What the tour opens on an empty canvas.
 *
 * A wizard workflow on the synthetic dataset, so a tour taken before any dataset is connected
 * still has cards, sockets, a wire and a run state to point at, and reaches no network doing it.
 * A tour of an empty canvas would spend a third of its stops explaining chrome that has nothing
 * to act on.
 *
 * It used to be a bundled example. The examples are gone — the wizard replaced them — and this is
 * the honest replacement rather than a fixture kept alive for the tour: the graph the tour points
 * at is one a reader can produce for themselves from four answers, which is the thing the tour is
 * ultimately teaching.
 */
const fallbackGraph = () => demoWorkflow('partners')

/** State a guide changes for its own purposes and hands back at the end. */
export interface Borrowed {
  inspector: boolean
  selection: string[]
  /**
   * Auto-run, which "Learn to Build" has to switch off to be able to teach anything about Run.
   *
   * With it on, every edit re-runs the graph, so the stale count is permanently zero — and the
   * Run button is `disabled` at exactly that. The step that says "your turn: press Run" was
   * pointing at a control that could not be pressed, for anybody who had ever ticked the box.
   * Like the inspector, it is a persisted preference (`coda.autorun.v1`) and a tour is not a
   * reason to have changed it, so it comes back.
   */
  autoRun: boolean
}

export function borrow(): Borrowed {
  const state = useGraphStore.getState()
  return {
    inspector: state.panels.inspector,
    selection: state.selection,
    autoRun: state.autoRun,
  }
}

export function restore(held: Borrowed, selection: boolean): void {
  const state = useGraphStore.getState()
  if (state.panels.inspector !== held.inspector) state.togglePanel('inspector')
  if (state.autoRun !== held.autoRun) state.setAutoRun(held.autoRun)
  if (!selection) return
  // Compared by content, not identity: `setSelection` mints a fresh array, so the snapshot is
  // never the same object as what is in the store by the time we get back here.
  const current = state.selection
  const same =
    current.length === held.selection.length &&
    current.every((id, i) => id === held.selection[i])
  if (!same) state.setSelection(held.selection)
}

/**
 * Put a graph on the canvas if there is none, and say so if we did.
 *
 * Returns the sentence to append to the welcome step, or nothing. The tour announcing its own
 * side effect in its first paragraph is the whole of the consent here: it is a mutation, it is
 * only ever made to an empty canvas, and it is undoable by the ordinary means.
 */
export function ensureGraph(): string {
  if (useGraphStore.getState().graph.nodes.length > 0) return ''
  useGraphStore.getState().loadGraph(fallbackGraph())
  return ' The canvas was empty, so a small workflow has been opened to point at.'
}
