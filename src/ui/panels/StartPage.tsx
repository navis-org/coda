/**
 * The start page — what someone sees when they open Coda.
 *
 * A large centred modal over the canvas, shown on every launch until the user ticks
 * "Don't show again". Three jobs, in order of how often they matter: say what this is and that
 * it is alpha, offer somewhere to start that is not an empty canvas, and point at the issue
 * tracker. The backdrop is lighter than the one under `NodeBrowser` — a welcome, not a wall.
 *
 * **Nothing here sits on raw image pixels.** The image is one layer, `.start__scrim` covers it
 * with theme tokens (and goes fully opaque from the rails down), and every card is an opaque
 * surface. So the placeholder can be swapped for any photograph without a contrast review: the
 * numbers are the theme's, not the picture's.
 *
 * **Closing is not dismissing.** Only the checkbox writes to storage; Esc, the ✕, the Close
 * button and a click on the backdrop all just close. Ticking the box does not close either, so
 * it stays undoable in the same visit — and reopening from the toolbar's ? shows it ticked.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { CodaMark } from '../CodaMark'
import { useGraphStore } from '../../store/graphStore'
import cambridgeDark from '../logos/cambridge-dark.png?url'
import cambridgeLight from '../logos/cambridge-light.png?url'
import lmbDark from '../logos/lmb-dark.png?url'
import lmbLight from '../logos/lmb-light.png?url'
import { datasetGlyph } from '../nodes/DatasetPreview'
import { nodeGlyph } from './NodeThumbnail'
import { REPLACE_GRAPH_QUESTION } from '../replaceConfirm'
import type { DatasetCard, ExampleCard, StartCard, WorkflowCard } from './startCards'
import { datasetCards, exampleCards, workflowCards } from './startCards'
import { shortcutKeys } from '../shortcuts'
import { TOURS, startTour } from '../tour/tourState'

const REPO_URL = 'https://github.com/navis-org/coda'
/** The group that develops Coda, named in the credits line. */
const GROUP_URL = 'https://flyconnecto.me/'
/** The two institutions behind that group, credited by their marks in the same row. */
const LMB_URL = 'https://mrclmb.ac.uk/'
const CAMBRIDGE_URL = 'https://www.zoo.cam.ac.uk/research/groups/connectomics'
/*
 * The scroll-through introduction, built as a second entry alongside the app —
 * and what "Docs" in the credits row points at, since it is the document
 * somebody arriving here actually wants.
 *
 * Through `BASE_URL` for the same reason the backdrop is: `base` is './' so the
 * build works from a subpath, where an absolute path resolves to the domain
 * root and 404s on GitHub Pages.
 */
const TUTORIAL_URL = `${import.meta.env.BASE_URL}tutorial.html`
/** The node reference, built as a third entry. Same `BASE_URL` reasoning as above. */
const NODE_GUIDE_URL = `${import.meta.env.BASE_URL}nodes.html`
/**
 * The feature overview, built as a fourth entry — the front door for somebody
 * who has not decided whether to open the editor at all. Same `BASE_URL`
 * reasoning as above.
 */
const OVERVIEW_URL = `${import.meta.env.BASE_URL}overview.html`

export function StartPage() {
  const open = useGraphStore((s) => s.startPageOpen)
  const dismissed = useGraphStore((s) => s.startPageDismissed)
  const closeStartPage = useGraphStore((s) => s.closeStartPage)
  const setStartPageDismissed = useGraphStore((s) => s.setStartPageDismissed)
  const requestFeedback = useGraphStore((s) => s.requestFeedback)
  const loadExample = useGraphStore((s) => s.loadExample)
  const loadStarter = useGraphStore((s) => s.loadStarter)
  const openFromLibrary = useGraphStore((s) => s.openFromLibrary)
  const library = useGraphStore((s) => s.library)
  const refreshLibrary = useGraphStore((s) => s.refreshLibrary)
  // A primitive, so the snapshot identity check is satisfied — see invariant 7.
  const hasWork = useGraphStore((s) => s.graph.nodes.length > 0)

  /** Card awaiting a "replace the current graph?" answer, if any. */
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const closeRef = useRef<HTMLButtonElement>(null)

  const examples = useMemo(() => exampleCards(), [])
  const datasets = useMemo(() => datasetCards(), [])
  const workflows = useMemo(() => workflowCards(library), [library])

  useEffect(() => {
    if (!open) return
    setConfirming(undefined)
    closeRef.current?.focus()
    // Read the shelf when the page opens rather than at store load: someone who has never
    // saved anything should not pay an IndexedDB open for a rail they will never see.
    void refreshLibrary()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeStartPage()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, closeStartPage, refreshLibrary])

  if (!open) return null

  /**
   * Loading resets the undo history, so a graph already on the canvas is asked about first.
   * On a fresh visit there is nothing there and this never fires. The question is asked on the
   * card rather than through `window.confirm`, which jsdom does not implement and which would
   * put a browser chrome dialog in front of a page explaining the app.
   */
  const pick = (card: StartCard) => {
    if (hasWork && confirming !== card.id) {
      setConfirming(card.id)
      return
    }
    if (card.kind === 'example') loadExample(card.id)
    else if (card.kind === 'workflow') void openFromLibrary(card.id)
    else loadStarter(card.starter)
    setConfirming(undefined)
    closeStartPage()
  }

  return (
    <div className="start" role="presentation" onPointerDown={closeStartPage}>
      <div
        className="start__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="start-title"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/*
         * `BASE_URL` rather than a bare `/start/…`: `base` is './' so the build works from a
         * subpath, where an absolute URL resolves to the domain root and 404s.
         */}
        <div
          className="start__image"
          style={{ backgroundImage: `url(${import.meta.env.BASE_URL}start/backdrop.svg)` }}
          aria-hidden="true"
        />
        <div className="start__scrim" aria-hidden="true" />

        <button
          type="button"
          className="start__close"
          onClick={closeStartPage}
          title="Close (Esc)"
          aria-label="Close start page"
        >
          ✕
        </button>

        <div className="start__scroll">
          <header className="start__head">
            <div className="start__brand">
              {/*
               * The mark stands in for the letter o rather than sitting beside the name — the
               * coda sign is a ring, so the substitution is the whole argument for it in one
               * image. `aria-label` because the visible text is now "C" + a glyph + "da", and
               * the dialog names itself from this heading.
               */}
              <h1 id="start-title" aria-label="Coda">
                C<CodaMark size={38} className="start__o" />
                da
              </h1>
              <span className="start__badge">Alpha</span>
              <span className="start__version">v{__APP_VERSION__}</span>
            </div>
            <p className="start__lede">
              Next-generation connectome analysis.{' '}
              <strong>Build an analysis out of nodes</strong>, wire them together, and see the
              result at every step.
            </p>
            <p className="start__alpha">
              Coda is in alpha. Expect rough edges. Feedback & feature requests are very welcome!
            </p>
          </header>

          {/*
           * First, and only when there is something on it. A returning user is here for their
           * own work, so it goes above the two rails of things to start from — and an empty
           * rail explaining that it is empty is noise on the visit where it matters most, the
           * first one, when nobody has saved anything yet.
           */}
          {workflows.length > 0 && (
            <Deck
              label="Your workflows"
              note="saved in this browser · not synced, and cleared with the site data"
              cards={workflows}
              confirming={confirming}
              onPick={pick}
              onCancel={() => setConfirming(undefined)}
            />
          )}

          <Deck
            label="Examples"
            note="these use built-in mock data · no token needed · swap in a real dataset"
            cards={examples}
            confirming={confirming}
            onPick={pick}
            onCancel={() => setConfirming(undefined)}
          />

          <Deck
            label="Datasets"
            note="real datasets · add credentials under Connections, the branch icon in the toolbar"
            cards={datasets}
            confirming={confirming}
            onPick={pick}
            onCancel={() => setConfirming(undefined)}
          />
        </div>

        {/*
         * The shortcuts and the credits live in the bar, not at the end of the scroll. That is
         * what makes them visible at all: the decks are the scrolling part, so a row below them
         * is only reached by someone who scrolled past the thing they opened the page for.
         *
         * Two rows rather than three, and the split is measured rather than chosen. The keys box
         * and the actions come to ~700px of the bar's 972, so they share a line; the credits run
         * ~850px and cannot join them without wrapping. The credits go last, where a colophon
         * goes, which also leaves the keys above them in the order they were already in.
         *
         * The funder logos share that last row rather than taking a third, and sit at its right
         * end: they are what "Developed by ... (Cambridge, UK)" is attributing, so they belong beside
         * that sentence and not under the whole bar. They cost the credits a line — ~850px of
         * text plus ~285px of logo does not fit 972 — which is why the text is allowed to wrap
         * to two and the logos are sized to stand about as tall as the two lines together.
         */}
        <div className="start__bar">
          <div className="start__bar-row">
            {/* Glyphs from `shortcuts.ts`, so the box says ⌘ or Ctrl to match the keyboard the
                reader actually has. The four are picked by hand rather than by a list constant
                because the last cell pairs two of them — see the width note above. */}
            <div className="start__keys">
              <span>
                <strong>{shortcutKeys('palette')}</strong> commands
              </span>
              <span>
                <strong>{shortcutKeys('browse-nodes')}</strong> add a node
              </span>
              <span>
                <strong>{shortcutKeys('run-all')}</strong> run
              </span>
              <span>
                <strong>{shortcutKeys('pan')}</strong> pan ·{' '}
                <strong>{shortcutKeys('box-select')}</strong> box-select
              </span>
            </div>
            <span className="toolbar__spacer" />
            <label className="start__dismiss">
              <input
                type="checkbox"
                checked={dismissed}
                onChange={(e) => setStartPageDismissed(e.target.checked)}
              />
              Don&rsquo;t show again
            </label>
            <button
              type="button"
              className="btn btn--primary"
              ref={closeRef}
              onClick={closeStartPage}
            >
              Close
            </button>
          </div>
          <div className="start__credits">
            <div className="start__links">
              <span>
                Developed by{' '}
                <a href={GROUP_URL} target="_blank" rel="noreferrer noopener">
                  Fly Connectomics Group
                </a>{' '}
                (Cambridge, UK) · Source Code at{' '}
                <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
                  github.com/navis-org/coda
                </a>{' '}
                <br/>
                <button
                  type="button"
                  className="start__link-button"
                  onClick={() => {
                    closeStartPage()
                    requestFeedback('general')
                  }}
                >
                  Give feedback
                </button>{' '}
                ·{' '}
                {/*
                 * Buttons, not links, and the only ones in this row — the tours happen *here*,
                 * over the editor this page is sitting on top of, rather than in a new tab. Each
                 * closes the start page on the way, because a tour whose first stop is the
                 * canvas cannot begin with a modal over it.
                 */}
                {TOURS.map((tour) => (
                  <span key={tour.id}>
                    <button
                      type="button"
                      className="start__link-button"
                      onClick={() => {
                        closeStartPage()
                        void startTour(tour.id)
                      }}
                    >
                      {tour.label}
                    </button>{' '}
                    ·{' '}
                  </span>
                ))}
                <a href={OVERVIEW_URL} target="_blank" rel="noreferrer noopener">
                  Overview
                </a>{' '}
                ·{' '}
                <a href={TUTORIAL_URL} target="_blank" rel="noreferrer noopener">
                  Docs
                </a>{' '}
                ·{' '}
                <a href={NODE_GUIDE_URL} target="_blank" rel="noreferrer noopener">
                  Node guide
                </a>
              </span>
            </div>

            {/*
             * Both inks of each logo ship, and CSS hides the wrong one — see `.start__logo`
             * in `editor.css`. Picking in JS would have to resolve `theme: 'system'` through
             * `matchMedia` and listen for changes; this keeps the swap in the one place the
             * rest of the theming already lives, and `display: none` also takes the hidden
             * copy out of the accessibility tree, so each logo is announced exactly once.
             */}
            <div className="start__logos">
              {/*
               * One anchor per institution wrapping both inks, rather than a link per image:
               * the hidden copy is `display: none` and so out of the accessibility tree, which
               * leaves each link named once, by the `alt` of whichever ink is showing.
               */}
              <a
                className="start__logo-link"
                href={LMB_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                <img
                  className="start__logo start__logo--light"
                  src={lmbLight}
                  alt="MRC Laboratory of Molecular Biology"
                />
                <img
                  className="start__logo start__logo--dark"
                  src={lmbDark}
                  alt="MRC Laboratory of Molecular Biology"
                />
              </a>
              <a
                className="start__logo-link"
                href={CAMBRIDGE_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                <img
                  className="start__logo start__logo--cam start__logo--light"
                  src={cambridgeLight}
                  alt="University of Cambridge"
                />
                <img
                  className="start__logo start__logo--cam start__logo--dark"
                  src={cambridgeDark}
                  alt="University of Cambridge"
                />
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface DeckProps {
  label: string
  note: string
  cards: StartCard[]
  confirming: string | undefined
  onPick: (card: StartCard) => void
  onCancel: () => void
}

/**
 * One horizontal rail of cards.
 *
 * The arrows appear only when the track actually overflows, so a short rail does not grow two
 * dead controls. Left/right walk the row because a rail that can only be reached by tabbing
 * through every card is a rail a keyboard user will not use.
 */
function Deck({ label, note, cards, confirming, onPick, onCancel }: DeckProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ overflows: false, atStart: true, atEnd: false })

  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const sync = () => {
      const overflows = track.scrollWidth - track.clientWidth > 4
      const atStart = track.scrollLeft < 8
      const atEnd = track.scrollLeft > track.scrollWidth - track.clientWidth - 8
      // Returning the previous object when nothing moved keeps a scroll event from
      // re-rendering the whole rail on every frame of a swipe.
      setScroll((prev) =>
        prev.overflows === overflows && prev.atStart === atStart && prev.atEnd === atEnd
          ? prev
          : { overflows, atStart, atEnd },
      )
    }
    sync()
    track.addEventListener('scroll', sync)
    const observer = new ResizeObserver(sync)
    observer.observe(track)
    return () => {
      track.removeEventListener('scroll', sync)
      observer.disconnect()
    }
  }, [cards])

  // Smoothness is left to CSS `scroll-behavior`, so `prefers-reduced-motion` can turn it off
  // in one place instead of this needing its own matchMedia check.
  const step = (direction: 1 | -1) => {
    trackRef.current?.scrollBy({ left: direction * 420 })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const buttons = [...(trackRef.current?.querySelectorAll('.start-card__main') ?? [])]
    const at = buttons.indexOf(document.activeElement as Element)
    const next = buttons[at + (event.key === 'ArrowRight' ? 1 : -1)]
    if (next instanceof HTMLElement) {
      event.preventDefault()
      next.focus()
    }
  }

  return (
    <section className="start__deck">
      <h2 className="start__deck-label">
        {label} <span>{note}</span>
      </h2>
      <div className="start__deck-viewport">
        {scroll.overflows && !scroll.atStart && (
          <button
            type="button"
            className="start__arrow"
            data-dir="prev"
            onClick={() => step(-1)}
            aria-label={`Scroll ${label.toLowerCase()} left`}
          >
            ‹
          </button>
        )}
        <div className="start__track" ref={trackRef} onKeyDown={onKeyDown}>
          {cards.map((card) => (
            <Card
              key={card.id}
              card={card}
              confirming={confirming === card.id}
              onPick={onPick}
              onCancel={onCancel}
            />
          ))}
        </div>
        {scroll.overflows && !scroll.atEnd && (
          <button
            type="button"
            className="start__arrow"
            data-dir="next"
            onClick={() => step(1)}
            aria-label={`Scroll ${label.toLowerCase()} right`}
          >
            ›
          </button>
        )}
      </div>
    </section>
  )
}

interface CardProps {
  card: StartCard
  confirming: boolean
  onPick: (card: StartCard) => void
  onCancel: () => void
}

function Card({ card, confirming, onPick, onCancel }: CardProps) {
  const tint = card.kind === 'dataset' ? 'var(--cat-dataset)' : `var(--cat-${card.category})`

  return (
    <div className="start-card" style={{ ['--tint' as string]: tint }}>
      {/* A separate element from the card so the confirm buttons are siblings rather than
          buttons nested inside a button. */}
      <button type="button" className="start-card__main" onClick={() => onPick(card)}>
        <span className="start-card__tile">
          <CardTile card={card} />
        </span>
        <span className="start-card__text">
          <span className="start-card__name">{card.title}</span>
          <span className="start-card__blurb">{card.blurb}</span>
        </span>
      </button>

      {confirming && (
        <div className="start-card__confirm">
          <p>{REPLACE_GRAPH_QUESTION}</p>
          <div>
            <button type="button" className="btn btn--primary" onClick={() => onPick(card)}>
              Replace
            </button>
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** The picture, when one exists; otherwise the art the app already draws for that thing. */
function CardTile({ card }: { card: StartCard }) {
  if (card.image) return <img className="start-card__img" src={card.image} alt="" />
  if (card.kind === 'dataset') {
    return <GlyphSvg viewBox="0 0 52 46">{datasetGlyph((card as DatasetCard).glyph)}</GlyphSvg>
  }
  // Examples and saved workflows both stand for a graph, so both take the art of their own
  // terminal viewer node — the same drawing that node wears on the canvas.
  const graphCard = card as ExampleCard | WorkflowCard
  return (
    <GlyphSvg viewBox="0 0 24 24">{nodeGlyph(graphCard.nodeType, graphCard.category)}</GlyphSvg>
  )
}

function GlyphSvg({ viewBox, children }: { viewBox: string; children: React.ReactNode }) {
  return (
    <svg
      className="start-card__glyph"
      viewBox={viewBox}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}
