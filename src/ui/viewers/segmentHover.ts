/**
 * The segment under the pointer in any of Coda's own neuroglancer frames (`FrameHoverMessage`),
 * for the review card to light its rows by (user, 2026-11-19).
 *
 * One for the whole app rather than one per Neuroglancer node: a root id names one object
 * whichever frame it was hovered in, so a card asks only whether it lists it — the full-size
 * viewer wired to its `Layers` and the viewer inside its own expanded body alike, with no wire to
 * follow between them. Only the frame that set a value clears it, so a frame unmounting cannot
 * wipe another's.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'

import { channel } from '../../data/channel'

/** How long the pointer rests on a segment before the card scrolls its row into view. */
export const REST_MS = 500

let hovered: { segment: string; from: object } | undefined
const changed = channel()

/** Say what `from` — a frame — has under the pointer; `undefined` for nothing. */
export function setHoveredSegment(from: object, segment: string | undefined): void {
  if (segment === undefined) {
    if (hovered?.from !== from) return
    hovered = undefined
  } else if (hovered?.segment === segment && hovered.from === from) return
  else hovered = { segment, from }
  changed.notify()
}

export function hoveredSegment(): string | undefined {
  return hovered?.segment
}

export function useHoveredSegment(): string | undefined {
  return useSyncExternalStore(changed.subscribe, hoveredSegment)
}

/**
 * The segment the pointer has rested on for `REST_MS`, counted, so resting on the same one again
 * after moving off is a new rest — what a scroll follows, where the highlight follows every move.
 */
export function useRestedSegment(): { segment: string; count: number } | undefined {
  const now = useHoveredSegment()
  const [rested, setRested] = useState<{ segment: string; count: number }>()
  useEffect(() => {
    if (now === undefined) return
    const timer = setTimeout(
      () => setRested((last) => ({ segment: now, count: (last?.count ?? 0) + 1 })),
      REST_MS,
    )
    return () => clearTimeout(timer)
  }, [now])
  return rested
}
