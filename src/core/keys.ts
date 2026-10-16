/**
 * True when a keypress is somebody typing rather than somebody reaching for a shortcut.
 *
 * The test every shortcut listener opens with — the editor's, the app's, and the one in Coda's own
 * neuroglancer frame (`src/ngframe`), which is why it is here rather than beside them: the frame
 * may import nothing from the UI. One copy, so they cannot drift on the next field kind that has
 * to be exempt — a `contenteditable` cell, a combobox.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  )
}
