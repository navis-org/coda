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

/** Selects the card the next few steps are about, and frames it. */
function focusCard(): void {
  const id = nodeIdOfCategory('dataset')
  frameNodes(id ? [id] : [], CARD_ZOOM)
}

function focusedCard(): Element | null {
  return cardOf(useGraphStore.getState().selection[0])
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
    title: 'Each card is one step',
    body:
      'The header names the node and carries the colour of its category — green for a dataset, ' +
      'blue for a query, purple for analysis, orange for a viewer. Double-click the name to ' +
      'rename it; the type underneath never changes.',
    before: focusCard,
    anchor: focusedCard,
    side: 'right',
    align: 'start',
  },
  {
    id: 'ports',
    title: 'Sockets are typed',
    body:
      'Inputs on the left, outputs on the right. Colour + shape say what a socket carries, ' +
      'and the label spells it out. Only matching types will connect!',
    anchor: () => focusedCard()?.querySelector('.coda-node__ports'),
    side: 'right',
    align: 'center',
  },
  {
    id: 'state',
    title: 'A card reports its current status',
    body:
      'The badge in the header reads up to date, stale, running or failed, and a ring traces ' +
      'the card while it runs. The ▶ beside it runs this one node and everything upstream of it, ' +
      'without touching the rest of the graph.',
    anchor: () => focusedCard()?.querySelector('.coda-node__header'),
    side: 'right',
    align: 'start',
  },
  {
    id: 'add',
    title: 'Four ways to add new nodes',
    body:
      'Press this button or hit `Tab` to open the node browser. Alernatively, hit Space ' +
      'to open the command palette, which works for both nodes and commands. Last but not least: ' +
      'double-clicking the empty canvas brings up a node search menu.',
    anchor: () => byTour('add'),
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'run',
    title: 'Nothing executes until you ask',
    body:
      'Pressing `Run` brings every *stale* node up to date - the badge counts how many are waiting. ' +
      'Results are cached against what produced them, so re-running after an edit re-fetches ' +
      'only what the edit actually invalidated. ⇧R does the same.',
    anchor: () => byTour('run'),
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'autorun',
    title: 'Auto-run, and when not to',
    body:
      'Tick it and the graph re-runs as you edit it. Leave it off if your graph has expensive nodes ' +
      'in it (e.g. NBLAST).',
    anchor: () => byTour('autorun'),
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'inspector',
    title: 'The Inspector show additional information and settings',
    body:
      'A card shows the most important settings. The inspector shows everything. ' +
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
    title: 'The Dashboard is the graph without the canvas',
    body:
      'Press D — or this button — and the wires give way to a grid of only the nodes worth ' +
      'watching. Each cell is a reference to a node rather than a copy, so Run updates them all ' +
      'at once, and the layout is saved with the workflow. Build a pipeline here, hand somebody ' +
      'a dashboard.',
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
    title: 'Need help? Use the assistant to build/edit workflows.',
    body:
      'Describe the change you want and it proposes nodes and wires. The assistant requires an ' +
      "OpenAI, Anthropic, Gemini API key or a local LLM to work. See the 'Connections' panel for details.",
    anchor: () => byTour('assistant'),
    side: 'bottom',
    align: 'end',
  },
  {
    id: 'share',
    title: 'Create links to share your workflows',
    body:
      'Links only contain the pipeline, never your credentials. Whoever opens them must also have access ' +
      "to the datasets. Short links require a Github account - see the 'Connections' panel for details.",
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
