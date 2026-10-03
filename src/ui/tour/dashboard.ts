/**
 * "Build a dashboard" — the third tour, and the one that ends somewhere other than the canvas.
 *
 * "Learn to Build" makes a pipeline: a chain, left to right, each node feeding the next. This
 * makes a **fan** — one Explore Dataset whose selection feeds two peers — and then arranges the
 * three on the grid. The pipeline tour is about how data moves; this one is about what you do
 * with the result once it does, which is the question somebody asks *after* they have built
 * something and want to hand it to a colleague.
 *
 * The graph it ends on is three nodes and two wires. That is the point: a dashboard is worth
 * building for a small graph, and a tour whose payoff needed twelve cards would be teaching the
 * pipeline again.
 *
 * ## It runs on a real dataset, and that is a departure worth arguing with
 *
 * "Learn to Build" runs on `dataset.mock.opticlobe`, and its module note gives the reason at
 * length: the public neuPrint deployment wants a token, so a newcomer hits a credentials wall
 * mid-build with no idea whether they did something wrong. Every word of that still holds.
 *
 * This tour takes the opposite decision **because one of its three cells is Neuroglancer**, and
 * Neuroglancer is the one viewer with nothing to draw from synthetic data: the mock sources
 * publish no segmentation layer, so a cell pointed at one is an empty black rectangle. A tour
 * whose whole subject is *what a dashboard looks like* cannot spend a third of its grid on a
 * blank. So it uses **MaleCNS on neuPrint**, which does publish one.
 *
 * The credentials wall is answered rather than ignored, in two places that work together and
 * before anything has been built. `prepare` checks for a token and, if there is none, says so in
 * the **first step's own body** — while Escape still leaves the canvas untouched. Then
 * `TOKEN_STEP` puts the Connections form itself in front of the reader, spotlit and live, and
 * advances by itself when they save. The tour still runs without one: every node, wire and cell
 * is made, and the layout is the thing being taught, so the cells are simply empty.
 *
 * **The token step exists because the warning alone was not enough**, and the way it failed is
 * worth keeping. A neuPrint dataset node peeks at the deployment the moment it is created
 * (`peekDatasets`, the once-per-instance fetch `CLAUDE.md` records), so step 3 draws a 401 out of
 * the server whatever the tour does — and the app answered a 401 by opening Connections over
 * everything. Under a tour that dialog is inert: driver makes every element but the spotlit one
 * `pointer-events: none`, so it could be neither typed into nor closed, and the tour was stuck
 * behind a form the reader had not asked for. Announcing it, which is what the copy used to do,
 * described the wedge rather than avoiding it. Both halves are now fixed: `SourcesPanel` sends an
 * auth failure to the status bar instead while a tour is running, and this tour asks for the
 * credential itself, up front, where saving one costs nothing.
 *
 * What the tour *can* still avoid is causing a **second** 401, which `runIfPossible` does.
 *
 * ## What it hands over
 *
 * Explore top left, its selection as a table below it, the same neurons in Neuroglancer down the
 * right at full height. Two columns, and the arrangement is written by the tour rather than left
 * to the reader, because a dashboard is judged as a *composition* — three cells in a row would
 * demonstrate the feature and not the point.
 */

import { activeTab } from '../../core/dashboard'
import { emptyGraph } from '../../core/graph'
import { getToken } from '../../data/neuprint/credentials'
import { useGraphStore } from '../../store/graphStore'
import { fan, makeBuilder, ranClean, runIfStale } from './builder'
import type { TourSpec, TourStep } from './steps'
import { byTour } from './anchors'

const DATASET = 'dataset.malecns'
const EXPLORE = 'neuron.explore'
const TABLE = 'out.table'
const SCENE = 'out.neuroglancer'

/**
 * The graph, in the order it gets built.
 *
 * Not a chain: the last two are peers hanging off Explore, so `fan` stacks them in one column
 * rather than drawing them in series — see the layout below.
 */
const CHAIN = [DATASET, EXPLORE, TABLE, SCENE] as const

/**
 * The parameters the tour sets.
 *
 * `version` is pinned rather than left to the listing, so the tour builds the same graph whether
 * or not neuPrint answered — an unpinned dataset node with no connection resolves to nothing and
 * every node downstream of it loses its schema, which is a lot of grey cards for a reader who was
 * told the tour would work without a token.
 *
 * The query is a cell type rather than a wildcard, because Explore searches locally and the
 * reader is about to tick three rows out of the result: `LC` on MaleCNS is a few dozen neurons,
 * which is a list you can see the shape of, and `*` is 160,000.
 */
const PARAMS: Record<string, Record<string, unknown>> = {
  [DATASET]: { version: 'v1.0' },
  [EXPLORE]: { query: 'LC' },
}

/**
 * One row for the dataset and Explore, then a column for the two viewers.
 *
 * 260 is a little more than a collapsed viewer card's height, so the two peers stand clear of
 * each other without the camera having to pull back far enough to make the text unreadable.
 */
const b = makeBuilder(CHAIN, PARAMS, { zoom: 0.9, layout: fan(260) })

/** How the three cells are laid out, and the one place the arrangement is written down. */
const COLUMNS = 2
/** Explore and the table are half the height each; the scene runs the whole way down. */
const HALF = 3
const FULL = 6

/** Everything the dashboard is built from, in the order the cells flow. */
const CELLS = [EXPLORE, SCENE, TABLE] as const

/**
 * Put the three nodes on the dashboard, in the order that produces the composition.
 *
 * Order *is* position — cells flow across the columns in list order — so `[Explore, Scene, Table]`
 * with the scene six rows tall is what puts Explore top left, the scene down the whole right, and
 * the table underneath Explore. Writing it as `[Explore, Table, Scene]` would read better and lay
 * out wrong: the table would take the top-right cell.
 *
 * Idempotent like every other `before`: `addToDashboard` skips a node already placed and
 * `setDashboardSpan` returns the graph unchanged when the span is what it already was.
 */
function arrange(): void {
  const store = useGraphStore.getState()
  const ids = CELLS.map((type) => b.idOf(type)).filter((id): id is string => Boolean(id))
  store.addToDashboard(ids)
  store.setDashboardColumns(COLUMNS)
  const scene = b.idOf(SCENE)
  const explore = b.idOf(EXPLORE)
  const table = b.idOf(TABLE)
  if (scene) store.setDashboardSpan(scene, { h: FULL })
  if (explore) store.setDashboardSpan(explore, { h: HALF })
  if (table) store.setDashboardSpan(table, { h: HALF })
}

/** How many of the three are on the dashboard. The predicate the "your turn" step waits on. */
function celled(): number {
  const { cells } = activeTab(useGraphStore.getState().graph)
  const ids = new Set(CELLS.map((type) => b.idOf(type)))
  return cells.filter((c) => ids.has(c.nodeId)).length
}

/**
 * Catch a reader up who pressed Next instead of Run — but only if the run can succeed.
 *
 * Without a token neuPrint answers 401, and a tour that fires one it knows will fail spends the
 * reader's next four steps on a failure it chose to cause. It is now a red node and a line in the
 * status bar rather than a modal — `SourcesPanel` holds the dialog back while a tour is up — but
 * the run is still pointless, and the payoff steps read better without a failed node in the
 * corner of them.
 *
 * So the tour never runs a graph it knows will fail. If the *reader* presses Run on the step
 * before, they get the failure and the explanation, which is the right outcome for a deliberate
 * act — and this step's `before` then has nothing left to catch up.
 */
function runIfPossible(): void {
  if (getToken()) runIfStale()
}

/** How many neurons the reader has ticked in Explore. */
function picked(): number {
  const id = b.idOf(EXPLORE)
  const node = id ? useGraphStore.getState().graph.nodes.find((n) => n.id === id) : undefined
  const selection = node?.params['selection']
  return Array.isArray(selection) ? selection.length : 0
}

/** A cell on the grid, for a step that points at one. */
function cell(type: string): Element | null {
  const id = b.idOf(type)
  return id ? document.querySelector(`.dash-cell[data-node="${id}"]`) : null
}

/**
 * Ask for the token before anything is built, and only when there is none.
 *
 * The reason it has to be a step rather than a sentence in the intro: step 3 adds a MaleCNS node,
 * which peeks at the deployment on creation and draws a 401 — and the app's answer to a 401 is to
 * open Connections over everything. Under a tour that dialog is `pointer-events: none` like the
 * rest of the page, so it could be neither filled in nor dismissed and the tour was stuck behind
 * a form. `SourcesPanel` no longer opens itself while a tour is running, which closes the wedge;
 * this closes the hole it was covering, which is that the tour wanted a credential and had no way
 * to ask for one.
 *
 * Four properties, each load-bearing:
 *
 *  - **`when`**, so a reader who already has a token never sees it. Asked once, when the tour
 *    starts — the token cannot arrive before that except through this step.
 *  - **`interactive`**, or the form under the spotlight is inert for the same reason the
 *    unannounced dialog was. `markElement` is what grants it back.
 *  - **`advanceWhen`**, so Save moves the tour on by itself. Saving also closes the panel, so
 *    without this the reader is left looking at a step pointing at nothing.
 *  - **`after` closing the panel**, which is what makes Next a real way past this step. A reader
 *    with no token has to be able to carry on — the tour still builds every node, wire and cell,
 *    and the copy has always said the cells stay empty — and a panel left open would then be the
 *    wedge again, this time put there by the tour.
 *
 * **The anchor is the panel and nothing else**, which is the trap `spanCards` already records in
 * the other direction. `before` opens it through the store, but React has not committed by the
 * time driver resolves the element, so the first resolve finds nothing — and an anchor that fell
 * back to the toolbar's Connections *button* handed driver a perfectly good element, which ends
 * its `waitForElement` poll on the spot. The step then spotlit a 28px icon behind the dialog,
 * `markElement` granted pointer events to *that*, and the form stayed inert: the exact bug this
 * step exists to fix, reproduced by the fix. Returning null keeps the poll alive until the panel
 * lands. Seen in a browser — the computed `pointer-events` on the token field said `none`.
 */
const TOKEN_STEP: TourStep = {
  id: 'token',
  title: 'This one needs a neuPrint sign-in',
  body:
    'MaleCNS is hosted on Janelia’s neuPrint server, and this browser has no token for it yet. ' +
    'Press Sign in with Google, or paste a token from neuprint.janelia.org/account and press ' +
    'Save, and the tour continues by itself. You can also press Next without a token: every ' +
    'step still works, but the three cells will stay empty.',
  when: () => !getToken(),
  // Asked for by name, so the tab shows even with neuPrint switched off — this step comes before
  // the tour has built anything that would keep it offered.
  before: () => useGraphStore.getState().openSources('neuprint'),
  after: () => useGraphStore.getState().closeSources(),
  anchor: () => byTour('connections-panel'),
  interactive: true,
  advanceWhen: () => Boolean(getToken()),
  side: 'left',
  align: 'start',
}

export const BUILD_A_DASHBOARD: readonly TourStep[] = [
  {
    id: 'intro',
    title: "Let's build a dashboard",
    body:
      'Once you have built your pipeline, you may realize that only a small set of nodes are actually interesting - ' +
      'the rest is just supporting infrastructure. This is when you want to create a dashboard for your workflow!',
  },
  TOKEN_STEP,
  {
    id: 'blank',
    title: 'Starting from a blank canvas',
    body:
      'The graph for this tour has just four nodes, three of which will end up on the ' +
      'dashboard. Dashboards are useful for small pipelines too.',
    before: () => {
      const store = useGraphStore.getState()
      if (store.graph.nodes.length) store.setGraph(emptyGraph('Dashboard'))
    },
    anchor: () => byTour('canvas'),
    side: 'top',
    align: 'center',
  },
  {
    id: 'dataset',
    title: 'MaleCNS, on neuPrint',
    body:
      'This time we use a real dataset instead of the synthetic Demo Data, because Neuroglancer ' +
      'needs a segmentation layer to draw the neurons. Everything else works the same with any ' +
      'dataset.',
    before: () => {
      b.ensure(DATASET)
      b.setParams(DATASET)
      b.reveal(DATASET)
    },
    anchor: () => b.card(DATASET),
    side: 'right',
    align: 'start',
  },
  {
    id: 'explore',
    title: 'Explore Dataset',
    body:
      'Explore Dataset downloads the dataset’s neuron table once and lets you search it as you ' +
      'type. It has three outputs: Hits for the search results, Selected for the rows you tick, ' +
      'and All for the whole table. We will use Selected.',
    before: () => {
      b.ensure(EXPLORE)
      b.wire(DATASET, 'dataset', EXPLORE, 'dataset')
      b.setParams(EXPLORE)
      b.reveal(DATASET, EXPLORE)
    },
    anchor: () => b.card(EXPLORE),
    side: 'right',
    align: 'start',
  },
  {
    id: 'table',
    title: 'A table of the selected neurons',
    body:
      'The Table is wired to Selected, so it shows the neurons you tick in Explore. This is the ' +
      'basic pattern for an interactive dashboard: one node picks the neurons, the others ' +
      'display them.',
    before: () => {
      b.ensure(TABLE)
      b.wire(EXPLORE, 'selected', TABLE, 'in')
      b.reveal(EXPLORE, TABLE)
    },
    anchor: () => b.card(TABLE),
    side: 'left',
    align: 'start',
  },
  {
    id: 'scene',
    title: 'And the same neurons in Neuroglancer',
    body:
      'Neuroglancer is wired to the same Selected output. Ticking a neuron in Explore now ' +
      'updates both the table and the 3D view.',
    before: () => {
      b.ensure(SCENE)
      b.wire(DATASET, 'dataset', SCENE, 'dataset')
      b.wire(EXPLORE, 'selected', SCENE, 'neurons')
      b.reveal(EXPLORE, TABLE, SCENE)
    },
    anchor: () => b.card(SCENE),
    side: 'left',
    align: 'start',
  },
  {
    id: 'run',
    title: 'Your turn: Run',
    body:
      'Press Run (or ⇧R). Explore fetches the neuron table; the other nodes have nothing to do ' +
      'until you tick something. Without a neuPrint token this step will fail. In that case, ' +
      'press Next and the tour carries on with empty cells.',
    anchor: () => byTour('run'),
    side: 'bottom',
    align: 'end',
    interactive: true,
    advanceWhen: ranClean,
  },
  {
    id: 'pick',
    title: 'Your turn: tick a few neurons',
    body:
      'Tick two or three rows in the Explore card. The search is already set to LC. The table ' +
      'and Neuroglancer will fill in as you go. If there is nothing to tick, you need a neuPrint ' +
      'token; the rest of this tour works regardless.',
    before: () => {
      runIfPossible()
      b.reveal(EXPLORE)
    },
    anchor: () => b.card(EXPLORE),
    side: 'right',
    align: 'start',
    interactive: true,
    advanceWhen: () => picked() > 0,
  },
  {
    id: 'open',
    title: 'Your turn: open the dashboard',
    body:
      'Press D or the grid button in the toolbar. The dashboard replaces the canvas. Your ' +
      'graph is still there, you are just looking at it in a different way.',
    // The catch-up for a reader who pressed Next on the last step: nothing can tick a neuron for
    // them, so what this does is frame the three cards, which is the state the next step assumes.
    before: () => b.reveal(EXPLORE, TABLE, SCENE),
    anchor: () => byTour('dashboard'),
    side: 'bottom',
    align: 'end',
    interactive: true,
    advanceWhen: () => useGraphStore.getState().dashboardOpen,
  },
  {
    id: 'empty',
    title: 'Your turn: add a cell',
    body:
      'A new dashboard is empty: you decide which nodes go on it. Press + Add node and pick any ' +
      'of the three, or right-click a node back on the canvas. (Next adds all three and ' +
      'arranges them for you.)',
    before: () => {
      if (!useGraphStore.getState().dashboardOpen)
        useGraphStore.getState().setDashboardOpen(true)
    },
    /*
     * The *bar*, not the empty-state text below it. driver gives pointer events back to the
     * spotlit element alone, and `+ Add node` is in the bar — anchoring on the prose would
     * spotlight the explanation and make the button the reader is being asked to press inert.
     */
    anchor: () => document.querySelector('.dashboard__bar'),
    side: 'bottom',
    align: 'end',
    interactive: true,
    advanceWhen: () => celled() > 0,
  },
  {
    id: 'arrange',
    title: 'Three cells, arranged',
    body:
      'Explore is top left with the table of ticked neurons below it, and Neuroglancer runs down ' +
      'the right at full height. Drag a cell’s ⠿ handle to move it, and its bottom-right corner ' +
      'to resize it. Heights snap to a third, a half, two thirds or the full height.',
    before: arrange,
    anchor: () => document.querySelector('.dashboard__grid'),
    side: 'top',
    align: 'center',
  },
  {
    id: 'live',
    title: 'The cells are live',
    body:
      'You can sort the table, rotate the 3D view, or tick another neuron in Explore and watch ' +
      'the other two update. In each cell, ⚙ opens the display settings, ▸ runs just that node, ' +
      '⤢ opens it full size and ✕ removes it from the dashboard (the node stays on the canvas).',
    before: () => {
      if (!useGraphStore.getState().dashboardOpen)
        useGraphStore.getState().setDashboardOpen(true)
      arrange()
    },
    anchor: () => cell(EXPLORE) ?? document.querySelector('.dashboard__grid'),
    side: 'right',
    align: 'start',
  },
  {
    id: 'saved',
    title: 'Saving the dashboard',
    body:
      'The dashboard is saved in the .coda.json file and in share links. If you save while the ' +
      'dashboard is open, the workflow will also open on the dashboard. Press D to go back to ' +
      'the canvas.',
    anchor: () => byTour('share'),
    side: 'bottom',
    align: 'end',
  },
]

/**
 * The tour as a spec — see `TourSpec`.
 *
 * `restoreSelection: false` for "Learn to Build"'s reason: this tour made the nodes that are
 * selected at the end, and putting back a selection from before the canvas was emptied would
 * name nodes that no longer exist.
 */
export const DASHBOARD_SPEC: TourSpec = {
  steps: BUILD_A_DASHBOARD,
  /*
   * Three things to own up to before the first Next, and the token is the one that matters.
   *
   * A reader without neuPrint credentials can still do every step — the graph is built, the cells
   * are placed, the arrangement is the lesson — but the cells will be empty, and being told that
   * at step 0 is the difference between a tour that is honest about its one prerequisite and one
   * that looks broken at step 8. Checked here rather than asserted in the copy, so somebody who
   * *does* have a token is not told about a problem they do not have.
   *
   * The canvas is not emptied here — that happens on the second step, so Escape on the first one
   * leaves the graph exactly as it was found.
   */
  prepare: () => {
    b.reset()

    const store = useGraphStore.getState()
    const notes: string[] = []
    if (!getToken()) {
      notes.push(
        'One thing first: this tour uses MaleCNS on neuPrint, and this browser has no token for ' +
          'it. The next step opens Connections so you can add one. You can skip that: every step ' +
          'still works, the three cells will just stay empty.',
      )
    }
    if (store.graph.nodes.length) {
      notes.push(
        '<br></br><b>Heads up</b>: this needs a blank canvas, so the graph you have open will be replaced when ' +
          'you press Next. ⌘Z brings it back, but if it matters, press Escape and save it first.',
      )
    }
    /*
     * Auto-run off, and said out loud — `restore` in `tour.ts` puts it back. With it on nothing
     * is ever stale, so the Run button is permanently `disabled`, and one step of this tour asks
     * the reader to press it.
     */
    if (store.autoRun) {
      store.setAutoRun(false)
      notes.push(
        'I have also switched Auto-run off so that Run has something to do when we get to it. ' +
          'It goes back on at the end.',
      )
    }
    return notes.length ? ` ${notes.join(' ')}` : ''
  },
  restoreSelection: false,
}
