/**
 * Keyboard Shortcuts — the whole keymap on one screen.
 *
 * A dialog rather than a page under `Help ▸`, because the question it answers is asked *while*
 * you are looking at a graph: the three documents in that menu all navigate away, and reading
 * "press §" in a tab that is not the editor is one context switch too many. It is also why the
 * canvas is still visible behind it.
 *
 * The content is `SHORTCUT_GROUPS` verbatim — this file draws, it does not decide. Every glyph
 * it prints is the same string the status bar and the palette badges print, which is the point
 * of the table existing at all.
 */

import { useEffect, useRef, useState } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { SHORTCUT_GROUPS, formatChord, isApplePlatform } from '../shortcuts'
import { useDismissOnOutside } from '../useDismiss'

/**
 * Mounted once, in `App`, and opened by a store request — the same idiom as `ShareDialog`, and
 * for the same reason: the palette closes on pick, so it has nowhere to hold a dialog. The
 * mount-seeded guard keeps a remount from re-firing the last request.
 */
export function ShortcutsDialog() {
  const request = useGraphStore((s) => s.shortcutsRequest)
  const [open, setOpen] = useState(false)
  const seen = useRef(request)

  useEffect(() => {
    if (request === seen.current) return
    seen.current = request
    setOpen(true)
  }, [request])

  if (!open) return null
  return <Dialog onClose={() => setOpen(false)} />
}

function Dialog({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  useDismissOnOutside(panelRef, onClose, { onEscape: true })

  /*
   * Resolved once per open rather than per row, so every glyph in the dialog agrees even if
   * something re-renders mid-read, and so the platform sniff runs once.
   */
  const apple = isApplePlatform()

  return (
    <div className="overlay" role="presentation">
      <div
        ref={panelRef}
        className="overlay__panel shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <header className="sources__header">
          <h2>Keyboard Shortcuts</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {/*
         * Two columns on a wide dialog, one on a narrow one, laid out with CSS `columns` so the
         * groups flow rather than being split into two hand-balanced halves — a fixed split
         * goes lopsided the moment a group gains a row.
         */}
        <div className="sources__body shortcuts__body">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="shortcuts__group">
              <h3>{group.title}</h3>
              {group.note && <p className="sources__note sources__note--tight">{group.note}</p>}
              <dl>
                {group.items.map((item) => (
                  <div key={item.id} className="shortcuts__row">
                    <dt>
                      {item.chords.map((chord, i) => (
                        <kbd key={i}>{formatChord(chord, apple)}</kbd>
                      ))}
                    </dt>
                    <dd>
                      {item.label}
                      {item.hint && <span>{item.hint}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        {/*
         * The one thing the table cannot say row by row. Fields are excluded wholesale rather
         * than per shortcut — `Editor.tsx` returns early for `INPUT`, `TEXTAREA`, `SELECT` and
         * anything contenteditable — so it is a property of the whole list, and a reader who
         * has just found a bare letter key is exactly the person about to wonder why it did
         * nothing while the cursor was in a query box.
         */}
        <footer className="shortcuts__foot">
          Bare letters are off while you are typing in a field, and while a guided tour is on
          screen.
        </footer>
      </div>
    </div>
  )
}
