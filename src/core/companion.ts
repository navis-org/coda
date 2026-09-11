/**
 * Companion nodes — a second node that arrives wired to the first.
 *
 * A dataset node answers "which data", and nothing on the canvas answers "whose data". Coda is
 * for connectomes that people spent years reconstructing and that ask to be cited, so a dataset
 * node arrives with a Description card already attached: the credit is present by default and
 * has to be *dismissed*, rather than being available and never looked for.
 *
 * Three properties this deliberately has:
 *
 *  - **It is a suggestion, not a fixture.** The companion is an ordinary node — delete it, move
 *    it, add it back from the palette. Nothing re-creates it, and nothing downstream depends on
 *    it existing.
 *  - **It happens on *add*, never on load.** Opening a saved graph must reproduce that graph
 *    exactly; a file that grew a node on every open would be unusable.
 *  - **It is one undo step.** The host and the companion go in through a single `commit`, so
 *    Ctrl-Z after adding a dataset removes both — an add that takes two undos reads as a bug.
 *
 * Declared on the `NodeDefinition` rather than looked up in the UI, because "this node comes with
 * that one" is a fact about the node pack and not about React: the graphs the Workflow Wizard
 * builds — the starters among them, `wizard/starters.ts` — are headless and go through the same
 * function.
 */

import type { CodaGraph, GraphNode } from './graph'
import { addEdge, addNode, newId } from './graph'
import { declaredHeight, defaultParams } from './node'
import { getNodeDef } from './registry'

/** How a node asks for a companion. See the module note. */
export interface CompanionSpec {
  /** Node type to create alongside. Must be registered, or nothing is created. */
  type: string
  /** Output port of the host node that feeds the companion. */
  from: string
  /** Input port of the companion the host feeds. */
  to: string
  /**
   * Where the companion goes: `x` from the host's left edge, and `gap` between the host's
   * **bottom** edge and the companion's top, in canvas units.
   *
   * Below rather than beside, because a graph flows left to right: a companion off to the right
   * sits where the *next* step in the pipeline goes, and reads as part of the chain.
   *
   * **A gap below the host's height, not an offset from its top**, because a dataset card's
   * height varies by backend and a fixed depth overlapped the tallest (`docs/canvas.md`). The
   * height comes from the canvas's measurement where there is one (`layout/companions.ts`, at an
   * arrange) and from the host's declared height where there is not (here, on add).
   *
   * **Both must be non-negative, and that is a constraint rather than the taste above.**
   * `layout/companions.ts` withholds a companion from the layout and grows its host's box to
   * reserve the space, anchoring that box at the host card's own top-left — which is what keeps
   * the measured socket offsets ELK is handed (`FIXED_POS` takes them literally) describing the
   * host. A negative one would put the companion outside the reserved box, so the layout declines
   * to pin it at all: the card lands here on add and then wanders on the next arrange, with
   * nothing on screen to say why. Stated here because this is where a node pack writes one.
   */
  offset: { x: number; gap: number }
}

/**
 * Add `node`, plus the companion its definition asks for, in one pure step.
 *
 * Returns the graph unchanged apart from the host when there is no companion — which is every
 * node type but the dataset ones, so every caller can route through here unconditionally.
 */
export function addNodeWithCompanion(graph: CodaGraph, node: GraphNode): CodaGraph {
  const withHost = addNode(graph, node)

  const hostDef = getNodeDef(node.type)
  const spec = hostDef?.companion
  const companionDef = spec ? getNodeDef(spec.type) : undefined
  // An unregistered companion type is a wiring mistake in the node pack, not the user's
  // problem: the node they actually asked for still has to arrive.
  if (!spec || !companionDef) return withHost

  /*
   * The host has not been drawn yet, so its height is what it declares: a size somebody gave it,
   * else the definition's. `registerNode` refuses a companion host declaring neither, so the `0`
   * is unreachable rather than a guess.
   */
  const hostHeight = node.size?.height ?? declaredHeight(hostDef) ?? 0
  const companion: GraphNode = {
    id: newId('n'),
    type: spec.type,
    position: {
      x: node.position.x + spec.offset.x,
      y: node.position.y + hostHeight + spec.offset.gap,
    },
    params: defaultParams(companionDef),
  }
  return addEdge(addNode(withHost, companion), {
    source: node.id,
    sourceHandle: spec.from,
    target: companion.id,
    targetHandle: spec.to,
  })
}
