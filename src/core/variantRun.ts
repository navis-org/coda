/**
 * The graph a node's input chain is re-run on, for another neuron (`EvalContext.rerunInput`).
 *
 * ## The chain above an input is a function of one neuron
 *
 * Meshes, a clean-up, a model, a Sort — whatever sits above a port was built for the neuron on
 * the wire, and nothing in it says so. This module finds where the neuron comes in and makes a
 * copy of the graph with another one there. The scheduler then runs that copy on a `Scheduler`
 * of its own (`scheduler.ts`, `rerunnerFor`), which is `docs/loops.md`' own idea — a new pass is
 * indistinguishable from somebody having edited a param upstream — without the pass being taken
 * on the cards the reader is looking at.
 *
 * **Why a copy and not a loop.** A `For Each` re-runs every pass when its collection grows,
 * publishes no partial results, and overwrites each region node's one cache entry. This is asked
 * for one neuron at a time, by a node that is itself mid-run and streaming.
 *
 * ## Where the neuron comes in
 *
 * Going up from the port, the **nearest wires carrying a neuron table**: the walk stops at each
 * one and does not look above it. Above that wire is how the reader *chose* the neuron — a
 * search, a filter, a typed list — and that is exactly what is being replaced.
 *
 * Two things the walk does not go through, each for a reason of its own:
 *
 * - **a reference wire**, which names a node and carries nothing that was computed;
 * - **a wire carrying a dataset**, because what is above a dataset is where its labels come
 *   from, not the neuron under study. An annotation chain there is often a neuron table too, and
 *   read as "the neuron" it would be swapped out from under the dataset.
 *
 * ## What it refuses, and why each is a sentence rather than a guess
 *
 * - **No neuron wire above the port.** The chain is not a function of a neuron — a published set
 *   read from a URL, say — so there is nothing to put another one into.
 * - **Neuron wires from two different places.** Two populations feed the chain and only one of
 *   them is the neuron being asked about; choosing would be a plausible answer about the wrong
 *   one.
 * - **The old source still feeding the chain by another wire.** A node whose neuron table is
 *   swapped out but whose second output — a table of hits, say — is joined in further down
 *   would leave the re-run half about the new neuron and half about the old one.
 * - **A loop anywhere in what the run would reach**, a dataset's own label chain included. A
 *   `For Each` iterates only when somebody asked it to (`docs/loops.md`), and a private run is
 *   nobody asking.
 *
 * ## What the copy holds
 *
 * The node that fed the port and everything that feeds *it* by an ordinary wire — and nothing
 * else on the canvas. A node the chain only **names**, by a reference wire, is kept on its own,
 * with none of its inputs: a reference reads params or a type, never a result. That is also what
 * keeps the caller out of its own re-run. `ancestors`, which the scheduler scopes a run with,
 * follows reference wires too, so a chain node naming something *below* the caller would pull the
 * caller in, and it would re-run its input again inside the re-run, without end.
 *
 * Headless and pure: it reads the graph and the inference the caller already has, and runs
 * nothing.
 */

import type { CodaGraph, GraphEdge } from './graph'
import { nodeLabel, nodesById, portKey, referenceEdgeIds } from './graph'
import type { InferenceResult } from './inference'
import type { NeuronSwap, RerunSettings } from './node'
import { getNodeDef } from './registry'

/** A graph with the neuron swapped, and where on it the asked-for value will arrive. */
export interface VariantGraph {
  graph: CodaGraph
  /** The output that fed the port: run this node, read this handle. */
  source: { nodeId: string; handle: string }
  /**
   * The nodes whose results the port's value is made from — the copy less the ones it only
   * names. For telling which failure is the chain's own.
   */
  chain: ReadonlySet<string>
}

function refuse(why: string): never {
  throw new Error(`This input's chain cannot be run again for another neuron: ${why}`)
}

/**
 * The copy of `graph` on which `swap` stands where the neuron wire(s) above one input began.
 *
 * Throws, in a sentence, where there is no one place to put it — the header lists them.
 */
export function variantGraph(
  graph: CodaGraph,
  inference: InferenceResult,
  nodeId: string,
  portId: string,
  swap: NeuronSwap,
  /** Params laid over each copied node of a type (`RerunSettings`). */
  settings: RerunSettings = {},
): VariantGraph {
  for (const [type, params] of Object.entries(settings)) {
    const def = getNodeDef(type)
    if (!def) refuse(`its settings name ${type}, which is not a node type this build has.`)
    const declared = new Set((def.params ?? []).map((param) => param.id))
    const unknown = Object.keys(params).find((id) => !declared.has(id))
    if (unknown !== undefined) refuse(`${type} has no param \`${unknown}\` to set.`)
  }
  const references = referenceEdgeIds(graph)
  const nodes = nodesById(graph)
  const inbound = new Map<string, GraphEdge[]>()
  let feeding: GraphEdge | undefined
  for (const edge of graph.edges) {
    if (references.has(edge.id)) continue
    if (edge.target === nodeId && edge.targetHandle === portId) feeding = edge
    const held = inbound.get(edge.target)
    if (held) held.push(edge)
    else inbound.set(edge.target, [edge])
  }
  if (!feeding) refuse('nothing is wired into it.')

  const kindOn = (edge: GraphEdge) =>
    inference.nodes[edge.source]?.outputs[edge.sourceHandle]?.kind

  // The wires the neuron arrives on.
  const cut: GraphEdge[] = []
  const seen = new Set<string>()
  const queue: GraphEdge[] = [feeding]
  for (let at = 0; at < queue.length; at++) {
    const edge = queue[at]!
    const kind = kindOn(edge)
    if (kind === 'neurons') {
      cut.push(edge)
      continue
    }
    // Above a dataset is where its labels come from, not the neuron — see the header.
    if (kind === 'dataset' || seen.has(edge.source)) continue
    seen.add(edge.source)
    for (const above of inbound.get(edge.source) ?? []) queue.push(above)
  }

  if (cut.length === 0) {
    refuse(
      'nothing above it is wired from a neuron table, so there is no neuron to put another in ' +
        'place of.',
    )
  }
  const sources = new Map(cut.map((edge) => [portKey(edge.source, edge.sourceHandle), edge]))
  if (sources.size > 1) {
    const names = [...sources.values()].map((edge) => nodeLabel(nodes.get(edge.source)))
    refuse(
      `neuron tables from ${names.length} places feed it (${names.join(', ')}), and only one ` +
        'of them can be the neuron asked about.',
    )
  }

  // An id nothing in the document can hold: a re-run inside a re-run nests rather than collides.
  let swapId = `rerun:${nodeId}:${portId}`
  while (nodes.has(swapId)) swapId += "'"
  const swapped = new Set(cut.map((edge) => edge.id))
  const edges = graph.edges.map((edge) =>
    swapped.has(edge.id) ? { ...edge, source: swapId, sourceHandle: swap.output } : edge,
  )
  // The port's own wire can be the neuron wire, and then the swap is what feeds the port.
  const source = swapped.has(feeding.id)
    ? { nodeId: swapId, handle: swap.output }
    : { nodeId: feeding.source, handle: feeding.sourceHandle }

  /*
   * **Only what the run needs** — the header's "what the copy holds". A run sorts, infers and
   * keys the whole graph it is handed, and a partial published inside it derives every cheap
   * node below, the document's own viewers among them; cut down, a re-run costs what its chain
   * costs. `inbound` holds the ordinary wires only, and none of the cut ones start at the swap
   * in it, which is right: nothing feeds the swap.
   */
  const needed = new Set([source.nodeId])
  const stack = [source.nodeId]
  while (stack.length > 0) {
    for (const edge of inbound.get(stack.pop()!) ?? []) {
      if (swapped.has(edge.id) || needed.has(edge.source)) continue
      needed.add(edge.source)
      stack.push(edge.source)
    }
  }
  for (const id of needed) {
    const node = nodes.get(id)
    if (node && getNodeDef(node.type)?.loop) {
      refuse(`${nodeLabel(node)} is part of a loop, which runs only when asked to.`)
    }
  }
  /*
   * Asked of `seen` — the walk that looked for the neuron — and not of `needed`, which also
   * crosses dataset wires. A source that feeds a dataset's labels as well is not feeding the
   * *chain* twice: what is above a dataset is not about the neuron under study (the header).
   */
  const stale = cut.find((edge) => seen.has(edge.source))
  if (stale) {
    refuse(
      `${nodeLabel(nodes.get(stale.source))} also feeds it by another wire, which would still ` +
        'be about the neuron it was first run for.',
    )
  }
  // The swap itself: the walk above read the wires as they were, where nothing led to it.
  needed.add(swapId)
  // Named, not read: kept so the reference resolves, with nothing wired into it.
  const named = new Set<string>()
  for (const edge of edges) {
    if (references.has(edge.id) && needed.has(edge.target) && !needed.has(edge.source)) {
      named.add(edge.source)
    }
  }
  return {
    graph: {
      ...graph,
      nodes: [
        ...graph.nodes
          .filter((node) => needed.has(node.id) || named.has(node.id))
          // On the chain only: a node it merely names is read for its params as they stand.
          .map((node) =>
            needed.has(node.id) && settings[node.type]
              ? { ...node, params: { ...node.params, ...settings[node.type] } }
              : node,
          ),
        { id: swapId, type: swap.type, position: { x: 0, y: 0 }, params: swap.params },
      ],
      edges: edges.filter(
        (edge) =>
          needed.has(edge.target) && (needed.has(edge.source) || named.has(edge.source)),
      ),
    },
    source,
    chain: needed,
  }
}
