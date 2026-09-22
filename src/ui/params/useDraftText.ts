/**
 * Local text while typing, committed on blur — and on a debounce, so a cheap downstream node
 * updates as you type without every keystroke becoming an undo step (the store coalesces those
 * by param id).
 *
 * The commit rules of every free-text param widget. `TextField` and `ComboField` each carried a
 * copy — the resync from the stored value while unfocused, the timer and its unmount cleanup, the
 * 220 ms debounce — and a change to one widget's commit behaviour would not have reached the
 * other.
 */

import { useEffect, useRef, useState } from 'react'

const DEBOUNCE_MS = 220

export interface DraftText {
  text: string
  setText: (text: string) => void
  /** The field took focus: stop following the stored value, which would overwrite the typing. */
  focus: () => void
  /** Somebody typed. Committed after the debounce where there is one. */
  edit: (next: string) => void
  /** Hand a value over now, cancelling any pending debounce. */
  commit: (next: string) => void
  /** The field lost focus: commit `current`, or nothing when it is undefined. */
  blur: (current: string | undefined) => void
}

export function useDraftText(
  value: string,
  onChange: (value: string) => void,
  { debounce }: { debounce: boolean },
): DraftText {
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!focused) setText(value)
  }, [value, focused])

  useEffect(() => () => clearTimeout(timer.current), [])

  const commit = (next: string) => {
    clearTimeout(timer.current)
    onChange(next)
  }

  return {
    text,
    setText,
    focus: () => setFocused(true),
    edit: (next) => {
      setText(next)
      clearTimeout(timer.current)
      if (debounce) timer.current = setTimeout(() => onChange(next), DEBOUNCE_MS)
    },
    commit,
    blur: (current) => {
      setFocused(false)
      clearTimeout(timer.current)
      if (current !== undefined) onChange(current)
    },
  }
}
