/**
 * The click-a-mark gesture, once.
 *
 * The histogram, the pie and the box plot all hand a selection back to the graph, and all three
 * had written the same three things: stabilise the incoming prop, hold it as a `Set`, and
 * decide what a click means. The pie's version is the general one — a residual slice stands for
 * many labels — and the other two are it with a one-element list, so this is that version with
 * the two special cases deleted rather than a fourth spelling.
 *
 * The gesture itself is the scatter's, deliberately: a plain click means *this mark*, a
 * modified click adds or removes, and clicking the mark that is already the whole selection
 * clears it — so the gesture that made a selection also undoes it, without a second control.
 *
 * `useStable` is not an optimisation here, it is what makes the `Set` a memo at all:
 * `ValuePreview` builds the prop with `idList(...)`, which mints a fresh array on every render,
 * so an identity-keyed memo would rebuild on every store tick. Same hook, same reason, as
 * `ScatterViewer`'s.
 */

import { useCallback, useMemo } from 'react'

import { useStable } from './useStable'

/** Shift, ⌘ or Ctrl — add-to-selection, matching the canvas underneath. */
export function isAdditive(event: {
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}): boolean {
  return event.shiftKey || event.metaKey || event.ctrlKey
}

export interface MarkSelection {
  /** How many names are selected — for the caption's readout. */
  size: number
  /** Whether a mark standing for these names is selected. */
  has(names: readonly string[]): boolean
  /** Click a mark standing for these names. */
  toggle(names: readonly string[], additive: boolean): void
  clear(): void
  /** False when the viewer has nowhere to write, i.e. no selection is offered at all. */
  writable: boolean
}

export function useMarkSelection(
  selection: string[] | undefined,
  onSelectionChange?: (ids: string[]) => void,
): MarkSelection {
  const stable = useStable(selection ?? [])
  const selected = useMemo(() => new Set(stable), [stable])

  const has = useCallback(
    (names: readonly string[]) => names.length > 0 && names.every((n) => selected.has(n)),
    [selected],
  )

  const toggle = useCallback(
    (names: readonly string[], additive: boolean) => {
      if (!onSelectionChange || names.length === 0) return
      const already = names.every((name) => selected.has(name))
      if (additive) {
        const next = new Set(selected)
        for (const name of names) {
          if (already) next.delete(name)
          else next.add(name)
        }
        onSelectionChange([...next])
        return
      }
      onSelectionChange(already && selected.size === names.length ? [] : [...names])
    },
    [onSelectionChange, selected],
  )

  const clear = useCallback(() => onSelectionChange?.([]), [onSelectionChange])

  return { size: selected.size, has, toggle, clear, writable: !!onSelectionChange }
}
