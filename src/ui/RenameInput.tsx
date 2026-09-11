/**
 * A name typed in place: Enter and blur commit, Escape reverts.
 *
 * **Escape reverts and blur commits, and the flag is why** — the same trap `NoteCard` records:
 * unmounting a focused input can fire blur on the way out, so "cancel" cannot be expressed by
 * leaving edit mode, because the blur handler would then write the edit being abandoned.
 *
 * `data-owns-escape` so an open overlay leaves the press to the field (`useOverlayEscape`), and
 * both the pointer and the keys stop here: every canvas shortcut is a window listener that skips
 * fields, but Escape and the canvas's own keys reach it through React first, and a press would
 * otherwise start a pan or a drag under it.
 */

import { useRef, useState } from 'react'

export interface RenameInputProps {
  initial: string
  /** The trimmed text. Not called on Escape. */
  onCommit: (name: string) => void
  /** Leaving edit mode, whichever way. */
  onDone: () => void
  className: string
  label: string
  placeholder?: string
}

export function RenameInput({
  initial,
  onCommit,
  onDone,
  className,
  label,
  placeholder,
}: RenameInputProps) {
  const [text, setText] = useState(initial)
  const reverting = useRef(false)

  return (
    <input
      data-owns-escape
      className={`${className} nopan nodrag`}
      value={text}
      autoFocus
      aria-label={label}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          reverting.current = true
          event.currentTarget.blur()
        }
        event.stopPropagation()
      }}
      onBlur={() => {
        if (!reverting.current) onCommit(text.trim())
        onDone()
      }}
    />
  )
}
