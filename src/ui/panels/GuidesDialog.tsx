/**
 * The first thing a first-time visitor sees: the in-app guides, and a nudge to take the first.
 *
 * It sits *in front of* the welcome page rather than inside it, which is a claim about what a
 * newcomer should do first. The welcome page is a good page — it says what Coda is, and it
 * offers eleven ways in. That is exactly the problem it has on a first visit: eleven doors is a
 * decision, and the reader has no basis on which to make it yet. This asks one question with a
 * recommended answer, and hands over to the page behind it either way.
 *
 * ## Three rules it is built on
 *
 * **First visit only.** `coda.guidesSeen.v1` is written the moment it is shown, not when it is
 * closed and not when the guides are finished — so it is never in the way twice. That is what
 * lets it be the loud, opinionated surface it is; a modal that keeps coming back has to be
 * quiet. The guides stay reachable afterwards from the `?` menu, the command palette and the
 * welcome page's own rail, none of which this changes.
 *
 * **A guide taken from here comes back here.** `beginGuide` takes the launch sequence off
 * screen, the guide runs over the canvas, and `finishGuide` puts it back — so somebody who
 * takes the Basics is offered the next one rather than being dropped on an empty canvas having
 * to find it again. A guide started from the `?` menu ends where it always did; the difference
 * is `beginGuide` having run, not anything the tour knows.
 *
 * **A checkmark means finished, not started.** driver's Done button is the only thing that
 * earns one — see `finishGuide`'s caller in `tour.ts`. A guide abandoned halfway still returns
 * here, unticked, which is the honest reading of what happened and leaves it inviting rather
 * than crossed off.
 *
 * The list itself is `TOURS`, for the reason that table exists: four surfaces now launch these
 * and none of them writes its own name for one.
 */

import { useEffect, useRef } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { saveGuidesSeen } from '../../store/persistence'
import { useDismissOnOutside } from '../useDismiss'
import { TOURS, startTour } from '../tour/tourState'
import { useLaunchStage } from './launchStage'

export function GuidesDialog() {
  const stage = useLaunchStage()
  if (stage !== 'guides') return null
  return <Dialog />
}

function Dialog() {
  const closeGuides = useGraphStore((s) => s.closeGuides)
  const beginGuide = useGraphStore((s) => s.beginGuide)
  const completed = useGraphStore((s) => s.completedGuides)
  const panelRef = useRef<HTMLDivElement>(null)
  const startRef = useRef<HTMLButtonElement>(null)

  /*
   * Escape and a click on the backdrop both close, which here means "on to the welcome page" —
   * nothing is lost by either, so the share gate's `outside: false` reasoning does not apply.
   */
  useDismissOnOutside(panelRef, closeGuides, { onEscape: true })

  /*
   * Written on *sight*, so this is the mount that spends the one visit it gets. Also runs on the
   * mount that follows a guide, which is harmless — the key is already there.
   */
  useEffect(() => {
    saveGuidesSeen()
    startRef.current?.focus()
  }, [])

  const allDone = TOURS.every((tour) => completed.includes(tour.id))
  /*
   * Where the keyboard lands: the first guide not yet taken. On the first visit that is the
   * Basics, which is the one being recommended; on the way back from it, it is the next one
   * along — so Enter always does the thing the dialog is currently suggesting.
   */
  const next = TOURS.find((tour) => !completed.includes(tour.id))

  const start = (id: (typeof TOURS)[number]['id']) => {
    beginGuide()
    // Not awaited: `startTour` is a dynamic import of driver.js, every caller of it is a click
    // handler, and the failure worth reporting is a chunk that will not load.
    void startTour(id)
  }

  return (
    <div className="overlay" role="presentation">
      <div
        ref={panelRef}
        className="overlay__panel guides"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guides-title"
      >
        <header className="sources__header">
          <h2 id="guides-title">Hi there 👋 Looks like you're new here! Care for a quick tour?</h2>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={closeGuides}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="guides__body">
          <p className="guides__lede">
            Coda has {TOURS.length} short guides that run <strong>inside the editor</strong>,
            pointing at things in place. If you only take one, take the first — it is about a
            minute, and everything else assumes it.
          </p>

          <ul className="guides__list">
            {TOURS.map((tour, index) => {
              const done = completed.includes(tour.id)
              return (
                <li key={tour.id}>
                  <button
                    type="button"
                    className="guides__row"
                    ref={tour.id === next?.id ? startRef : undefined}
                    onClick={() => start(tour.id)}
                    /* The mark is a glyph; `data-done` is what the checkmark and the muted
                       title hang off, so the state is not carried by colour alone. */
                    data-done={done ? '' : undefined}
                  >
                    <span className="guides__mark" aria-hidden="true">
                      {done ? '✓' : index + 1}
                    </span>
                    <span className="guides__text">
                      <span className="guides__name">
                        {tour.label}
                        {index === 0 && !done && (
                          <span className="guides__badge">Start here</span>
                        )}
                        {done && <span className="guides__done">Completed</span>}
                      </span>
                      <span className="guides__blurb">{tour.blurb}</span>
                    </span>
                    <span className="guides__go" aria-hidden="true">
                      {done ? 'Again' : 'Start'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="guides__foot">
          <span className="guides__note">
            You can start these any time from the <strong>?</strong> menu.
          </span>
          {/*
           * One button, whose label is the honest description of what it does at the time.
           * "Skip" for somebody who has taken nothing, and something that reads like an ending
           * for somebody who has just finished the last guide and is being shown this dialog
           * for the third time.
           */}
          <button
            type="button"
            className={allDone ? 'btn btn--primary' : 'btn'}
            onClick={closeGuides}
          >
            {allDone ? 'Continue to Coda' : 'Skip for now'}
          </button>
        </div>
      </div>
    </div>
  )
}
