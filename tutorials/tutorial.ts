/**
 * The shape of a scripted tutorial, which `scripts/record-tutorial.mjs` turns into a video.
 *
 * A tutorial is a list of steps, each a line of narration and the actions that go with it. The
 * narration is synthesised first, so its length is known before anything is recorded, and each
 * step lasts as long as the longer of its narration and its actions. Nothing is synced by hand,
 * and a UI change means re-running the script rather than re-recording a take.
 *
 * Actions go in through the browser's own input pipeline (`Input.dispatchMouseEvent`), at human
 * speed and with a drawn cursor, because a viewer cannot learn a gesture they never saw. Setup —
 * whatever the video does not teach — goes straight through the store, before recording starts.
 */

/**
 * Something on screen to point at.
 *
 * - a CSS selector, answered by the first match — or, with `text`, the first match whose trimmed
 *   text is exactly that, or which holds an element whose text is: a result row showing a name
 *   and a description is found by the name;
 * - a card, by node type — its header unless `css` names an element inside it, or `handle` a port
 *   socket; `nth` picks among several cards of one type;
 * - a point in CSS pixels.
 *
 * `at` is where inside the element's box, as fractions of its width and height; the centre by
 * default. Values past 0..1 point outside it, which is how a script names "the empty canvas just
 * right of this card" at any zoom. `offset` then moves that point by CSS pixels.
 */
type Placement = { at?: [number, number]; offset?: [number, number] }
export type Target =
  | string
  | ({ css: string; text?: string } & Placement)
  | ({ node: string; nth?: number; css?: string; handle?: string } & Placement)
  | { x: number; y: number }

export interface Driver {
  /**
   * Run `body` in the page, with `s` bound to the graph store. Returns what `body` returns. Import
   * app modules there through `appModule(path)` rather than `import(path)`, which after a hot
   * reload is a second copy of the module rather than the one on screen.
   */
  inPage<T = unknown>(body: string): Promise<T>
  /** Glide the cursor to a target. */
  moveTo(target: Target, options?: { ms?: number }): Promise<void>
  /** Glide there and rest the pointer for `ms`, so a hover panel has time to open and be read. */
  hover(target: Target, ms: number): Promise<void>
  /**
   * Glide there and click; `holding` presses that key around the click, as a person would —
   * `Meta` is how the canvas adds a card to a selection.
   */
  click(target: Target, options?: { holding?: 'Meta' | 'Shift' }): Promise<void>
  /**
   * Glide there and show the click without making it: for a link that opens a new tab, which a
   * recording of this one cannot follow. Follow it with `navigate`, which is the cut to that page.
   */
  clickOpensTab(target: Target): Promise<void>
  /** Glide there and right-click, which is what opens a card's context menu. */
  rightClick(target: Target): Promise<void>
  /** Click it if it is on screen within half a second, and say whether it was. */
  clickIf(target: Target): Promise<boolean>
  /**
   * Press on one target, glide to another, release. Wiring two sockets is a drag. `ms` is the
   * drag itself; `approach` the glide to the start and `dwell` the rest there before the press,
   * which together are what make a drag read as deliberate rather than as a flick.
   */
  drag(from: Target, to: Target, options?: { ms?: number; approach?: number; dwell?: number }): Promise<void>
  /**
   * Drag a card by its header so that it lands to the right of another card, top edges aligned.
   * Positions are in world units, so this holds at any zoom.
   */
  placeRightOf(type: string, anchor: string, options?: { gap?: number; dy?: number }): Promise<void>
  /**
   * Pick an option in a native `<select>`. The cursor goes there and clicks, but the value is set
   * directly: a headless screencast does not draw a native popup, and a real one left open would
   * swallow the events after it.
   */
  choose(target: Target, value: string): Promise<void>
  /** Click into a field and type, one character at a time. */
  type(target: Target, text: string, options?: { enter?: boolean }): Promise<void>
  press(key: 'Enter' | 'Escape' | 'Tab' | 'Backspace' | 'Space'): Promise<void>
  /** Poll a page expression until it is truthy. `what` names it in the timeout error. */
  waitFor(expression: string, what: string): Promise<void>
  /** Wait until the first node of this type has a result. Throws on an error state. */
  waitForResult(type: string): Promise<void>
  /** Point the camera at these cards, by type, and wait for the move to finish. */
  frame(types: readonly string[], maxZoom?: number): Promise<void>
  /** The same for every card on the canvas, for a step whose cards somebody else chose. */
  frameAll(maxZoom?: number): Promise<void>
  /**
   * Wait until no card is running, stale or blocked. An error does not throw: it is printed, so a
   * take whose cards came back with one can be judged and re-recorded rather than aborted.
   */
  waitSettled(): Promise<void>
  pause(ms: number): Promise<void>
  /** Scroll the page smoothly until the target sits mid-screen: for a document, not the canvas. */
  scrollTo(target: Target): Promise<void>
  /**
   * Load a page — a workflow link's `#!…` fragment, or another page of the site such as
   * `mcp.html` — and ready it for filming as setup does. A reload, so do it off camera, which is
   * what a `clip` step playing at the same moment is for.
   */
  navigate(path: string): Promise<void>
}

export interface Step {
  /** Starts a YouTube chapter here. The first step's chapter is placed at 0:00. */
  chapter?: string
  /** The narration, which is also the caption. */
  say: string
  /** What the voice should say, where the caption's spelling reads badly aloud (`LC.*`). */
  spoken?: string
  /** Seconds into the narration before the actions start. 0.4 by default. */
  lead?: number
  /**
   * Seconds of quiet before this line, after the previous step's line and actions have both
   * finished. 0.5 by default. Splitting one sentence pair into two steps is how a pause lands
   * mid-thought, with the second half's actions starting on its first word.
   */
  gapBefore?: number
  /**
   * Outside footage shown for this step instead of the browser: a screen recording of another
   * app, cut to `from`..`to` seconds, cropped to `crop` (`[x, y, width, height]` in its own
   * pixels), played at `speed`, and fitted to the video's frame. The step lasts as long as the
   * longer of the narration and the footage, and `do` still runs — off camera, which is where a
   * reload belongs.
   */
  clip?: { file: string; from: number; to: number; speed?: number; crop?: [number, number, number, number] }
  do?: (t: Driver) => Promise<void>
}

export interface Tutorial {
  title: string
  /**
   * A file in `tutorials/music/` to play under the narration, ducked while the voice speaks.
   * That folder is gitignored, so a tutorial naming a track nobody else has still records for
   * them with `--music none`, or with a track of their own via `--music <file>`.
   */
  music?: string
  /**
   * A credential the tutorial's dataset needs, read from this machine and handed to the page
   * before anything opens: `neuprint` reads `NEUPRINT_APPLICATION_CREDENTIALS` (a token, or a
   * file holding one), `cave` reads `CAVE_TOKEN` or caveclient's own secret file. The
   * recording's browser profile is deleted when the run ends.
   */
  signIn?: 'neuprint' | 'cave'
  /**
   * A line under "Coda" on the title card, naming what this video is about ("Recipes"). Absent,
   * the card is the name alone — which is what an introduction to the whole app wants.
   */
  topic?: string
  /** Runs before recording starts. The start page and guides are already closed. */
  setup(t: Driver): Promise<void>
  steps: readonly Step[]
}
