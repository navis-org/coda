/**
 * The menu on a group frame: rename it, restyle it, take it apart.
 *
 * The styling lives *here* rather than in the inspector, and that is a deliberate call. The
 * inspector is node-shaped — one selected node's params, its port types, its result — and a
 * second mode for a thing that is not a node would need group selection in the store beside the
 * node selection already there. A frame has four decisions in it (a name, a colour, a fill, a
 * dash), which is a menu's worth, and a menu opens on the thing it is about.
 *
 * The swatches are **names**, not colours: what is stored is `blue`, and `theme.css` decides what
 * blue is in each mode. See `GROUP_COLORS` for why a document may not carry a CSS value.
 */

import { useRef } from 'react'

import type { GroupColor } from '../../core/graph'
import { GROUP_COLORS } from '../../core/graph'
import { useGraphStore } from '../../store/graphStore'
import { LOCKED_HINT } from '../lockCopy'
import { shortcutKeys } from '../shortcuts'
import { useDismissOnOutside } from '../useDismiss'

/** Named for the reader rather than for the token: a swatch has to say something out loud. */
const COLOR_LABELS: Record<GroupColor, string> = {
  grey: 'Grey',
  blue: 'Blue',
  orange: 'Orange',
  green: 'Green',
  pink: 'Pink',
  violet: 'Violet',
}

export interface GroupContextMenuProps {
  screenPosition: { x: number; y: number }
  groupId: string
  /** Puts the frame's title into edit mode — the canvas owns that state, see `GroupLayer`. */
  onRename: () => void
  onClose: () => void
}

export function GroupContextMenu({
  screenPosition,
  groupId,
  onRename,
  onClose,
}: GroupContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const store = useGraphStore()
  const group = store.graph.groups?.find((g) => g.id === groupId)

  useDismissOnOutside(ref, onClose, { onEscape: true })

  if (!group) return null

  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{
        left: Math.min(screenPosition.x, window.innerWidth - 190),
        top: Math.min(screenPosition.y, window.innerHeight - 240),
      }}
      role="menu"
    >
      <div className="context-menu__header">{group.title || 'Untitled group'}</div>
      <button type="button" className="context-menu__item" onClick={act(onRename)}>
        {group.title ? 'Rename' : 'Name this group'}
      </button>
      <button
        type="button"
        className="context-menu__item"
        title="Select every card inside the frame"
        onClick={act(() => store.setSelection(group.nodeIds))}
      >
        Select {group.nodeIds.length} nodes
      </button>

      <div className="context-menu__sep" />
      {/*
       * A row of swatches rather than six menu items: colour is the one choice here where the
       * value *is* its own label, and a list of words next to a canvas would be six lines
       * saying what one line can show.
       */}
      <div className="context-menu__swatches" role="group" aria-label="Frame colour">
        {GROUP_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className="context-menu__swatch"
            data-color={color}
            data-current={(group.color ?? 'grey') === color || undefined}
            aria-label={COLOR_LABELS[color]}
            aria-pressed={(group.color ?? 'grey') === color}
            title={COLOR_LABELS[color]}
            onClick={() => store.styleGroup(groupId, { color })}
          />
        ))}
      </div>
      <button
        type="button"
        className="context-menu__item"
        aria-pressed={group.filled === true}
        title="Tint the inside of the frame instead of drawing an outline only"
        onClick={() => store.styleGroup(groupId, { filled: !group.filled })}
      >
        {group.filled ? '✓ ' : ''}Filled
      </button>
      <button
        type="button"
        className="context-menu__item"
        aria-pressed={group.dashed === true}
        onClick={() => store.styleGroup(groupId, { dashed: !group.dashed })}
      >
        {group.dashed ? '✓ ' : ''}Dashed
      </button>

      <div className="context-menu__sep" />
      {/*
       * Ungroup, not Delete: nothing is removed from the graph, so the danger styling every
       * other terminal row wears would be a lie about what this does.
       */}
      <button
        type="button"
        className="context-menu__item"
        onClick={act(() => store.ungroup([groupId]))}
        disabled={store.locked}
        title={store.locked ? LOCKED_HINT : 'Remove the frame; the cards stay where they are'}
      >
        Ungroup <kbd>{shortcutKeys('ungroup')}</kbd>
      </button>
    </div>
  )
}
