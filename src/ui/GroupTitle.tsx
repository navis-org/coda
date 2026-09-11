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
 * The field's own behaviour — Escape reverts, blur commits — is `RenameInput`'s.
 *
 * The class is the frame's (`group-frame__title-input`) on both surfaces: it is one control that
 * happens to be drawn in two places, and a second class would be a second set of type styles to
 * keep equal.
 */

import type { GraphGroup } from '../core/graph'
import { useGraphStore } from '../store/graphStore'
import { RenameInput } from './RenameInput'

export function GroupTitleInput({ group }: { group: GraphGroup }) {
  const renameGroup = useGraphStore((s) => s.renameGroup)
  const editGroupTitle = useGraphStore((s) => s.editGroupTitle)

  return (
    <RenameInput
      className="group-frame__title-input"
      label="Group title"
      placeholder="Name this group"
      initial={group.title ?? ''}
      onCommit={(title) => renameGroup(group.id, title)}
      onDone={() => editGroupTitle(undefined)}
    />
  )
}
