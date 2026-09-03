/**
 * What the Guided Tour points at, and what it says.
 *
 * The split between this file and `tour.ts` is deliberate: this one is **data**, imports no
 * tour library and can be read by a test, while `tour.ts` owns the lifecycle and is the only
 * thing that loads driver.js. That is what makes the one failure worth catching catchable —
 * see below.
 *
 * ## Anchors are `data-tour`, never a class or an `aria-label`
 *
 * Three ways to find a toolbar button were available and two of them rot silently. A class name
 * (`.btn--primary`) is a styling decision that may be applied to a second button next week, and
 * `document.querySelector` takes the first — so the spotlight moves to a control the copy is not
 * about, with nothing failing. An `aria-label` is *copy*, and reworded on the ordinary grounds
 * that copy is reworded; the tour then highlights nothing.
 *
 * `data-tour` is neither. It exists for exactly one reader, it is greppable from the element to
 * this file and back, and `tour.test.tsx` asserts every one of them resolves against a rendered
 * `App`. That test is the point of the whole arrangement: a static tour is not a route, so
 * nothing else in the app fails when a button it names goes away — the same standing the
 * overview page's claims have, and that page had **already drifted before it shipped**.
 *
 * Node cards are the exception, and do not carry one: React Flow already renders
 * `.react-flow__node[data-id="<id>"]`, and which card the tour means is a question about the
 * *graph* rather than about the markup — see `cardOfCategory`.
 *
 * ## The copy
 *
 * One or two sentences a step, naming the keyboard shortcut where there is one, and saying the
 * non-obvious thing rather than the visible one. "Run brings stale nodes up to date" is on the
 * button's own tooltip; "nothing fetches until you ask" is not, and is the thing somebody
 * arriving from a spreadsheet needs told.
 */

import type { Alignment, Side } from 'driver.js'

import { getNodeDef } from '../../core/registry'
import type { NodeSize } from '../../layout/elkGraph'
import { boundsOf } from '../../layout/place'
import { useGraphStore } from '../../store/graphStore'
import { requestFitSelected } from '../fitView'

/**
 * Every `data-tour` value the app carries. A union rather than a bare string so a step naming
 * an anchor nobody publishes is a type error, not a silent no-op at runtime.
 */
export const TOUR_ANCHORS = [
  'canvas',
  'add',
  'run',
  'autorun',
  'inspector',
  'inspector-panel',
  'connections-panel',
  'dashboard',
  'connections',
  'assistant',
  'share',
  'help',
] as const

export type TourAnchor = (typeof TOUR_ANCHORS)[number]

/** One stop. `anchor` returning nothing means the popover is centred with no spotlight. */
export interface TourStep {
  /** Stable, for the test's failure message and for a future "resume where I left off". */
  id: string
  title: string
  /** Plain text. Rendered into driver's description node as text, never as markup. */
  body: string
  /**
   * The element to spotlight, resolved when the step is reached rather than when the tour is
   * built — a panel the previous step opened does not exist until it does.
   */
  anchor?: () => Element | null | undefined
  side?: Side
  align?: Alignment
  /**
   * Runs before the step is shown: opens a panel, moves the camera, adds a node.
   *
   * **Must be idempotent, and on a "your turn" step's successor that is load-bearing.** An
   * interactive step can always be skipped with Next, so the step after it does the thing the
   * reader was invited to do if they did not — which means it runs having-already-happened just
   * as often as not.
   */
  before?: () => void
  /**
   * Runs when the step stops showing, in either direction. The teardown half of `before`.
   *
   * Most steps need none: what `before` does — adding a node, opening a panel, moving the camera
   * — is meant to persist, because the reader is building something. This is for scaffolding the
   * tour puts up for one step only, which today means the invisible element a multi-card
   * highlight spans.
   */
  after?: () => void
  /**
   * Leave the highlighted element live, for a step that asks the reader to press something.
   *
   * Off by default: a tour that explains has no business firing the Run it is pointing at. See
   * `disableActiveInteraction` in `tour.ts`, and `pinDriverClasses` for what has to happen for
   * this to work on an element React re-renders.
   */
  interactive?: boolean
  /**
   * Whether this step is part of the tour at all, asked **once, when the tour starts**.
   *
   * For a stop that answers a condition rather than teaching something: "Build a Dashboard" asks
   * for a neuPrint token, and a reader who already has one should not be shown a form they have
   * already filled in. Evaluated once rather than per step so the step list `go` indexes into
   * cannot change under it mid-tour, and so a reader who saves a token *during* the step does not
   * have it vanish from under them — `advanceWhen` is the mechanism for that, and it moves on
   * rather than rewriting the tour.
   *
   * Not a way to skip a step whose anchor is missing. `tour.ts`'s note is explicit that a stop
   * which quietly vanished leaves the copy referring to something the reader never saw; this is
   * for a step that would be *wrong* to show, not one that is merely awkward.
   */
  when?: () => boolean
  /**
   * Move on by itself once this holds — the reader did the thing.
   *
   * Polled while the step is showing, and only ever fires on a **false-to-true transition**: a
   * predicate already true when the step opens means the reader has done it before (their graph
   * already had a Find Neurons in it) and the step just waits for Next, rather than flashing
   * past before it has been read.
   *
   * Deliberately a DOM or store *predicate* rather than a hook on the action, so it does not
   * care how the reader got there — the node browser, the command palette and a double-click on
   * empty canvas all add a node, and a tour that only accepted one of them would be teaching
   * the tour rather than the app.
   */
  advanceWhen?: () => boolean
}

/**
 * One tour, as `tour.ts` runs it.
 *
 * Two exist. What differs between them is not the steps — that is the point of `TourStep` — but
 * what they are allowed to do to the graph, which is the difference between a tour that explains
 * and a tour that builds.
 */
export interface TourSpec {
  steps: readonly TourStep[]
  /**
   * Gets the canvas ready, and returns a sentence appended to the first step's body.
   *
   * The return value is how a tour owns up to what it just did in the paragraph the reader is
   * about to read — an example loaded onto an empty canvas, or a graph replaced.
   */
  prepare?: () => string
  /**
   * Put the selection back at the end.
   *
   * True for a tour that only pointed at things. False for one that built a graph: the cards it
   * made are the result, and restoring a selection from before the canvas was emptied would
   * select nodes that no longer exist.
   */
  restoreSelection: boolean
}

/** The element carrying a `data-tour` name, or null. */
export function byTour(anchor: TourAnchor): Element | null {
  return document.querySelector(`[data-tour="${anchor}"]`)
}

/**
 * The card React Flow drew for a graph node — **our** card inside React Flow's wrapper.
 *
 * Matched by walking `data-id` rather than by putting the id in a selector: node ids are
 * `newId()`'s `n1_ab3cd` in a fresh graph but the *example* graphs name theirs by hand (`ds`,
 * `find`, `conn`), and a selector built from an id nobody constrains is one shipped example
 * away from needing `CSS.escape` and not having it.
 *
 * It then descends to our own card, which is the thing the step is about — React Flow's wrapper
 * is the library's business, and it is the element handles are portalled into.
 *
 * ## What descending does *not* fix, which is worth knowing before "Learn to Build"
 *
 * **driver's classes do not survive on a card, at either level.** driver adds
 * `driver-active-element` — the class its stylesheet re-enables pointer events on, everything
 * else being `pointer-events: none` while a tour is up — and `driver-no-interaction`. React
 * rewrites the whole `class` attribute whenever the string it computed changes, and both the
 * wrapper (`react-flow__node … selected selectable draggable`) and `.coda-node` build theirs
 * from a template that varies with selection and size. So driver's two are wiped, measured in a
 * browser as gone within 50 ms of the step opening. `.coda-node__ports` and `.coda-node__header`
 * *do* keep them, because their `className` is a constant string and React never touches the
 * attribute.
 *
 * The spotlight is unaffected — driver holds the element by reference and reads its rect, so the
 * cut-out is in the right place either way, which is exactly why this is invisible until it
 * matters. What breaks is **interaction**: a step that asks somebody to click the card they can
 * see highlighted would find the click swallowed. The Guided Tour never asks, and sets
 * `disableActiveInteraction` globally besides. A tour that builds a graph will have to grant that
 * one card pointer events from a rule of our own rather than relying on driver's class.
 *
 * The general rule, for any anchor added later: **only an element whose `className` is a literal
 * keeps what driver puts on it.**
 */
export function cardOf(nodeId: string | undefined): Element | null {
  if (!nodeId) return null
  for (const el of document.querySelectorAll('.react-flow__node')) {
    if (el.getAttribute('data-id') !== nodeId) continue
    return el.querySelector('.coda-node, .coda-note') ?? el
  }
  return null
}

/**
 * A node of this category if the graph has one, else the first node.
 *
 * The tour runs over whatever is on the canvas — the user's own work, if they have any — so it
 * cannot name a node. What it can do is ask for the *kind* it is about to talk about and fall
 * back rather than skip: the copy for "every card is one step" is true of any card, and a step
 * that vanished on a graph with no dataset node in it would leave the tour explaining sockets
 * before it had shown a card.
 */
function nodeIdOfCategory(category: string): string | undefined {
  const { nodes } = useGraphStore.getState().graph
  const match = nodes.find((node) => getNodeDef(node.type)?.category === category)
  return (match ?? nodes[0])?.id
}

/**
 * How close the three card steps get.
 *
 * Deliberately far below the shared `maxZoom` of 3, which frames one card at four times the size
 * it is ever drawn at on the canvas — see `FitSelectedOptions.maxZoom`. At 1.2 the card is the
 * subject and its neighbours and wires are still in frame, which is what "each card is one step"
 * needs in the picture to be a statement about a pipeline rather than about a rectangle.
 */
export const CARD_ZOOM = 1.2

/**
 * Select these nodes and bring the camera to them — how every "and here it is" step ends, in
 * both tours.
 *
 * Shared rather than written twice because it is the only place either tour touches the camera:
 * how a tour frames a card is one decision, and it should not be possible to change it in the
 * Guided Tour and not in "Learn to Build".
 */
export function frameNodes(ids: readonly string[], maxZoom: number): void {
  if (!ids.length) return
  useGraphStore.getState().setSelection([...ids])
  requestFitSelected({ maxZoom })
}

/** The id the tour's own spanning element carries, so there is only ever one of them. */
const SPAN_ID = 'coda-tour-span'

/**
 * An invisible element covering several cards at once, for a step that highlights more than one.
 *
 * driver spotlights exactly one element, and a step that says *"notice the wire"* is about two
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
 *
 * **All the cards, or none.** Skipping one that has not been rendered yet looks like tolerance
 * and is the opposite: the step that adds a node resolves its anchor in the same tick, so the new
 * card is reliably absent — and returning a span around the *other* card hands driver a perfectly
 * good element, which ends its `waitForElement` poll on the spot. The step then spotlights one
 * card for a sentence about two, with nothing to recompute it, because `refresh` re-reads the
 * stored element rather than re-resolving the anchor. Answering `null` keeps the poll alive;
 * driver watches the document for mutations, and the card landing is one. Measured before this:
 * the span came out `left: 60px; width: 248px`, exactly the dataset card, with Find Neurons
 * sitting 338px to its right.
 *
 * Here rather than in `builder.ts` because both kinds of tour want it: a tour that *builds* spans
 * the two cards it just wired, and the Guided Tour spans two it found. `Builder.span` is the
 * same call with the ids looked up by node type.
 */
export function spanCards(ids: readonly string[]): Element | null {
  const viewport = document.querySelector('.react-flow__viewport')
  if (!viewport || !ids.length) return null

  const nodes = []
  const measured = new Map<string, NodeSize>()
  for (const id of ids) {
    const node = useGraphStore.getState().graph.nodes.find((n) => n.id === id)
    const card = cardOf(id)
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

/** Takes the spanning element back down. Paired with `spanCards` through a step's `after`. */
export function clearSpan(): void {
  document.getElementById(SPAN_ID)?.remove()
}

/** Selects the card the next few steps are about, and frames it. */
function focusCard(): void {
  const id = nodeIdOfCategory('dataset')
  frameNodes(id ? [id] : [], CARD_ZOOM)
}

function focusedCard(): Element | null {
  return cardOf(useGraphStore.getState().selection[0])
}

/**
 * The wire the tour talks about: one leaving the card just shown, else any wire in the graph.
 *
 * Chosen the same way `nodeIdOfCategory` chooses a card, and for the same reason — the Guided
 * Tour runs over whatever is on the canvas, which may be the reader's own work, so it can name a
 * *kind* of thing and not a particular one. Leaving the card the last two steps were about is
 * the continuity worth having: the sentence is "this is how what you just looked at gets
 * somewhere else".
 *
 * Deterministic across the two calls a step makes (`before` frames it, `anchor` spans it) even
 * though the first changes the selection: `frameNodes` selects source *and* target with the
 * source first, so the second call finds the same edge.
 */
function tourEdge(): { source: string; target: string } | undefined {
  const { graph, selection } = useGraphStore.getState()
  const focused = selection[0]
  return graph.edges.find((edge) => edge.source === focused) ?? graph.edges[0]
}

/** Frames both ends of that wire, so the step is a picture of a connection rather than a card. */
function focusWire(): void {
  const edge = tourEdge()
  if (edge) frameNodes([edge.source, edge.target], CARD_ZOOM)
}

/**
 * Both cards and the run between them.
 *
 * `null` when the graph has no wires at all, which a reader's own canvas may not: driver then
 * centres the popover with no spotlight, and the copy is written to still be true — it is about
 * what a wire *is*, not about that one.
 */
function wireSpan(): Element | null {
  const edge = tourEdge()
  return edge ? spanCards([edge.source, edge.target]) : null
}

/**
 * The Guided Tour: where things are, and what to press.
 *
 * Scope is deliberately the *chrome* and one card's anatomy. It builds nothing and changes no
 * parameter — that is "Learn to Build", and two tours teaching the same lesson is how they drift
 * apart. The same division the Field Guide and the Node Guide already make.
 */
export const GUIDED_TOUR: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'A tour of the editor',
    body:
      'Hey there! Welcome to the Guided Tour! A few notes before we get going: this does not ' +
      'change your graph, and any panel it opens it closes again at the end. Arrow keys move ' +
      'between steps; Escape leaves at any point.',
  },
  {
    id: 'canvas',
    title: 'The canvas is the document',
    body:
      'A Coda pipeline is a graph consisting of nodes: data flows along the wires, left to right. Drag ' +
      'empty space to pan, scroll to zoom, click a node to select it, click + drag a port to make a new ' +
      'connection.',
    anchor: () => byTour('canvas'),
    side: 'top',
    align: 'center',
  },
  {
    id: 'card',
    title: 'This is a node',
    body:
      'Workflows are built by adding nodes to the canvas and wire them together. Each node has ' +
      'a specific purpose and a specific type. This here is one of the most important node types in ' +
      'in Coda: a <b>dataset node</b> - it determines where the data comes from.',
    before: focusCard,
    anchor: focusedCard,
    side: 'right',
    align: 'start',
  },
  {
    id: 'ports',
    title: 'Nodes have ports for in- and output',
    body:
      'Inputs on the left, outputs on the right. Colour + shape say what a socket carries, ' +
      'and the label spells it out. Only matching types will connect!',
    anchor: () => focusedCard()?.querySelector('.coda-node__ports'),
    side: 'right',
    align: 'center',
  },
  {
    /*
     * Straight after the sockets, because a socket is only half of the idea: the ports step says
     * what a node *accepts*, and this says what happens when two of them agree. It is also the
     * first step that frames two cards rather than one, which is the picture of a pipeline the
     * tour has been building up to.
     */
    id: 'wire',
    title: 'A wire is one node feeding the next',
    body:
      'Drag from an output to a matching input to make one. Data flows along it when you Run, ' +
      'and one output can feed as many inputs as you like. Two things worth knowing: drag a ' +
      'wire’s end away to re-route it, and drop a fresh, unconnected node onto a wire to splice ' +
      'it into the middle.',
    before: focusWire,
    anchor: wireSpan,
    after: clearSpan,
    side: 'bottom',
    align: 'center',
  },
  {
    id: 'add',
    title: 'Adding new nodes is easy',
    body:
      'Press this button and the six node categories fan out above it — pick one and its nodes ' +
      'appear along the bottom. The bottom button, or `Tab`, opens the full browser instead. ' +
      'Alternatively, hit Space to open the command palette, which works for both nodes and ' +
      'commands.',
    anchor: () => byTour('add'),
    // `top`, not `bottom`: the button is in the canvas's bottom-right corner, so a popover
    // below it is a popover off the bottom of the window.
    side: 'top',
    align: 'end',
  },
  {
    id: 'run',
    title: 'Press `Run` to execute the pipeline',
    body:
      'Adding or editing a node will mark it and everything downstream of it as stale. ' +
      'Pressing `Run` (or ⇧R) brings every *stale* node up to date - this badge counts how many are waiting. ',
    anchor: () => byTour('run'),
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'autorun',
    title: 'Auto-run for convenience',
    body:
      'It is on by default, so the graph re-runs as you edit it. Untick it if your graph has ' +
      'expensive nodes in it (e.g. NBLAST) that you would rather run on demand.',
    anchor: () => byTour('autorun'),
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'inspector',
    title: 'The Inspector show additional information and settings',
    body:
      "A node's card shows the most important settings. The inspector shows everything. " +
      'Press I to open/close the sidebar.',
    before: () => {
      if (!useGraphStore.getState().panels.inspector)
        useGraphStore.getState().togglePanel('inspector')
    },
    anchor: () => byTour('inspector-panel') ?? byTour('inspector'),
    side: 'left',
    align: 'start',
  },
  {
    id: 'dashboard',
    title: 'Use Dashboard once the workflow is built',
    body:
      'The Dashboard lets you select the important nodes (viewers, filter, etc) from the canvas ' +
      'and arrange them on a grid. It removes the wires and the "supporting" nodes. ',
    anchor: () => byTour('dashboard'),
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'connections',
    title: 'Connections is where to put your credentials',
    body:
      'Server addresses, API tokens, uploaded files and annotation tables all live behind the ' +
      'branch icon. A dataset node that says it cannot reach anything is almost always lacking ' +
      'credentials.',
    anchor: () => byTour('connections'),
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'assistant',
    title: 'Need help? Use the AI assistant to build/edit workflows.',
    body:
      'Describe the change you want and it proposes nodes and wires. Requires an OpenAI, Anthropic, ' +
      "Gemini API key or a local LLM to work. See the 'Connections' panel for details.",
    anchor: () => byTour('assistant'),
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'share',
    title: 'Create links to share your workflows',
    body:
      'Just like you can share Neuroglancer scenes with links, Coda lets you share workflows with the press of a button. ' +
      'Links contain only the pipeline, never your credentials.',
    anchor: () => byTour('share'),
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'guides',
    title: 'More help',
    body:
      'Under Documentation: the Field Guide explains the concepts this tour has been pointing ' +
      'at, and the Node Guide is the reference for every node, its sockets and its settings. ' +
      'Both open in a new tab. This tour is under Guides, whenever you want it again.',
    anchor: () => byTour('help'),
    side: 'bottom',
    align: 'start',
  },
]

/**
 * The Guided Tour as a spec — see `TourSpec`.
 *
 * `prepare` opens an example onto an empty canvas, because a tour of the chrome that has no
 * cards to point at would spend a third of its stops explaining controls with nothing to act on.
 * It is *only* ever done to an empty canvas, and the first step says so.
 */
export const GUIDED_SPEC: TourSpec = {
  steps: GUIDED_TOUR,
  restoreSelection: true,
}
