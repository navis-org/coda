/**
 * The review card's keys (user, 2026-11-22): a verdict on the row under the cursor, then on to the
 * next row nobody has reviewed — `Q` Accept, `W` Reject, `T` Ends, `Y` Unsure, `U` Ignore — and `G`
 * to move on without one. Which keys, and why bare letters, is `REVIEW_KEY_CODES`'; where the
 * cursor goes, `nextToReview`'s; what a verdict writes, the card's own `judge`.
 *
 * Bound here rather than in `Editor.tsx`, as the pick key is (`segmentHover.ts`), and for the same
 * reason: the keys belong to the card and exist only while one is mounted. Two roads, as for `J`
 * — pressed in Coda's document, or in a neuroglancer frame and handed back — both arriving as a
 * `keydown` on the window. With several cards open the keys go to the one `pickingNode` names,
 * never to every card.
 *
 * **Keys only, never the buttons** (user): a click stays where it is, so a reader working with the
 * mouse is not moved off a row they are still looking at.
 */

import { useEffect } from 'react'

import { isTypingTarget } from '../../core/keys'
import type { ReviewKey } from '../../data/neuroglancer/frameMessage'
import { reviewKeyOf } from '../../data/neuroglancer/frameMessage'
import { useGraphStore } from '../../store/graphStore'
import { isTourActive } from '../tour/tourState'
import { useLatest } from '../useLatest'
import { pickingNode } from '../viewers/segmentHover'

type Answer = (key: ReviewKey) => void

/** Who answers, by node id, each card's surfaces in the order they mounted (as `pickers`). */
const answerers = new Map<string, Answer[]>()

function onKey(event: KeyboardEvent): void {
  const key = reviewKeyOf(event)
  // A held key repeats: one verdict per press.
  if (key === undefined || event.repeat || isTypingTarget(event.target)) return
  /*
   * Nor where something else has the keyboard: a tour, as the editor's own letters stand down
   * (`TOUR_DECLINES`); a key a menu or dialog took; one pressed in an open menu or dialog, which
   * may be another row's (the verdict ▾) — a verdict there would land on the row under the cursor.
   */
  if (event.defaultPrevented || isTourActive()) return
  const within = event.target instanceof Element ? event.target : null
  if (within?.closest('[role="menu"], [role="dialog"]')) return
  event.preventDefault()
  const nodeId = pickingNode([...answerers.keys()])
  if (nodeId === undefined) {
    useGraphStore
      .getState()
      .setNotice(
        'Several Review Suggestions cards are open. Select the one to review in, and press the key again.',
      )
    return
  }
  answerers.get(nodeId)?.at(-1)?.(key)
}

/** Hand `answer` every review key pressed while this card is mounted and the one to answer. */
export function useReviewKeys(nodeId: string, answer: Answer): void {
  const latest = useLatest(answer)
  useEffect(() => {
    const mine: Answer = (key) => latest.current(key)
    if (answerers.size === 0) window.addEventListener('keydown', onKey)
    answerers.set(nodeId, [...(answerers.get(nodeId) ?? []), mine])
    return () => {
      const left = (answerers.get(nodeId) ?? []).filter((one) => one !== mine)
      if (left.length > 0) answerers.set(nodeId, left)
      else answerers.delete(nodeId)
      if (answerers.size === 0) window.removeEventListener('keydown', onKey)
    }
  }, [nodeId, latest])
}
