/**
 * The field a frame's title is typed into, shared by the two surfaces a frame has.
 *
 * Moved out of `GroupLayer` at the second consumer, for `groupDrag.ts`'s reason: a *folded*
 * frame draws no outline at all (`groupBoxes` skips it), so Rename on a collapsed group's menu
 * used to open this input on a surface that is not on the canvas — the edit went to the frame
 * you would see if you expanded it again, which reads exactly like a menu row that does nothing.
 * Which frame is being edited is `editingGroupId` in the store — three surfaces ask it and the
 * menu that starts a rename can reach neither of the two that draw one.
 *
 * **Escape reverts and blur commits, and the flag is why** — the same trap `NoteCard` records:
 * unmounting a focused input can fire blur on the way out, so "cancel" cannot be expressed by
 * leaving edit mode, because the blur handler would then write the edit being abandoned.
 *
 * The class is the frame's (`group-frame__title-input`) on both surfaces: it is one control that
 * happens to be drawn in two places, and a second class would be a second set of type styles to
 * keep equal.
 */

import { useRef, useState } from 'react'

import type { GraphGroup } from '../core/graph'
import { useGraphStore } from '../store/graphStore'

export function GroupTitleInput({ group }: { group: GraphGroup }) {
  const renameGroup = useGraphStore((s) => s.renameGroup)
  const editGroupTitle = useGraphStore((s) => s.editGroupTitle)
  const onDone = () => editGroupTitle(undefined)
  const [text, setText] = useState(group.title ?? '')
  const reverting = useRef(false)

  return (
    <input
      className="group-frame__title-input nopan nodrag"
      value={text}
      autoFocus
      aria-label="Group title"
      placeholder="Name this group"
      onChange={(event) => setText(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          reverting.current = true
          event.currentTarget.blur()
        }
        // Every canvas shortcut is a window listener that skips fields — but Escape and the
        // canvas's own keys reach it through React first, so the propagation stops here.
        event.stopPropagation()
      }}
      onBlur={() => {
        if (!reverting.current) renameGroup(group.id, text.trim())
        onDone()
      }}
    />
  )
}
