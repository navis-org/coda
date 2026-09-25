/**
 * What's New — a card in the corner listing highlighted changelog updates.
 *
 * A card rather than a modal, for `FeedbackNudge`'s reason: nothing here blocks the canvas, and a
 * dialog that arrives unprompted over somebody's graph is the wrong tone for "this changed". It
 * takes the nudge's corner, and the nudge stands down while it is up (`whatsNewOpen`).
 *
 * It puts itself up at most once a session, and only when `ui/whatsNew.ts` says a returning
 * reader has a highlighted update they have not seen — and even then it waits for the launch
 * sequence, a tour, the Screen Map and the canvas's **+** menu to be out of the way. The `?` menu
 * opens it by hand at any time. Every way of closing it records the newest update as seen, and
 * so does following one of its links, which open the changelog in a new tab.
 */

import { useEffect, useRef } from 'react'

import { shortDate } from '../../changelog/dates'
import { depictsCard, thumbFile } from '../../changelog/images'
import { useGraphStore } from '../../store/graphStore'
import { isTourActive } from '../tour/tourState'
import { useOverlayEscape } from '../useOverlayEscape'
import {
  loadWhatsNew,
  markWhatsNewSeen,
  prefetchWhatsNew,
  useWhatsNew,
  whatsNewDue,
  whatsNewRows,
} from '../whatsNew'
import { useLaunchStage } from './launchStage'

/** Let the canvas settle first, as the nudge does; the chunk is fetched in the same pause. */
const SHOW_DELAY_MS = 2500

/** How many updates the card lists before pointing at the page for the rest. */
const ROWS = 3

const page = (anchor?: string): string =>
  `${import.meta.env.BASE_URL}changelog.html${anchor ? `#${anchor}` : ''}`

export function WhatsNew() {
  const open = useGraphStore((s) => s.whatsNewOpen)
  const openWhatsNew = useGraphStore((s) => s.openWhatsNew)
  const closeWhatsNew = useGraphStore((s) => s.closeWhatsNew)
  const addMenuOpen = useGraphStore((s) => s.addMenuOpen)
  const screenMapOpen = useGraphStore((s) => s.screenMapOpen)
  const stage = useLaunchStage()
  const whatsNew = useWhatsNew()
  const shown = useRef(false)

  useEffect(() => {
    const timer = window.setTimeout(prefetchWhatsNew, SHOW_DELAY_MS / 2)
    return () => window.clearTimeout(timer)
  }, [])

  const clear = whatsNewDue(whatsNew) && stage === 'none' && !addMenuOpen && !screenMapOpen
  useEffect(() => {
    if (!clear) return
    const timer = window.setTimeout(() => {
      if (isTourActive() || shown.current) return
      shown.current = true
      openWhatsNew()
    }, SHOW_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [clear, openWhatsNew])

  /*
   * Opened before the entries arrived — by hand from the `?` menu, or on a first visit, which
   * prefetches nothing: fetch them here, so every way of opening the card works, and close again
   * if they cannot be had, so `whatsNewOpen` does not claim a card nobody can see.
   */
  const loaded = whatsNew.entries !== undefined
  useEffect(() => {
    if (!open || loaded) return
    void loadWhatsNew().then((ready) => {
      if (!ready) closeWhatsNew()
    })
  }, [open, loaded, closeWhatsNew])

  const dismiss = () => {
    markWhatsNewSeen()
    closeWhatsNew()
  }
  useOverlayEscape(open ? dismiss : undefined)

  if (!open) return null
  const { rows, unseen } = whatsNewRows(whatsNew)
  if (rows.length === 0) return null
  const seen = whatsNew.seen
  const listed = rows.slice(0, ROWS)
  const more = rows.length - listed.length

  return (
    <section
      className="whats-new"
      role="dialog"
      aria-modal="false"
      aria-labelledby="whats-new-title"
    >
      <button
        type="button"
        className="btn btn--ghost whats-new__close"
        onClick={dismiss}
        aria-label="Close"
      >
        ✕
      </button>
      <header className="whats-new__head">
        <span className="whats-new__kicker">What’s new</span>
        <h2 id="whats-new-title">
          {unseen ? 'Coda has changed since you were last here' : 'Recent updates'}
        </h2>
        {unseen && seen && <p>Since your last visit on {shortDate(seen)}.</p>}
      </header>
      <ol className="whats-new__rows">
        {listed.map((entry) => {
          const image = entry.features?.find(
            (f) => f.image && !depictsCard(f.image.capture),
          )?.image
          // A captured image has a thumbnail beside it; a hand-added one is drawn as it is.
          const thumb = image && (image.capture ? thumbFile(image.file) : image.file)
          return (
            <li key={entry.date}>
              <a href={page(entry.date)} target="_blank" rel="noopener" onClick={dismiss}>
                {thumb && (
                  <img
                    src={`${import.meta.env.BASE_URL}changelog/${thumb}`}
                    alt=""
                    loading="lazy"
                  />
                )}
                <span>
                  <strong>{entry.title}</strong>
                  <small>{entry.summary}</small>
                  <time dateTime={entry.date}>{shortDate(entry.date)}</time>
                </span>
              </a>
            </li>
          )
        })}
      </ol>
      {more > 0 && <p className="whats-new__more">and {more} more in the changelog</p>}
      <footer className="whats-new__foot">
        <a href={page()} target="_blank" rel="noopener" onClick={dismiss}>
          See the full changelog
        </a>
        <button type="button" className="btn btn--primary" onClick={dismiss}>
          Got it
        </button>
      </footer>
    </section>
  )
}
