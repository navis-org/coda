/**
 * Copy, cut and paste: a selection lifted out of a graph as a document, and merged back into one.
 *
 * `duplicateSelection` already knew how to clone a subgraph, and this deliberately does not
 * reimplement it — the two share every rule that decides *what* comes along (internal edges only,
 * a frame only when the whole of it was taken, see `cloneGroups`). What is new is the seam in the
 * middle: a fragment leaves the app as text and comes back having possibly been somewhere else —
 * another tab, another build, a text editor, a chat window. That is the whole reason this exists
 * rather than an in-memory list of nodes.
 *
 * **A fragment is a graph file, plus a marker.** Not a format of its own: everything that could go
 * wrong with a pasted fragment — an unknown node type, an edge naming a socket that is not there,
 * a param that predates a control — is what `deserializeGraph` was written to survive, and a
 * second lenient reader would be the place those repairs quietly stop happening. So `readFragment`
 * *is* `deserializeGraph`, and the marker only says which shape of document was on the clipboard;
 * a whole `.coda.json` pastes in as readily, which is the useful side of the same decision.
 *
 * Headless, so `core/clipboard.test.ts` reads it with no DOM. The system clipboard itself is a
 * browser API and lives in `ui/clipboard.ts`; what crosses between them is a string.
 */

import type { CodaGraph } from './graph'
import { GRAPH_FORMAT_VERSION, deserializeGraph, newId } from './graph'
import { cloneGroups } from './groups'

/**
 * What a copied fragment says it is.
 *
 * A field on the document rather than a clipboard MIME type: `text/plain` is the only flavour
 * every browser lets a page write *and* read back from a paste event, so the marker has to ride
 * inside the text. It is read as a hint, never as a gate — see `readFragment`.
 */
export const FRAGMENT_MARKER = 'coda.fragment'

/** How far a paste with nowhere in particular to land sits from what it was copied from. */
export const PASTE_OFFSET = 28

export interface Point {
  x: number
  y: number
}

/**
 * The chosen nodes as a graph in their own right, or undefined when none of them are there.
 *
 * The half of a copy that has nothing to do with the clipboard, and the reason it is exported:
 * `duplicateSelection` in the store is `subgraphOf` + `insertFragment`, so "what comes along with
 * a selection" is one answer rather than two that agree by restatement. `docs/canvas.md` records
 * why that matters here — the next field on the document that references a node id has to be
 * found in one clone path, not two.
 *
 * Positions are kept **absolute**, exactly as they sit on the canvas: the subgraph records the
 * shape of the thing copied, and where it lands is a decision the paste makes — with a pointer to
 * aim at, usually, which the copy cannot know about.
 */
export function subgraphOf(
  graph: CodaGraph,
  nodeIds: readonly string[],
): CodaGraph | undefined {
  const wanted = new Set(nodeIds)
  const nodes = graph.nodes.filter((n) => wanted.has(n.id))
  if (nodes.length === 0) return undefined
  const kept = new Set(nodes.map((n) => n.id))
  /*
   * Internal edges only, and whole frames only.
   *
   * A copied clone must not silently steal an input the original had, and a frame around three of
   * six cards is a claim about a set nobody selected. `cloneGroups` applies the second rule again
   * on the way back in, which is not redundant: what leaves has to be a document that stands on
   * its own, and what arrives may have come from another build entirely.
   */
  const edges = graph.edges.filter((e) => kept.has(e.source) && kept.has(e.target))
  const groups = (graph.groups ?? []).filter((g) => g.nodeIds.every((id) => kept.has(id)))
  return {
    ...graph,
    version: GRAPH_FORMAT_VERSION,
    nodes,
    edges,
    ...(groups.length ? { groups } : { groups: [] }),
  }
}

/**
 * The selected nodes as clipboard text, or undefined when there is nothing to copy.
 *
 * `serializeGraph` is deliberately not used: it stamps a wall-clock `modifiedAt` and carries
 * `meta.gist` through, and a fragment is a piece of a document rather than a document — the name
 * of the graph it came from, the gist it is published to and the viewport it was framed in are
 * all facts about the *file*, and none of them should follow four cards onto a clipboard.
 */
export function fragmentFrom(graph: CodaGraph, nodeIds: readonly string[]): string | undefined {
  const sub = subgraphOf(graph, nodeIds)
  if (!sub) return undefined
  const { meta: _meta, dashboard: _dashboard, viewport: _viewport, ...rest } = sub
  return JSON.stringify({ coda: FRAGMENT_MARKER, ...rest }, null, 2)
}

/**
 * Text from the clipboard read as a graph, or undefined when it was not one.
 *
 * Undefined is the common case and is not an error: most of what is on somebody's clipboard is
 * prose, a URL or a column of neuron ids. A paste handler has to be able to tell "not for me" from
 * "for me and broken", because the first has to leave the event alone for whatever else wants it.
 *
 * The marker is **not** required. What makes text pasteable is that it parses as a graph with at
 * least one node this build knows — which a `.coda.json` somebody was sent does, and which a JSON
 * document that merely happens to have `nodes` and `edges` arrays does not. Requiring the marker
 * would refuse the file and accept nothing extra.
 */
export function readFragment(
  text: string,
): { graph: CodaGraph; warnings: string[] } | undefined {
  const trimmed = text.trim()
  // The one cheap gate worth keeping in front: a pasted column of ten thousand neuron ids should
  // not be parsed at all to find out it is not a graph.
  if (!trimmed.startsWith('{')) return undefined
  let read
  try {
    // Everything a hand-rolled pre-check would ask — valid JSON, an object, `nodes` and `edges`
    // arrays — `deserializeGraph` already asks, and *throws* on each. Asking first meant parsing
    // the payload twice per call to reach the same three answers.
    read = deserializeGraph(trimmed)
  } catch {
    return undefined
  }
  // Every node dropped means a document from a build with other nodes, or JSON that only looked
  // like one. Either way there is nothing to place, and a paste that adds nothing must not also
  // swallow the keystroke.
  if (read.graph.nodes.length === 0) return undefined
  return read
}

export interface PasteResult {
  graph: CodaGraph
  /** The ids the pasted nodes were given, in document order — what the caller selects. */
  nodeIds: string[]
}

/**
 * Merge a read fragment into a graph, re-identified, and say what the new nodes are called.
 *
 * Every id is minted fresh, which is what makes pasting into the graph it was copied from the
 * same operation as pasting into another one — and what stops a second paste of the same
 * clipboard colliding with the first.
 *
 * `at` places the fragment's top-left corner, so a paste lands under the pointer rather than
 * wherever the cards happened to be when they were copied. Without one — a paste with no pointer
 * to aim at — it goes down `PASTE_OFFSET` from the original position, which is `duplicateSelection`'s
 * answer to the same question.
 */
export function insertFragment(graph: CodaGraph, incoming: CodaGraph, at?: Point): PasteResult {
  const minX = Math.min(...incoming.nodes.map((n) => n.position.x))
  const minY = Math.min(...incoming.nodes.map((n) => n.position.y))
  const dx = at ? at.x - minX : PASTE_OFFSET
  const dy = at ? at.y - minY : PASTE_OFFSET

  const idMap = new Map<string, string>()
  const nodes = incoming.nodes.map((node) => {
    const id = newId('n')
    idMap.set(node.id, id)
    return {
      ...node,
      id,
      position: { x: node.position.x + dx, y: node.position.y + dy },
      params: { ...node.params },
    }
  })
  const edges = incoming.edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({
      ...e,
      id: newId('e'),
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
    }))
  const groups = cloneGroups(incoming, idMap)

  return {
    graph: {
      ...graph,
      nodes: [...graph.nodes, ...nodes],
      edges: [...graph.edges, ...edges],
      ...(groups.length ? { groups: [...(graph.groups ?? []), ...groups] } : {}),
    },
    nodeIds: nodes.map((n) => n.id),
  }
}
