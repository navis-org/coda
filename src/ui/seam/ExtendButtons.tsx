/**
 * An accepted row's Extend button, split like the verdicts' (`VerdictButtons`): the face extends
 * the piece by hand, or stops extending it; the ▾ offers Extend and Auto-extend, the reader's own
 * choice ticked (user, 2026-11-18). What each says and whether it can be pressed is
 * `extendPress`'s and `extendMenu`'s, in `reviewQueue.ts`.
 */

import type { ExtendChoice } from '../../packs/seam/reviewQueue'
import type { SplitMenuItem } from './splitMenu'
import { SplitMenu, useSplitMenu } from './splitMenu'

export function ExtendButtons({
  face,
  pressed,
  menu,
  checked,
  onPress,
}: {
  /** `extendPress`'s answer, with what a press on the face writes. */
  face: { label: string; title: string; disabled: boolean; writes: ExtendChoice }
  /** Whether the piece is extended, by the reader or by an Auto-extend further up. */
  pressed: boolean
  /** `extendMenu`'s answer: the items, each with what its press writes. */
  menu: ReadonlyArray<SplitMenuItem<'extend' | 'auto'> & { writes: ExtendChoice }>
  /** The reader's own choice, ticked in the menu. */
  checked: 'extend' | 'auto' | undefined
  /** A press, as what it writes (`extendParams`). */
  onPress: (writes: ExtendChoice) => void
}) {
  const { menuAt, trigger, close, toggle } = useSplitMenu('extend-menu')
  const offered = menu.some((item) => !item.disabled)
  return (
    <span className="review-row__split review-row__split--extend">
      <button
        type="button"
        className="review-row__extend"
        aria-pressed={pressed}
        disabled={face.disabled}
        onClick={() => onPress(face.writes)}
        title={face.title}
      >
        {face.label}
      </button>
      <button
        ref={trigger}
        type="button"
        className="review-row__extend review-row__more"
        aria-haspopup="menu"
        aria-expanded={menuAt !== undefined}
        aria-label="Ways to extend"
        title="Extend, or Auto-extend"
        disabled={!offered}
        onClick={toggle}
      >
        ▾
      </button>
      {menuAt && (
        <SplitMenu
          at={menuAt}
          close={close}
          label="Extend"
          className="extend-menu"
          items={menu}
          checked={checked}
          onPick={(value) => onPress(menu.find((item) => item.value === value)!.writes)}
        />
      )}
    </span>
  )
}
