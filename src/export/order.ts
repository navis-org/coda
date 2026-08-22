/**
 * The order the exporters write nodes out in.
 *
 * `topoSort` leaves reference edges out, because a reference names a node rather than consuming
 * its output and the reader waits on nothing. **Writing the graph out wants the opposite**: a
 * cell that names the referenced node needs that node's own line to exist already, so without the
 * hoist the reader is classified `blocked by "Dataset"` and emits a TODO that is false — and
 * `ctx.todo()` binds nothing, so it cascades one to every node downstream. A document of TODOs
 * about a dataset that translated perfectly well.
 *
 * Here rather than in `src/core` because the rationale is entirely `src/export`'s — emitters,
 * TODO cells, `blocked` — and one function rather than two lines copied into each walk. The two
 * walks are deliberate copies (see CLAUDE.md), but what that protects is the *assembly*: chunk
 * building, variable naming, unwired-versus-blocked, where the notes land. An ordering rule with
 * no language in it is the same class as `canExport.ts`'s refusal policy, which both surfaces
 * already share.
 *
 * **The condition that makes the hoist valid is the one that makes references sound**: a
 * referenced node's cell must be writable from its params alone. A dataset's is — a `Client(…)`
 * naming a datastack and a version — which is why it can be lifted above the annotations wired
 * into it. Check that before writing an emitter for a node anything references.
 */

import type { CodaGraph } from '../core/graph'
import { referencesFirst, topoSort } from '../core/graph'

export interface ExportOrder {
  /** Node ids, referenced nodes first, then dependency order. */
  order: string[]
  /** Ids that could not be ordered because they sit on or behind a cycle. */
  cyclic: string[]
}

export function exportOrder(graph: CodaGraph): ExportOrder {
  const { order, cyclic } = topoSort(graph)
  return { order: referencesFirst(order, graph), cyclic }
}
