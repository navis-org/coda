/**
 * The store's notice — a sentence any surface can leave for the reader (`setNotice`): why a pick
 * was refused, why a Submit did not open, what a shortcut did.
 *
 * **Drawn by whichever view holds the canvas column**: `Editor` and `DashboardView` each render
 * one. It was `Editor`'s alone, and `Editor` is not mounted while the dashboard is up, so a
 * reader working from the dashboard was told nothing at all — a hand pick (`J`) refused in a
 * sentence read as "nothing happens" (user, 2026-11-20).
 */

import { useGraphStore } from '../store/graphStore'
import { dismissNotice } from './noticeDismiss'

export function StatusNotice() {
  const notice = useGraphStore((s) => s.notice)
  if (!notice) return null
  return (
    <div className="notice" role="status">
      <span>{notice}</span>
      <button type="button" onClick={dismissNotice} title="Dismiss">
        ×
      </button>
    </div>
  )
}
