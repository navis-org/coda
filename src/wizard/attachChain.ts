/**
 * Attaching a dataset's annotation chain to a dataset node that is already on a canvas.
 *
 * The builders write the chain in when they write the dataset (`buildWorkflow`). This is the
 * other case: a FlyWire node that arrived on its own (from the palette, the **+**, a plan, a
 * paste, an old file) and is reading the stale labels `AnnotationChain.staleBuiltin` describes.
 * Its card offers the chain, and this does the work.
 *
 * **The same declaration and the same three readers as the builders**: `chainLinks` for the
 * wires, `foldChain` for the frame, `withChainCaptions` for the note. Only placement is this
 * module's own, and placement is the one thing a builder is allowed to decide.
 *
 * **Placed, never arranged.** What the canvas draws for the chain, which is the folded frame with
 * its caption under it, goes one card gap to the left of the dataset, top-aligned with it. That is
 * where the wizard's own layout pass puts the frame. Where that lands on something already there,
 * it moves *down* (`dodgeDelta`, the arrange's own rule for notes). Nothing already on the canvas
 * moves: it is somebody's graph, and a button that re-lays it out to add six cards is a button
 * nobody presses twice.
 *
 * **The frame is placed, not the cards**, and the first version got this backwards. It put the
 * cards in their columns ending left of the dataset, so that unfolding would cover nothing. But a
 * folded frame is drawn at its members' top-left, which put the box four columns out, with a long
 * wire across empty canvas to the dataset it feeds. Unfolding covers nothing of the dataset only
 * if the box stays that far away, and the folded view is the one people see. So unfolding now
 * spreads the cards over the dataset, the same as in a wizard graph after its layout pass, and an
 * Arrange tidies it.
 */

import type { CodaGraph } from '../core/graph'
import { addEdge, edgeInto, newId } from '../core/graph'
import { collapsedView, condense } from '../layout/collapse'
import { CARD_GAP, placeInColumns } from '../layout/columns'
import { boundsOf, dodgeDelta, rectsOf } from '../layout/place'
import type { AnnotationChain } from '../nodes/lib/annotationChain'
import { chainLinks, foldChain, prefixChain } from '../nodes/lib/annotationChain'
import { graphNode } from './assemble'
import { withChainCaptions } from './build'

export interface AttachedChain {
  graph: CodaGraph
  /** The chain's cards, under the ids they were given here. Empty where nothing was attached. */
  nodeIds: string[]
}

/**
 * The graph with `chain` feeding the dataset node `datasetId`. Unchanged where that node is
 * missing, or where something already feeds its Annotations port: replacing a wire somebody
 * made is not what "add the current annotations" means.
 */
export function attachChain(
  graph: CodaGraph,
  datasetId: string,
  chain: AnnotationChain,
): AttachedChain {
  const dataset = graph.nodes.find((node) => node.id === datasetId)
  if (!dataset || edgeInto(graph, datasetId, 'annotations')) return { graph, nodeIds: [] }

  // Fresh ids, because a chain's own (`annotations`, `join`) are local to it and this canvas
  // may already hold one: a wizard graph, or this same chain attached to a second dataset.
  const local = prefixChain(chain, `${newId('ann')}-`)
  const links = chainLinks(local, datasetId)

  // In columns by depth, relative to one another: where they end up is decided by what the
  // canvas will draw for them, below. A chain's rows are its declaration (`ChainNode.row`).
  const at = placeInColumns(
    local.nodes.map((card) => ({ id: card.id, type: card.type, row: card.row ?? 0 })),
    links,
  )
  const cards = local.nodes.map((card) =>
    graphNode(card.id, card.type, at.get(card.id) ?? { x: 0, y: 0 }, card.params),
  )
  const cardIds = cards.map((card) => card.id)

  let built: CodaGraph = { ...graph, nodes: [...graph.nodes, ...cards] }
  for (const [source, sourceHandle, target, targetHandle] of links) {
    built = addEdge(built, { source, sourceHandle, target, targetHandle })
  }
  built = withChainCaptions(foldChain(built, local), [local])

  // Everything this added (the cards and the caption), and the rectangle the canvas draws for it:
  // `condense` swaps folded members for their box, the same fold align and arrange count by.
  const before = new Set(graph.nodes.map((node) => node.id))
  const added = new Set(built.nodes.filter((node) => !before.has(node.id)).map((n) => n.id))
  const drawn = boundsOf(
    condense(
      built.nodes.filter((node) => added.has(node.id)),
      [],
      collapsedView(built),
    ).nodes,
  )!

  const target = { x: dataset.position.x - CARD_GAP - drawn.width, y: dataset.position.y }
  const down = dodgeDelta(
    new Map([['chain', target]]),
    new Map([['chain', { width: drawn.width, height: drawn.height }]]),
    rectsOf(condense(graph.nodes, [], collapsedView(graph)).nodes),
  ).y
  const dx = target.x - drawn.x
  const dy = target.y + down - drawn.y
  const next: CodaGraph = {
    ...built,
    nodes: built.nodes.map((node) =>
      added.has(node.id)
        ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } }
        : node,
    ),
  }
  return { graph: next, nodeIds: cardIds }
}
