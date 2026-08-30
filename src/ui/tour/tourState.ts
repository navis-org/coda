/**
 * The static half of the tour, and the reason there are two halves.
 *
 * `tour.ts` imports driver.js, `driver.css` and the step copy — around 8 kB gzipped that most
 * sessions never look at. Two places in the app need to know about a tour *without* wanting any
 * of that: the toolbar, which starts one, and the canvas, which has to keep the spotlight
 * attached to a card while React Flow moves the camera under it. A static import from either
 * would put driver.js in the main chunk and undo the split.
 *
 * So this module is the whole of what the rest of the app links against — four functions over
 * one nullable handle — and `startTour` is the single `import()` that pulls the real thing in.
 * Nothing here knows what a step is.
 */

/** What `tour.ts` hands back once a tour is running. A subset of driver's own `Driver`. */
export interface TourHandle {
  refresh(): void
}

let handle: TourHandle | undefined
/** True from the click until `runTour` has the driver up — see `startTour`. */
let loading = false

/**
 * Published by `tour.ts` when a tour starts, and cleared when it ends.
 *
 * Holding the handle here rather than in `tour.ts` is what lets `isTourActive` be a synchronous
 * answer from a module that has loaded nothing: the canvas asks it on every keystroke.
 */
export function setTourHandle(next: TourHandle | undefined): void {
  handle = next
}

/**
 * Is a tour on screen right now?
 *
 * The canvas's keyboard handler asks before acting. Bare `f`, `i`, `m`, `h`, `/` and `§` are all
 * live over the canvas, and driver's popover buttons are ordinary `<button>`s — so the guard
 * that keeps the app's shortcuts off a field somebody is typing in (`INPUT`, `TEXTAREA`) does
 * not cover them, and reading a popover with a finger near the keyboard would go fullscreen.
 */
export function isTourActive(): boolean {
  return handle !== undefined
}

/**
 * Recompute the spotlight's geometry against the elements' current rects.
 *
 * driver.js watches `resize` and `scroll` and nothing else, which is correct for a document and
 * wrong for this canvas: React Flow moves the world with a CSS `transform`, so panning or
 * zooming fires neither event and the cut-out stays where the card *was*. It renders perfectly
 * and is silently pointing at empty canvas — the same class of failure as a `stroke` attribute
 * that will not resolve a `var()`.
 *
 * `Editor` calls this from React Flow's `onMove`, which fires for programmatic viewport
 * animations as well as for the user's own drag. That is what makes a step able to frame the
 * card it is about: the spotlight tracks the camera through the whole `fitView` transition
 * rather than being recomputed once at each end of it.
 *
 * A no-op when no tour is running, so the canvas can call it unconditionally.
 */
export function refreshTour(): void {
  handle?.refresh()
}

/** Which tour to run. */
export type TourId = 'guided' | 'build' | 'dashboard'

/**
 * The tours as the menus offer them, so three surfaces cannot disagree about what they are
 * called.
 *
 * The toolbar's `?` menu, the command palette and the start page each launch both tours, and
 * each had its own hand-written label and blurb — which had already drifted ("A minute around
 * the editor, in place." against "…pointing at things in place"). One table is the same fix the
 * tours' own `data-tour` anchors make: name the thing once, in the place both readers look.
 *
 * **Two names each, because one surface nests them and two do not.** Under the `?` menu's
 * `Guides ▸` heading, "Guided Tour" stutters and the useful word is what distinguishes the two
 * — so that menu takes `short`. The palette is a flat searchable list and the start page a row
 * of links; in both, a bare "Basics" says nothing about what it is, so they keep `label`. The
 * shortening is a consequence of the nesting, so it belongs to the surface that nests.
 */
export const TOURS = [
  {
    id: 'guided',
    label: 'Guided Tour',
    short: 'Basics',
    blurb: 'A minute around the editor, pointing at things in place.',
  },
  {
    id: 'build',
    label: 'Learn to Build',
    short: 'Learn to Build',
    blurb: 'Build a working pipeline from scratch, a node at a time.',
  },
  {
    id: 'dashboard',
    label: 'Build a Dashboard',
    short: 'Build a Dashboard',
    blurb: 'Turn a small graph into a grid of live views. Uses MaleCNS on neuPrint.',
  },
] as const satisfies readonly {
  id: TourId
  label: string
  short: string
  blurb: string
}[]

/**
 * Load driver.js and run a tour.
 *
 * The one `import()` in the app that reaches the tour. Awaited by nobody: every caller is a
 * click handler, and the failure worth reporting is a chunk that will not load, which the
 * console already says more about than we could.
 *
 * **Refuses while one is already running**, which is what lets `build.ts` keep the ids of what
 * it has made in module state: there is never a second reader for them.
 */
export async function startTour(id: TourId = 'guided'): Promise<void> {
  /*
   * `loading` covers the window `handle` cannot: it is only set once `runTour` is running, and
   * the `import()` below is a network round trip on the first press. Two clicks inside it would
   * start two tours, two driver instances and two writers into `build.ts`'s module state —
   * whose own note rests on this refusal holding.
   */
  if (handle || loading) return
  loading = true
  try {
    const module = await import('./tour')
    await module.runTour(id)
  } finally {
    loading = false
  }
}
