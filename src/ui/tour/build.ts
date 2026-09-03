/**
 * "Learn to Build" — the second tour, and the one that actually makes something.
 *
 * The Guided Tour says where things are. This one builds the Field Guide's pipeline a node at a
 * time, on the canvas, with the reader doing four of the moves themselves. Same *pipeline* the
 * Field Guide walks — find neurons, pull their partners, sum by partner type — so somebody who
 * has read the chapter arrives here recognising the shape, and somebody who does this first can
 * go and read why it works.
 *
 * **It is framed as a technique, not as a finding, and that is not squeamishness.** The Field
 * Guide runs on Hemibrain; this runs on Demo Data, which is generated in the browser from a seed.
 * The type names in it are real and everything they do is invented, so a tour that promised "a
 * real question" and then answered it would be teaching the reader to trust a number that means
 * nothing. The dataset step says so outright, and no later step claims a result.
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
 * **Its parameters are the wizard's connectivity workflow's, and a test holds them there.** The Field Guide
 * walks the same pipeline and `src/wizard/build.ts` builds it; this file is a third statement
 * of it, and an earlier version of the note below claimed the three shared a source when they
 * did not. They still do not — the tour needs its own ordering and its own copy — but `PARAMS`
 * gathers every value that has to agree into one place and `tour.test.tsx` compares it against
 * the generated workflow, which is the difference between a claim and a fact.
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
import type { NodeCategory } from '../../core/node'
import { useGraphStore } from '../../store/graphStore'
import { hasNode, makeBuilder, ranClean, runIfStale } from './builder'
import type { TourSpec, TourStep } from './steps'
import { byTour } from './steps'

/**
 * The add menu's band for one category, or null.
 *
 * By attribute rather than by the accessible name, for `byTour`'s reason: an attribute nothing
 * else reads cannot be reworded out from under a step. Asking for the *category* and not just
 * "a band" is deliberate — a reader who opens Analysis has not done what the step asked, and
 * the next step's spotlight would land on the wrong row of buttons.
 *
 * `data-band` and not `data-cat`, which is the rail *button's*: two elements answering the same
 * attribute made `AddMenu`'s alignment measure the band against itself, since the band is
 * written first and `querySelector` answers in document order.
 */
const bandFor = (category: NodeCategory): Element | null =>
  document.querySelector(`.fab-menu__band[data-band="${category}"]`)

/**
 * The chain, in the order it gets built. Types are the wizard's connectivity workflow's, which is
 * the same pipeline the Field Guide walks; see `PARAMS` for the values and the module note for
 * what keeps the two in step.
 */
const DATASET = 'dataset.mock.opticlobe'
/** Exported for the test that walks the add-menu steps the way a reader does. */
export const FIND = 'neuron.findNeurons'
const CONNECTIVITY = 'neuron.connectivity'
const TABLE = 'out.table'
const GROUP = 'core.groupBy'
const CHART = 'out.barChart'

/** The chain, left to right. A node's place in it *is* its column. */
const CHAIN = [DATASET, FIND, CONNECTIVITY, TABLE, GROUP, CHART] as const

/**
 * The parameters the tour sets, per node.
 *
 * Lifted out of the steps so there is one place to compare them against the wizard's own
 * connectivity workflow (`demoWorkflow('partners')`), which builds the same pipeline and is what
 * these were copied from. **`tour.test.tsx` asserts the two agree** — an earlier version of this
 * file claimed in prose to be reading from a single source and was in fact a second, unchecked
 * copy, which is the arrangement where the builder's own test stays green while the tour quietly
 * narrates a pipeline it is no longer building.
 */
export const PARAMS: Record<string, Record<string, unknown>> = {
  [FIND]: {
    filters: [
      '{"f":"type","op":"matches","v":["LC.*"]}',
      '{"f":"status","op":"is","v":["Traced"]}',
    ],
  },
  [CONNECTIVITY]: { direction: 'outputs' },
  [GROUP]: { by: ['postType'], agg: 'sum', value: ['weight'] },
  [CHART]: { category: 'postType', value: 'sum_weight' },
}

/**
 * The tour's builder: what it has made, where each card goes, and the moves that make them.
 *
 * `makeBuilder` is shared with "Build a dashboard" — see `builder.ts` for why the state that used
 * to live in this module is now scoped to the tour that owns it. `row` is the default layout and
 * the one a pipeline wants: one row, left to right, each column as wide as the card in it.
 *
 * 1.0 rather than the Guided Tour's 1.2, because this graph *grows* and what somebody building a
 * pipeline needs to see is the new card **and the wire that arrived with it**.
 */
const b = makeBuilder(CHAIN, PARAMS, { zoom: 1.0 })

export const LEARN_TO_BUILD: readonly TourStep[] = [
  {
    id: 'intro',
    title: "Let's build something",
    body:
      'This guide will teach you how to build a simple analysis pipeline in Coda: find a set of ' +
      'neurons, pull everything they connect to, and add up the synapses per partner type. ' +
      'We will use demo data to illustrate the process, so you do not need an account. Just replace the ' +
      'demo dataset node with an actual dataset to see real data.',
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
      'Demo Data is synthetic and generated right here in your browser, so this tour ' +
      'needs no token and no network — and so the numbers it produces are a demonstration rather ' +
      'than a result. Swap it for Hemibrain, FlyWire or MANC later: every node downstream of it ' +
      'stays exactly the same, and then the answers mean something.',
    before: () => {
      b.ensure(DATASET)
      b.reveal(DATASET)
    },
    anchor: () => b.card(DATASET),
    side: 'right',
    align: 'start',
  },
  /*
   * Three steps for three clicks, and each one's **anchor is the thing to press**.
   *
   * driver gives pointer events back to the spotlit element *and its subtree* and to nothing
   * else, so a step that spotlights one surface while asking the reader to press another is a
   * step that cannot be completed — which is what a single "open the browser" step became the
   * day the **+** stopped opening the browser and started unfolding a rail. Splitting it is
   * cheaper than teaching the tour to hold two elements live at once, and it spotlights exactly
   * what the sentence is about at each stage.
   *
   * Each `before` puts the menu into the state its step describes, so Next skips forward without
   * wedging — the tour's standing rule, and what `setAddMenu` was lifted to the store for. The
   * band's own step closes the menu again on the way out: the reader who pressed Next through it
   * gets the node from `auto-wire`'s `b.ensure`, and a menu left standing would be over the card
   * that step is about.
   */
  {
    id: 'open-menu',
    title: 'Your turn: open the add menu',
    body:
      'Press the **+** button in the corner. It fans out into the node categories. (If you ' +
      'would rather watch, Next does it for you.)',
    // The stack, so the **+** and the rail it unfolds are both inside the live subtree.
    anchor: () => byTour('add'),
    // `top`: the anchor is at the bottom of the canvas.
    side: 'top',
    align: 'end',
    interactive: true,
    advanceWhen: () => Boolean(document.querySelector('.fab-menu__rail')),
  },
  {
    id: 'pick-category',
    title: 'Your turn: choose Queries',
    body:
      'Each circle is a category. Pick **Queries** — the magnifier — and its nodes appear along ' +
      'the bottom. The bottom button opens the full browser instead, which is also what `Tab` ' +
      'does.',
    before: () => useGraphStore.getState().setAddMenu(true),
    anchor: () => document.querySelector('.fab-menu__rail'),
    side: 'left',
    align: 'end',
    interactive: true,
    advanceWhen: () => Boolean(bandFor('query')),
  },
  {
    id: 'pick-find',
    title: 'Your turn: add Find Neurons',
    body:
      'Pick **Find Neurons**. It is the node that turns a search into a set of neurons — nearly ' +
      'every pipeline starts with one.',
    before: () => useGraphStore.getState().setAddMenu(true, 'query'),
    anchor: () => bandFor('query'),
    after: () => useGraphStore.getState().setAddMenu(false),
    side: 'top',
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
      b.ensure(FIND)
      b.wire(DATASET, 'dataset', FIND, 'dataset')
      b.reveal(DATASET, FIND)
    },
    // Both cards and the wire between them, not one of the two — see `Builder.span`.
    anchor: () => b.span(DATASET, FIND),
    after: () => b.clearSpan(),
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
      b.setParams(FIND)
      b.reveal(FIND)
    },
    anchor: () => b.card(FIND),
    side: 'right',
    align: 'start',
  },
  {
    id: 'connectivity',
    title: 'Who do they talk to?',
    body:
      'Connectivity takes those neurons and returns one row per connected pair, ' +
      'downstream by default. Look at its sockets: it takes *two* inputs, and both got wired.',
    before: () => {
      b.ensure(CONNECTIVITY)
      b.wire(DATASET, 'dataset', CONNECTIVITY, 'dataset')
      b.wire(FIND, 'neurons', CONNECTIVITY, 'neurons')
      b.setParams(CONNECTIVITY)
      b.reveal(CONNECTIVITY)
    },
    anchor: () => b.card(CONNECTIVITY),
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
      'Note the footer of the node: 278 rows - each representing a neuron-to-neuron connection. ' +
      'Did you spot the download (⤓) button? It lets you save the table to disk if you want.',
    before: () => {
      runIfStale()
      b.reveal(CONNECTIVITY)
    },
    anchor: () => b.card(CONNECTIVITY),
    side: 'right',
    align: 'start',
  },
  {
    id: 'table',
    title: 'Look at what came out',
    body:
      'A Table, so you can actually read the rows: one per connected pair, including columns with ' +
      'the partner type and the synapse count. Viewer node such as this one pass their input straight ' +
      'through, so they can sit in the middle of a chain. Note that this Table also allows you to sort ' +
      'and apply filters. Like many other nodes, double clicking the body expands it.',
    before: () => {
      b.ensure(TABLE)
      b.wire(CONNECTIVITY, 'connections', TABLE, 'in')
      b.reveal(TABLE)
    },
    anchor: () => b.card(TABLE),
    side: 'right',
    align: 'start',
  },
  {
    id: 'group',
    title: 'Sum by partner type',
    body:
      'Group By collapses every row onto its partner type and adds up the weight. This gives ' +
      'us the type-to-type connectivity which is usually more manageable.',
    before: () => {
      b.ensure(GROUP)
      b.wire(TABLE, 'out', GROUP, 'in')
      b.setParams(GROUP)
      b.reveal(GROUP)
    },
    anchor: () => b.card(GROUP),
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
      b.ensure(CHART)
      b.wire(GROUP, 'out', CHART, 'in')
      b.setParams(CHART)
      b.reveal(CHART)
    },
    anchor: () => b.card(CHART),
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
     * pass as they arrived; Find Neurons and Connectivity are `expensive` and waited to
     * be asked. That split *is* Coda's execution model, and this is the one moment in the tour
     * where the reader has just watched it happen to them.
     */
    id: 'cheap',
    title: 'Notice what you did not have to do',
    body:
      'You never pressed Run for those last three, and the button has gone quiet — everything ' +
      'is already up to date. Table, Group By and Bar Chart are *cheap* nodes: pure table ' +
      'work, no server, so Coda re-runs them for you on every edit. Find Neurons and ' +
      'Connectivity are *expensive* — they query a backend, so they wait until you ask.',
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
    b.reset()

    const store = useGraphStore.getState()
    const notes: string[] = []
    if (store.graph.nodes.length) {
      notes.push(
        '<br></br><b>Heads up</b>: this needs a blank canvas, so the graph you have open will be replaced ' +
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
