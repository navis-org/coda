/**
 * A viewer with nothing to draw, and the sentence saying why.
 *
 * The wrapper every viewer wrote out for itself — about twenty copies of the same two `div`s. The
 * sentence is the part worth each viewer's attention: "nothing to plot" and "nothing *yet*" are
 * different states, and the reader is owed which one this is.
 */

import type { ReactNode } from 'react'

export function ViewerEmpty({
  stacked = false,
  children,
}: {
  /** A column rather than a line — for a message with an action under it. */
  stacked?: boolean
  children: ReactNode
}) {
  return (
    <div className="viewer">
      <div className={stacked ? 'viewer__empty viewer__empty--stacked' : 'viewer__empty'}>
        {children}
      </div>
    </div>
  )
}
