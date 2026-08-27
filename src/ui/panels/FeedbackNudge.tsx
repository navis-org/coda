/**
 * The alpha's periodic nudge — a small dismissible card asking for feedback roughly once a week.
 *
 * Not a modal: nothing is being asked that blocks the canvas, and a dialog that appears
 * unprompted over somebody's graph is the wrong tone for "got a minute?". A fixed card in the
 * corner, closeable without a click hitting the graph underneath, matches `.share-gate`.
 *
 * `ALPHA_NUDGES` is the single switch for the whole feature. Once Coda leaves alpha this stops
 * being wanted at all — turning it off here is one line, rather than a date compared against
 * `Date.now()` that somebody has to remember to update.
 */

import { useEffect, useState } from 'react'

import { loadFeedbackNudgeAt, saveFeedbackNudgeAt } from '../../store/persistence'
import { useGraphStore } from '../../store/graphStore'

/** Flip to `false` when Coda is no longer soliciting feedback on a schedule. */
const ALPHA_NUDGES = true
const NUDGE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
/** Let the canvas settle before asking for anything — not the first thing on screen. */
const SHOW_DELAY_MS = 4000

export function FeedbackNudge() {
  const requestFeedback = useGraphStore((s) => s.requestFeedback)
  const startPageOpen = useGraphStore((s) => s.startPageOpen)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!ALPHA_NUDGES) return
    const last = loadFeedbackNudgeAt()
    if (last !== undefined && Date.now() - last < NUDGE_INTERVAL_MS) return
    const timer = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])

  const dismiss = () => {
    setVisible(false)
    saveFeedbackNudgeAt(Date.now())
  }

  // Withheld rather than stacked behind the start page: it is not the most specific thing on
  // screen while somebody is still deciding what to open.
  if (!visible || startPageOpen) return null

  return (
    <div className="feedback-nudge" role="note">
      <p>Coda is in alpha — got a minute for feedback? It shapes what we build next.</p>
      <div className="feedback-nudge__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            dismiss()
            requestFeedback('general')
          }}
        >
          Give Feedback
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={dismiss}
          aria-label="Dismiss"
          title="Ask again in a week"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
