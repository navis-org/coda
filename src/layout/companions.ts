/**
 * A companion card and the node it belongs to, as one box the layout places together.
 *
 * A dataset node arrives with a Description card wired to it (`NodeDefinition.companion`), and
 * that card is not a step in the pipeline — it is a credit hanging off the dataset, with no
 * outputs at all (`dataset.description`). Handed to ELK as an ordinary node it is treated as one:
 * layered puts it in the layer *after* its dataset, where it competes with the real next step for
 * the same column and adds a row to it.
 *
 * Measured in a browser on the wizard's `flywire + banc / compare` workflow: both Description
 * cards landed at x = −540 alongside `find` and `find2`, a full layer right of their datasets at
 * x = −884, and on the four-dataset co-cluster one of them was the *topmost* card on the canvas
 * while its dataset sat in the previous column. Withholding them from the layout entirely takes
 * that graph from 910 to 574 units tall in the headless probe — the single biggest contribution
 * to the arrangement being nearly square on a wide screen.
 *
 * ## The shape: one box, not a constraint
 *
 * ELK has no "put this node directly below that one" constraint, and the two things that come
 * closest are both wrong here. A partition puts the pair in one *layer* and says nothing about
 * which is above; a post-pass that moves the card after the fact lands it on whatever ELK put
 * there, which is a packing problem of its own.
 *
 * So the pair is condensed the way `layout/collapse.ts` condenses a folded group: the companion
 * leaves the layout graph, the host's box **grows to cover where the companion will sit**, and the
 * companion is put back at its declared offset once positions are known. ELK reserves the space,
 * nothing can be placed in it, and the rule holds exactly rather than on average.
 *
 * The host keeps its own id, ports and edges — only its size changes — which is what keeps this
 * off every other part of the pass. `toElkGraph` learns nothing about companions, and neither
 * does `place.ts`.
 *
 * ## Why the box only grows down and right
 *
 * The box's top-left **is** the host card's top-left, so a pinned socket offset
 * (`MeasuredPorts`, which `FIXED_POS` takes literally) still describes the host card. A spec
 * placing its companion above or to the left would need every one of those offsets shifted, and
 * would put the companion outside the box ELK reserved if they were not. Rather than carry that
 * arithmetic for a case no definition asks for, a negative offset simply declines the pin and the
 * companion is laid out as the ordinary node it was — visible in `companions.test.ts` rather than
 * assumed.
 *
 * ## Under the host's height, not at a fixed depth
 *
 * A companion goes `CompanionSpec.offset.gap` below the host's **measured** bottom edge, floored
 * by its declared `cardHeight` (see `under`).
 *
 * ## A chain's caption is the same move, and the one exception to "notes never move"
 *
 * A note that **declares** its host (`GraphNode.captionOf` — never inferred from what a note
 * happens to be near) is condensed exactly like a companion: its host's box grows to cover it, it
 * is not an obstacle to `dodge`, and it is snapped back `CAPTION_GAP` under the host. The host is
 * the card it names, or the folded box standing in for it. `docs/canvas.md` has why.
 */

import type { CodaGraph, GraphEdge, GraphNode } from '../core/graph'
import { getNodeDef, isAnnotation } from '../core/registry'
import type { CollapsedView } from './collapse'
import { collapsedView, condense, expandPositions } from './collapse'
import type { LayoutNode, MeasuredSizes, NodeSize } from './elkGraph'
import { resolveSize } from './elkGraph'
import type { XY } from './place'

/** One host and the card pinned to it, with the box the pair occupies. */
export interface CompanionPair {
  /** The node that stays in the layout. */
  host: string
  /** The node withheld from it. */
  companion: string
  /**
   * Where the companion goes, relative to the host's top-left — resolved, so `y` is the host's
   * height plus the declared gap rather than `CompanionSpec.offset` itself.
   */
  offset: XY
  /** The box the pair occupies, anchored at the host's top-left. */
  box: NodeSize
}

/**
 * Which cards are companions of which, over a set the layout is about to be handed.
 *
 * **Derived from the wires, not from how the node arrived.** Nothing in the document records that
 * a card came in as a companion — `addNodeWithCompanion` adds an ordinary node and an ordinary
 * edge, deliberately, so that deleting or re-adding one is nothing special. So the question asked
 * here is the one the rule is actually about: is this card of the type its neighbour's definition
 * names, wired from the port that definition names to the port it names? A Description somebody
 * re-wired to a different dataset is pinned under *that* dataset, which is what "underneath the
 * Dataset node it's connected to" says.
 *
 * Three things are refused, each of which the loop would otherwise get wrong:
 *
 * - **A companion carrying any other wire.** A Description has no outputs, so this is not the
 *   daily case; but a companion type that grew one, or an input from somewhere else, has a
 *   dependency the layout must go on seeing. Withholding it would delete that edge from the
 *   layout silently. This is also what settles the *shared* companion — one card wired from two
 *   datasets is not pinned under either, since pinning it under the first would hide the second
 *   wire from the layout while looking like a decision.
 * - **A second companion on one host.** The first wins and the rest stay ordinary nodes: two
 *   cards at one offset would be drawn on top of each other, which is worse than either place ELK
 *   would have chosen.
 * - **A negative offset**, for the reason in the module note.
 *
 * Takes the already-condensed node list rather than the graph, so a card inside a folded group is
 * simply not here to be paired — a box is one node and its contents are not the layout's business.
 */
export function companionView(
  nodes: readonly LayoutNode[],
  edges: readonly GraphEdge[],
  measured?: MeasuredSizes,
): CompanionPair[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))

  // How many wires touch each node, so "this companion has another wire" is one lookup rather
  // than a scan of every edge per candidate.
  const degree = new Map<string, number>()
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1)
  for (const edge of edges) {
    bump(edge.source)
    bump(edge.target)
  }

  const pairs: CompanionPair[] = []

  for (const edge of edges) {
    const host = byId.get(edge.source)
    const companion = byId.get(edge.target)
    if (!host || !companion) continue
    // Scanned rather than tracked in a Set: `pairs` is one entry per host by construction and is
    // a handful of entries on any real graph. Only the host can already be spoken for — a
    // companion reached twice has a degree of two and is turned away below.
    if (pairs.some((p) => p.host === host.id)) continue

    const spec = getNodeDef(host.type)?.companion
    if (!spec) continue
    if (spec.type !== companion.type) continue
    if (edge.sourceHandle !== spec.from || edge.targetHandle !== spec.to) continue
    if (spec.offset.x < 0 || spec.offset.gap < 0) continue
    // Its one wire is this one. See the note above.
    if ((degree.get(companion.id) ?? 0) !== 1) continue

    pairs.push(under(host, companion, spec.offset, measured))
  }

  return pairs
}

/**
 * One pin: `card` below `host`, `gap` under the host's height, and the box covering both.
 *
 * One function for the companion and the caption, since the arithmetic is the whole of what they
 * share and a second copy is how one of them comes to grow the box and the other not.
 */
function under(
  host: LayoutNode,
  card: GraphNode,
  at: { x: number; gap: number },
  measured?: MeasuredSizes,
): CompanionPair {
  const hostSize = resolveSize(host, measured)
  const size = resolveSize(card, measured)
  /*
   * The declared `cardHeight` is a floor under the measurement, because a card measured at the
   * moment an arrange runs can still be growing (`docs/canvas.md` has the measurements). Only
   * `cardHeight`, not `declaredHeight`: a `defaultSize` is a resizable card's starting size, and a
   * card resized shorter is drawn shorter.
   */
  const hostHeight = Math.max(hostSize.height, getNodeDef(host.type)?.cardHeight ?? 0)
  const y = hostHeight + at.gap
  return {
    host: host.id,
    companion: card.id,
    offset: { x: at.x, y },
    box: { width: Math.max(hostSize.width, at.x + size.width), height: y + size.height },
  }
}

/**
 * Space between a host's bottom edge and a caption hung under it — what the wizard places a
 * caption at (`wizard/build.ts`), so an arrange puts it back where it arrived.
 */
export const CAPTION_GAP = 16

/**
 * Which notes are captions of which layout items. See the module note for why a caption moves.
 *
 * **Declared, never inferred**: only a note carrying `captionOf` is one, so a note somebody wrote
 * beside a card keeps `dodge`'s rule and stays put. Its host is the card it names — or, when that
 * card is inside a folded group, the group's box, since the box is what is drawn and what the
 * caption was placed under. Expanded, the frame is not a layout item (only its members are), so
 * the caption goes under the card it names — the chain's output card, the one that feeds the
 * dataset — which is the only thing in that state ELK can reserve room under; a post-pass placing
 * it under the members' union would land it on whatever ELK put there.
 *
 * Refused where the host already carries a pinned companion, for `companionView`'s "second
 * companion on one host" reason; the caption then stays an ordinary note and is dodged.
 */
export function captionView(
  graph: CodaGraph,
  items: readonly LayoutNode[],
  view: CollapsedView,
  measured: MeasuredSizes | undefined,
  taken: ReadonlySet<string>,
): CompanionPair[] {
  const byId = new Map(items.map((node) => [node.id, node]))
  const boxOf = new Map<string, string>()
  for (const box of view.boxes) for (const member of box.members) boxOf.set(member.id, box.id)

  const pairs: CompanionPair[] = []
  for (const note of graph.nodes) {
    const about = note.captionOf
    if (!about || !isAnnotation(note.type)) continue
    const host = byId.get(boxOf.get(about) ?? about)
    if (!host || taken.has(host.id) || pairs.some((pair) => pair.host === host.id)) continue
    pairs.push(under(host, note, { x: 0, gap: CAPTION_GAP }, measured))
  }
  return pairs
}

/**
 * What an arrange hands ELK: folded groups as one box each, companions and captions withheld and
 * their hosts grown — and the note ids `dodge` must no longer treat as obstacles.
 *
 * The sequence the arrange runs, as one function so the canvas and the tests run the same one:
 * folded first (a card inside a folded group has no place of its own to be put back into), then
 * pinned. `hidden` is the fold's hidden set plus every pinned caption — a caption the block dodged
 * would be pushed away from the very host it is about to be snapped under.
 */
export function condenseForArrange(
  graph: CodaGraph,
  scope: {
    nodes: readonly GraphNode[]
    edges: readonly GraphEdge[]
    omit: Parameters<typeof condense>[3]
  },
  measured?: MeasuredSizes,
): {
  view: CollapsedView
  pins: CompanionPair[]
  nodes: LayoutNode[]
  edges: GraphEdge[]
  sizes: MeasuredSizes
  hidden: ReadonlySet<string>
} {
  const view = collapsedView(graph, measured)
  const folded = condense(scope.nodes, scope.edges, view, scope.omit)
  const companions = companionView(folded.nodes, folded.edges, measured)
  const taken = new Set(companions.map((pair) => pair.host))
  const captions = captionView(graph, folded.nodes, view, measured, taken)
  const pins = [...companions, ...captions]
  const { nodes, edges, sizes } = pinCompanions(folded.nodes, folded.edges, pins, measured)
  const hidden = new Set([...view.hidden, ...captions.map((pair) => pair.companion)])
  return { view, pins, nodes, edges, sizes, hidden }
}

/**
 * Positions for the real cards: companions and captions snapped back, then folded members moved
 * with their boxes — each undoing one of `condenseForArrange`'s two condensations, in reverse.
 */
export function expandArranged(
  placed: ReadonlyMap<string, XY>,
  arranged: { pins: readonly CompanionPair[]; view: CollapsedView },
): Map<string, XY> {
  return expandPositions(expandCompanions(placed, arranged.pins), arranged.view)
}

/**
 * What ELK is handed: the nodes without their pinned companions, the edges without their wires,
 * and the sizes to place them at.
 *
 * **The three come out together because they have to agree.** The sizes are keyed by *layout
 * item* — collapsed boxes included, pinned companions excluded, hosts grown to their pair's box —
 * so a caller building them separately is restating which nodes survived. It was two functions
 * and both callers wrote the same three lines in the same order; returned together, the agreement
 * is structural instead of a comment.
 *
 * A companion's one wire goes with it, which is the whole of what it contributed: a leaf hanging
 * off one port. Only the target side is checked, because a pinned companion passed the degree
 * rule as an edge's *target* — its single incident wire always has it on that side.
 *
 * The sizes are a fresh map rather than a grown `measured`, and that is not tidiness:
 * `resolveSize` reads `measured` first, so a `size` written onto the host would be ignored on
 * exactly the graphs where every card has been measured — and `measured` is what `structureKey`
 * is computed from, so growing it in place would make the key follow the pinning rather than the
 * cards, and auto mode would arrange its own arrangement for ever.
 */
export function pinCompanions(
  nodes: readonly LayoutNode[],
  edges: readonly GraphEdge[],
  pairs: readonly CompanionPair[],
  measured?: MeasuredSizes,
): { nodes: LayoutNode[]; edges: GraphEdge[]; sizes: MeasuredSizes } {
  const pinned = new Set(pairs.map((pair) => pair.companion))
  const kept: LayoutNode[] = []
  const sizes = new Map<string, NodeSize>()
  for (const node of nodes) {
    if (pinned.has(node.id)) continue
    kept.push(node)
    sizes.set(node.id, resolveSize(node, measured))
  }
  for (const pair of pairs) sizes.set(pair.host, { ...pair.box })
  return { nodes: kept, edges: edges.filter((e) => !pinned.has(e.target)), sizes }
}

/**
 * Put every pinned companion back, at its host's new position plus the declared offset.
 *
 * `expandPositions`' counterpart, and deliberately the *opposite* rule: a folded group's members
 * keep the arrangement their author left them in, because folding a group is a way of telling the
 * layout to leave that part alone. A companion has no such arrangement to keep — it is placed by
 * its host's definition, so an arrange puts it back where that definition says. This is what the
 * pin buys and is the reason it is a snap rather than a preserved relative offset.
 *
 * A host the layout did not place contributes nothing: its companion stays wherever the document
 * has it, which is the same thing that happens to any node outside the arranged scope.
 */
export function expandCompanions(
  positions: ReadonlyMap<string, XY>,
  pairs: readonly CompanionPair[],
): Map<string, XY> {
  const out = new Map(positions)
  for (const pair of pairs) {
    const at = positions.get(pair.host)
    if (!at) continue
    out.set(pair.companion, { x: at.x + pair.offset.x, y: at.y + pair.offset.y })
  }
  return out
}
