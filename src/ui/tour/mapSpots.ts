/**
 * What the Screen Map labels, in the order it places them.
 *
 * ## The one thing it does
 *
 * The three tours walk. Each stop hides the rest of the app behind a scrim and says one thing,
 * which is the right shape for teaching a sequence and the wrong shape for the question this
 * answers: *what is all of this*. Somebody looking at the editor for the first time does not
 * have a sequence in mind — they have eleven buttons in front of them and no idea which of them
 * is the one they want. So this guide has no steps. Everything on screen is boxed and labelled
 * at once, the reader reads the half they care about, and it closes.
 *
 * It is `nodeguide/anatomy.ts` pointed at the shell instead of at a card, which is also the
 * division of labour: that figure explains a *node*, this one explains everything round it, and
 * the canvas spot's note is what sends a reader from one to the other.
 *
 * ## Why the finders are functions
 *
 * A spot that is not on screen is not on the map. That is not a degradation, it is the feature:
 * the inspector is labelled when it is open, `⋯` swallows two thirds of the toolbar below 720px,
 * and a control folded away has no box because it has no place. Every finder may return nothing,
 * and several return more than one element — `New`, `Open` and `Save` are three menus and one
 * idea, so they get one box round all three.
 *
 * `screenMap.test.tsx` mounts the app and asserts every finder resolves, which is the only thing
 * standing between a renamed anchor and a map with a hole in it. One spot is a class selector
 * rather than a `data-tour` name, and only one: `.react-flow__controls` is React Flow's own
 * markup, so an anchor there would mean wrapping a library element. Everything else the map names
 * is ours and publishes an anchor, because a class is a *styling* decision that rots silently —
 * which is the argument `anchors.ts` exists on, and the map is exactly the one reader that makes
 * an anchor on a `<div>` worth having.
 *
 * ## The copy
 *
 * A label of two or three words and **one** sentence under it. The rule is `docs/help.md`'s
 * voice rule narrowed by the space: say the thing a reader would not predict from the icon.
 * "Run — runs the graph" is a label that has cost the reader a glance and told them what the
 * word already said; "nothing fetches until you ask for it" is what they did not know.
 */

import { byTour } from './anchors'
import type { LabelSide } from './mapLayout'

export interface MapSpot {
  id: string
  /**
   * The elements this box goes round, unioned. Empty or all-missing means the spot is not on
   * this screen and is simply left off the map.
   */
  find: () => readonly (Element | null | undefined)[]
  /** Two or three words. The sentence is in `note`. */
  label: string
  /** One sentence. Rendered as text, never as markup. */
  note: string
  side: LabelSide
  /** A region rather than a control — see `LabelBox.region`. */
  region?: boolean
  /** For an `inside` label: where in the box it starts, as a fraction of each axis. */
  at?: readonly [number, number]
}

/** React Flow's own controls rail — the one element here we do not render and cannot anchor. */
const viewRail = () => document.querySelector('.react-flow__controls')

export const MAP_SPOTS: readonly MapSpot[] = [
  // --- the canvas, first, because everything else is arranged round it -------
  {
    id: 'canvas',
    find: () => [byTour('canvas')],
    label: 'The canvas',
    note: 'Every card is one step, and a wire carries a typed value to the next. The node guide explains a card.',
    side: 'inside',
    region: true,
    at: [0.5, 0.34],
  },

  // --- the left of the toolbar: the document --------------------------------
  {
    id: 'documents',
    find: () => [byTour('new'), byTour('open'), byTour('save')],
    label: 'The workflow',
    note: 'Start one from a dataset or the wizard; open and save to a file or to this browser.',
    side: 'below',
  },
  {
    id: 'name',
    find: () => [byTour('workflow-name')],
    label: 'Its name',
    note: 'Type over it to rename. The name travels with the workflow into a link or a file.',
    side: 'below',
  },
  {
    id: 'help',
    find: () => [byTour('help')],
    label: 'Help',
    note: 'These guides, the written documentation, and the way back to the welcome page.',
    side: 'below',
  },
  {
    id: 'history',
    find: () => [byTour('undo'), byTour('redo')],
    label: 'Undo and redo',
    note: 'Every edit is a step, including the ones the assistant made for you.',
    side: 'below',
  },

  // --- the right of the toolbar: panels, then the run -----------------------
  {
    id: 'share',
    find: () => [byTour('share')],
    label: 'Share',
    note: 'A link with the whole workflow inside it. Nothing is uploaded, and no results travel.',
    side: 'below',
  },
  {
    id: 'connections',
    find: () => [byTour('connections')],
    label: 'Connections',
    note: 'Where a server and its token go. Tokens stay in this browser, never in a share link.',
    side: 'below',
  },
  {
    id: 'assistant',
    find: () => [byTour('assistant')],
    label: 'Assistant',
    note: 'Describe the change you want in words; it wires the cards and shows you the plan first.',
    side: 'below',
  },
  {
    id: 'dashboard',
    find: () => [byTour('dashboard')],
    label: 'Dashboard',
    note: 'Swaps the canvas for a grid of the views worth watching.',
    side: 'below',
  },
  {
    id: 'run',
    find: () => [byTour('run')],
    label: 'Run',
    note: 'Brings the out-of-date cards up to date — the badge says how many. Nothing reaches a server until you ask.',
    side: 'below',
  },
  {
    id: 'autorun',
    find: () => [byTour('autorun')],
    label: 'Auto-run',
    note: 'Re-runs the cheap cards as you edit. The ones that fetch or compute still wait for Run.',
    side: 'below',
  },
  {
    id: 'window',
    find: () => [byTour('fullscreen'), byTour('theme')],
    label: 'Screen and theme',
    note: 'Fullscreen reclaims the browser’s own chrome. The theme cycles dark, light, system.',
    side: 'below',
  },

  // --- the canvas's own controls --------------------------------------------
  {
    id: 'add',
    find: () => [byTour('add')],
    label: 'Add a node',
    note: 'Unfolds into every node there is, by category. Double-clicking empty canvas does the same.',
    side: 'left',
  },
  {
    id: 'rail',
    find: () => [viewRail()],
    label: 'View and layout',
    note: 'Zoom and fit, arrange the cards, and the lock that keeps them where they are.',
    side: 'right',
  },

  // --- the panels and the foot ----------------------------------------------
  {
    id: 'inspector',
    find: () => [byTour('inspector-panel')],
    label: 'The inspector',
    note: 'Every setting of the selected card, including the ones it keeps out of the way.',
    side: 'left',
    region: true,
  },
  {
    id: 'statusbar',
    find: () => [byTour('statusbar')],
    label: 'Status',
    note: 'How big the graph is, what the last run did, and six shortcuts worth learning.',
    side: 'above',
  },
]
