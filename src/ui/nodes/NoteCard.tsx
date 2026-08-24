/**
 * The Text note's card.
 *
 * Deliberately not a node card. No header, no state bar, no run button, no sockets, no footer —
 * a framed box with prose in it, so it reads as something written *about* the graph rather than
 * as a step in it. A note that wore the node chrome would be asking to be wired up, and there is
 * nothing to wire.
 *
 * **Read mode drags, edit mode types.** The rendered view is draggable everywhere, which is what
 * makes a note a thing you push around the canvas; the cost is that you cannot select its text
 * with the pointer, since the same gesture moves the card. Double-click swaps in a textarea,
 * which carries `nodrag` and so behaves like a normal field. That is Blender's and ComfyUI's
 * note behaviour and the trade is the right way round: notes are moved far more often than they
 * are re-read a phrase at a time.
 *
 * **Escape reverts, blur commits, and the flag is why.** Unmounting a focused textarea can fire
 * blur on the way out, so "cancel" cannot be expressed by simply leaving edit mode — the blur
 * handler would commit the very edit being abandoned. Escape sets the flag and blurs; the blur
 * handler reads it and skips the write.
 */

import { NodeResizer } from '@xyflow/react'
import { memo, useRef, useState } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { MarkdownView } from '../MarkdownView'
import type { CodaNodeData } from './CodaNodeView'

/**
 * Floors for the resize handles. Far below a node's, because a note legitimately is a label —
 * three words beside a socket — and the only thing that must not happen is a box dragged down to
 * nothing, which cannot be grabbed again.
 */
const MIN_NOTE_WIDTH = 120
const MIN_NOTE_HEIGHT = 56

const EMPTY_HINT = 'Double-click to write. Markdown works.'

function NoteCardImpl({
  id,
  data,
  selected,
  draggable,
}: {
  id: string
  data: CodaNodeData
  selected?: boolean
  /** `!locked`, handed down by React Flow — see `CodaNodeView`'s note on the same prop. */
  draggable?: boolean
}) {
  const node = data.node
  const setParam = useGraphStore((s) => s.setParam)
  const [editing, setEditing] = useState(false)
  /** Set by Escape, read by the blur that follows it. See the module note. */
  const reverting = useRef(false)

  const text = typeof node.params.text === 'string' ? node.params.text : ''
  // Absent means on: a note saved before the param existed keeps the frame it was drawn with.
  const outlined = node.params.outline !== false

  return (
    <>
      {/*
       * A sibling of the card for the same reason the node's resizer is one: the handles
       * straddle the border, and anything that clips would cut them in half.
       */}
      <NodeResizer
        minWidth={MIN_NOTE_WIDTH}
        minHeight={MIN_NOTE_HEIGHT}
        // Gone rather than refusing while the canvas is locked — `CodaNodeView`'s `resizable`
        // records why a resize needs its own answer instead of `nodesDraggable`.
        isVisible={selected === true && draggable !== false}
        lineClassName="coda-node__resize-line"
        handleClassName="coda-node__resize-handle"
      />
      <div
        className={`coda-note nowheel${selected ? ' selected' : ''}`}
        data-editing={editing || undefined}
        data-outline={outlined ? undefined : 'false'}
        onDoubleClick={(event) => {
          // The canvas turns a double-click into "add a node here"; this one means "edit me".
          event.stopPropagation()
          setEditing(true)
        }}
        {...(editing ? {} : { title: 'Double-click to edit' })}
      >
        {editing ? (
          <textarea
            className="coda-note__editor nodrag"
            aria-label="Note text"
            autoFocus
            defaultValue={text}
            placeholder={EMPTY_HINT}
            onBlur={(event) => {
              const next = event.target.value
              if (!reverting.current && next !== text) setParam(id, 'text', next)
              reverting.current = false
              setEditing(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                reverting.current = true
                event.currentTarget.blur()
              }
              // Enter is a newline in a note, so committing needs a modifier.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.currentTarget.blur()
              }
            }}
          />
        ) : text.trim() ? (
          <MarkdownView source={text} className="coda-note__text" />
        ) : (
          <p className="coda-note__hint">{EMPTY_HINT}</p>
        )}
      </div>
    </>
  )
}

export const NoteCard = memo(NoteCardImpl)
