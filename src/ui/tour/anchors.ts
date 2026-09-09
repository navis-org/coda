/**
 * Every `data-tour` name the app publishes, and the one way to resolve one.
 *
 * Split out of `steps.ts` rather than living there, and the reason is the chunk boundary rather
 * than tidiness. `steps.ts` holds the Guided Tour's prose and imports the store, `fitView` and
 * the registry; it is reachable only through the `import()` in `startTour`, which is what keeps
 * ~24 kB of step copy out of every cold load. The Screen Map is **not** behind that import — it
 * is mounted in `App.tsx` — so `mapSpots.ts` importing `byTour` from `steps.ts` pulled the whole
 * module, prose included, into the main chunk. Verified against a real build: the Guided Tour's
 * step bodies were in `main-*.js` while `build.ts`'s and `dashboard.ts`'s were not.
 *
 * So the vocabulary lives here, where a static importer costs a string tuple and two lines, and
 * `steps.ts` keeps everything that is about a *step*. It is still one table with one reader
 * apiece — which is the argument `steps.ts` makes for addressing elements this way at all, and
 * the reason the Screen Map's own anchors are in it rather than in a second list.
 */

/**
 * Every `data-tour` value the app carries. A union rather than a bare string so a step naming
 * an anchor nobody publishes is a type error, not a silent no-op at runtime.
 */
export const TOUR_ANCHORS = [
  'canvas',
  'add',
  'run',
  'autorun',
  /*
   * Added for the Screen Map, which labels everything on the shell at once and so names controls
   * no tour ever stops at. In this table rather than a second one because `byTour` is the one way
   * anything in the app addresses an element by name, and two vocabularies for that is how a
   * renamed anchor comes to be a silent no-op in one of them. Not marked as the map's own: the
   * moment a tour points at Undo, an ownership claim here would be wrong with nothing failing.
   */
  'new',
  'open',
  'save',
  'undo',
  'redo',
  'fullscreen',
  'theme',
  'workflow-name',
  'statusbar',
  'inspector',
  'inspector-panel',
  'connections-panel',
  'dashboard',
  'connections',
  'assistant',
  'share',
  'help',
] as const

export type TourAnchor = (typeof TOUR_ANCHORS)[number]

/** The element carrying a `data-tour` name, or null. */
export function byTour(anchor: TourAnchor): Element | null {
  return document.querySelector(`[data-tour="${anchor}"]`)
}
