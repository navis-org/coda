/**
 * The store's notice — a sentence any surface can leave for the reader (`setNotice`): why a pick
 * was refused, why a Submit did not open, what a shortcut did. A feature's own notice may carry a
 * small choice beside its text (`showNotice`'s `NoticeChoice`: find path's "Colour by").
 *
 * **Drawn by whichever view holds the canvas column**: `Editor` and `DashboardView` each render
 * one. It was `Editor`'s alone, and `Editor` is not mounted while the dashboard is up, so a
 * reader working from the dashboard was told nothing at all — a hand pick (`J`) refused in a
 * sentence read as "nothing happens" (user, 2026-11-20).
 */

import { useSyncExternalStore } from 'react'

import { useGraphStore } from '../store/graphStore'
import { dismissNotice, noticeChoice, onOwnedNotice } from './noticeDismiss'

export function StatusNotice() {
  const notice = useGraphStore((s) => s.notice)
  const choice = useSyncExternalStore(onOwnedNotice, () => noticeChoice(notice))
  if (!notice) return null
  return (
    <div className="notice" role="status">
      <span>{notice}</span>
      {choice && (
        <label className="notice__choice">
          <span>{choice.label}</span>
          <select
            className="field"
            value={choice.value}
            onChange={(event) => choice.onChange(event.target.value)}
          >
            {choice.options.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.disabled !== undefined}
                title={option.disabled}
              >
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="button" onClick={dismissNotice} title="Dismiss">
        ×
      </button>
    </div>
  )
}
