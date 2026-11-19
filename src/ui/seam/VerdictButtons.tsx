/**
 * A review row's verdict buttons: Accept, and a split button for the three ways of saying no —
 * Reject (a wrong continuation), Ends (rejected because the neuron ends here) and Unsure (user,
 * 2026-11-18). One button where there were two, because a row is short of room.
 *
 * The face is a verdict in one press: the row's own where it is one of the three, else Reject,
 * the commonest. The ▾ opens the three as a menu. What each press may do, and what its title
 * says, is `verdictPress`'s, as before.
 *
 * The menu is `useSplitMenu`'s, shared with the Extend button's.
 */

import type { Verdict } from '../../packs/seam/reviewQueue'
import { NOT_ACCEPT, faceOf } from '../../packs/seam/reviewQueue'
import { SplitMenu, useSplitMenu } from './splitMenu'

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
  const { menuAt, trigger, close, toggle } = useSplitMenu('verdict-menu')
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
          onClick={toggle}
        >
          ▾
        </button>
      </span>
      {menuAt && (
        <SplitMenu
          at={menuAt}
          close={close}
          label="Verdict"
          className="verdict-menu"
          items={NOT_ACCEPT.map((verdict) => ({
            value: verdict,
            label: VERDICT_LABEL[verdict],
            ...press(verdict),
          }))}
          checked={said}
          onPick={onJudge}
        />
      )}
    </>
  )
}
