/**
 * "Learn to Build" — the second tour, and the one that actually makes something.
 *
 * The Guided Tour says where things are. This one builds the Field Guide's pipeline a node at a
 * time, on the canvas, with the reader doing four of the moves themselves. Same question the
 * Field Guide's worked example asks — *which cell types do LC neurons drive, and how strongly* —
 * so somebody who has read the chapter arrives here recognising the shape, and somebody who does
 * this first can go and read why it works.
 *
 * ## Three decisions worth arguing with
 *
 * **It starts from an empty canvas, and it says so before it does it.** A build tutorial that
 * dropped six nodes into somebody's working graph would be worse than useless. The clearing goes
 * through `setGraph`, *not* `newGraph`: `newGraph` resets `past` and `future`, so the reader's
 * work would be gone beyond recall, while a `setGraph` commit is one ⌘Z away for the rest of the
 * session. The first step's body says both halves of that, and Escape at step 0 has not touched
 * anything yet.
 *
 * **Its parameters are the `partners` example's, and a test holds them there.** The Field Guide
 * walks the same pipeline and `src/examples/index.ts` builds it; this file is a third statement
 * of it, and an earlier version of the note below claimed the three shared a source when they
 * did not. They still do not — the tour needs its own ordering and its own copy — but `PARAMS`
 * gathers every value that has to agree into one place and `tour.test.tsx` compares it against
 * the example, which is the difference between a claim and a fact.
 *
 * **The dataset is the mock one, not hemibrain.** The Field Guide can name hemibrain freely
 * because it is a document. A tour cannot: the public neuPrint deployment wants a token, so a
 * newcomer taking this on their first afternoon would hit a credentials wall at step 3 of 15
 * with a half-built graph and no idea whether they had done something wrong.
 * `dataset.mock.opticlobe` generates in the browser, needs nothing, and — this is the part that
 * makes it honest rather than a cop-out — **every node downstream of it is the same node it
 * would be against hemibrain**. The step says that too, and points at Connections.
 *
 * **Four steps hand over, the rest build while you watch.** Adding all six nodes by hand is
 * tedious by the third; watching all six appear teaches nothing. So the reader adds one node
 * (which is where the node browser gets learned), presses Run twice (which is where the
 * execution model gets learned), and the tour does the wiring and the parameters — narrating
 * each. Every interactive step's *successor* does the action if it was skipped, so Next always
 * works and the tour cannot wedge.
 */

import { emptyGraph } from '../../core/graph'
import { getNodeDef } from '../../core/registry'
import { FALLBACK_NODE_SIZE } from '../../layout/elkGraph'
import type { NodeSize } from '../../layout/elkGraph'
import { boundsOf } from '../../layout/place'
import { useGraphStore } from '../../store/graphStore'
import { isViewer } from '../nodes/CodaNodeView'
import { NODE_BODIES, WIDE_CARD_WIDTH } from '../nodes/nodeBodies'
import type { TourSpec, TourStep } from './steps'
import { byTour, cardOf, frameNodes } from './steps'

/**
 * The chain, in the order it gets built. Types are the `partners` example's, which is the same
 * pipeline the Field Guide walks; see `PARAMS` for the values and the module note for what keeps
 * the two in step.
 */
const DATASET = 'dataset.mock.opticlobe'
const FIND = 'neuron.findNeurons'
const CONNECTIVITY = 'neuron.connectivity'
const TABLE = 'out.table'
const GROUP = 'core.groupBy'
const CHART = 'out.barChart'

/** The chain, left to right. A node's place in it *is* its column. */
const CHAIN = [DATASET, FIND, CONNECTIVITY, TABLE, GROUP, CHART] as const

/**
 * The parameters the tour sets, per node.
 *
 * Lifted out of the steps so there is one place to compare them against `src/examples/index.ts`,
 * which builds the same pipeline as the `partners` example and is the thing they were copied
 * from. **`tour.test.tsx` asserts the two agree** — an earlier version of this file claimed in
 * prose to be reading from a single source and was in fact a second, unchecked copy, which is
 * the arrangement where the example's own test stays green while the tour quietly narrates a
 * pipeline it is no longer building.
 */
export const PARAMS: Record<string, Record<string, unknown>> = {
  [FIND]: {
    filters: [
      '{"f":"type","op":"matches","v":["LC.*"]}',
      '{"f":"status","op":"is","v":["Traced"]}',
    ],
  },
  [CONNECTIVITY]: { direction: 'outputs' },
  [GROUP]: { by: ['postType'], agg: 'sum', value: 'weight' },
  [CHART]: { category: 'postType', value: 'sum_weight' },
}

/** Clear space between one card's right edge and the next card's left. */
const GAP = 90

/**
 * Where each card goes, computed once from the cards rather than from a spacing constant.
 *
 * A fixed column pitch does not work here, because these cards are not one width: the default is
 * `FALLBACK_NODE_SIZE.width` but `NODE_BODIES` gives Find Neurons 360 for its filter rows and the
 * dataset card 248 for its preview. At a flat 340 the two widest overlapped their neighbours by
 * the end of the chain — which is the graph the reader is handed as the payoff, so it reading as
 * a pile is not a cosmetic problem. Seen in a browser before this existed.
 *
 * Width is resolved from every source that can decide it — the widest wins. `defaultSize` sizes
 * React Flow's wrapper, `NODE_BODIES.width` sizes the card, and a **viewer** declares neither yet
 * still reaches `WIDE_CARD_WIDTH` the moment it has a value to draw, because `showPreview` puts
 * `.coda-node--wide` on it. Missing that third source is what had the Table card, which declares
 * nothing at all and renders at 360, sitting 38px inside Group By. Measured in a browser.
 *
 * Reading the declarations rather than restating a pitch means a node that gets wider later moves
 * its neighbours along instead of growing into them.
 */
const SLOTS: ReadonlyMap<string, { x: number; y: number }> = (() => {
  const slots = new Map<string, { x: number; y: number }>()
  let x = 60
  for (const type of CHAIN) {
    slots.set(type, { x, y: 0 })
    const def = getNodeDef(type)
    const width = Math.max(
      def?.defaultSize?.width ?? 0,
      NODE_BODIES[type]?.width ?? 0,
      def && isViewer(def) ? WIDE_CARD_WIDTH : 0,
      FALLBACK_NODE_SIZE.width,
    )
    x += width + GAP
  }
  return slots
})()

function slot(type: string): { x: number; y: number } {
  return SLOTS.get(type) ?? { x: 60, y: 0 }
}

/**
 * What has been built so far, node type to node id. Reset by `prepare`.
 *
 * Keyed by **type**, which is the same key `CHAIN`, `SLOTS` and `advanceWhen` already use — an
 * earlier version carried a second set of short names (`'ds'`, `'find'`, `'conn'`) alongside,
 * and a mapping that is total and injective onto the types buys nothing but a second spelling
 * for every node that nothing checks against the first.
 *
 * Module state, reset by `prepare`. The alternative was threading a context object through every
 * `before`, which is an extra parameter on a signature shared with the tour that needs none of
 * them. A tour is a singleton — `startTour` refuses a second one while the first is up — so
 * there is no second reader for this to be shared with.
 */
const built = new Map<string, string>()

/**
 * Make sure this node is on the canvas, in its column, and remembered — however it got there.
 *
 * One function rather than an add and an adopt, because the caller cannot usefully tell the two
 * apart: on a "your turn" step the reader may have added the node from the browser, the palette
 * or a double-click, and on the same step reached by Next nobody has added it at all. All three
 * want the same thing to be true afterwards.
 *
 * A node the *reader* added is moved into line, and that is not tidiness for its own sake: it
 * lands wherever the browser puts a node, which is not the column of a chain being built around
 * it, and left alone it ended up overlapping two later cards — so the graph handed over at the
 * end, the whole payoff, read as a mess they had made. `commit: false`, so the nudge does not
 * become an undo step of its own between the add and the wiring.
 */
function ensure(type: string): string {
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
}

/**
 * Wires one port to another.
 *
 * Called unconditionally, including for links the store's own auto-wire has already made. That
 * is safe rather than sloppy: `addEdge` evicts whatever occupies the destination input before
 * inserting, so re-making a link that exists replaces it with itself rather than doubling it.
 */
function wire(from: string, fromPort: string, to: string, toPort: string): void {
  const source = built.get(from)
  const target = built.get(to)
  if (!source || !target) return
  useGraphStore
    .getState()
    .connect({ source, sourceHandle: fromPort, target, targetHandle: toPort })
}

/**
 * How close the camera gets to a card as it arrives.
 *
 * 1.0 rather than the Guided Tour's 1.2: this graph *grows*, and what somebody building a
 * pipeline needs to see is the new card **and the wire that arrived with it**, which means
 * keeping its upstream neighbour in frame. At 1.2 the neighbour is off the edge on a laptop.
 */
const BUILD_ZOOM = 1.0

/** Selects the built nodes a step is about and frames them. */
function reveal(...types: string[]): void {
  frameNodes(
    types.map((type) => built.get(type)).filter((id): id is string => Boolean(id)),
    BUILD_ZOOM,
  )
}

/** The id the tour's own spanning element carries, so there is only ever one of them. */
const SPAN_ID = 'coda-tour-span'

/**
 * An invisible element covering several cards at once, for a step that highlights more than one.
 *
 * driver spotlights exactly one element, and the step that says *"notice the wire"* is about two
 * cards and what runs between them — a cut-out around either one alone contradicts the sentence.
 *
 * **It is placed inside React Flow's viewport, in world coordinates, and that is the whole
 * trick.** The viewport carries the pan and zoom as a CSS transform, so a child positioned in
 * world units is moved by the browser along with the cards, and `getBoundingClientRect` — which
 * is all driver ever asks — returns the right screen rectangle at every zoom with nothing
 * recomputing it. Positioning it in screen pixels instead would need re-measuring on every frame
 * of the camera animation the step starts.
 *
 * The rectangle itself is `boundsOf`, which is the module that owns this arithmetic; the sizes
 * handed to it are read off the DOM exactly as `useArrange`'s `measure` reads them, because
 * `offsetWidth` is pre-transform (world units, the distinction the field guide's `offsetParent`
 * note records) while a `getBoundingClientRect` here would be screen pixels.
 *
 * `pointer-events: none`, so it cannot intercept anything even though driver will mark it the
 * active element; and removed by the step's `after`, since it is scaffolding rather than part of
 * the graph.
 */
function spanOf(...types: string[]): Element | null {
  const viewport = document.querySelector('.react-flow__viewport')
  if (!viewport) return null

  const nodes = []
  const measured = new Map<string, NodeSize>()
  for (const type of types) {
    const id = built.get(type)
    const node = id ? useGraphStore.getState().graph.nodes.find((n) => n.id === id) : undefined
    const card = id ? cardOf(id) : null
    /*
     * **All the cards, or none.** Skipping a card that has not been rendered yet looks like
     * tolerance and is the opposite: the step that adds a node resolves its anchor in the same
     * tick, so the new card is reliably absent — and returning a span around the *other* card
     * hands driver a perfectly good element, which ends its `waitForElement` poll on the spot.
     * The step then spotlights one card for a sentence about two, with nothing to recompute it,
     * because `refresh` re-reads the stored element rather than re-resolving the anchor.
     *
     * Answering `null` keeps the poll alive; driver watches the document for mutations, and the
     * card landing is one. Measured before this: the span came out `left: 60px; width: 248px`,
     * exactly the dataset card, with Find Neurons sitting 338px to its right.
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
}

/** Takes the spanning element back down. Paired with `spanOf` through a step's `after`. */
function clearSpan(): void {
  document.getElementById(SPAN_ID)?.remove()
}

/** The card for a built node, for a step that points at one. */
function builtCard(type: string): Element | null {
  return cardOf(built.get(type))
}

/** Applies this node's entry from {@link PARAMS}. */
function setParams(type: string): void {
  const id = built.get(type)
  if (!id) return
  for (const [param, value] of Object.entries(PARAMS[type] ?? {})) {
    useGraphStore.getState().setParam(id, param, value as never)
  }
}

/** Is there a node of this type on the canvas? The predicate the "your turn" steps wait on. */
function hasNode(type: string): boolean {
  return useGraphStore.getState().graph.nodes.some((node) => node.type === type)
}

/** Is anything waiting to be run? One definition, for the two steps and the one predicate. */
function isStale(): boolean {
  const store = useGraphStore.getState()
  return store.graph.nodes.some((node) => store.needsRun(node.id))
}

/** Catches up a reader who pressed Next instead of Run. Idempotent, like every other `before`. */
function runIfStale(): void {
  if (isStale()) void useGraphStore.getState().runAll()
}

/** The `advanceWhen` both Run steps share: the reader pressed it and it finished. */
function ranClean(): boolean {
  return !useGraphStore.getState().busy && !isStale()
}

export const LEARN_TO_BUILD: readonly TourStep[] = [
  {
    id: 'intro',
    title: "Let's build something",
    body:
      'This guide will teach you how to build a simple analysis pipeline in Coda. ' +
      'To keep things interesting, we are going to answer a real question: which cell ' +
      'types do LC neurons talk to?',
  },
  {
    id: 'blank',
    title: 'Starting from a blank canvas',
    body:
      'Our graph starts with a dataset — the node that defines where the data comes from ' +
      'Everything else hangs off it.',
    before: () => {
      const store = useGraphStore.getState()
      if (store.graph.nodes.length) store.setGraph(emptyGraph('Learn to Build'))
    },
    anchor: () => byTour('canvas'),
    side: 'top',
    align: 'center',
  },
  {
    id: 'dataset',
    title: 'The dataset node',
    body:
      'Optic Lobe (mini) is synthetic and generated right here in your browser, so this tour ' +
      'needs no token and no network. Swap it for Hemibrain, FlyWire or MANC later — every node ' +
      'downstream of it stays exactly the same.',
    before: () => {
      ensure(DATASET)
      reveal(DATASET)
    },
    anchor: () => builtCard(DATASET),
    side: 'right',
    align: 'start',
  },
  {
    id: 'open-browser',
    title: 'Your turn: open the node browser',
    body:
      'Press `+ Add` — or hit `Tab`. (If you would rather watch, Next does it for you.)',
    anchor: () => byTour('add'),
    side: 'bottom',
    align: 'end',
    interactive: true,
    advanceWhen: () => Boolean(document.querySelector('.node-browser')),
  },
  {
    id: 'pick-find',
    title: 'Your turn: add Find Neurons',
    body:
      'Type `find` and pick **Find Neurons**. It is the node that turns a search into a set of ' +
      'neurons — nearly every pipeline starts with one.',
    before: () => {
      if (!document.querySelector('.node-browser')) useGraphStore.getState().requestNodeBrowser()
    },
    anchor: () => document.querySelector('.node-browser'),
    side: 'left',
    align: 'center',
    interactive: true,
    advanceWhen: () => hasNode(FIND),
  },
  {
    id: 'auto-wire',
    title: 'It wired itself',
    body:
      'Notice the wire: a node with a Dataset socket gets fed automatically when there is ' +
      'exactly one dataset on the canvas — Coda does the obvious connection so you do not have ' +
      'to. Everything else you drag socket to socket.',
    before: () => {
      ensure(FIND)
      wire(DATASET, 'dataset', FIND, 'dataset')
      reveal(DATASET, FIND)
    },
    // Both cards and the wire between them, not one of the two — see `spanOf`.
    anchor: () => spanOf(DATASET, FIND),
    after: clearSpan,
    side: 'bottom',
    align: 'center',
  },
  {
    id: 'search',
    title: 'Define search criteria',
    body:
      'I have set two filters: `type` matching `LC.*`, and `status` = Traced. The pattern is a ' +
      'regex, anchored the way neuPrint anchors it — `LC.*` matches LC4 and LC6 but *not* ' +
      'LPLC1. What fields are available depends on the dataset.',
    before: () => {
      setParams(FIND)
      reveal(FIND)
    },
    anchor: () => builtCard(FIND),
    side: 'right',
    align: 'start',
  },
  {
    id: 'connectivity',
    title: 'Who do they talk to?',
    body:
      'Connectivity Graph takes those neurons and returns one row per connected pair, ' +
      'downstream by default. Look at its sockets: it takes *two* inputs, and both got wired.',
    before: () => {
      ensure(CONNECTIVITY)
      wire(DATASET, 'dataset', CONNECTIVITY, 'dataset')
      wire(FIND, 'neurons', CONNECTIVITY, 'neurons')
      setParams(CONNECTIVITY)
      reveal(CONNECTIVITY)
    },
    anchor: () => builtCard(CONNECTIVITY),
    side: 'right',
    align: 'start',
  },
  {
    id: 'run-first',
    title: 'Your turn: press Run',
    body:
      'Nothing has been fetched yet — a node holds a recipe until you ask. Press `Run` and ' +
      'watch the badges go green. (Only the two query nodes will run; the dataset node has ' +
      'nothing to fetch until somebody asks it something.)',
    anchor: () => byTour('run'),
    side: 'bottom',
    align: 'end',
    interactive: true,
    advanceWhen: ranClean,
  },
  {
    id: 'too-much',
    title: 'That is a lot of rows',
    body:
      'One row per neuron-to-neuron connection: thousands of them, which is more than anybody ' +
      'can read as a list. The rest of the graph turns it into an answer.',
    before: () => {
      runIfStale()
      reveal(CONNECTIVITY)
    },
    anchor: () => builtCard(CONNECTIVITY),
    side: 'right',
    align: 'start',
  },
  {
    id: 'table',
    title: 'Look at what came out',
    body:
      'A Table, so you can actually read the rows: one per connected pair, with the partner and ' +
      'the synapse count. Viewers pass their input straight through, so this one sits in the ' +
      'middle of the chain rather than ending it — which is how you check a step before the ' +
      'next one eats it.',
    before: () => {
      ensure(TABLE)
      wire(CONNECTIVITY, 'connections', TABLE, 'in')
      reveal(TABLE)
    },
    anchor: () => builtCard(TABLE),
    side: 'right',
    align: 'start',
  },
  {
    id: 'group',
    title: 'Sum by partner type',
    body:
      'Group By collapses every row onto its partner type and adds up the weight — so thousands ' +
      'of neuron-to-neuron rows become one row per cell type. That is the answer we came for. ' +
      'Small nodes rather than one big one, so each can be read, re-ordered and re-run on its ' +
      'own — and the Table is still there showing you what went in.',
    before: () => {
      ensure(GROUP)
      wire(TABLE, 'out', GROUP, 'in')
      setParams(GROUP)
      reveal(GROUP)
    },
    anchor: () => builtCard(GROUP),
    side: 'right',
    align: 'start',
  },
  {
    id: 'chart',
    title: 'Look at it',
    body:
      'A Bar Chart, plotting the summed weight against the partner type — the same numbers the ' +
      'Group By produced, in the shape you can read at a glance.',
    before: () => {
      ensure(CHART)
      wire(GROUP, 'out', CHART, 'in')
      setParams(CHART)
      reveal(CHART)
    },
    anchor: () => builtCard(CHART),
    side: 'left',
    align: 'start',
  },
  {
    /*
     * This was a second "your turn: press Run", and it could not work: by the time the reader
     * gets here the graph is already up to date, so the button is disabled and the step waits
     * for a press that can never land. Found by driving it — the tour sat on step 14 forever.
     *
     * The reason it is already up to date is the better lesson, so the step teaches that
     * instead. Filter, Group By and Bar Chart are all `cost: 'cheap'` and re-ran on the cheap
     * pass as they arrived; Find Neurons and Connectivity Graph are `expensive` and waited to
     * be asked. That split *is* Coda's execution model, and this is the one moment in the tour
     * where the reader has just watched it happen to them.
     */
    id: 'cheap',
    title: 'Notice what you did not have to do',
    body:
      'You never pressed Run for those last three, and the button has gone quiet — everything ' +
      'is already up to date. Table, Group By and Bar Chart are *cheap* nodes: pure table ' +
      'work, no server, so Coda re-runs them for you on every edit. Find Neurons and ' +
      'Connectivity Graph are *expensive* — they query a backend, so they wait until you ask.',
    anchor: () => byTour('run'),
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'done',
    title: 'That is a pipeline',
    body:
      'Double-click the chart to open it full size. From here: swap the dataset node for a real ' +
      'one, press Share to send the graph to somebody, or Save ▸ Notebook to get the same ' +
      'analysis as Python. The Node Guide in the `?` menu documents every node there is.',
    before: () => {
      runIfStale()
      useGraphStore.getState().setSelection([])
      useGraphStore.getState().requestFitView()
    },
    anchor: () => byTour('canvas'),
    side: 'top',
    align: 'center',
  },
]

export const BUILD_SPEC: TourSpec = {
  steps: LEARN_TO_BUILD,
  /**
   * Clears what the previous run of this tour remembered, and warns if there is work to lose.
   *
   * The canvas is *not* emptied here — that happens on the second step, so Escape on the first
   * one leaves the graph exactly as it was found. The warning has to be raised here anyway,
   * because by the time the reader is reading it the emptying is one Next away.
   */
  prepare: () => {
    built.clear()
    clearSpan()

    const store = useGraphStore.getState()
    const notes: string[] = []
    if (store.graph.nodes.length) {
      notes.push(
        'Heads up: this needs a blank canvas, so the graph you have open will be replaced ' +
          'when you press Next. ⌘Z brings it back, but if it matters, press Escape and save ' +
          'it first.',
      )
    }
    /*
     * Auto-run has to come off, and the reader has to be told.
     *
     * With it on nothing is ever stale, so the Run button is permanently `disabled` — and two
     * steps of this tour are about pressing it. Switching it off silently would be the same
     * mistake as leaving the inspector open at the end: it is a preference somebody set, and
     * `restore` in `tour.ts` puts it back. Saying so costs one sentence and is the difference
     * between a tour that borrows a setting and one that changes it behind your back.
     */
    if (store.autoRun) {
      store.setAutoRun(false)
      notes.push(
        'I have also switched Auto-run off, so that Run has something to do when we get to it ' +
          '— it goes back on at the end.',
      )
    }
    return notes.length ? ` ${notes.join(' ')}` : ''
  },
  restoreSelection: false,
}
