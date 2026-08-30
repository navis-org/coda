/**
 * The Guided Tour's lifecycle — the half that loads driver.js.
 *
 * Reached only through `tourState.startTour`, so nothing here is in the main chunk. See
 * `tourState.ts` for why the split exists and `steps.ts` for what the tour says.
 *
 * ## Why driver.js and not the two better-known ones
 *
 * intro.js and Shepherd.js are both **AGPL-3.0**. Coda is MIT and ships as a static bundle to
 * GitHub Pages, which is distribution — a copyleft dependency bundled into it is a licensing
 * problem rather than a footnote. driver.js is MIT, has no dependencies, and measures 25.4 kB
 * raw / 7.2 kB gzipped plus 3.0/1.0 kB of CSS. That is the whole of the comparison.
 *
 * ## What it borrows, and gives back
 *
 * A tour that pointed at the inspector without opening it would be pointing at a button and
 * calling it a panel, so the inspector step opens it — and `restore` puts it back, because that
 * flag is a *persisted preference* (`coda.panels.v1`) and a tour is not a reason to have
 * changed it. The selection is restored for the same reason. What is deliberately **not**
 * restored is an example loaded onto an empty canvas: the welcome step says it happened, and
 * unloading it at the end would take away the graph somebody has just been taught to read.
 *
 * ## The one thing driver does not do for us
 *
 * `element` is resolved **before** `onHighlightStarted` fires, so that hook cannot be a "make
 * the thing this step points at" callback — the resolve has already missed. Two mechanisms
 * cover it together:
 *
 *  - Navigation is intercepted at `onNextClick` / `onPrevClick`, which is where *both* the
 *    footer buttons and the arrow keys arrive (driver's `arrowRightPress` listener calls the
 *    same hook), so a step's `before` runs before `moveTo` is asked for that step.
 *  - `waitForElement` covers the gap between `before` calling into the store and React having
 *    committed the DOM. driver polls it with a `MutationObserver`, which React's commit trips.
 *    A step whose anchor is already on screen does not wait at all — the check is "not found
 *    yet", not "always".
 *
 * A step whose element never turns up is **not** skipped: driver falls back to a zero-sized
 * element at the centre of the screen, so the popover still shows its text with no spotlight.
 * A stop that quietly vanished would leave the copy referring to something the reader never saw.
 */

import { driver } from 'driver.js'
import type { Config, Driver, DriveStep } from 'driver.js'

import 'driver.js/dist/driver.css'
import './tour.css'

import { useGraphStore } from '../../store/graphStore'
import { BUILD_SPEC } from './build'
import { DASHBOARD_SPEC } from './dashboard'
import type { TourSpec, TourStep } from './steps'
import { GUIDED_SPEC } from './steps'
import type { TourId } from './tourState'
import { setTourHandle } from './tourState'

/**
 * What the tour opens on an empty canvas.
 *
 * The mock optic-lobe example, so a tour taken before any dataset is connected still has cards,
 * sockets and a run state to point at, and reaches no network doing it. A tour of an empty
 * canvas would spend a third of its stops explaining chrome that has nothing to act on.
 */
const FALLBACK_EXAMPLE = 'partners'

/**
 * How long a step waits for an element its `before` is bringing into existence.
 *
 * Long enough for a React commit and the 240 ms viewport animation a card step starts, short
 * enough that a genuinely missing anchor lands on the centred fallback while the reader is still
 * expecting the step rather than a second later.
 */
const WAIT_MS = 600

/**
 * How often a step with an `advanceWhen` asks whether the reader has done it.
 *
 * Polled rather than subscribed, and that is the cheaper design here rather than the lazier one:
 * the predicates ask about three different things — a modal being on screen, a node type
 * existing in the graph, a run having settled — and only one of them is a store field. A
 * subscription per kind would be three mechanisms where the reader cannot tell the difference
 * between 0 ms and 150 ms.
 */
const POLL_MS = 150

/** State the tour changes for its own purposes and hands back at the end. */
interface Borrowed {
  inspector: boolean
  selection: string[]
  /**
   * Auto-run, which "Learn to Build" has to switch off to be able to teach anything about Run.
   *
   * With it on, every edit re-runs the graph, so the stale count is permanently zero — and the
   * Run button is `disabled` at exactly that. The step that says "your turn: press Run" was
   * pointing at a control that could not be pressed, for anybody who had ever ticked the box.
   * Like the inspector, it is a persisted preference (`coda.autorun.v1`) and a tour is not a
   * reason to have changed it, so it comes back.
   */
  autoRun: boolean
}

function borrow(): Borrowed {
  const state = useGraphStore.getState()
  return {
    inspector: state.panels.inspector,
    selection: state.selection,
    autoRun: state.autoRun,
  }
}

function restore(held: Borrowed, selection: boolean): void {
  const state = useGraphStore.getState()
  if (state.panels.inspector !== held.inspector) state.togglePanel('inspector')
  if (state.autoRun !== held.autoRun) state.setAutoRun(held.autoRun)
  if (!selection) return
  // Compared by content, not identity: `setSelection` mints a fresh array, so the snapshot is
  // never the same object as what is in the store by the time we get back here.
  const current = state.selection
  const same =
    current.length === held.selection.length &&
    current.every((id, i) => id === held.selection[i])
  if (!same) state.setSelection(held.selection)
}

/**
 * Mark the spotlit element live or inert, in a way React will not undo.
 *
 * driver says this with two classes — `driver-active-element`, which its stylesheet uses to give
 * back pointer events while everything else is `pointer-events: none`, and
 * `driver-no-interaction` for a step that only explains. React rewrites the whole `class`
 * attribute whenever the string a component computed for it changes, so on anything whose
 * `className` is a template rather than a literal both are simply gone: measured on a node card
 * as within 50 ms of the step opening.
 *
 * The *spotlight* is unharmed either way, because driver holds the element by reference and
 * reads its rect — which is why this stayed invisible while the Guided Tour was the only tour.
 * What breaks is interaction, and "Learn to Build" asks the reader to press things.
 *
 * **So say it in an attribute React does not manage, rather than defending a class it does.**
 * That is the same property `data-tour` already relies on: React writes the attributes a
 * component renders and leaves every other one alone, so one `setAttribute` holds for the life
 * of the step with nothing watching it. `tour.css` carries the two rules, which win on order
 * against driver's own at equal specificity — the arrangement the rest of that file already uses.
 *
 * The previous version of this re-added driver's classes from a `MutationObserver`, and is worth
 * recording because of how it failed: `classList.add`/`remove` rewrite the `class` attribute
 * whether or not they change anything, so an unguarded call inside the observer's own callback
 * queued the observer again — a microtask enqueuing microtasks, which never yields. **The whole
 * tab wedged**, with no error and no stack, from the moment React first re-rendered the spotlit
 * element. Guarding each call fixed it and left the trap in place for the next edit; not
 * observing at all removes it.
 */
function markElement(element: Element, interactive: boolean): () => void {
  const attribute = interactive ? 'data-tour-live' : 'data-tour-inert'
  element.setAttribute(attribute, '')
  return () => element.removeAttribute(attribute)
}

/**
 * The scrim colour, as the theme's own canvas rather than black.
 *
 * driver writes this to `path.style.fill`, which is a **style property** and therefore does
 * resolve `var()` — the exact inverse of the trap the tutorial page and the overview page's
 * figures both record, where a `stroke` *presentation attribute* silently comes out black. So
 * the scrim re-resolves on a theme switch with nothing listening for one.
 *
 * `CSS.supports` guards it rather than trusting it: a browser that would not take the custom
 * property gets a black overlay, and the fallback here is the resolved literal instead. That is
 * one line against a failure whose symptom — a light-theme reader getting a black screen with a
 * hole in it — looks nothing like its cause.
 */
function scrimColor(): string {
  if (typeof CSS !== 'undefined' && CSS.supports?.('fill', 'var(--canvas)'))
    return 'var(--canvas)'
  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue('--canvas')
    .trim()
  return resolved || '#000'
}

/** Our step shape, as driver's. `before` is deliberately not passed on — see the module note. */
function toDriveStep(step: TourStep, index: number, total: number): DriveStep {
  return {
    ...(step.anchor ? { element: () => step.anchor?.() as Element } : {}),
    // Per-step, overriding the config default. `pinDriverClasses` is what makes it stick.
    ...(step.interactive ? { disableActiveInteraction: false } : {}),
    waitForElement: WAIT_MS,
    popover: {
      title: step.title,
      description: step.body,
      ...(step.side ? { side: step.side } : {}),
      ...(step.align ? { align: step.align } : {}),
      progressText: `${index + 1} of ${total}`,
    },
  }
}

/**
 * Put a graph on the canvas if there is none, and say so if we did.
 *
 * Returns the sentence to append to the welcome step, or nothing. The tour announcing its own
 * side effect in its first paragraph is the whole of the consent here: it is a mutation, it is
 * only ever made to an empty canvas, and it is undoable by the ordinary means.
 */
function ensureGraph(): string {
  if (useGraphStore.getState().graph.nodes.length > 0) return ''
  useGraphStore.getState().loadExample(FALLBACK_EXAMPLE)
  return ' The canvas was empty, so an example graph has been opened to point at.'
}

async function drive(spec: TourSpec): Promise<void> {
  /*
   * **Before `prepare`, and that ordering is the whole of whether `restore` works.**
   *
   * `prepare` is where a tour changes things it means to give back — "Learn to Build" switches
   * Auto-run off there, because the Run button is `disabled` while nothing is ever stale.
   * Borrowing afterwards captures the value the tour has just written, so the restore at the end
   * faithfully puts back *off*, which is not what anybody lent it. Seen in a browser: start with
   * Auto-run ticked, take the tour, finish with it unticked and nothing to say why.
   *
   * It is the better order for the selection too: what the reader had selected before the tour
   * touched the canvas is the thing worth putting back.
   */
  const held = borrow()
  const preamble = spec.prepare?.() ?? ''
  const steps = spec.steps

  /** Undoes the class pinning and the completion poll of whichever step is showing. */
  let releaseStep: (() => void) | undefined

  const endStep = (): void => {
    releaseStep?.()
    releaseStep = undefined
  }

  const driveSteps = steps.map((step, index) => {
    const drive = toDriveStep(step, index, steps.length)
    if (index === 0 && preamble && drive.popover) {
      drive.popover.description = `${step.body}${preamble}`
    }
    return drive
  })

  /**
   * Both directions go through here, from the footer buttons and from the arrow keys alike.
   * `moveTo` rather than `moveNext`, because the index is already computed and the step's
   * `before` has to run against *that* index rather than against wherever driver thinks it is.
   */
  const go = (delta: number): void => {
    const from = tour.getActiveIndex()
    if (from === undefined) return
    const to = from + delta
    if (to < 0) return
    if (to >= steps.length) {
      tour.destroy()
      return
    }
    endStep()
    steps[to]?.before?.()
    tour.moveTo(to)
  }

  /**
   * Watch for the reader having done what this step asked, and move on when they have.
   *
   * The false-to-true rule lives here: a predicate that already holds when the step opens is not
   * something the reader just did, so the step waits for Next instead of vanishing out from
   * under them. See `TourStep.advanceWhen`.
   */
  const watchStep = (step: TourStep | undefined): (() => void) | undefined => {
    if (!step?.advanceWhen) return undefined
    if (step.advanceWhen()) return undefined
    const timer = window.setInterval(() => {
      if (!step.advanceWhen?.()) return
      window.clearInterval(timer)
      go(1)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }

  const config: Config = {
    steps: driveSteps,
    showProgress: true,
    showButtons: ['next', 'previous', 'close'],
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    overlayColor: scrimColor(),
    overlayOpacity: 0.72,
    // Room for the run ring, which is drawn 3–6px outside the card it belongs to and would
    // otherwise be cut in half by the spotlight on the three card steps.
    stagePadding: 8,
    stageRadius: 6,
    /*
     * The default for a step that only explains: the spotlit Run button is not live, so a reader
     * who clicks the thing being pointed at does not fire a graph run. A step that *wants* the
     * press sets `interactive` and turns this off for itself.
     */
    disableActiveInteraction: true,
    // The canvas does not scroll; the page behind it must not either while the stage is placed
    // against viewport coordinates.
    allowScroll: false,
    /*
     * A click on the scrim does nothing. driver's default is to close, which is the right
     * behaviour for a five-step product tour and the wrong one here: these run to thirteen and
     * fifteen stops, half of "Learn to Build" asks the reader to go and click something, and
     * losing the whole thing to a stray click eleven steps in is not a trade worth making. The
     * × and Escape both still leave, and the × is on screen the entire time.
     */
    overlayClickBehavior: () => {},
    onNextClick: () => go(1),
    onPrevClick: () => go(-1),
    /*
     * One more placement pass once the step has actually landed, plus the per-step machinery
     * that needs the resolved element.
     *
     * `refresh` re-places the popover from `__activeStep` — the *committed* step, which driver
     * only writes at the end of its 400 ms transition. Our `onMove` refresh fires throughout
     * React Flow's 240 ms `fitView`, which finishes first, so the last refresh of a card step
     * ran while `__activeStep` was still the step before it: the popover was positioned to the
     * **previous** step's `side` and `align` and, with no further camera movement to trigger
     * another pass, stayed there.
     *
     * It rendered cleanly and read as driver ignoring `side` on some steps and honouring it on
     * others. Measured: the card step asked for `right`/`start` and came back carrying
     * `driver-popover-side-top driver-popover-align-center` — which is exactly what the canvas
     * step before it had asked for.
     *
     * `onHighlighted` is the hook that fires after the commit, so this is the pass that uses the
     * right step. Cheap, and idempotent: repositioning does not re-fire it.
     */
    onHighlighted: (element) => {
      tour.refresh()
      endStep()
      const index = tour.getActiveIndex()
      const step = index === undefined ? undefined : steps[index]
      const unmark = element ? markElement(element, Boolean(step?.interactive)) : undefined
      const unwatch = watchStep(step)
      releaseStep = () => {
        unmark?.()
        unwatch?.()
        step?.after?.()
      }
    },
    onDestroyed: () => {
      endStep()
      setTourHandle(undefined)
      restore(held, spec.restoreSelection)
    },
  }

  const tour: Driver = driver(config)
  setTourHandle(tour)
  // The first step's `before` has no click to hang off, so it runs here.
  steps[0]?.before?.()
  tour.drive(0)
}

/**
 * The two tours, by id.
 *
 * `ensureGraph` is attached here rather than on `GUIDED_SPEC` itself because it is the one part
 * of the Guided Tour's preparation that has to live in this module — it is the only thing that
 * reaches for `FALLBACK_EXAMPLE`. A table plus one exported function, rather than a wrapper each
 * and a ternary in `startTour`: a third tour is then one entry.
 */
const SPECS: Record<TourId, TourSpec> = {
  guided: { ...GUIDED_SPEC, prepare: ensureGraph },
  build: BUILD_SPEC,
  dashboard: DASHBOARD_SPEC,
}

export async function runTour(id: TourId): Promise<void> {
  await drive(SPECS[id])
}
