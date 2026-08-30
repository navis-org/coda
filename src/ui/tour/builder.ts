/**
 * The scaffolding a tour needs when it *builds* something, rather than pointing at what is there.
 *
 * "Learn to Build" wrote all of this first and owned it privately, which was right while it was
 * the only builder. "Build a dashboard" is the second, and it needs the same seven things: put a
 * node on the canvas however it got there, wire two of them, remember what has been made, place
 * each card in its column, frame the ones a step is about, span several cards for a step about
 * the wire between them, and apply a table of parameters.
 *
 * A factory rather than a module of free functions, because two of those seven are per-tour
 * state: what has been built so far, and where each card goes. `makeBuilder` closes over both, so
 * a second tour is a second call rather than a second copy — and the module state that used to be
 * a documented singleton ("a tour is a singleton, so there is no second reader") is now scoped to
 * the tour that owns it, which is what makes that argument unnecessary rather than load-bearing.
 *
 * What stays free is everything with no per-tour state: `hasNode`, `isStale`, `runIfStale`,
 * `ranClean`. They are questions about the store, and both tours ask them identically.
 */

import { getNodeDef } from '../../core/registry'
import { FALLBACK_NODE_SIZE } from '../../layout/elkGraph'
import type { NodeSize } from '../../layout/elkGraph'
import { boundsOf } from '../../layout/place'
import { useGraphStore } from '../../store/graphStore'
import { isViewer } from '../nodes/CodaNodeView'
import { NODE_BODIES, WIDE_CARD_WIDTH } from '../nodes/nodeBodies'
import { cardOf, frameNodes } from './steps'

/** Clear space between one card's right edge and the next card's left. */
const GAP = 90

/** The id the tour's own spanning element carries, so there is only ever one of them. */
const SPAN_ID = 'coda-tour-span'

/**
 * The widest a card of this type can draw, from every source that can decide it.
 *
 * A fixed column pitch does not work, because these cards are not one width: the default is
 * `FALLBACK_NODE_SIZE.width` but `NODE_BODIES` gives Find Neurons 360 for its filter rows and the
 * dataset card 248 for its preview. At a flat 340 the two widest overlapped their neighbours by
 * the end of the chain — which is the graph the reader is handed as the payoff, so it reading as
 * a pile is not a cosmetic problem. Seen in a browser before this existed.
 *
 * `defaultSize` sizes React Flow's wrapper, `NODE_BODIES.width` sizes the card, and a **viewer**
 * declares neither yet still reaches `WIDE_CARD_WIDTH` the moment it has a value to draw, because
 * `showPreview` puts `.coda-node--wide` on it. Missing that third source is what had the Table
 * card, which declares nothing at all and renders at 360, sitting 38px inside Group By. Measured
 * in a browser.
 */
function cardWidth(type: string): number {
  const def = getNodeDef(type)
  return Math.max(
    def?.defaultSize?.width ?? 0,
    NODE_BODIES[type]?.width ?? 0,
    def && isViewer(def) ? WIDE_CARD_WIDTH : 0,
    FALLBACK_NODE_SIZE.width,
  )
}

export interface BuilderOptions {
  /**
   * How close the camera gets to a card as it arrives.
   *
   * "Learn to Build" takes 1.0 rather than the Guided Tour's 1.2: its graph *grows*, and what
   * somebody building a pipeline needs to see is the new card **and the wire that arrived with
   * it**, which means keeping its upstream neighbour in frame. At 1.2 the neighbour is off the
   * edge on a laptop.
   */
  zoom?: number
  /**
   * Where each card goes, keyed by type. Omitted means one row, laid out left to right in chain
   * order from the widths above — which is what a pipeline wants and what the first builder had.
   */
  layout?: (chain: readonly string[]) => ReadonlyMap<string, { x: number; y: number }>
}

/** One row, left to right, each column as wide as the card that sits in it. */
export function row(chain: readonly string[]): ReadonlyMap<string, { x: number; y: number }> {
  const slots = new Map<string, { x: number; y: number }>()
  let x = 60
  for (const type of chain) {
    slots.set(type, { x, y: 0 })
    x += cardWidth(type) + GAP
  }
  return slots
}

/**
 * A fan: one node on the left, the rest stacked in a column to its right.
 *
 * The shape a dashboard's graph takes rather than a pipeline's — Explore feeds a table and a
 * scene that are peers, so drawing them in series would claim an order between them that the
 * wires do not have.
 */
export function fan(rowHeight: number) {
  return (chain: readonly string[]): ReadonlyMap<string, { x: number; y: number }> => {
    const slots = new Map<string, { x: number; y: number }>()
    let x = 60
    chain.forEach((type, i) => {
      if (i < 2) {
        slots.set(type, { x, y: 0 })
        x += cardWidth(type) + GAP
      } else {
        // Everything past the second shares one column and stacks.
        slots.set(type, { x, y: (i - 2) * rowHeight })
      }
    })
    return slots
  }
}

export interface Builder {
  /** The node id for a type, if it has been built. */
  idOf(type: string): string | undefined
  /** Make sure this node is on the canvas, in its slot, and remembered — however it got there. */
  ensure(type: string): string
  /** Wire one built node's port to another's. Safe to call for a link that already exists. */
  wire(from: string, fromPort: string, to: string, toPort: string): void
  /** Selects the built nodes a step is about and frames them. */
  reveal(...types: string[]): void
  /** The card for a built node, for a step that points at one. */
  card(type: string): Element | null
  /** An invisible element covering several cards at once — see below. */
  span(...types: string[]): Element | null
  /** Takes the spanning element back down. Paired with `span` through a step's `after`. */
  clearSpan(): void
  /** Applies this node's entry from the params table. */
  setParams(type: string): void
  /** Forget everything built, and take down any span. Called from `prepare`. */
  reset(): void
}

export function makeBuilder(
  chain: readonly string[],
  params: Record<string, Record<string, unknown>> = {},
  options: BuilderOptions = {},
): Builder {
  const slots = (options.layout ?? row)(chain)
  const zoom = options.zoom ?? 1.0
  /**
   * What has been built so far, node type to node id.
   *
   * Keyed by **type**, which is the same key the chain, the slots and `advanceWhen` already use —
   * an earlier version carried a second set of short names (`'ds'`, `'find'`, `'conn'`) alongside,
   * and a mapping that is total and injective onto the types buys nothing but a second spelling
   * for every node that nothing checks against the first.
   */
  const built = new Map<string, string>()

  const slot = (type: string) => slots.get(type) ?? { x: 60, y: 0 }

  return {
    idOf: (type) => built.get(type),

    /*
     * One function rather than an add and an adopt, because the caller cannot usefully tell the
     * two apart: on a "your turn" step the reader may have added the node from the browser, the
     * palette or a double-click, and on the same step reached by Next nobody has added it at all.
     * All three want the same thing to be true afterwards.
     *
     * A node the *reader* added is moved into line, and that is not tidiness for its own sake: it
     * lands wherever the browser puts a node, which is not the column of a chain being built
     * around it, and left alone it ended up overlapping two later cards — so the graph handed
     * over at the end, the whole payoff, read as a mess they had made. `commit: false`, so the
     * nudge does not become an undo step of its own between the add and the wiring.
     */
    ensure(type) {
      const store = useGraphStore.getState()
      const { nodes } = store.graph

      const remembered = built.get(type)
      if (remembered && nodes.some((node) => node.id === remembered)) return remembered

      const found = nodes.find((node) => node.type === type)
      if (found) {
        built.set(type, found.id)
        store.moveNodes([{ id: found.id, position: slot(type) }], false)
        return found.id
      }

      const id = store.addNode(type, slot(type))
      built.set(type, id)
      return id
    },

    /*
     * Called unconditionally, including for links the store's own auto-wire has already made.
     * That is safe rather than sloppy: `addEdge` evicts whatever occupies the destination input
     * before inserting, so re-making a link that exists replaces it with itself rather than
     * doubling it.
     */
    wire(from, fromPort, to, toPort) {
      const source = built.get(from)
      const target = built.get(to)
      if (!source || !target) return
      useGraphStore
        .getState()
        .connect({ source, sourceHandle: fromPort, target, targetHandle: toPort })
    },

    reveal(...types) {
      frameNodes(
        types.map((type) => built.get(type)).filter((id): id is string => Boolean(id)),
        zoom,
      )
    },

    card: (type) => cardOf(built.get(type)),

    /**
     * An invisible element covering several cards at once, for a step that highlights more than
     * one.
     *
     * driver spotlights exactly one element, and the step that says *"notice the wire"* is about
     * two cards and what runs between them — a cut-out around either one alone contradicts the
     * sentence.
     *
     * **It is placed inside React Flow's viewport, in world coordinates, and that is the whole
     * trick.** The viewport carries the pan and zoom as a CSS transform, so a child positioned in
     * world units is moved by the browser along with the cards, and `getBoundingClientRect` —
     * which is all driver ever asks — returns the right screen rectangle at every zoom with
     * nothing recomputing it. Positioning it in screen pixels instead would need re-measuring on
     * every frame of the camera animation the step starts.
     *
     * The rectangle itself is `boundsOf`, which is the module that owns this arithmetic; the
     * sizes handed to it are read off the DOM exactly as `useArrange`'s `measure` reads them,
     * because `offsetWidth` is pre-transform (world units, the distinction the field guide's
     * `offsetParent` note records) while a `getBoundingClientRect` here would be screen pixels.
     *
     * `pointer-events: none`, so it cannot intercept anything even though driver will mark it the
     * active element; and removed by the step's `after`, since it is scaffolding rather than part
     * of the graph.
     */
    span(...types) {
      const viewport = document.querySelector('.react-flow__viewport')
      if (!viewport) return null

      const nodes = []
      const measured = new Map<string, NodeSize>()
      for (const type of types) {
        const id = built.get(type)
        const node = id
          ? useGraphStore.getState().graph.nodes.find((n) => n.id === id)
          : undefined
        const card = id ? cardOf(id) : null
        /*
         * **All the cards, or none.** Skipping a card that has not been rendered yet looks like
         * tolerance and is the opposite: the step that adds a node resolves its anchor in the
         * same tick, so the new card is reliably absent — and returning a span around the *other*
         * card hands driver a perfectly good element, which ends its `waitForElement` poll on the
         * spot. The step then spotlights one card for a sentence about two, with nothing to
         * recompute it, because `refresh` re-reads the stored element rather than re-resolving
         * the anchor.
         *
         * Answering `null` keeps the poll alive; driver watches the document for mutations, and
         * the card landing is one. Measured before this: the span came out `left: 60px;
         * width: 248px`, exactly the dataset card, with Find Neurons sitting 338px to its right.
         */
        if (!node || !(card instanceof HTMLElement)) return null
        nodes.push(node)
        measured.set(node.id, { width: card.offsetWidth, height: card.offsetHeight })
      }

      const bounds = boundsOf(nodes, measured)
      if (!bounds) return null

      const span = document.getElementById(SPAN_ID) ?? document.createElement('div')
      span.id = SPAN_ID
      span.style.cssText = `position:absolute;pointer-events:none;left:${bounds.x}px;top:${bounds.y}px;width:${bounds.width}px;height:${bounds.height}px`
      if (span.parentElement !== viewport) viewport.appendChild(span)
      return span
    },

    clearSpan() {
      document.getElementById(SPAN_ID)?.remove()
    },

    setParams(type) {
      const id = built.get(type)
      if (!id) return
      for (const [param, value] of Object.entries(params[type] ?? {})) {
        useGraphStore.getState().setParam(id, param, value as never)
      }
    },

    reset() {
      built.clear()
      document.getElementById(SPAN_ID)?.remove()
    },
  }
}

/** Is there a node of this type on the canvas? The predicate the "your turn" steps wait on. */
export function hasNode(type: string): boolean {
  return useGraphStore.getState().graph.nodes.some((node) => node.type === type)
}

/** Is anything waiting to be run? One definition, for the steps and the predicates. */
export function isStale(): boolean {
  const store = useGraphStore.getState()
  return store.graph.nodes.some((node) => store.needsRun(node.id))
}

/** Catches up a reader who pressed Next instead of Run. Idempotent, like every other `before`. */
export function runIfStale(): void {
  if (isStale()) void useGraphStore.getState().runAll()
}

/** The `advanceWhen` a Run step takes: the reader pressed it and it finished. */
export function ranClean(): boolean {
  return !useGraphStore.getState().busy && !isStale()
}
