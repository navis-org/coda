/**
 * The notice a phone gets instead of the editor.
 *
 * `smallScreen.ts` decides *when*; this is *what it says*, and the shape is deliberate in three
 * ways.
 *
 * **It covers rather than tints.** Every other dialog here uses `.overlay`'s translucent
 * backdrop, because the canvas behind it is context worth keeping. Here the canvas behind it is
 * the problem being described — a toolbar wrapped onto three rows and a card half off the edge —
 * so this one backdrop is opaque. Showing somebody the mess while telling them about it makes
 * the notice read as a symptom of the same breakage.
 *
 * **It is not a wall.** "Proceed anyway" is the primary action and it is not hidden behind a
 * warning triangle: the layout is bad on a phone, not broken, and somebody who wants to open a
 * link a colleague sent them and read the graph is doing something perfectly reasonable. A gate
 * with no way through would also be the one thing here that a person cannot work around, which
 * for an app with no account and no server is out of character.
 *
 * **The links are the useful half.** Coda's three static pages — the overview, the field guide
 * and the node reference — carry the prose and are already responsive. For a reader who arrived
 * on a phone from a link, those are very often what they actually wanted, and offering them is a
 * better answer than either "sorry" or a canvas they cannot use.
 *
 * Mounted last in `App`, above every other dialog, and `GuidesDialog` stands down while it is up
 * so the first-run dialog does not spend its once-ever appearance behind this one.
 */

import { useEffect, useRef } from 'react'

import { acknowledgeSmallScreen, useSmallScreenNotice } from '../smallScreen'

/*
 * The three pages that read on a phone. Through `BASE_URL` for `StartPage`'s reason: `base` is
 * './' so the build works from a subpath, where an absolute path resolves to the domain root and
 * 404s on GitHub Pages.
 */
const OVERVIEW_URL = `${import.meta.env.BASE_URL}overview.html`
const TUTORIAL_URL = `${import.meta.env.BASE_URL}tutorial.html`
const NODE_GUIDE_URL = `${import.meta.env.BASE_URL}nodes.html`

export function SmallScreenGate() {
  const showing = useSmallScreenNotice()
  if (!showing) return null
  return <Notice />
}

function Notice() {
  const proceedRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    proceedRef.current?.focus()
  }, [])

  /*
   * No `useDismissOnOutside`. Every other dialog closes on Escape or a tap on the backdrop, and
   * both would be accidents here: there is no keyboard on the device this is written for, and a
   * tap outside a card is what a finger does on the way to a button. Dismissing has to be the
   * button, because dismissing is an answer that gets written down.
   */
  return (
    <div className="overlay small-screen" role="presentation">
      <div
        className="overlay__panel small-screen__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="small-screen-title"
      >
        <h2 id="small-screen-title">Coda wants a bigger screen</h2>
        <p>
          Coda is a node-graph editor built for a desktop or a tablet — a canvas you place cards
          on, wire together and read charts from. On a phone the layout will not hold together.
        </p>
        <p className="small-screen__quiet">
          These pages do read here, and are where the writing is:
        </p>
        <ul className="small-screen__links">
          <li>
            <a href={OVERVIEW_URL}>Overview</a> — what Coda is, in one scroll.
          </li>
          <li>
            <a href={TUTORIAL_URL}>Field guide</a> — an introduction that builds a real
            pipeline.
          </li>
          <li>
            <a href={NODE_GUIDE_URL}>Node guide</a> — every node, what it takes and what it
            hands on.
          </li>
        </ul>
        <div className="small-screen__actions">
          <button
            ref={proceedRef}
            type="button"
            className="btn btn--primary"
            onClick={acknowledgeSmallScreen}
          >
            Open it anyway
          </button>
        </div>
      </div>
    </div>
  )
}
