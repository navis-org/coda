/**
 * The nodes a dataset needs in front of it before its neurons have names.
 *
 * **Why this is data rather than a graph.** A neuPrint dataset carries its cell typing as
 * properties on the neuron, so `Dataset ▸ Explore` is a browser you can read. A CAVE datastack
 * does not: the labels live in a table, and browsing FlyWire without an annotation chain is
 * browsing a list of eighteen-digit root ids. That chain was written once, as
 * `examples/starters.ts`' bespoke FlyWire starter, and stayed there — so the Workflow Wizard
 * opened every FlyWire workflow on those root ids, and the assistant, whose catalogue is
 * generated from the registry, could not know the chain existed at all.
 *
 * So the chain is declared here, on the family, and **placed** by whoever is building: the
 * starter has hand-tuned coordinates and a folded frame, the wizard lays out in columns, and
 * neither is a fact about the annotations. What is shared is the part that has to agree —
 * which nodes, which params, which wires, and which column the fold produces.
 *
 * **Generated, not transcribed, is the rule this exists to keep.** `datasetChainNote` renders
 * the same declaration for the assistant catalogue, so a chain that changes cannot leave a
 * catalogue line telling a model to build the old one. That is `operatorVocabulary()`'s
 * arrangement and it is here for the same reason.
 *
 * It is deliberately **not** baked into the dataset node. Two of these six are `expensive` — one
 * fetches a third-party file from GitHub, one does a supervoxel lookup per neuron — and a third
 * reads a table of about a million rows. A node doing all that with nothing on the canvas to say
 * so is un-inspectable and un-switchable, which is the opposite of what a node-graph editor is
 * for; the chain is foldable instead, which buys the same first screen without hiding anything.
 */

import type { CodaGraph } from '../../core/graph'
import { createGroup } from '../../core/groups'
import type { ParamValues } from '../../core/node'

/** One card in a chain: an id local to the chain, a node type, and its overrides. */
export interface ChainNode {
  id: string
  type: string
  params?: ParamValues
  /**
   * Which arm of the chain this card is on. Absent is the first.
   *
   * **Structure, not placement.** Both builders were inventing it and disagreeing: the starter
   * keyed absolute coordinates on the chain's internal ids, and the wizard derived a row from
   * the list index — which fills column-major and interleaves the two arms, the transpose of
   * what its own comment claimed and of what the starter draws. Neither could be derived from
   * the other because the declaration did not state it. A row is a fact about the chain (a
   * structured source down the top, a free-form one along the bottom, meeting at a join); an
   * origin and a step are facts about the canvas, and those stay with each builder.
   */
  row?: number
}

/** `[from, fromPort, to, toPort]`, matching `examples/assemble.ts`' `Link`. */
export type ChainLink = [string, string, string, string]

export interface AnnotationChain {
  /** The cards, in the order they run. */
  nodes: readonly ChainNode[]
  /** Wires between chain members. Wires to the dataset are the three fields below. */
  links: readonly ChainLink[]
  /**
   * Chain ids taking the dataset's identity on a `dataset` port.
   *
   * A **reference** edge, so neither pair is a cycle: `Update root IDs` and the CAVE table both
   * read the datastack out of the dataset they are about to feed. See `PortDef.reference`.
   */
  datasetRefs: readonly string[]
  /** The chain member whose output goes to the dataset's `annotations` port. */
  output: { id: string; port: string }
  /**
   * The column the fold produces, which Explore's `Additional tags` has to be pointed at.
   *
   * Carried on the chain rather than recomputed by each builder: it is `groupByTable`'s
   * `<agg>_<column>` rule, and a second spelling of it draws no tag row while failing nothing.
   */
  tagColumn?: string
  /** What the folded frame is called, where a builder folds it. */
  title: string
  /**
   * Why this dataset needs one, in a sentence, for the assistant catalogue.
   *
   * On the chain rather than passed in by the caller, so the reason and the nodes that answer it
   * are read from one place — a note saying the built-in typing is stale, beside a chain that no
   * longer fetches the replacement, is the drift this whole module exists to stop.
   */
  why: string
}

/**
 * The chain's cards with their grid position worked out: a row from the declaration, a column
 * from how many cards precede it on that row.
 *
 * One derivation because two builders were making it separately and getting different answers.
 * Only the origin and the step stay with the builder.
 */
export function chainGrid(
  chain: AnnotationChain,
): { node: ChainNode; row: number; col: number }[] {
  const filled = new Map<number, number>()
  return chain.nodes.map((node) => {
    const row = node.row ?? 0
    const col = filled.get(row) ?? 0
    filled.set(row, col + 1)
    return { node, row, col }
  })
}

/** How many columns the widest row needs, for a builder placing the chain right-to-left. */
export function chainWidth(chain: AnnotationChain): number {
  return Math.max(...chainGrid(chain).map((cell) => cell.col + 1))
}

/**
 * Every wire a chain needs, including the three that touch the dataset it feeds.
 *
 * **The rule for how a chain attaches is one rule**, and it was the half the first version left
 * behind: the nodes were declared once and both builders still spelled out the reference edges,
 * the output wire and the near-identical comment explaining them. A chain that grows a second
 * output, or a member needing a reference port that is not called `dataset`, would have been an
 * edit in each builder with nothing failing if one were missed — which is the drift the
 * declaration exists to prevent.
 *
 * The two `dataset` edges are **references**, so neither pair is a cycle: both read the
 * datastack's identity out of the dataset they are about to feed. See `PortDef.reference`.
 */
export function chainLinks(chain: AnnotationChain, datasetId: string): ChainLink[] {
  return [
    ...chain.links,
    ...chain.datasetRefs.map((id): ChainLink => [datasetId, 'dataset', id, 'dataset']),
    [chain.output.id, chain.output.port, datasetId, 'annotations'],
  ]
}

/**
 * Fold the chain into one frame, which is the same call in every builder.
 *
 * Not placement — nothing about it varies between surfaces, so it sat as a duplicated
 * `createGroup(…, { title, collapsed: true })` in both. Six cards of plumbing that has to be
 * right and never has to be touched are the biggest thing on the canvas and none of them is what
 * the reader came to do; folded, the graph reads as the cards they asked for with the chain as a
 * single box anybody can open. `collapsed` lives in the document precisely so a graph can
 * *arrive* this way (see `GraphGroup.collapsed`).
 *
 * **A one-card chain is left alone**, which is what BANC's is: a frame around a single node hides
 * nothing, costs a click to open, and replaces a card whose title says what it does with a box
 * whose title says roughly the same thing. The rule is here rather than at each call site so the
 * two builders cannot disagree about how small is too small.
 */
export function foldChain(graph: CodaGraph, chain: AnnotationChain): CodaGraph {
  if (chain.nodes.length < 2) return graph
  return createGroup(
    graph,
    chain.nodes.map((node) => node.id),
    { title: chain.title, collapsed: true },
  )
}

/**
 * The catalogue's note for a dataset node that wants one of these, or `undefined`.
 *
 * Read by `buildDatasetNode` into `NodeDefinition.catalogueNote`.
 *
 * **Every part of it is generated from the declaration**, which is the rule this module exists
 * for and is load-bearing in a way a first draft got wrong: written as prose it said "wired in
 * that order", and this chain is not an order — it is two rows meeting at a join, and a model
 * following the sentence would have built a line of six. So the wires are printed as wires and
 * the params as params, from `links` and `nodes`; a chain that gains a branch re-renders.
 *
 * It names types rather than the chain's internal ids, because a type is the only handle a plan
 * has: `add` invents its own refs. And it carries the params, because a `core.tableFromUrl` with
 * no URL is six nodes of correct wiring around nothing.
 */
export function datasetChainNote(chain: AnnotationChain | undefined): string | undefined {
  if (!chain) return undefined
  const typeOf = (id: string) => chain.nodes.find((n) => n.id === id)?.type ?? id
  const wires = [
    ...chain.links.map(
      ([from, fromPort, to, toPort]) => `${typeOf(from)}:${fromPort} → ${typeOf(to)}:${toPort}`,
    ),
    `${typeOf(chain.output.id)}:${chain.output.port} → this node:annotations`,
    ...chain.datasetRefs.map((id) => `this node:dataset → ${typeOf(id)}:dataset`),
  ]
  const params = chain.nodes
    .filter((node) => node.params && Object.keys(node.params).length > 0)
    .map((node) => `${node.type} ${JSON.stringify(node.params)}`)
  return [
    chain.why,
    `Build this and wire it in — ${wires.join('; ')}.`,
    `Set: ${params.join('; ')}.`,
    'Do this on any workflow that reads neuron names from this dataset; a bare dataset node here',
    'gives a table of root ids with no cell types on it.',
  ].join(' ')
}
