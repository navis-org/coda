/**
 * A review row's verdict buttons: Accept, and a split button for the ways of not merging —
 * Reject (a wrong continuation), Ends (rejected because the neuron ends here), Unsure (user,
 * 2026-11-18) and Ignore (right, but it would grow a false branch; user, 2026-11-22). One button
 * where there were two, because a row is short of room.
 *
 * The face is a verdict in one press: the row's own where it is one of these, else Reject, the
 * commonest. The ▾ opens them as a menu. What each press may do, and what its title
 * says, is `verdictPress`'s, as before.
 *
 * The menu is `useSplitMenu`'s, shared with the Extend button's.
 *
 * Each title names the verdict's key (`reviewKeys.ts`), read off the shortcut table so it cannot
 * name another — except where the button is disabled: the key is refused there too, and the
 * title's sentence is why.
 */

import type { Verdict } from '../../packs/seam/reviewQueue'
import { NOT_ACCEPT, faceOf } from '../../packs/seam/reviewQueue'
import { shortcutKeys } from '../shortcuts'
import { SplitMenu, useSplitMenu } from './splitMenu'

const VERDICT_LABEL: Record<Verdict, string> = {
  accept: 'Accept',
  reject: 'Reject',
  ends: 'Ends',
  unsure: 'Unsure',
  ignore: 'Ignore',
}

const keyOf = (verdict: Verdict) => shortcutKeys(`review-${verdict}`)

/** The ▾'s title: the verdicts behind it, each with its key. */
const MORE_TITLE = (() => {
  const named = NOT_ACCEPT.map((verdict) => `${VERDICT_LABEL[verdict]} (${keyOf(verdict)})`)
  return `${named.slice(0, -1).join(', ')} or ${named.at(-1)!}`
})()

/**
 * A press's title with the verdict's key added, where the press can be made — said apart where the
 * reader has given that verdict already: the press takes it back, the key never does and only
 * moves on. Asked of the reader's **own** verdict, as the key is (`ReviewBody`): on an `auto` row
 * Q writes the accept as theirs, so "keeps it" would be untrue there.
 */
function withKey(
  verdict: Verdict,
  own: Verdict | undefined,
  can: { title: string; disabled: boolean },
) {
  if (can.disabled) return can
  const key = keyOf(verdict)
  const note =
    own === verdict
      ? `Key: ${key} keeps it and moves on to the next row without a verdict.`
      : `Key: ${key}, which also moves on to the next row without a verdict.`
  return { ...can, title: `${can.title} ${note}` }
}

export function VerdictButtons({
  said,
  own,
  press,
  onJudge,
}: {
  /** The row's verdict, where it has one. */
  said: Verdict | undefined
  /** The reader's own verdict on the row: `said` less Auto-extend's accept. */
  own: Verdict | undefined
  /** What a verdict's button says and whether it can be pressed (`verdictPress`). */
  press: (verdict: Verdict) => { title: string; disabled: boolean }
  onJudge: (verdict: Verdict) => void
}) {
  const { menuAt, trigger, close, toggle } = useSplitMenu('verdict-menu')
  const keyed = (verdict: Verdict) => withKey(verdict, own, press(verdict))
  const face = faceOf(said)
  const faced = keyed(face)
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
      {button('accept', keyed('accept'))}
      <span className="review-row__split">
        {button(face, faced)}
        <button
          ref={trigger}
          type="button"
          className="review-row__verdict review-row__more"
          aria-haspopup="menu"
          aria-expanded={menuAt !== undefined}
          aria-label="Other verdicts"
          title={MORE_TITLE}
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
            ...keyed(verdict),
          }))}
          checked={said}
          onPick={onJudge}
        />
      )}
    </>
  )
}
