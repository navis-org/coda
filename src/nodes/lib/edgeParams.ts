/**
 * The two params that attach a user-supplied edge set to a dataset node, and the rules around
 * them.
 *
 * `annotationParams.ts`'s shape, for a control that is not a socket. An annotation chain is a
 * wire because it is *ordinary table data* — a Filter or a Sort routinely wants to stand in it —
 * where an edge set is a hundred megabytes of compressed indices that no table op could touch
 * and no `.coda.json` could carry. So it arrives through the dataset's own panel and the node
 * remembers which one, exactly as `core.uploadTable` remembers a `dataId`.
 *
 * That trade has a cost this states rather than hides: **there is no wire on the canvas saying
 * the connectivity came from a file**, so the card, `validate` and the share advisory all have
 * to. A dataset silently answering from somewhere other than its backend is the failure this
 * codebase keeps writing post-mortems about.
 */

import type { DatasetEdges } from '../../core/values'
import { edgeSetsKnown, peekEdgeSet } from '../../data/edges/store'

/**
 * The content hash of the attached set.
 *
 * **Not** `presentational`: it decides what every connectivity question returns, so it belongs
 * in the provenance key. `internal`, because the panel writes it and it is machinery rather than
 * a setting — the same exclusion the `… N more` counter makes for a `refresh` nonce.
 */
export const EDGE_SET_ID_PARAM = {
  id: 'edgeSetId',
  kind: 'string',
  label: 'Edge set',
  help: 'Content id of an imported edge set answering this dataset’s connectivity.',
  default: '',
  advanced: true,
  internal: true,
} as const

/**
 * The set's name at the time it was attached.
 *
 * `presentational`, and for `core.uploadTable`'s `fileName` reason: it cannot change a byte of
 * any answer — the id decides that — and leaving it in the key would re-run the whole graph
 * because somebody renamed a file. It exists so a refusal can name the thing the reader is
 * looking for rather than a hash, which is exactly the case where the catalogue cannot supply
 * the name because the set is not here.
 */
export const EDGE_SET_NAME_PARAM = {
  id: 'edgeSetName',
  kind: 'string',
  label: 'Edge set name',
  help: 'Shown when the edge set this graph names is not in this browser.',
  default: '',
  advanced: true,
  internal: true,
  presentational: true,
} as const

export const EDGE_SET_PARAMS = [EDGE_SET_ID_PARAM, EDGE_SET_NAME_PARAM]

/**
 * The edges half of a `DatasetValue`, spread into it.
 *
 * A spread rather than a field, `annotationsFrom`'s rule: a dataset with nothing attached
 * carries no key at all, so a saved graph does not gain an `edges: undefined` it never had.
 *
 * It does **not** check whether the set is present. That is `queries.ts`' job, at the moment a
 * question is actually asked, and it belongs there rather than here for a reason worth stating:
 * a dataset node whose set is missing still resolves to a perfectly good dataset handle, and
 * everything that does not ask about connectivity — Find Neurons, Explore, Skeletons, the ROI
 * nodes — goes on working. Refusing here would take the whole graph down for a question nobody
 * asked.
 */
export function edgesFrom(params: Record<string, unknown>): { edges?: DatasetEdges } {
  const id = edgeSetId(params)
  return id ? { edges: { id, name: edgeSetLabel(params) } } : {}
}

/** How an id is normalised out of a node's params. One rule, three readers. */
function edgeSetId(params: Record<string, unknown>): string {
  return String(params.edgeSetId ?? '').trim()
}

/** Whether this node's params attach a set at all — what the dataset *type* has to carry. */
export function hasEdgeSet(params: Record<string, unknown>): boolean {
  return edgeSetId(params) !== ''
}

/**
 * What to call the attached set on screen and in a refusal.
 *
 * The catalogue's name wins where we have it, so a set renamed since it was attached reads as its
 * current name; the stored one is the fallback for exactly the case it exists for — a graph
 * somebody was sent, naming a set this browser does not hold.
 *
 * Exported because the dataset card shows the same label, and the card is the *only* thing on the
 * canvas saying connectivity came from a file. Two spellings of this fallback would have the card
 * naming one thing and the run-time refusal naming another.
 */
export function edgeSetLabel(params: Record<string, unknown>): string {
  const id = edgeSetId(params)
  return peekEdgeSet(id)?.name || String(params.edgeSetName ?? '').trim() || id
}

/**
 * Edit-time issue for a graph naming an edge set this browser does not have.
 *
 * Reported here as well as refused at run time, because the two answer different questions: a
 * run says "this cannot be computed", and this says "before you press Run, the file is missing"
 * — which on a graph somebody was sent is the first thing they need to know.
 *
 * Silent while `edgeSetsKnown()` is false, the distinction `columnSchemaFor` draws. The
 * catalogue is read asynchronously, so without the guard every dataset node in a loaded graph
 * warns for the instant before it lands. `subscribeEdgeSetsLearned` is what re-runs this.
 */
export function edgeSetIssues(params: Record<string, unknown>): string[] {
  const id = edgeSetId(params)
  if (!id) return []
  /*
   * Peeked **before** the known-yet check, and the order is load-bearing: `peekEdgeSet` is what
   * starts the catalogue read the first time it cannot answer, and `validate` is the one caller
   * guaranteed to run. Returning early on `edgeSetsKnown()` left the read to be started by the
   * dataset card — which is not rendered while the node is collapsed, so a collapsed card naming
   * a missing edge set never warned at all.
   */
  const held = peekEdgeSet(id)
  if (held || !edgeSetsKnown()) return []
  const name = edgeSetLabel(params)
  return [
    `The edge set ${name === id ? id : `"${name}"`} is not in this browser, so this dataset cannot ` +
      `answer connectivity. Import the same file under Edge data — a set is identified by its ` +
      `contents, so the same file will match.`,
  ]
}
