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
import { arrangeScope, resolveSize } from '../layout/elkGraph'
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

/** Ease-out cubic: fast away from the old arrangement, gentle into the new one. */
function ease(t: number): number {
  return 1 - (1 - t) ** 3
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
  const frame = useRef<number | undefined>(undefined)

  /**
   * How big each card actually is, in flow units, read off the DOM.
   *
   * **Not `node.measured`, and the reason is worth the paragraph.** There are two plausible
   * sources and both are wrong here. `getNodes()` returns a shallow copy of the array *this
   * component built*, so `measured` on it is whatever we put there, which is nothing.
   * `getInternalNode(id).measured` is the real measurement — but React Flow's `adoptUserNodes`
   * only carries it forward while the *user* node object behind it is identity-equal, and
   * otherwise re-seeds it from `userNode.measured`. Coda rebuilds every node object in the
   * `rfNodes` memo on each store change and deliberately never writes React Flow's own
   * dimension measurements back into the document, so **every graph edit wipes every
   * measurement** — and the ResizeObserver does not re-fire for a card whose size did not
   * change, so they do not come back. Observed directly: 9 measured, then 0, then 0.
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
    const sizes = new Map<string, NodeSize>()
    // One query rather than a lookup per id: it avoids escaping ids into a selector, and a
    // loaded file may carry any id at all.
    for (const el of document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')) {
      const id = el.dataset.id
      if (id && el.offsetWidth > 0 && el.offsetHeight > 0) {
        sizes.set(id, { width: el.offsetWidth, height: el.offsetHeight })
      }
    }
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
   * on the left against `translate(50%)` on the right) and the diamond sockets add a `rotate`
   * on top of it. A rect has already applied all three.
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

    for (const el of document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')) {
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
    (final: ReadonlyMap<string, XY>, from: Map<string, XY>, routes: Map<string, XY[]>) => {
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
          frame.current = requestAnimationFrame(step)
          return
        }
        // Commit and drop the overrides together, so the frame that stops drawing the animation
        // is the same one that starts drawing the document. Clearing first flashes the old
        // positions for a frame.
        useGraphStore.getState().arrangeNodes(final)
        publishRoutes(routes)
        setOverrides(null)
        setBusy(false)
      }
      frame.current = requestAnimationFrame(step)
    },
    [publishRoutes],
  )

  const arrange = useCallback(() => {
    const mine = ++token.current
    const state = useGraphStore.getState()
    const current = state.graph
    const scope = arrangeScope(current, state.selection)
    // One node cannot be arranged, and neither can none. No commit, so no undo entry for a
    // press that did nothing.
    if (scope.nodes.length < 2) return

    const measured = measure()
    const sizes = new Map<string, NodeSize>(
      scope.nodes.map((node) => [node.id, resolveSize(node, measured)]),
    )
    const before = boundsOf(scope.nodes, measured)
    if (!before) return

    setBusy(true)
    void runLayout(scope.nodes, scope.edges, state.layoutOptions, measured, measurePorts())
      .then(({ positions: raw, routes: rawRoutes }) => {
        if (token.current !== mine) return
        const anchored = anchorTo(raw, sizes, { x: before.x, y: before.y })
        // Notes are dodged even when only a selection is being arranged: a subgraph landing on
        // a note is the same collision, and the selection is not what decides that.
        const obstacles = noteRects(current, measured)
        const final = dodge(anchored, sizes, obstacles)

        /*
         * The routes take the *same* two shifts the positions did, read back off `place.ts`
         * rather than re-derived here. ELK lays out from the origin and knows nothing about
         * where the work already was, so a route left in raw coordinates would be a wire drawn
         * across the canvas to wherever (0,0) happens to be — and being off by the anchor is not
         * a subtle wrongness, it is the whole graph's width.
         */
        const shift = anchorDelta(raw, sizes, { x: before.x, y: before.y })
        const cleared = dodgeDelta(anchored, sizes, obstacles)
        const routes = translateRoutes(rawRoutes, shift.x + cleared.x, shift.y + cleared.y)

        const from = new Map<string, XY>(
          scope.nodes.map((node) => [node.id, { ...node.position }]),
        )
        if (prefersReducedMotion()) {
          useGraphStore.getState().arrangeNodes(final)
          publishRoutes(routes)
          setBusy(false)
          return
        }
        animate(final, from, routes)
      })
      .catch((error: unknown) => {
        if (token.current !== mine) return
        setBusy(false)
        setOverrides(null)
        useGraphStore
          .getState()
          .setNotice(`Layout failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }, [animate, measure, measurePorts, publishRoutes])

  useEffect(
    () => () => {
      token.current++
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
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
   * flag is the obvious signal — it is what the fit-on-load waits for — but this app defeats it.
   * React Flow's `adoptUserNodes` keeps an internal node's measurements only while the *user*
   * node object behind it is identity-equal; otherwise it rebuilds the entry and re-seeds
   * `measured` from `userNode.measured`. Coda rebuilds every node object in the `rfNodes` memo
   * on each store change, and `onNodesChange` deliberately does not persist React Flow's own
   * dimension measurements into the document — so `userNode.measured` is permanently undefined
   * and the store's `nodesInitialized` latches **false** once the first edit lands.
   *
   * The measurements themselves are fine; they live on the internal node, which is what
   * `measure()` reads. So readiness is asked directly of the sizes about to be used — more
   * precise than the flag, and unlike the flag, true.
   *
   * `armed` is what makes switching the mode on arrange immediately rather than waiting for the
   * next edit — the same call `setAutoRun` makes. Seeded false, so a remount with the mode
   * already on does not re-arrange a canvas nobody touched.
   */
  const armed = useRef(false)
  const lastKey = useRef<string | undefined>(undefined)
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
    if (measured.size < graph.nodes.length && retries.current < MEASURE_RETRIES) {
      const raf = requestAnimationFrame(() => {
        retries.current += 1
        setMeasureTick((tick) => tick + 1)
      })
      return () => cancelAnimationFrame(raf)
    }
    retries.current = 0

    const key = structureKey(graph, measured)
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
  }, [autoLayout, locked, graph, arrange, measure, measureTick])

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current)
    },
    [],
  )

  return { arrange, overrides, routes: held?.routes ?? null, busy }
}
