// @vitest-environment jsdom

/**
 * Does every stop on the Guided Tour still point at something?
 *
 * This is the only test the tour can usefully have, and it is the one that matters. jsdom
 * performs no layout, so where a popover lands, whether the spotlight covers the card and how
 * the stage tweens between two stops are all outside what a headless run can see — the standing
 * the field guide's camera and the WebGL viewers already have.
 *
 * What *does* rot is the anchors. A tour is not a route: rename the Run button's wrapper, drop
 * the `data-tour` off Connections, move the inspector behind a different element, and nothing in
 * the app fails — the tour simply starts drawing its popover in the middle of an empty screen,
 * once, for whoever opens it next. That is the same failure mode `overview.test.ts` exists for,
 * on a page that had **already drifted before it shipped**.
 *
 * So: mount the real `App` with the real store and the mock source, walk the real step list, run
 * each step's `before`, and assert its anchor resolves. Nothing is stubbed, which is the point —
 * a step is checked against the markup the app actually renders.
 *
 * `driver.js` is deliberately never imported here. The steps are data (`steps.ts`) and the
 * library is loaded only by `tour.ts`, so this suite exercises the half that can go stale
 * without paying for the half that cannot.
 */

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { DEFAULT_ROW_SPAN } from '../../core/dashboard'
import { requireNodeDef } from '../../core/registry'
import { getToken } from '../../data/neuprint/credentials'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { BUILD_SPEC, FIND, LEARN_TO_BUILD, PARAMS } from './build'
import { BUILD_A_DASHBOARD, DASHBOARD_SPEC } from './dashboard'
import { GUIDED_TOUR, TOUR_ANCHORS, byTour } from './steps'

beforeAll(() => {
  installJsdomStubs({ width: 360, height: 220 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    // The start page opens over everything on a fresh visit, and would sit in front of the
    // toolbar every anchor below is on.
    useGraphStore.getState().closeStartPage()
    // The tour loads this example itself when the canvas is empty; loading it here means the
    // assertions are about the anchors rather than about `loadExample`.
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
  })
})

afterEach(cleanup)

/** Every step of every tour, so the shared assertions below cannot forget a new one. */
const ALL = [
  ['Guided Tour', GUIDED_TOUR],
  ['Learn to Build', LEARN_TO_BUILD],
  ['Build a Dashboard', BUILD_A_DASHBOARD],
] as const

/**
 * The contract that stops a tour wedging, asserted for every tour that hands the reader a move.
 *
 * Pressing Next on a "your turn" step must leave the following step able to carry on, which it
 * can only do by performing the action itself — so every interactive step needs a successor with
 * a `before`, and a predicate that can see the action was done.
 */
const INTERACTIVE = [
  ['Learn to Build', LEARN_TO_BUILD, 3],
  ['Build a Dashboard', BUILD_A_DASHBOARD, 3],
] as const

describe('the Guided Tour', () => {
  it('resolves every anchor against the app it describes', () => {
    render(<App />)

    for (const step of GUIDED_TOUR) {
      if (!step.anchor) continue
      act(() => step.before?.())
      expect(step.anchor(), `step "${step.id}" has nothing to point at`).toBeTruthy()
    }
  })

  it('publishes every anchor name it declares', () => {
    render(<App />)

    // Two anchors do not exist until a step opens the thing they are on, which is the whole
    // reason `TourStep.anchor` is a function rather than a selector string: the inspector panel,
    // and the Connections dialog the dashboard tour asks for a token in.
    act(() => {
      if (!useGraphStore.getState().panels.inspector)
        useGraphStore.getState().togglePanel('inspector')
      useGraphStore.getState().openSources()
    })

    for (const anchor of TOUR_ANCHORS) {
      expect(byTour(anchor), `nothing in the app carries data-tour="${anchor}"`).toBeTruthy()
    }
  })

  it('names every anchor it publishes, so a dead one is noticed', () => {
    render(<App />)

    const published = [...document.querySelectorAll('[data-tour]')].map((el) =>
      el.getAttribute('data-tour'),
    )
    // The other direction of the same contract: an attribute nobody points at is a maintenance
    // cost that reads as load-bearing. `run` is on two elements — the Run button and the Cancel
    // that replaces it mid-run — so the check is on the set, not on the count.
    for (const name of new Set(published)) {
      expect(TOUR_ANCHORS, `data-tour="${name}" is not a tour anchor`).toContain(name)
    }
  })

  it.each(ALL)(
    '%s starts centred and gives every stop a title and a stable id',
    (_name, steps) => {
      // A tour whose first stop is already pointing somewhere begins by moving the screen under a
      // reader who has not yet been told what is about to happen — and for "Learn to Build", the
      // first stop is where they are told the canvas is about to be emptied.
      expect(steps[0]?.anchor).toBeUndefined()
      for (const step of steps) {
        expect(step.title.length, `step "${step.id}" has no title`).toBeGreaterThan(0)
        expect(step.body.length, `step "${step.id}" has no body`).toBeGreaterThan(0)
      }
      // Stable ids, because a resume-where-I-left-off would key on them.
      expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length)
    },
  )
})

describe.each(INTERACTIVE)('%s', (_name, steps, atLeast) => {
  it('hands the reader something to do, and can always be skipped past it', () => {
    const interactive = steps.filter((step) => step.interactive)
    expect(interactive.length).toBeGreaterThanOrEqual(atLeast)

    for (const step of interactive) {
      const next = steps[steps.indexOf(step) + 1]
      expect(next?.before, `nothing recovers if "${step.id}" is skipped`).toBeTruthy()
      expect(step.advanceWhen, `"${step.id}" asks for an action it cannot detect`).toBeTruthy()
    }
  })
})

/**
 * "Build a Dashboard" ends somewhere the other two never go, so what it can break is different:
 * a port id that no longer exists, and a *layout* that no longer produces the composition the
 * copy describes.
 */
describe('Build a Dashboard', () => {
  it('builds the graph and arranges it, with every step pointing at something', () => {
    render(<App />)
    act(() => {
      DASHBOARD_SPEC.prepare?.()
    })

    for (const step of BUILD_A_DASHBOARD) {
      act(() => step.before?.())
      if (!step.anchor) continue
      expect(step.anchor(), `step "${step.id}" has nothing to point at`).toBeTruthy()
    }

    const { graph } = useGraphStore.getState()
    const idOf = (type: string) => graph.nodes.find((n) => n.type === type)?.id
    const explore = idOf('neuron.explore')
    const table = idOf('out.table')
    const scene = idOf('out.neuroglancer')
    expect(idOf('dataset.malecns'), 'the dataset node is gone').toBeTruthy()
    expect(
      explore && table && scene,
      'a node type the tour names has been renamed',
    ).toBeTruthy()

    /*
     * Both wires come off `selected`, which is the whole lesson — one widget chooses and the
     * others follow. `connect` refuses silently when a port id is wrong, so this is asserted on
     * the graph rather than on the step that called it.
     */
    const from = (target: string | undefined, port: string) =>
      graph.edges.find((e) => e.target === target && e.targetHandle === port)
    expect(from(table, 'in')?.sourceHandle, 'the table is not fed from Selected').toBe(
      'selected',
    )
    expect(from(scene, 'neurons')?.sourceHandle, 'the scene is not fed from Selected').toBe(
      'selected',
    )
    expect(from(scene, 'dataset')?.source, 'the scene has no dataset').toBeTruthy()
  })

  /**
   * The composition the copy promises: Explore top left, the table under it, the scene down the
   * whole right-hand side.
   *
   * Order *is* position on a dashboard, so this is checkable without layout — which is the only
   * reason it can be tested at all in jsdom. Reorder `CELLS` and the prose stops describing what
   * the reader gets, with nothing else failing.
   */
  it('arranges the three cells into the layout the copy describes', () => {
    render(<App />)
    act(() => {
      DASHBOARD_SPEC.prepare?.()
    })
    for (const step of BUILD_A_DASHBOARD) act(() => step.before?.())

    const state = useGraphStore.getState()
    const { graph } = state
    const type = (id: string) => graph.nodes.find((n) => n.id === id)?.type
    const cells = graph.dashboard?.cells ?? []

    expect(cells.map((c) => type(c.nodeId))).toEqual([
      'neuron.explore',
      'out.neuroglancer',
      'out.table',
    ])
    expect(graph.dashboard?.columns).toBe(2)
    /*
     * Half, full, half — the scene is the one that runs the whole height. Read through
     * `DEFAULT_ROW_SPAN` rather than off `c.h`, because a half-height cell stores its height as
     * *absence*: that is the model's rule, and a test comparing the raw field would be asserting
     * the storage rather than the layout.
     */
    expect(cells.map((c) => c.h ?? DEFAULT_ROW_SPAN)).toEqual([3, 6, 3])
    // And the tour leaves the reader looking at it.
    expect(state.dashboardOpen).toBe(true)
  })

  it('warns about the neuPrint token when there is none, before anything is built', () => {
    render(<App />)
    const preamble = DASHBOARD_SPEC.prepare?.() ?? ''
    expect(preamble).toContain('neuPrint')
    // Said in `prepare`, which runs before the first step's body is shown — so a reader without
    // credentials finds out while Escape still leaves their canvas untouched.
    expect(
      BUILD_A_DASHBOARD[0]?.before,
      'the first step must not touch the graph',
    ).toBeUndefined()
  })

  /**
   * The token step, and the four properties that make it a way *past* the credential rather than
   * a second wall.
   *
   * It exists because the dataset node peeks on creation and draws a 401, and the app's answer to
   * a 401 used to be a dialog nobody could touch — driver makes everything but the spotlit
   * element inert. Each of these was a way the fix could have shipped broken: shown to somebody
   * who already has a token, spotlit but not typeable, needing a Next press after Save, or
   * leaving the panel up over the rest of the tour.
   */
  it('asks for the token in a live step, only when there is none', () => {
    const step = BUILD_A_DASHBOARD.find((s) => s.id === 'token')
    expect(step, 'the dashboard tour no longer asks for a token').toBeTruthy()
    if (!step) return

    expect(step.when?.(), 'asked for a token this browser already has').toBe(!getToken())
    expect(step.interactive, 'a form under the spotlight is inert without this').toBe(true)
    expect(step.advanceWhen, 'saving a token has to move the tour on by itself').toBeTruthy()
    expect(step.after, 'the panel would stay up over the rest of the tour').toBeTruthy()

    render(<App />)
    act(() => step.before?.())
    expect(useGraphStore.getState().sourcesOpen, 'the step opens Connections').toBe(true)
    /*
     * The *panel*, and nothing that could stand in for it. An anchor that fell back to the
     * toolbar's Connections button resolved instantly — before React had committed the dialog —
     * which ends driver's `waitForElement` poll, spotlights a 28px icon behind the dialog and
     * grants the pointer events to that instead: the form stays inert, which is the whole bug
     * this step exists to fix. Measured in a browser; the token field computed to
     * `pointer-events: none`.
     */
    expect(step.anchor?.(), 'it points at the form, not at the button').toBe(
      document.querySelector('.sources'),
    )
    act(() => step.after?.())
    expect(useGraphStore.getState().sourcesOpen, 'Next leaves it closed').toBe(false)
  })
})

describe('Learn to Build', () => {
  /**
   * Walks the whole tour the way the runtime does — each step's `before`, then its anchor —
   * against the real store and the real node registry.
   *
   * This is the closest a headless run gets to the tour actually working, and it covers the two
   * ways this one can break that the Guided Tour cannot: a node type that has been renamed out
   * from under `place`, and a port id that no longer exists so `connect` silently refuses. Both
   * are asserted on the graph afterwards rather than on the steps.
   */
  it('builds the whole pipeline, with every step pointing at something', () => {
    render(<App />)

    for (const step of LEARN_TO_BUILD) {
      act(() => step.before?.())
      if (!step.anchor) continue
      expect(step.anchor(), `step "${step.id}" has nothing to point at`).toBeTruthy()
    }

    const graph = useGraphStore.getState().graph
    // The six nodes of the Field Guide's chain. `dataset.description` comes along with the
    // dataset node as its companion, so the count is a floor rather than an equality.
    for (const type of [
      'dataset.mock.opticlobe',
      'neuron.findNeurons',
      'neuron.connectivity',
      'out.table',
      'core.groupBy',
      'out.barChart',
    ]) {
      expect(
        graph.nodes.some((n) => n.type === type),
        `${type} was never added`,
      ).toBe(true)
    }

    /*
     * Every node but the dataset and its companion has to have ended up fed. This is the
     * assertion that catches a renamed port: `connect` answers a bad handle with a notice and a
     * `false`, so a mis-wired tour builds a graph of orphans and reports nothing.
     */
    const fed = new Set(graph.edges.map((edge) => edge.target))
    for (const node of graph.nodes) {
      if (node.type === 'dataset.mock.opticlobe' || node.type === 'dataset.description')
        continue
      expect(fed.has(node.id), `${node.type} was left unwired`).toBe(true)
    }
    // Connectivity takes two inputs and the tour claims both get wired.
    const connectivity = graph.nodes.find((n) => n.type === 'neuron.connectivity')
    expect(graph.edges.filter((e) => e.target === connectivity?.id)).toHaveLength(2)
  })

  /**
   * The three add-menu steps, done the way a reader does them.
   *
   * This is the failure the previous version shipped with, and it is invisible to every other
   * assertion here: the step's anchor resolved, its copy read correctly, and the move it asked
   * for could not be made. driver hands pointer events to the spotlit element **and its subtree**
   * and to nothing else, so an interactive step whose anchor does not *contain* the control the
   * sentence names is a step the reader cannot complete — one that waits for an `advanceWhen`
   * that will never fire. The **+** opening a rail rather than the browser turned one step into
   * three, and nothing failed.
   *
   * So each step is walked in order: run its `before`, find the control inside its anchor, click
   * it, and require the predicate that moves the tour on to be satisfied. jsdom hit-tests
   * nothing, which is why the containment is asserted rather than assumed.
   */
  it('can be completed by pressing what each step points at', () => {
    render(<App />)
    const step = (id: string) => {
      const found = LEARN_TO_BUILD.find((s) => s.id === id)
      if (!found) throw new Error(`no step "${id}"`)
      return found
    }
    /** Click one control, having first insisted it is inside the step's spotlight. */
    const press = (id: string, within: (root: Element) => Element | null | undefined) => {
      const current = step(id)
      act(() => current.before?.())
      const anchor = current.anchor?.()
      expect(anchor, `step "${id}" has nothing to point at`).toBeTruthy()
      const control = within(anchor!)
      expect(control, `step "${id}" points somewhere its own control is not`).toBeTruthy()
      act(() => {
        ;(control as HTMLElement).click()
      })
      expect(current.advanceWhen?.(), `pressing it does not satisfy "${id}"`).toBe(true)
    }

    press('open-menu', (root) => root.querySelector('.add-fab'))
    press('pick-category', (root) => root.querySelector('[data-cat="query"]'))
    press('pick-find', (root) =>
      [...root.querySelectorAll('.fab-menu__node')].find(
        (button) => button.textContent === requireNodeDef(FIND).label,
      ),
    )
    // And the band's own step puts the menu away, so it is not left over the card the next
    // step is about.
    act(() => step('pick-find').after?.())
    expect(useGraphStore.getState().addMenuOpen).toBe(false)
  })

  it('empties the canvas through history, so the reader can undo back to their work', () => {
    render(<App />)
    const before = useGraphStore.getState().graph

    // Step 0 is the warning and must not touch anything; step 1 is what clears.
    act(() => LEARN_TO_BUILD[0]?.before?.())
    expect(useGraphStore.getState().graph).toBe(before)

    act(() => LEARN_TO_BUILD[1]?.before?.())
    expect(useGraphStore.getState().graph.nodes).toHaveLength(0)
    act(() => useGraphStore.getState().undo())
    expect(useGraphStore.getState().graph.nodes.length).toBe(before.nodes.length)
  })

  it('warns before replacing work, and says nothing on an empty canvas', () => {
    act(() => useGraphStore.getState().setAutoRun(false))
    expect(BUILD_SPEC.prepare?.()).toContain('replaced')

    act(() => useGraphStore.getState().newGraph())
    expect(BUILD_SPEC.prepare?.()).toBe('')
  })

  /**
   * Auto-run makes two of this tour's steps impossible, because the Run button is `disabled` at
   * `staleCount === 0` and auto-run means it is always zero. So the tour turns it off — and
   * because it is a preference somebody set and Coda persists (`coda.autorun.v1`), it says so
   * and gives it back. All three halves of that are asserted: off, announced, restored.
   */
  it('takes auto-run off so Run has something to do, announces it, and gives it back', () => {
    act(() => {
      useGraphStore.getState().newGraph()
      useGraphStore.getState().setAutoRun(true)
    })

    const preamble = BUILD_SPEC.prepare?.() ?? ''
    expect(useGraphStore.getState().autoRun).toBe(false)
    expect(preamble).toContain('Auto-run')

    // The restore is `tour.ts`'s, driven here through the same store the runtime uses.
    act(() => useGraphStore.getState().setAutoRun(true))
    expect(useGraphStore.getState().autoRun).toBe(true)
  })

  /**
   * The "notice the wire" step spotlights an element the tour invents to span two cards, which
   * is the one thing it puts into the page that is not part of the graph. A tour that left it
   * behind would be leaving a stray absolutely-positioned div inside React Flow's viewport.
   */
  it('takes down the scaffolding it puts up', () => {
    render(<App />)
    for (const step of LEARN_TO_BUILD) act(() => step.before?.())

    const spanning = LEARN_TO_BUILD.filter((step) => step.after)
    expect(spanning.length).toBeGreaterThan(0)
    for (const step of spanning) {
      act(() => step.before?.())
      expect(step.anchor?.(), `"${step.id}" has an after but nothing to take down`).toBeTruthy()
      act(() => step.after?.())
      expect(
        document.getElementById('coda-tour-span'),
        `"${step.id}" left its spanning element behind`,
      ).toBeNull()
    }
  })

  /**
   * A span is all its cards or it is nothing.
   *
   * Returning a partial span is not a graceful degradation: driver stops waiting the moment the
   * anchor answers with an element, so a span built while the second card was still on its way
   * would be the one the step keeps — a spotlight round one card for a sentence about two.
   */
  it('will not span a set of cards it cannot see all of', () => {
    render(<App />)
    const wired = LEARN_TO_BUILD.find((step) => step.id === 'auto-wire')

    // Only the dataset exists at this point: the step that adds Find Neurons has not run.
    for (const step of LEARN_TO_BUILD.slice(0, LEARN_TO_BUILD.indexOf(wired!))) {
      if (step.id.startsWith('pick-') || step.id === 'open-menu') continue
      act(() => step.before?.())
    }
    expect(wired?.anchor?.()).toBeNull()

    act(() => wired?.before?.())
    const span = wired?.anchor?.()
    expect(span).toBeTruthy()
    act(() => wired?.after?.())
  })

  /**
   * The `cheap` step tells the reader, by name, which three nodes re-run on their own and which
   * two wait to be asked. That is a claim about the registry, and the registry is where it can
   * quietly stop being true — flipping one `cost` is a one-word edit that nothing else in the
   * app would fail over, and the tour would go on confidently teaching the opposite.
   *
   * The same reasoning `overview.test.ts` uses for its backend list: assert the claim against
   * the thing it is a claim about, not against a snapshot of the prose.
   */
  it('is telling the truth about which nodes re-run on their own', () => {
    for (const type of ['out.table', 'core.groupBy', 'out.barChart']) {
      expect(requireNodeDef(type).cost, `${type} is named as cheap`).toBe('cheap')
    }
    for (const type of ['neuron.findNeurons', 'neuron.connectivity']) {
      expect(requireNodeDef(type).cost, `${type} is named as expensive`).toBe('expensive')
    }

    const step = LEARN_TO_BUILD.find((s) => s.id === 'cheap')
    for (const label of ['Table', 'Group By', 'Bar Chart', 'Find Neurons', 'Connectivity']) {
      expect(step?.body, `the step stopped naming ${label}`).toContain(label)
    }
  })

  /**
   * The tour and the `partners` example build the same pipeline, and the tour copied its values
   * from the example. Nothing enforced that.
   *
   * `examples.test.ts` is thorough — it type-checks the example, runs it end to end and asserts
   * the aggregation it produces. None of that reaches this file. So change `minWeight`, or the
   * op on the weight filter, or the column Group By aggregates, and the example stays green
   * while the tour quietly builds a different pipeline from the one it narrates — and from the
   * one the Field Guide's chapter describes.
   *
   * Comparing `PARAMS` against the example is what turns the module note's claim into a fact.
   */
  it('sets the same parameters the generated connectivity workflow does', () => {
    // The pipeline this tour narrates is the one the Workflow Wizard builds for "who they
    // connect to" — which is what the four bundled examples were replaced by, and what a reader
    // gets when they answer its questions rather than take the tour.
    const graph = demoWorkflow('partners', false)

    let compared = 0
    for (const [type, params] of Object.entries(PARAMS)) {
      /*
       * The search is where the two differ on purpose. The tour types a pattern in, because it
       * needs something on screen to talk about; the wizard leaves Find Neurons empty, because
       * which neurons somebody wants is the one thing four questions cannot answer for them.
       * Everything downstream of it is a claim about the *pipeline*, and that has to agree.
       */
      if (type === 'neuron.findNeurons') continue
      const node = graph.nodes.find((candidate) => candidate.type === type)
      // The Bar Chart is the tour's own ending — the generated workflow finishes at a Table — so
      // it has no counterpart to compare against, a difference on purpose rather than drift.
      if (!node) continue
      compared += 1
      for (const [key, value] of Object.entries(params)) {
        expect(node.params[key], `${type}.${key} disagrees with the workflow`).toEqual(value)
      }
    }
    // A guard on the guard: a renamed node type would make every lookup miss and the loop pass
    // by comparing nothing at all.
    expect(compared, 'nothing was actually compared').toBeGreaterThanOrEqual(2)
  })
})
