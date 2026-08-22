/**
 * How old the data behind a node's result is, and the control that replaces it.
 *
 * `cached 3d ago ⟳`, in the card's foot, on any node declaring `dataCache`. The age is the whole
 * point: an annotation base is somebody's spreadsheet, edited daily, and `loadCachedTable` keeps
 * a copy for a month — so a node can sit there green, answering in milliseconds, on a table
 * nobody has re-read since. Nothing on the card said so, and nothing could: a cache hit and a
 * fresh read are indistinguishable from the rows.
 *
 * **It is the affordance rather than a badge.** What somebody wants on reading "3d" is a fresher
 * copy, and a passive marker means finding Clear Cache in a menu and then pressing Run — two
 * gestures away from the thing that prompted it. So the whole clause is the button: it clears the
 * node's data cache and runs it.
 *
 * **Shown whenever there is an age, not only when it is large.** A line that appears only when
 * something is wrong is a line nobody learns to look at — the rule that keeps geometry units
 * printed when they are the expected ones, and the matched half of `unmatchedLabels` on screen.
 * A fresh read reads `cached 0s ago`, which is exactly as informative as it sounds and is what
 * makes the number believable the day it says `28d`.
 */

import { useEffect, useState } from 'react'

import { formatAge } from '../format'

/** How often the label re-reads the clock. A minute, since the unit never changes faster. */
const TICK_MS = 60_000

export interface CacheAgeProps {
  /** Epoch ms the data was read from a server, or undefined when the node did not report one. */
  fetchedAt: number | undefined
  /** Clear this node's data cache and run it again. */
  onRefresh: () => void
}

export function CacheAge({ fetchedAt, onRefresh }: CacheAgeProps) {
  /*
   * A counter rather than a stored age: the value is derived at render from `Date.now()`, so a
   * card mounted at any point shows the right number without waiting for the first tick, and
   * nothing has to be kept in step. Only running while there is something to say.
   */
  const [, tick] = useState(0)
  useEffect(() => {
    if (fetchedAt === undefined) return
    const id = setInterval(() => tick((n) => n + 1), TICK_MS)
    return () => clearInterval(id)
  }, [fetchedAt])

  if (fetchedAt === undefined) return null
  const age = formatAge(Date.now() - fetchedAt)
  return (
    <button
      type="button"
      className="coda-node__cache nodrag"
      // `nodrag` because the foot sits on a draggable card, and a control that pans the canvas
      // when you press it is not a control.
      title={`Data read ${age} ago — click to fetch it again`}
      onClick={(event) => {
        event.stopPropagation()
        onRefresh()
      }}
    >
      cached {age} ago <span aria-hidden="true">⟳</span>
    </button>
  )
}
