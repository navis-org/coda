/**
 * The hairline that says the graph is running, across the top of the dashboard.
 *
 * The dashboard is the one surface with no run indication of its own. A card on the canvas wears
 * `NodeRunRing`, and a `For Each` card its own bar; a cell has neither — the grid draws values,
 * not badges — so a run under a wall of viewers is a wall of viewers that sit there and then
 * change. This is the missing half, and it deliberately borrows the ring's two channels rather
 * than inventing a third vocabulary: **that** it is running, and **how far**.
 *
 * Three things about it are decisions rather than styling.
 *
 * **It takes no layout space.** `--dash-row` is measured from the grid's content box, so a bar
 * that appeared *in the column* would shorten every row the moment a run started and lengthen
 * them again when it stopped — every cell in the grid resized twice per run, WebGL scenes and
 * all, which is the one cost this view is arranged to avoid. So it is absolutely positioned over
 * the header's bottom border, which is where "between the header and the cards" actually is.
 *
 * **It waits before appearing.** `busy` is also true for auto-run's automatic full pass, which
 * fires 700ms after any edit — including a presentational one from a cell's ⚙ rail, where
 * nothing is stale and the run is over in about a millisecond. Without the delay, changing a
 * colour scale blinks a progress bar at somebody a beat later, for a run that did nothing.
 * `RUN_BAR_DELAY_MS` is one `setTimeout` per run, not per tick.
 *
 * **A missing denominator is drawn, not faked.** `RunProgress` is undefined for the moment
 * between `busy` and the scope being known, and for a run whose scope is empty. An indeterminate
 * bar says "working, and I cannot say how far", which is what `NodeRunRing` does with a
 * travelling arc for the same reason: a full bar that means "no idea" reads as finished.
 */

import { useEffect, useState } from 'react'

import { useGraphStore, useRunProgress } from '../../store/graphStore'
import { plural } from '../format'

/**
 * How long a run has to last before it is worth drawing a bar for.
 *
 * Long enough to swallow an auto-run pass with nothing stale in it, short enough that a real run
 * is announced before anybody wonders whether the click landed. The cheap auto pass does not
 * raise `busy` at all, so it is not what this number is defending against — see the file note.
 */
const RUN_BAR_DELAY_MS = 150

export function RunProgressBar() {
  const busy = useGraphStore((s) => s.busy)
  const progress = useRunProgress()

  /*
   * One state flip per run rather than per tick: the timer is armed when a run starts and
   * cleared when it ends, and nothing here re-renders on the progress moving except the bar.
   */
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!busy) {
      setShown(false)
      return
    }
    const timer = setTimeout(() => setShown(true), RUN_BAR_DELAY_MS)
    return () => clearTimeout(timer)
  }, [busy])

  if (!shown) return null

  /*
   * One `undefined` rather than a `determinate` flag beside two placeholder values: React emits
   * no attribute for an `undefined` prop, so the ARIA branch below is the absence itself. A bar
   * with no denominator is a bar with no `valuenow`, which is exactly what the spec means by
   * indeterminate — a 0 there would claim a measurement instead of admitting to none.
   */
  const scope = progress && progress.total > 0 ? progress : undefined
  const percent = scope && Math.round((scope.done / scope.total) * 100)
  // Rounded for the caption only: `done` carries a mid-flight loop's share, and a fraction of a
  // node is not a thing to say out loud. `plural` on the total, so one node reads "1 of 1 node".
  const said = scope && `${Math.round(scope.done)} of ${plural(scope.total, 'node')}`

  return (
    <div
      className="dashboard__progress"
      data-mode={scope ? 'progress' : 'indeterminate'}
      role="progressbar"
      aria-label="Running"
      aria-valuenow={percent}
      aria-valuemin={scope && 0}
      aria-valuemax={scope && 100}
      aria-valuetext={said}
      title={said ? `Running · ${said}` : 'Running'}
    >
      <div
        className="dashboard__progressBar"
        style={scope ? { width: `${percent}%` } : undefined}
      />
    </div>
  )
}
