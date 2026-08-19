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

import type { MeasuredSizes, NodeSize } from '../layout/elkGraph'
import { arrangeScope, resolveSize } from '../layout/elkGraph'
import { runLayout } from '../layout/engine'
import type { XY } from '../layout/place'
import { anchorTo, boundsOf, dodge, noteRects, structureKey } from '../layout/place'
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
  busy: boolean
}

export function useArrange(): ArrangeHandle {
  const { getNodes, getInternalNode } = useReactFlow()
  const autoLayout = useGraphStore((s) => s.autoLayout)
  const graph = useGraphStore((s) => s.graph)

  const [overrides, setOverrides] = useState<ReadonlyMap<string, XY> | null>(null)
  const [busy, setBusy] = useState(false)
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

  const animate = useCallback((final: ReadonlyMap<string, XY>, from: Map<string, XY>) => {
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
      setOverrides(null)
      setBusy(false)
    }
    frame.current = requestAnimationFrame(step)
  }, [])

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
    void runLayout(scope.nodes, scope.edges, state.layoutOptions, measured)
      .then((raw) => {
        if (token.current !== mine) return
        const anchored = anchorTo(raw, sizes, { x: before.x, y: before.y })
        // Notes are dodged even when only a selection is being arranged: a subgraph landing on
        // a note is the same collision, and the selection is not what decides that.
        const final = dodge(anchored, sizes, noteRects(current, measured))

        const from = new Map<string, XY>(
          scope.nodes.map((node) => [node.id, { ...node.position }]),
        )
        if (prefersReducedMotion()) {
          useGraphStore.getState().arrangeNodes(final)
          setBusy(false)
          return
        }
        animate(final, from)
      })
      .catch((error: unknown) => {
        if (token.current !== mine) return
        setBusy(false)
        setOverrides(null)
        useGraphStore
          .getState()
          .setNotice(`Layout failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }, [animate, measure])

  useEffect(
    () => () => {
      token.current++
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    },
    [],
  )

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
  }, [autoLayout, graph, arrange, measure, measureTick])

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current)
    },
    [],
  )

  return { arrange, overrides, busy }
}
