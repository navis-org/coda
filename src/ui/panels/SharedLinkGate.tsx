/**
 * Opening a workflow somebody sent you — everything the receiver sees.
 *
 * `useShareLink` does the reading and the fetching; this is the four things it can have to say.
 * Three of them are transient and one is a question, and the question is the reason this is a
 * component rather than a line in the status bar: `loadGraph` resets the undo history, and the
 * autosave is the only copy of whatever is on the canvas.
 *
 * Nothing is rendered at all on the common path — a fresh tab following a gist link answers no
 * questions and sees only the "opening" note for as long as the fetch takes.
 */

import { useRef } from 'react'

import { plural } from '../format'
import { useDismissOnOutside } from '../useDismiss'
import { useShareLink } from '../useShareLink'

export function SharedLinkGate() {
  const { load, accept, dismiss } = useShareLink()
  const panelRef = useRef<HTMLDivElement>(null)

  /*
   * Escape declines, like every other dialog here — through the shared hook rather than a
   * private listener, and bound only while a question is on screen so it cannot take the key
   * from the palette or a viewer overlay.
   *
   * `outside: false` is the one departure, and it is the reason that option exists: dismissing
   * here throws away a link somebody was sent, and on the replace prompt the alternative answer
   * discards the canvas. A stray click on the backdrop is not an answer to either.
   */
  useDismissOnOutside(panelRef, dismiss, {
    onEscape: true,
    outside: false,
    enabled: load.state !== 'idle' && load.state !== 'loading',
  })

  if (load.state === 'idle') return null

  if (load.state === 'loading') {
    return (
      <div className="share-gate share-gate--note" role="status">
        Opening a shared workflow from {load.target.label}…
      </div>
    )
  }

  return (
    <div className="overlay" role="presentation">
      <div
        ref={panelRef}
        className="overlay__panel share-gate__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Shared workflow"
      >
        {load.state === 'confirm-fetch' ? (
          <>
            <h2>Open a shared workflow?</h2>
            {/*
             * The host is the whole content of this question. A link that carries its own
             * workflow shows what it is; one that points somewhere does not, and shortening a
             * link is exactly the act of hiding where it goes.
             */}
            <p>
              This link does not carry the workflow itself — it points at{' '}
              <code>{load.target.host ?? 'another site'}</code>, which Coda will have to fetch
              from.
            </p>
            <p className="share-gate__quiet">
              A workflow is a document, not a program: nothing in it runs until you press Run,
              and it cannot reach your neuPrint token or any other credential.
            </p>
            <div className="share-gate__actions">
              <button type="button" className="btn btn--primary" onClick={accept}>
                Fetch it
              </button>
              <button type="button" className="btn" onClick={dismiss}>
                Cancel
              </button>
            </div>
          </>
        ) : null}

        {load.state === 'confirm-replace' ? (
          <>
            <h2>Open “{load.name}”?</h2>
            <p>
              This replaces the graph on your canvas, and undo will not bring it back. Save it
              first if you want to keep it.
            </p>
            {load.result.warnings.length > 0 ? (
              <p className="share-gate__quiet">
                {plural(load.result.warnings.length, 'warning')} on load:{' '}
                {load.result.warnings.join(' · ')}
              </p>
            ) : null}
            <div className="share-gate__actions">
              <button type="button" className="btn btn--primary" onClick={accept}>
                Open it
              </button>
              <button type="button" className="btn" onClick={dismiss}>
                Keep what I have
              </button>
            </div>
          </>
        ) : null}

        {load.state === 'error' ? (
          <>
            <h2>That link did not open</h2>
            <p>{load.message}</p>
            <div className="share-gate__actions">
              <button type="button" className="btn btn--primary" onClick={dismiss}>
                Close
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
