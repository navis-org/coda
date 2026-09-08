/**
 * Driving a layout pass from the canvas.
 *
 * This is the seam between the headless half in `src/layout` and React Flow. It exists here
 * rather than in the store for one reason: **only the canvas knows how big a card is**. A
 * node's height is decided by its param rows, its port count, its body widget and whether it is
 * collapsed, none of which the document records — so the sizes ELK needs come from React Flow's
 * own measurements and nowhere else.
 *
 * The pass is: scope → measure → ELK → anchor → dodge → animate → one commit.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'

import type { MeasuredPorts, MeasuredSizes, NodeSize } from '../layout/elkGraph'
import { measureCardSizes } from './cardSizes'
import { nodesById } from '../core/graph'
import { collapsedView, condense, expandPositions, foldedNodeCount } from '../layout/collapse'
import { arrangeScope } from '../layout/elkGraph'
import { companionView, expandCompanions, pinCompanions } from '../layout/companions'
import { packColumns } from '../layout/pack'
import { packSupported, targetAspect } from '../layout/options'
import { runLayout } from '../layout/engine'
import type { XY } from '../layout/place'
import {
  anchorDelta,
  anchorTo,
  boundsOf,
  dodge,
  dodgeDelta,
  noteRects,
  routeKey,
  structureKey,
  translateRoutes,
} from '../layout/place'
import { useGraphStore } from '../store/graphStore'

/** How long the cards take to glide to their new places. */
const ANIMATION_MS = 300

/**
 * Debounce on auto mode's re-arrange.
 *
 * Short, because the triggers are discrete acts — an add, a wire, a collapse — and waiting after
 * one reads as lag. Its real work is collapsing a *resize* gesture, which arrives as a stream of
 * frames and would otherwise ask for a layout pass per pixel.
 */
const AUTO_DELAY_MS = 120

/**
 * How many frames auto mode waits for a newly added card to be laid out before arranging
 * without it. A ceiling on the retry below, not a number anything is tuned to.
 */
const MEASURE_RETRIES = 10

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * The shape of the space this arrangement will be framed into, as width ÷ height.
 *
 * **`.canvas-area`, not `window`, and the difference is the whole point of measuring.** What a
 * layout is fitted into is the pane — the window minus the toolbar, the panels and, when a viewer
 * is pinned, a whole grid column. On a 16:9 display with the dock open that is nearer 1:1 than
 * 1.78, and the dock is exactly the case somebody would notice. Scoped to that class for the
 * reason `measureCardSizes` records at length: the group peek mounts a second React Flow inside a
 * modal, and it is not the canvas.
 *
 * **A bounding rect, which is the opposite of what `measure` above does, and the exception is the
 * same one `measurePorts` makes.** The pane sits *outside* React Flow's transformed subtree — the
 * camera lives on `.react-flow__viewport`, inside it — so its rect is in CSS pixels at any zoom
 * and needs no division. It is also the one measurement here that wants the fractional answer,
 * `offsetWidth` being rounded to whole pixels.
 *
 * `undefined` for anything unmeasurable: no element yet, or an axis at zero mid-transition.
 * `elkOptionsFor` reads that as "send no key", and ELK answers with its own 1.6 — the same result
 * as leaving the option switched off, which is the right degradation for a number nobody typed.
 *
 * Read once per pass, unconditionally. Gating it on the preference would save one rect and buy a
 * second place that has to know what the preference means.
 *
 * Exported only so `layoutControls.test.tsx` can pin that the *window* is not what answered —
 * the substitution a reader would plausibly make, and the reason `installJsdomStubs` gives
 * `.canvas-area` a size of its own (1200×800, against jsdom's 1024×768). jsdom performs no
 * layout, so whether the pane is measured correctly against real CSS is a browser question.
 */
export function canvasAspect(): number | undefined {
  const pane = document.querySelector('.canvas-area')
  if (!pane) return undefined
  const { width, height } = pane.getBoundingClientRect()
  if (!(width > 0) || !(height > 0)) return undefined
  return width / height
}

/** Ease-out cubic: fast away from the old arrangement, gentle into the new one. */
function ease(t: number): number {
  return 1 - (1 - t) ** 3
}

/**
 * What a pass does besides moving the cards. Both defaults are what the Arrange button wants.
 *
 * Two independent things rather than one "opening" flag, because they are answers to two
 * questions and only one of them is about the reader being there. `animate` is: gliding the
 * cards explains a change to somebody who was looking at the old arrangement, and explains
 * nothing to somebody who has not seen it. `frame` is about the camera, which after a pass that
 * halves a graph's width is pointed at a frame that no longer exists — `loadGraph` already fired
 * its fit, and it framed the row.
 */
interface ArrangeOptions {
  /** Glide the cards to their new places. Off for a pass the reader was not watching. */
  animate?: boolean
  /** Frame the result when it lands, through `requestFitView`. */
  frame?: boolean
}

export interface ArrangeHandle {
  arrange: () => void
  /**
   * Positions to draw *instead of* the document's, while the animation runs.
   *
   * Frames deliberately never reach the store. `commit` re-runs `inferGraph` and
   * `refreshStates` on every call, and an eighteen-frame glide has no business paying for
   * eighteen inference passes to move some rectangles.
   */
  overrides: ReadonlyMap<string, XY> | null
  /**
   * The waypoints ELK bent each wire through, for the arrangement currently on the canvas.
   *
   * `null` whenever there is no arrangement to describe — before the first arrange, after a
   * card was dragged, after a graph was opened. Only the edges that were actually bent appear;
   * most wires are straight and simply have no entry.
   */
  routes: ReadonlyMap<string, readonly XY[]> | null
  busy: boolean
}

export function useArrange(): ArrangeHandle {
  const { getNodes, getInternalNode, getZoom } = useReactFlow()
  const autoLayout = useGraphStore((s) => s.autoLayout)
  /*
   * A locked canvas arranges nothing. `arrangeNodes` refuses the write anyway; what this saves is
   * the work in front of it — `measure()` reads `offsetWidth`/`offsetHeight` off every card, which
   * is a forced synchronous layout per card, and a short measurement then enters a
   * `requestAnimationFrame` retry loop that re-renders the canvas each time. This effect runs on
   * every commit, and a locked graph still gets plenty of those from param edits.
   */
  const locked = useGraphStore((s) => s.locked)
  const graph = useGraphStore((s) => s.graph)

  const [overrides, setOverrides] = useState<ReadonlyMap<string, XY> | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * The routes, together with the arrangement they describe.
   *
   * Held as a pair because a route on its own cannot be checked. Positions are outside
   * `structureKey` on purpose — dragging a card must not ask auto-layout for a new arrangement —
   * so nothing already here fires when a route goes stale, and there is no single event that
   * means it either. `routeKey` is the whole answer: keep them while it matches, drop them when
   * it does not. See `place.ts`.
   */
  const [held, setHeld] = useState<{ key: string; routes: Map<string, XY[]> } | null>(null)
  /** Supersedes an in-flight pass, so a burst of edits cannot land two arrangements at once. */
  const token = useRef(0)
  /** The animation's rAF handle. `frameRef`, because a pass has a `frame` option. */
  const frameRef = useRef<number | undefined>(undefined)

  /**
   * How big each card actually is, in flow units, read off the DOM.
   *
   * **Not `node.measured`, and the reason is worth the paragraph.** There are two plausible
   * sources and both are wrong here. `getNodes()` returns a shallow copy of the array *this
   * component built*, so `measured` on it is whatever we put there, which is nothing.
   * `getInternalNode(id).measured` is the real measurement, and it is only as good as what
   * `rfNodes` last handed back. `adoptUserNodes` carries a measurement forward while the *user*
   * node object behind it is identity-equal and otherwise re-seeds it from `userNode.measured`;
   * Coda rebuilds every node object on each store change, so before `Editor`'s `measuredSizes`
   * existed **every graph edit wiped every measurement** — and the ResizeObserver does not
   * re-fire for a card whose size did not change, so they did not come back. Observed directly:
   * 9 measured, then 0, then 0. They survive an edit now, but a card added *this* tick still has
   * none, and that is the case auto-layout is most often asked about.
   *
   * `offsetWidth`/`offsetHeight` sidestep the whole question. They are layout-space and ignore
   * CSS transforms, so they are the card's size in flow units at *any* zoom — verified at 1.0,
   * 0.833 and 0.694, where the bounding rect reads 520, 433 and 361 and the offset size reads
   * 520 throughout. Zoom-independence is not a nicety: these numbers go into `structureKey`, and
   * a size that drifted with the viewport would have auto-layout re-arranging the graph every
   * time somebody scrolled.
   *
   * Getting the size wrong does not throw and fails no type check. Every card silently falls
   * back to `FALLBACK_NODE_SIZE` and the graph is arranged as a row of identical 232x120 boxes,
   * so the wide ones — Explore at 520, a dataset at 248, a Profile at 560 — get their
   * neighbours packed straight through them.
   */
  const measure = useCallback((): MeasuredSizes => {
    // The DOM read lives in `ui/cardSizes.ts`, because the align tools need exactly the same
    // answer from a context menu that is nowhere near this provider.
    const sizes = new Map<string, NodeSize>(measureCardSizes())
    // For anything with no element to read — React Flow's own measurement, when it still has
    // one. Rarely reached, and better than a fallback box.
    for (const node of getNodes()) {
      if (sizes.has(node.id)) continue
      const measured = getInternalNode(node.id)?.measured
      if (measured?.width && measured.height) {
        sizes.set(node.id, { width: measured.width, height: measured.height })
      }
    }
    return sizes
  }, [getNodes, getInternalNode])

  /**
   * Where every socket sits inside its own card, in flow units.
   *
   * **Read from bounding rects, which is the opposite of what `measure` above does, and the
   * exception is principled.** A rect is in screen pixels and moves with the camera, which is
   * why sizes go through `offsetWidth`; but what is wanted here is a socket's offset *within* a
   * card, and both rects sit inside the same transformed subtree, so dividing the difference by
   * the zoom cancels the camera exactly. The offset walk that would avoid the division cannot be
   * used: a handle is positioned with `top: 50%` and centred by a `transform`, and `offsetTop`
   * is the pre-transform border-box top — so the correction differs by side (`translate(-50%)`
   * on the left against `translate(50%)` on the right) and the diamond sockets carry a `rotate`
   * after it. A rect has already applied all three.
   *
   * That last clause is true by construction rather than by luck, and it was not always: since
   * `transform` is one property, `editor.css`' diamond rule *replaced* the centring instead of
   * adding to it, and every Matrix socket sat 4px low. It restates the translate now — see the
   * comment there.
   *
   * **React Flow's own `handleBounds` would be the obvious source and is unusable here**, for
   * exactly the reason `measure` cannot use `node.measured`: `parseHandles` returns
   * `!userNode.measured ? undefined : …`, and this app never writes `measured` back into the
   * document, so `adoptUserNodes` wipes the handle bounds on every graph edit and React Flow
   * re-measures them asynchronously afterwards. Reading them synchronously during an arrange is
   * reading whatever survived the last edit.
   *
   * Kept out of `measure()` deliberately. That one runs on every graph change to compute
   * `structureKey`, and a rect per socket per card on each keystroke is a forced layout nobody
   * asked for. This runs once per arrange.
   */
  const measurePorts = useCallback((): MeasuredPorts => {
    const ports = new Map<string, Map<string, XY>>()
    const zoom = getZoom()
    // A degenerate zoom would divide the offsets into nonsense, and a pinned port at the wrong
    // place is worse than no pinning at all — `toElkGraph` falls back to `FIXED_ORDER` per card.
    if (!Number.isFinite(zoom) || zoom <= 0) return ports

    // `.canvas-area`, for the reason `measureCardSizes` records at length: the group peek mounts
    // the same cards inside a modal, and their ids are the same ids.
    for (const el of document.querySelectorAll<HTMLElement>(
      '.canvas-area .react-flow__node[data-id]',
    )) {
      const id = el.dataset.id
      if (!id) continue
      const card = el.getBoundingClientRect()
      if (card.width === 0 || card.height === 0) continue
      const offsets = new Map<string, XY>()
      for (const handle of el.querySelectorAll<HTMLElement>(
        '.react-flow__handle[data-handleid]',
      )) {
        const portId = handle.dataset.handleid
        if (!portId) continue
        const box = handle.getBoundingClientRect()
        offsets.set(portId, {
          x: (box.left + box.width / 2 - card.left) / zoom,
          y: (box.top + box.height / 2 - card.top) / zoom,
        })
      }
      /*
       * Two sockets at the same point is a measurement that says nothing, and under `FIXED_POS`
       * it is worse than nothing: ELK routes both wires into one coordinate, so two links leave
       * the card superimposed and the port order it was given is silently discarded. A real card
       * never stacks its sockets — even a folded one fans them by `--port-pitch` — so exact
       * agreement across every one of them means the rects were not describing this card.
       *
       * Which is precisely what a test environment produces: jsdom performs no layout and the
       * stub answers one rect for every element, so every socket resolves to the card's centre.
       * Same shape as the fallback-size trap the sizes above document, and the same answer —
       * fall back per card rather than arrange against a number that was never measured.
       */
      const distinct = new Set([...offsets.values()].map((p) => `${p.x},${p.y}`))
      if (offsets.size > 0 && (offsets.size === 1 || distinct.size > 1)) ports.set(id, offsets)
    }
    return ports
  }, [getZoom])

  /**
   * Keep the routes, stamped with the arrangement they belong to.
   *
   * Called *after* `arrangeNodes` has committed, so the key is read off the graph the canvas is
   * about to draw rather than off the one it was drawing. Computing it from `final` by hand
   * would be a second, hand-rolled copy of what `routeKey` says an arrangement is, and the two
   * would agree only until somebody added a field to one of them.
   */
  const publishRoutes = useCallback(
    (routes: Map<string, XY[]>) => {
      if (routes.size === 0) {
        setHeld(null)
        return
      }
      setHeld({ key: routeKey(useGraphStore.getState().graph, measure()), routes })
    },
    [measure],
  )

  const animate = useCallback(
    (
      final: ReadonlyMap<string, XY>,
      from: Map<string, XY>,
      routes: Map<string, XY[]>,
      frame: boolean,
    ) => {
      const mine = token.current
      const start = performance.now()
      const step = () => {
        if (token.current !== mine) return
        const t = Math.min(1, (performance.now() - start) / ANIMATION_MS)
        const eased = ease(t)
        const at = new Map<string, XY>()
        for (const [id, target] of final) {
          const origin = from.get(id) ?? target
          at.set(id, {
            x: origin.x + (target.x - origin.x) * eased,
            y: origin.y + (target.y - origin.y) * eased,
          })
        }
        if (t < 1) {
          setOverrides(at)
          frameRef.current = requestAnimationFrame(step)
          return
        }
        // Commit and drop the overrides together, so the frame that stops drawing the animation
        // is the same one that starts drawing the document. Clearing first flashes the old
        // positions for a frame.
        useGraphStore.getState().arrangeNodes(final)
        publishRoutes(routes)
        setOverrides(null)
        setBusy(false)
        if (frame) useGraphStore.getState().requestFitView()
      }
      frameRef.current = requestAnimationFrame(step)
    },
    [publishRoutes],
  )

  const runArrange = useCallback(
    ({ animate: gliding = true, frame = false }: ArrangeOptions = {}) => {
      const mine = ++token.current
      const state = useGraphStore.getState()
      const opts = state.layoutOptions
      const current = state.graph
      const scope = arrangeScope(current, state.selection)
      // One node cannot be arranged, and neither can none. No commit, so no undo entry for a
      // press that did nothing.
      if (scope.nodes.length < 2) return

      const measured = measure()
      /*
       * Collapsed groups take part as **one box each**, which is the whole of what this pass has
       * to know about them. Arranging the members instead would move cards nobody can see, reserve
       * their space in the layout and leave the box wherever its top-left member landed — a graph
       * with a hole in it and a card in the wrong place, from a button that looks like it worked.
       *
       * Condensed *after* scoping, so a selection decides which cards take part and the folding
       * decides how they are counted. See `layout/collapse.ts`.
       */
      const view = collapsedView(current, measured)
      // `scope.omit` rather than a second `referenceEdgeIds` call: the fold re-derives its
      // stand-ins from the whole graph, so a rule the scope applied has to be handed on or it is
      // undone for exactly the folded annotation chains it was written for. See `condense`.
      const folded = condense(scope.nodes, scope.edges, view, scope.omit)
      /*
       * Then the companion cards, which is the same move one level down: a Description is not a
       * step in the pipeline, so it leaves the layout and its dataset's box grows to hold the
       * place it will be put back in. *After* the fold, because a card inside a folded group is
       * not on the canvas and has no place of its own to be put back into — `condense` has
       * already replaced it with a box by the time this asks. See `layout/companions.ts`.
       */
      const pins = companionView(folded.nodes, folded.edges, measured)
      /*
       * Nodes, edges and sizes together, because they have to agree: `sizes` is keyed by layout
       * item — boxes in, pinned companions out, hosts grown to hold the card that is coming back
       * — and everything after this reads *it* rather than `measured`. What ELK is told, what
       * `boundsOf` anchors against and what `dodge` keeps off the notes are then one answer, or
       * the space reserved for a companion is reserved in the layout and nowhere else.
       */
      const {
        nodes: items,
        edges: links,
        sizes,
      } = pinCompanions(folded.nodes, folded.edges, pins, measured)
      if (items.length < 2) return
      const before = boundsOf(items, sizes)
      if (!before) return

      setBusy(true)
      const aspect = canvasAspect()
      void runLayout(items, links, opts, sizes, measurePorts(), aspect)
        .then(({ positions: laid, routes: rawRoutes }) => {
          if (token.current !== mine) return
          /*
           * Packed before anything is anchored, because the pack changes the block's *shape* and
           * the anchor is about where that shape lands. It aims at the pane it is about to be
           * framed into — the one input here the graph cannot answer, which is `canvasAspect`'s
           * whole reason for existing; an unmeasurable pane falls to `PACK_TARGET_ASPECT`.
           *
           * **The routes are given up whenever it moves anything**, and that is not a shortcut.
           * ELK's bend points describe gaps between cards at the positions ELK chose, so a card
           * that has since moved to another column leaves its wire heading into empty space —
           * exactly the staleness `routeKey` drops a whole arrangement's routes for. The pass
           * reports whether it moved anything rather than leaving the caller to compare maps,
           * because it always builds one: read as identity this was true on every arrange, and
           * the routes were being dropped even on the graphs it declined to touch.
           */
          const { positions: raw, moved: packed } =
            opts.packColumns && packSupported(opts)
              ? packColumns(items, links, laid, sizes, opts, targetAspect(aspect))
              : { positions: laid, moved: false }
          const anchor = { x: before.x, y: before.y }
          const anchored = anchorTo(raw, sizes, anchor)
          // Notes are dodged even when only a selection is being arranged: a subgraph landing on
          // a note is the same collision, and the selection is not what decides that.
          const obstacles = noteRects(current, measured, view.hidden)
          // Still keyed by box wherever a group is folded: `dodge` and the routes below both work
          // in the arranged vocabulary, and only the positions handed to the store are expanded.
          const placed = dodge(anchored, sizes, obstacles)
          // Companions first, then folded members: each undoes one of the two condensations, in
          // the reverse of the order they were applied.
          const final = expandPositions(expandCompanions(placed, pins), view)

          /*
           * The routes take the *same* two shifts the positions did, read back off `place.ts`
           * rather than re-derived here. ELK lays out from the origin and knows nothing about
           * where the work already was, so a route left in raw coordinates would be a wire drawn
           * across the canvas to wherever (0,0) happens to be — and being off by the anchor is not
           * a subtle wrongness, it is the whole graph's width.
           */
          const shift = anchorDelta(raw, sizes, anchor)
          const cleared = dodgeDelta(anchored, sizes, obstacles)
          const routes = packed
            ? new Map<string, XY[]>()
            : translateRoutes(rawRoutes, shift.x + cleared.x, shift.y + cleared.y)

          // The *members'* starting places, not the boxes': the animation drives the real cards,
          // and a box is drawn from wherever its members currently are — so it glides with them.
          // Indexed rather than scanned: `find` per arranged node is O(n·m) over the document.
          const byId = nodesById(current)
          const from = new Map<string, XY>()
          for (const id of final.keys()) {
            const node = byId.get(id)
            if (node) from.set(id, { ...node.position })
          }
          // A pass nobody watched lands the same way one somebody asked not to see does, so the
          // two share a branch: there is nothing to explain and no old arrangement to leave.
          if (!gliding || prefersReducedMotion()) {
            useGraphStore.getState().arrangeNodes(final)
            publishRoutes(routes)
            setBusy(false)
            if (frame) useGraphStore.getState().requestFitView()
            return
          }
          animate(final, from, routes, frame)
        })
        .catch((error: unknown) => {
          if (token.current !== mine) return
          setBusy(false)
          setOverrides(null)
          useGraphStore
            .getState()
            .setNotice(
              `Layout failed: ${error instanceof Error ? error.message : String(error)}`,
            )
        })
    },
    [animate, measure, measurePorts, publishRoutes],
  )

  /**
   * The Arrange button's pass — glides, and leaves the camera alone.
   *
   * Zero-arg on purpose: `LayoutControls` passes this straight to `onClick`, so a first
   * parameter would be handed a React `MouseEvent` and every property read off it would be
   * `undefined` — which for an options object means the defaults, i.e. right by accident until
   * somebody adds an option whose default is `true`.
   */
  const arrange = useCallback(() => runArrange(), [runArrange])

  useEffect(
    () => () => {
      token.current++
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  /**
   * Drop the routes as soon as they stop describing the canvas.
   *
   * A route is a path through particular gaps between particular cards. Move one and the
   * waypoints describe a picture that is no longer there — a wire heading confidently into empty
   * space, which reads much worse than the curve it replaced, because a curve that goes through
   * a card still plainly connects two sockets. Nothing re-routes on a drag: that is an ELK pass
   * per pointer move, which is the cost the whole arrangement is debounced to avoid.
   *
   * Runs while an animation is in flight too, and harmlessly: the frames never reach the store,
   * so `graph` does not change until the single commit at the end — which is also when the new
   * routes are published, under the key that commit produces.
   */
  useEffect(() => {
    if (!held) return
    if (routeKey(graph, measure()) === held.key) return
    setHeld(null)
  }, [graph, held, measure])

  // --- auto mode ----------------------------------------------------------

  /**
   * Re-arrange when the *structure* changes, and only then.
   *
   * **Not gated on `useNodesInitialized`, and that is a finding rather than an oversight.** That
   * flag is the obvious signal — it is what the fit-on-load waits for — but this app defeated it
   * for most of its life. React Flow's `adoptUserNodes` keeps an internal node's measurements
   * only while the *user* node object behind it is identity-equal; otherwise it rebuilds the
   * entry and re-seeds `measured` from `userNode.measured`. Coda rebuilds every node object in
   * the `rfNodes` memo on each store change, and with nothing putting a measurement back on it
   * `userNode.measured` was permanently undefined, so the store's `nodesInitialized` latched
   * **false** once the first edit landed. `Editor`'s `measuredSizes` now hands them back — for
   * the minimap, which cannot draw a card it has no size for — and the flag would recover.
   *
   * The gate stays off all the same, because the question it answers is the wrong one: it is
   * about *every* node, and what matters here is the sizes this pass is about to use. Readiness
   * is asked of those directly — more precise than the flag, and it was never at its mercy.
   *
   * `armed` is what makes switching the mode on arrange immediately rather than waiting for the
   * next edit — the same call `setAutoRun` makes. Seeded false, so a remount with the mode
   * already on does not re-arrange a canvas nobody touched.
   */
  const armed = useRef(false)
  const lastKey = useRef<string | undefined>(undefined)
  /**
   * The one-shot pass a builder asks for — see `GraphState.arrangeRequest`.
   *
   * It rides *this* effect rather than one of its own, because what it needs is the half that is
   * hard: waiting until every drawn card has a real `offsetWidth`, which is the retry below.
   * A pass fired before then arranges the graph around `FALLBACK_NODE_SIZE` boxes, so an Explore
   * card at 520 gets its neighbour packed straight through it — the failure `measure` records,
   * and one that looks like a layout bug rather than a timing one.
   *
   * **Seeded from the store at mount**, `fitRequest`'s guard: a request made while the dashboard
   * was up — where there is no canvas and no `useArrange` at all — is dropped rather than fired
   * at whoever next presses `D`, and a remount does not re-arrange a graph somebody has since
   * moved by hand.
   *
   * That drop is a property of the ref rather than something the suite pins, and the attempt is
   * worth recording. A test that raises a request with the grid up, opens the canvas and asserts
   * nothing moved is asserting an *absence*, and every way of waiting for one here is a race: a
   * fixed window passes whenever it is shorter than a pass, which at 60ms against a pass that
   * takes ~400 it was, guard deliberately broken and the test still green. Counting commits
   * instead does not separate them either — `token` supersedes an in-flight pass, so a stray
   * request answered a moment before a real one lands as *one* commit, which is the same number
   * the correct behaviour produces. What is asserted instead is the half that decides it in
   * practice: the wizard does not raise a request it knows nothing will answer
   * (`wizardDialog.test.tsx`).
   */
  const arrangeRequest = useGraphStore((s) => s.arrangeRequest)
  const handledRequest = useRef(arrangeRequest)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Bumped to re-run this effect once the browser has laid a new card out. */
  const [measureTick, setMeasureTick] = useState(0)
  const retries = useRef(0)

  useEffect(() => {
    /*
     * Before `measure()`, deliberately. Below the measurement this read as a guard and cost as
     * much as no guard at all.
     *
     * `lastKey` is left alone: on unlock the effect re-runs with `armed` false, so `firstArm` is
     * true and the arrange happens whatever the key says. The pending timer *is* cleared, or an
     * arrange scheduled a moment before the lock would land on a frozen canvas.
     */
    if (locked) {
      armed.current = false
      if (pending.current) {
        clearTimeout(pending.current)
        pending.current = undefined
      }
      return
    }

    const measured = measure()
    /*
     * Wait until every card has a size, and *come back* if one does not.
     *
     * This effect runs when the graph commits, which for an added node is before the browser
     * has laid its card out — so the newcomer has no `offsetWidth` yet and `resolveSize` would
     * hand ELK a `FALLBACK_NODE_SIZE` box, arranging the graph around a card of the wrong shape.
     *
     * The retry is what makes it correct rather than merely careful. Nothing else re-runs this:
     * the deps are the graph and the mode, and a card being laid out changes neither, so simply
     * returning meant a node added with auto-layout on stayed exactly where the palette dropped
     * it, on top of whatever was underneath. A frame is the right unit to wait on, since layout
     * is what is being waited for. Bounded, and then it proceeds anyway — arranging around one
     * fallback box is bad, never arranging at all is worse.
     */
    // Cards inside a folded group are not on the canvas and will never be measured, so the count
    // to wait for is what is *drawn* — the box itself is a card and does get measured. The count
    // rather than the whole view: this runs on every commit, which during a drag is every frame,
    // and the view also walks the edges and mints a wire per crossing to be thrown away.
    const drawn = graph.nodes.length - foldedNodeCount(graph)
    if (measured.size < drawn && retries.current < MEASURE_RETRIES) {
      const raf = requestAnimationFrame(() => {
        retries.current += 1
        setMeasureTick((tick) => tick + 1)
      })
      return () => cancelAnimationFrame(raf)
    }
    retries.current = 0

    const key = structureKey(graph, measured)
    /*
     * Ahead of the auto-layout branch, because the two are unrelated and this one has to happen
     * whatever the mode says — `loadGraph` turns auto-layout *off* on every open, so a requested
     * pass gated behind it would never run at all.
     *
     * `lastKey` is advanced with it: the arrangement about to land is this structure's, and
     * leaving it stale would have auto mode re-arrange the same graph a moment later for anybody
     * who had the mode on.
     */
    if (arrangeRequest !== handledRequest.current) {
      handledRequest.current = arrangeRequest
      lastKey.current = key
      // Not gliding, and framed when it lands: the reader has not seen the arrangement this is
      // moving away from, and the fit `loadGraph` fired framed it.
      runArrange({ animate: false, frame: true })
      return
    }
    if (!autoLayout) {
      armed.current = false
      lastKey.current = key
      if (pending.current) {
        clearTimeout(pending.current)
        pending.current = undefined
      }
      return
    }
    const firstArm = !armed.current
    /*
     * Return *without* touching the pending timer.
     *
     * Cancelling here and rescheduling at the top was the bug: this effect re-runs whenever
     * React Flow finishes measuring, that pass finds the key unchanged and returns — having
     * already cancelled the arrange the previous pass scheduled, and having already advanced
     * `lastKey`, so nothing ever reschedules it. The visible symptom was a node added with
     * auto-layout on simply staying where the palette dropped it, straight through whatever
     * was underneath.
     */
    if (!firstArm && key === lastKey.current) return

    armed.current = true
    lastKey.current = key
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(arrange, AUTO_DELAY_MS)
  }, [autoLayout, locked, graph, arrange, runArrange, arrangeRequest, measure, measureTick])

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current)
    },
    [],
  )

  return { arrange, overrides, routes: held?.routes ?? null, busy }
}
