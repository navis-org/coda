/**
 * The store's notice — a sentence any surface can leave for the reader (`setNotice`): why a pick
 * was refused, why a Submit did not open, what a shortcut did. A feature's own notice may carry a
 * small choice beside its text (`showNotice`'s `NoticeChoice`: find path's "Colour by"), and a
 * run's failure notice the button that answers it (`noticeFix`: "Allow model download").
 *
 * **Drawn by whichever view holds the canvas column**: `Editor` and `DashboardView` each render
 * one. It was `Editor`'s alone, and `Editor` is not mounted while the dashboard is up, so a
 * reader working from the dashboard was told nothing at all — a hand pick (`J`) refused in a
 * sentence read as "nothing happens" (user, 2026-11-20).
 */

import { useSyncExternalStore } from 'react'

import { useGraphStore } from '../store/graphStore'
import { IssueFixButton } from './IssueFixButton'
import { IssueText } from './IssueText'
import { dismissNotice, noticeChoice, onOwnedNotice } from './noticeDismiss'

export function StatusNotice() {
  const notice = useGraphStore((s) => s.notice)
  // The run failure's fix, while the notice is still its sentence. A stored object (invariant 7).
  const fixed = useGraphStore((s) =>
    s.notice !== undefined && s.noticeFix?.text === s.notice ? s.noticeFix : undefined,
  )
  const choice = useSyncExternalStore(onOwnedNotice, () => noticeChoice(notice))
  if (!notice) return null
  return (
    <div className="notice" role="status">
      <IssueText message={notice} />
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
      {fixed?.fix && <IssueFixButton nodeId={fixed.nodeId} fix={fixed.fix} />}
      <button type="button" onClick={dismissNotice} title="Dismiss">
        ×
      </button>
    </div>
  )
}
