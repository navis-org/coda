/**
 * A review row's verdict buttons: Accept, and a split button for the three ways of saying no —
 * Reject (a wrong continuation), Ends (rejected because the neuron ends here) and Unsure (user,
 * 2026-11-18). One button where there were two, because a row is short of room.
 *
 * The face is a verdict in one press: the row's own where it is one of the three, else Reject,
 * the commonest. The ▾ opens the three as a menu. What each press may do, and what its title
 * says, is `verdictPress`'s, as before.
 *
 * The menu is portalled (`ContextMenu`): the row sits in a scrolling list on a card inside React
 * Flow's transformed pane, which would clip a panel hung under it and scale it with the zoom.
 */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import type { Verdict } from '../../packs/seam/reviewQueue'
import { NOT_ACCEPT, faceOf } from '../../packs/seam/reviewQueue'
import { ContextMenu } from '../menu/ContextMenu'
import { anchorBelow } from '../menu/placement'

const VERDICT_LABEL: Record<Verdict, string> = {
  accept: 'Accept',
  reject: 'Reject',
  ends: 'Ends',
  unsure: 'Unsure',
}

export function VerdictButtons({
  said,
  press,
  onJudge,
}: {
  /** The row's verdict, where it has one. */
  said: Verdict | undefined
  /** What a verdict's button says and whether it can be pressed (`verdictPress`). */
  press: (verdict: Verdict) => { title: string; disabled: boolean }
  onJudge: (verdict: Verdict) => void
}) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>()
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => {
    setMenuAt(undefined)
    trigger.current?.focus()
  }
  /*
   * **Closed by a press outside, but not by a press on ▾**, which toggles it. `ContextMenu`'s own
   * outside-dismiss cannot tell the two apart — the menu is portalled, ▾ is not in it — so it
   * closed on the press and the click reopened it at once.
   */
  useEffect(() => {
    if (!menuAt) return
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (trigger.current?.contains(target) || target?.closest?.('.verdict-menu')) return
      setMenuAt(undefined)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [menuAt])
  // Focus into the menu as it opens, once, so a keyboard can reach it.
  const open = menuAt !== undefined
  useEffect(() => {
    if (open) {
      document
        .querySelector<HTMLButtonElement>('.verdict-menu [role="menuitemradio"]:enabled')
        ?.focus()
    }
  }, [open])
  const face = faceOf(said)
  const faced = press(face)
  const button = (verdict: Verdict, can: { title: string; disabled: boolean }) => (
    <button
      type="button"
      className="review-row__verdict"
      data-verdict={verdict}
      aria-pressed={said === verdict}
      disabled={can.disabled}
      onClick={() => onJudge(verdict)}
      title={can.title}
    >
      {VERDICT_LABEL[verdict]}
    </button>
  )
  return (
    <>
      {button('accept', press('accept'))}
      <span className="review-row__split">
        {button(face, faced)}
        <button
          ref={trigger}
          type="button"
          className="review-row__verdict review-row__more"
          aria-haspopup="menu"
          aria-expanded={menuAt !== undefined}
          aria-label="Other verdicts"
          title="Reject, Ends or Unsure"
          // `verdictPress` fixes or frees a piece's verdicts together, so the face's state is all of theirs.
          disabled={faced.disabled}
          onClick={(event) => setMenuAt(menuAt ? undefined : anchorBelow(event.currentTarget))}
        >
          ▾
        </button>
      </span>
      {menuAt && (
        <ContextMenu
          at={menuAt}
          onClose={close}
          portal
          label="Verdict"
          className="verdict-menu"
          dismissOnOutside={false}
          onKeyDown={moveFocus}
        >
          {NOT_ACCEPT.map((verdict) => {
            const can = press(verdict)
            return (
              <button
                key={verdict}
                type="button"
                role="menuitemradio"
                aria-checked={said === verdict}
                className="context-menu__item"
                data-verdict={verdict}
                disabled={can.disabled}
                title={can.title}
                onClick={() => {
                  close()
                  onJudge(verdict)
                }}
              >
                {VERDICT_LABEL[verdict]}
                <span aria-hidden="true">{said === verdict ? '✓' : ''}</span>
              </button>
            )
          })}
        </ContextMenu>
      )}
    </>
  )
}

/** Up and down move between the menu's rows, as in any menu. */
function moveFocus(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]:enabled',
    ),
  ]
  if (rows.length === 0) return
  const at = rows.indexOf(document.activeElement as HTMLButtonElement)
  const step = event.key === 'ArrowDown' ? 1 : -1
  rows[(at + step + rows.length) % rows.length]!.focus()
}
