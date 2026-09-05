/**
 * Data & Privacy — where your work lives, and who you have to cite.
 *
 * A dialog rather than a page under `Help ▸ Documentation`, for `ShortcutsDialog`'s reason: both
 * questions are asked *while* looking at a graph, and every document in that submenu navigates
 * away. It is also two answers rather than one, and they are here together on purpose — the
 * reader arriving for either is exactly the reader who has not thought about the other.
 *
 * ## Why the citation half is the loud half
 *
 * The privacy half is reassuring: nothing leaves this machine that you did not send somewhere
 * yourself. Reassurance does not need volume. The citation half is an obligation the reader
 * acquires without doing anything — a dataset picker that says "MaleCNS" gives no hint that
 * behind it are years of somebody's reconstruction work, published with a request for
 * attribution — so it gets the callout, and it goes second, where a short document is actually
 * read.
 *
 * It deliberately does **not** list papers. Any list here would be a second copy of the
 * publisher's own wording, drifting from it from the day it is written, and it would go stale
 * silently — a citation that is merely out of date still looks like a citation. The `Description`
 * node renders the publisher's own text, arrives already wired to every dataset node, and is
 * therefore the thing to point at rather than reproduce. See `src/nodes/dataset/description.ts`.
 *
 * The copy here and the four `sources__privacy` notes in `SourcesPanel` say the same things
 * about credentials. That is duplication with a reason: this dialog is where somebody who has
 * not opened Connections looks, and a reader who has to go and find the other surface to learn
 * whether their token is safe has already been failed.
 */

import { useEffect, useRef, useState } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { useDismissOnOutside } from '../useDismiss'

/** The visitor counter's public dashboard — the same link the start page credits row carries. */
const ANALYTICS_URL = 'https://coda-science.goatcounter.com/'

/**
 * Mounted once, in `App`, and opened by a store request — the same idiom as `ShortcutsDialog`
 * and `ShareDialog`, and for the same reason: the `?` menu closes on pick, so it has nowhere to
 * hold a dialog. The mount-seeded guard keeps a remount from re-firing the last request.
 */
export function PrivacyDialog() {
  const request = useGraphStore((s) => s.privacyRequest)
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

  return (
    <div className="overlay" role="presentation">
      <div
        ref={panelRef}
        className="overlay__panel privacy"
        role="dialog"
        aria-modal="true"
        aria-label="Data and privacy"
      >
        <header className="sources__header">
          <h2>Data &amp; Privacy</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="sources__body privacy__body">
          <section className="privacy__group">
            <h3>Where your data lives</h3>
            <dl>
              <div className="privacy__row">
                <dt>Your workflow</dt>
                <dd>
                  In this browser. Autosaved to local storage on this machine; a share link
                  carries the whole graph inside the address itself. There is no account and no
                  server of ours holding it.
                </dd>
              </div>
              <div className="privacy__row">
                <dt>Tokens &amp; keys</dt>
                <dd>
                  In this browser&rsquo;s local storage, in the clear, on this machine only.
                  Never written into a saved graph or an export, never sent to us — each goes
                  only to the deployment it belongs to.
                </dd>
              </div>
              <div className="privacy__row">
                <dt>Connectome data</dt>
                <dd>
                  Fetched straight from the publisher&rsquo;s servers to this page — neuPrint,
                  CAVE, CATMAID, Neuroglancer buckets — directly where they allow it, otherwise
                  through a same-origin relay. Analysis runs here, not on a server.
                </dd>
              </div>
              <div className="privacy__row">
                <dt>AI assistant</dt>
                <dd>
                  Off unless you configure it. Your question and the graph on your canvas go
                  straight to the provider you pick, with no server of ours in between.
                </dd>
              </div>
              <div className="privacy__row">
                <dt>This site</dt>
                <dd>
                  Counts page views only — no cookies, nothing kept in your browser, and{' '}
                  <a href={ANALYTICS_URL} target="_blank" rel="noreferrer noopener">
                    the dashboard is public
                  </a>
                  . Nothing observes what you build.
                </dd>
              </div>
            </dl>
          </section>

          {/*
           * The callout, and the reason this dialog exists in a menu rather than in a document
           * nobody opens. Deliberately not a list of papers — see the file header.
           */}
          <section className="privacy__cite">
            <h3>Citing the data</h3>
            <p>
              <strong>
                The datasets Coda ships are public, but they are not unattributed.
              </strong>{' '}
              Each represents years of effort (sample prep, imaging, reconstruction,
              proofreading, curation, etc) by the group that published it, released on the
              understanding that work built on it says so.
            </p>
            <p>
              <strong>If a dataset informs your publication, cite its original sources.</strong>{' '}
              Citing Coda is not citing the data, and licence terms differ from one dataset to
              the next.
            </p>
            <p className="privacy__where">
              The <strong>Description</strong> node should point you to the original sources: it
              contains the publisher&rsquo;s own text that often includes the project name and
              the papers it asks for. If it does not, it is your responsibility to find the
              right citation.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
