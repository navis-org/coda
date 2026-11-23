/**
 * The segment under the pointer in any of Coda's own neuroglancer frames (`FrameHoverMessage`),
 * for the review card to light its rows by (user, 2026-11-19), and to take a hand pick from.
 *
 * One for the whole app rather than one per Neuroglancer node: a root id names one object
 * whichever frame it was hovered in, so a card asks only whether it lists it — the full-size
 * viewer wired to its `Layers` and the viewer inside its own expanded body alike, with no wire to
 * follow between them. Only the frame that set a value clears it, so a frame unmounting cannot
 * wipe another's.
 *
 * **A hand pick** (`J`, `handPicks.ts`) is the segment under the pointer and the place the pointer
 * is on it. The key reaches Coda by two roads — pressed with focus in Coda's document, or in the
 * frame and handed back (`isPickKey`) — and both arrive here as a `keydown` on the window. The
 * card's button takes the segment the pointer last **rested** on instead, since by the time the
 * button is pressed the pointer has left the frame, crossing whatever lay on its way out.
 */

import { useEffect, useSyncExternalStore } from 'react'

import { isTypingTarget } from '../../core/keys'
import { channel } from '../../data/channel'
import { isPickKey } from '../../data/neuroglancer/frameMessage'
import { useGraphStore } from '../../store/graphStore'
import { useLatest } from '../useLatest'

/** How long the pointer rests on a segment before the card scrolls its row into view. */
export const REST_MS = 500

/** A segment pointed at, and where on it, absolute nm, where the frame could say. */
export interface PointedSegment {
  readonly segment: string
  readonly positionNm?: readonly [number, number, number]
  /** The frame's layer the segment is from (`FrameHoverMessage.layer`), where it said. */
  readonly layer?: string
}

/**
 * The pointer on one segment in one frame. Its place moves with the pointer, written in place:
 * nothing renders from it, so a move over the same segment re-renders nothing.
 */
interface Stay {
  readonly point: {
    readonly segment: string
    positionNm?: readonly [number, number, number]
    readonly layer?: string
  }
  readonly from: object
}

let hovered: Stay | undefined
/**
 * The last stay that lasted `REST_MS`, counted, and what `useRestedSegment` hands out. Its point
 * only, never the frame, which may be gone by the time the button is pressed.
 */
let rest:
  | { readonly point: Stay['point']; readonly view: { segment: string; count: number } }
  | undefined
let restTimer: ReturnType<typeof setTimeout> | undefined
const changed = channel()
/** Every report, a move over the same segment included — what `changed` leaves out. */
const moved = channel()

/** Say what `from` — a frame — has under the pointer, and where; `undefined` for nothing. */
export function setHoveredSegment(
  from: object,
  segment: string | undefined,
  positionNm?: readonly [number, number, number],
  layer?: string,
): void {
  record(from, segment, positionNm, layer)
  moved.notify()
}

function record(
  from: object,
  segment: string | undefined,
  positionNm?: readonly [number, number, number],
  layer?: string,
): void {
  if (segment === undefined) {
    if (hovered?.from !== from) return
    hovered = undefined
    clearTimeout(restTimer)
  } else if (
    hovered?.point.segment === segment &&
    hovered.point.layer === layer &&
    hovered.from === from
  ) {
    hovered.point.positionNm = positionNm
    return
  } else {
    const point = { segment, positionNm, ...(layer === undefined ? {} : { layer }) }
    hovered = { point, from }
    clearTimeout(restTimer)
    restTimer = setTimeout(() => {
      rest = { point, view: { segment, count: (rest?.view.count ?? 0) + 1 } }
      changed.notify()
    }, REST_MS)
  }
  changed.notify()
}

/**
 * Hear every pointer report from any frame, a move over the same segment included — for reading
 * ahead under a resting pointer (the split key, `ui/seam/splitKey.ts`), where the segment
 * changing is not the event. Read `pointerStay()` on each.
 */
export function onPointerMove(listener: () => void): () => void {
  return moved.subscribe(listener)
}

export function hoveredSegment(): string | undefined {
  return hovered?.point.segment
}

/**
 * The segment under the pointer, where it is, and the frame it is in — for a key whose meaning
 * depends on which frame's dataset the segment is from (the split key, `ui/seam/splitSession.ts`).
 * A copy of the point, as every point handed out is.
 */
export function pointerStay(): { point: PointedSegment; from: object } | undefined {
  return hovered && { point: { ...hovered.point }, from: hovered.from }
}

export function useHoveredSegment(): string | undefined {
  return useSyncExternalStore(changed.subscribe, hoveredSegment)
}

const restView = () => rest?.view

/**
 * The segment the pointer has rested on for `REST_MS`, counted, so resting on the same one again
 * after moving off is a new rest — what a scroll follows, where the highlight follows every move.
 */
export function useRestedSegment(): { segment: string; count: number } | undefined {
  return useSyncExternalStore(changed.subscribe, restView)
}

/**
 * The segment the pointer last rested on, and where it was last on it — what the button takes.
 * A copy, as every point handed out is: the held one moves on with the pointer.
 */
export function restedPoint(): PointedSegment | undefined {
  return rest && { ...rest.point }
}

type Take = (pointed: PointedSegment) => void

/**
 * Who takes a pick, by node id, each card's surfaces in the order they mounted: a card drawn on
 * two surfaces answers once, from the newest, and the older answers again when that one goes.
 *
 * Bound here rather than in `Editor.tsx`, which owns the app's bindings: the key belongs to the
 * review card and exists only while one is mounted, as `useOverlayEscape`'s Escape belongs to an
 * overlay. `shortcuts.ts` still lists it, so the shortcut dialog shows it.
 */
const pickers = new Map<string, Take[]>()

function onKey(event: KeyboardEvent): void {
  // A held key repeats: one pick per press.
  if (event.repeat || !isPickKey(event) || isTypingTarget(event.target) || !hovered) return
  event.preventDefault()
  const nodeId = pickingNode([...pickers.keys()])
  if (nodeId === undefined) {
    useGraphStore
      .getState()
      .setNotice(
        'Several Review Suggestions cards are open. Select the one to add the piece to, and press J again.',
      )
    return
  }
  pickers.get(nodeId)?.at(-1)?.({ ...hovered.point })
}

/**
 * Which card a pick goes to: the only one open, else the one expanded, pinned or alone selected —
 * never every card, each of which would add the piece to its own neuron. The verdict keys ask the
 * same (`ui/seam/reviewKeys.ts`).
 */
export function pickingNode(ids: readonly string[]): string | undefined {
  if (ids.length <= 1) return ids[0]
  const { expandedNodeId, pinnedNodeId, selection } = useGraphStore.getState()
  const selected = selection.filter((id) => ids.includes(id))
  return [expandedNodeId, pinnedNodeId, selected.length === 1 ? selected[0] : undefined].find(
    (id) => id !== undefined && ids.includes(id),
  )
}

/** Hand `take` the segment under the pointer whenever the pick key is pressed, while mounted. */
export function useSegmentPick(nodeId: string, take: Take): void {
  const latest = useLatest(take)
  useEffect(() => {
    const mine: Take = (pointed) => latest.current(pointed)
    if (pickers.size === 0) window.addEventListener('keydown', onKey)
    pickers.set(nodeId, [...(pickers.get(nodeId) ?? []), mine])
    return () => {
      const left = (pickers.get(nodeId) ?? []).filter((one) => one !== mine)
      if (left.length > 0) pickers.set(nodeId, left)
      else pickers.delete(nodeId)
      if (pickers.size === 0) window.removeEventListener('keydown', onKey)
    }
  }, [nodeId, latest])
}
