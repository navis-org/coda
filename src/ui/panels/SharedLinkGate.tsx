/**
 * Opening a workflow somebody sent you — everything the receiver sees.
 *
 * `useShareLink` does the reading and the fetching; this is the three things it can have to say.
 * Two of them are transient and one is a question — *fetch from this host?*, asked only for a
 * bare `https://` link whose destination the recipient cannot see, which is the reason this is a
 * component rather than a line in the status bar.
 *
 * It used to have a fourth state and a second question, *replace what is on your canvas?*. A link
 * now opens in a document of its own, so there is nothing to replace; see `useShareLink`.
 *
 * Nothing is rendered at all on the common path — a fresh tab following a gist link answers no
 * questions and sees only the "opening" note for as long as the fetch takes.
 */

import { useShareLink } from '../useShareLink'
import { Modal } from '../Modal'

export function SharedLinkGate() {
  const { load, accept, dismiss } = useShareLink()

  if (load.state === 'idle') return null

  if (load.state === 'loading') {
    return (
      <div className="share-gate share-gate--note" role="status">
        Opening a shared workflow from {load.target.label}…
      </div>
    )
  }

  return (
    /*
     * Escape declines, like every other dialog here, and is bound only while a question is on
     * screen, so it cannot take the key from the palette or a viewer overlay.
     *
     * `backdrop={false}` is the one departure, and the reason that option exists: dismissing
     * here throws away a link somebody was sent, and on the replace prompt the alternative answer
     * discards the canvas. A stray click on the backdrop is not an answer to either.
     */
    <Modal
      className="overlay__panel share-gate__panel"
      label="Shared workflow"
      onClose={dismiss}
      backdrop={false}
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
            A workflow is a document, not a program: nothing in it runs until you press Run, and
            it cannot reach your neuPrint token or any other credential.
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
    </Modal>
  )
}
