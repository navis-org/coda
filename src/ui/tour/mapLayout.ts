/**
 * Where each label goes on the Screen Map, given the rects everything is at.
 *
 * ## Why this is a pure function and not part of the component
 *
 * `nodeguide/anatomy.ts` places eighteen labels round two cards, and it places them **by hand**
 * — authored coordinates against a world (940 × 552) that never stretches, because a leader
 * pointing at a 14px button cannot be composed by a layout that reflows. It gets to do that
 * because the thing it labels is a *drawing*.
 *
 * This labels the running app, which is every width the window can be, with a toolbar that folds
 * half its controls into `⋯` below 720px and panels that come and go. There is no fixed world to
 * author against, so the placement has to be computed — and the moment it is computed, it is the
 * one part of this feature that can be wrong in a way nobody notices: a label two pixels over the
 * button it names still renders perfectly.
 *
 * So the arithmetic is here, over rects handed in, with no DOM anywhere in it. **jsdom performs
 * no layout** — every `getBoundingClientRect` comes back as one constant — so a test that drove
 * the component could only ever assert that a label exists. Fed synthetic rects, this module can
 * be asked the things that actually matter: that no two labels overlap, that none covers a
 * control it does not name, that none hangs off the window. The browser half is
 * `pnpm probe:screen-map`, which asks the same questions of the real screen.
 *
 * ## The one idea in it
 *
 * Every label is placed by **first free candidate**. A spot proposes a sequence of positions in
 * its own preferred direction — a toolbar button's label wants to be under it, and if that place
 * is taken, one row further down — and each candidate is tested against *everything already
 * placed*: the labels, and the boxes of the controls themselves. First one that fits wins.
 *
 * That is what makes the zones compose. The inspector's label sits to the left of a panel on the
 * right-hand edge, in the middle of the window; the toolbar's labels sit in a band under the top
 * of it. They are placed by different rules and are checked against the same list, so the one
 * case that would look broken — a label from one zone landing on a label from another — cannot
 * arise without every candidate in the sequence being taken.
 *
 * Authoring order is priority order: `MAP_SPOTS` is read top to bottom, and what is declared
 * first gets the position closest to the thing it names.
 */

import type { Rect } from '../../layout/place'
import { overlaps } from '../../layout/place'

/**
 * `place.ts`' rectangle, re-exported as the type this module's callers speak.
 *
 * Not a second declaration: `place.ts` already exports this shape and the `union` and `overlaps`
 * that go with it, with a note recording that a fourth hand-rolled `Math.min` over four extents
 * is how one of them comes to disagree about an empty set. A viewport rect and a canvas rect are
 * the same four numbers, and the one predicate that matters here — "nothing overlaps" — has to be
 * the same claim in the test as in the pass.
 */
export type { Rect }

/**
 * Which side of its box a label wants to sit on.
 *
 * Named for where the *label* goes, not for where the box is: `below` is a toolbar button, whose
 * label hangs under it. `inside` is for a box that is a region rather than a control — the
 * canvas is most of the window, and a label beside it would be off the screen.
 */
export type LabelSide = 'below' | 'above' | 'left' | 'right' | 'inside'

/** One thing to label, with its box and its label's measured size. */
export interface LabelBox {
  id: string
  side: LabelSide
  /** Where the thing is. */
  box: Rect
  /** The label's own size, measured — see `ScreenMap`'s two-pass note. */
  width: number
  height: number
  /**
   * A region rather than a control: its box is not an obstacle other labels have to avoid.
   *
   * The canvas covers the middle of the window and the inspector a whole column of it. Treated
   * as obstacles, they would push every label that is *supposed* to sit over them out to the
   * edges, which is the opposite of what the boxes are for.
   */
  region?: boolean
  /** For `inside` only: where in the box the label starts, as a fraction of each axis. */
  at?: readonly [number, number]
}

export interface Viewport {
  width: number
  height: number
}

export interface Placement {
  id: string
  /** The label's top-left, in viewport coordinates. */
  x: number
  y: number
  /**
   * The leader, box end first, as a polyline. Empty for an `inside` label, which sits in the
   * thing it names and needs no line to it.
   */
  leader: readonly (readonly [number, number])[]
}

/** How close a label may come to the window's edge. */
export const PAD = 12
/** Between a label and its box, and between a label and anything already placed. */
export const GAP = 10
/** How far the next candidate moves when one is taken. */
const STEP = 24
/** How far off the label's edge the leader turns. */
const ELBOW = 9
/** How many candidates a spot is given before it takes the last one anyway. */
const TRIES = 28

const right = (r: Rect) => r.x + r.width
const bottom = (r: Rect) => r.y + r.height
const midX = (r: Rect) => r.x + r.width / 2
const midY = (r: Rect) => r.y + r.height / 2

/**
 * The furthest a label's top-left may go and still be fully on screen.
 *
 * One definition, because it is the number that decides what "on screen" means and the two
 * searches below both need it — having it twice is how they come to disagree about the edge.
 */
function limits(item: LabelBox, view: Viewport): { maxX: number; maxY: number } {
  return { maxX: view.width - PAD - item.width, maxY: view.height - PAD - item.height }
}

function clamp(value: number, low: number, high: number): number {
  return high < low ? low : Math.min(Math.max(value, low), high)
}

/** `place.ts`' `overlaps`, over a `b` grown by `gap` on every side. */
function crowds(a: Rect, b: Rect, gap: number): boolean {
  return overlaps(a, {
    x: b.x - gap,
    y: b.y - gap,
    width: b.width + gap * 2,
    height: b.height + gap * 2,
  })
}

/** The edge of a box that a label on the given side hangs off. */
function edgeOf(side: LabelSide, box: Rect): number {
  if (side === 'below') return bottom(box)
  if (side === 'above') return box.y
  if (side === 'left') return box.x
  return right(box)
}

/**
 * How far apart two boxes' edges may be and still be called the same row.
 *
 * Half a toolbar button. Wide enough that a 26px button and a 30px one beside it share a band,
 * narrow enough that two controls at opposite ends of the window do not.
 */
const BAND_TOL = 24

/**
 * The line a label starts from: its own box's edge, pushed out to the furthest edge among the
 * boxes *level with it*.
 *
 * Per-box alone would be the obvious reading and looks wrong: the toolbar's controls are not all
 * the same height, so eleven labels each hugging its own button come out on a ragged line under
 * a row that is visibly straight.
 *
 * One band for the whole side is the obvious *fix* and is worse, which the test fixture is built
 * to show. It reads "the extreme box on this side" as "the row", so a single spot on that side
 * somewhere else on the screen — the **+** button is 700px below the toolbar and both want a
 * label under them — drags every other label down to its level and lands the toolbar's whole
 * first row on top of the status bar. Found that way rather than reasoned about; the fixture
 * still carries the spot that showed it.
 *
 * So: level with each other, within `BAND_TOL`. A row of controls is a row; a lone one is its
 * own.
 */
function bandFor(item: LabelBox, items: readonly LabelBox[]): number {
  const own = edgeOf(item.side, item.box)
  const level = items
    .filter((other) => other.side === item.side)
    .map((other) => edgeOf(item.side, other.box))
    .filter((edge) => Math.abs(edge - own) <= BAND_TOL)
  if (item.side === 'below' || item.side === 'right') return Math.max(...level) + GAP
  return Math.min(...level) - GAP
}

/** 0, +1, −1, +2, −2 … — out from the middle in both directions. */
function fan(i: number): number {
  return Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1)
}

/**
 * How far sideways a label will slide before it gives up its row, as a fraction of its width.
 *
 * The whole reason a row is worth fighting for: **eleven toolbar buttons are about 34px apart
 * and their labels are 176px wide**, so a placer that only ever moves *down* puts one label per
 * row and the band comes out 567px deep on a 1000px window — measured, and most of it empty
 * space to the left and right of a single column of labels. Sliding sideways first packs the
 * same eleven into two or three rows, and the elbow leader is what keeps each one attached to
 * its own button.
 *
 * 0.6 rather than 1: a slide of a whole width is a label whose leader crosses its neighbour's
 * to reach it, which is the thing that makes a figure like this unreadable. Two slides each way
 * is as far as it goes before dropping a row.
 */
const SLIDE = 0.6

/**
 * The positions a spot will accept, best first.
 *
 * `below` and `above` fill a **row** before dropping to the next: for each row, the centred
 * position first and then out to either side in `SLIDE` steps. `left` and `right` do the
 * transpose — along the box's own axis first, then out to the next column — because a side label
 * wants to stay level with the thing it names far more than it wants to keep its column.
 * `inside` walks down.
 */
function candidates(item: LabelBox, band: number, view: Viewport): { x: number; y: number }[] {
  const { box, width: w, height: h } = item
  const { maxX, maxY } = limits(item, view)
  const out: { x: number; y: number }[] = []
  const across = 5
  if (item.side === 'below' || item.side === 'above') {
    for (let row = 0; row * across < TRIES; row += 1) {
      /* A row's own height, not `STEP`: a "next row" that is 24px down is not a next row at all
         for a label three lines tall, so five of the six were positions the collision test threw
         away — and a spot could run out of candidates and land on top of its neighbour with
         plenty of empty screen below. `STEP` is for nudging along an axis, which is what the
         side labels do. */
      const drop = row * (h + GAP)
      const y = item.side === 'below' ? band + drop : band - h - drop
      for (let i = 0; i < across; i += 1) {
        const x = midX(box) - w / 2 + fan(i) * SLIDE * w
        out.push({ x: clamp(x, PAD, maxX), y: clamp(y, PAD, maxY) })
      }
    }
    return out
  }
  if (item.side === 'left' || item.side === 'right') {
    for (let col = 0; col * across < TRIES; col += 1) {
      const away = col * (w + GAP)
      const x = item.side === 'left' ? band - w - away : band + away
      for (let i = 0; i < across; i += 1) {
        const y = midY(box) - h / 2 + fan(i) * STEP
        out.push({ x: clamp(x, PAD, maxX), y: clamp(y, PAD, maxY) })
      }
    }
    return out
  }
  const [fx, fy] = item.at ?? [0.5, 0.5]
  const x = clamp(box.x + box.width * fx - w / 2, PAD, maxX)
  for (let i = 0; i < TRIES; i += 1) {
    out.push({ x, y: clamp(box.y + box.height * fy + i * STEP, PAD, maxY) })
  }
  return out
}

/** How much of `a` and `b` overlap, in px². */
function spill(a: Rect, b: Rect): number {
  const w = Math.min(right(a), right(b)) - Math.max(a.x, b.x)
  const h = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * The candidate that collides with the least, ties going to whichever was preferred first.
 *
 * Total rather than possibly-`undefined`: `candidates` always yields at least one position for
 * every side, so there is always an answer, and typing it as maybe-nothing put a `continue` in
 * `placeLabels` that would silently drop a label — the one thing that function's own note says it
 * never does.
 */
function least(
  options: readonly { x: number; y: number }[],
  rect: (at: { x: number; y: number }) => Rect,
  taken: readonly Rect[],
): { x: number; y: number } {
  let best = options[0]!
  let worst = Infinity
  for (const option of options) {
    const box = rect(option)
    const cost = taken.reduce((sum, other) => sum + spill(box, other), 0)
    if (cost >= worst) continue
    worst = cost
    best = option
  }
  return best
}

/**
 * Every position the window has room for, nearest the box first.
 *
 * The last resort, appended behind a spot's own preferences. Those describe a *lattice* — this
 * row or the next, this column or the one out from it — and a lattice can be full while the
 * window is not: on a 1024 × 720 shell, sixteen labels exhausted the rows under the toolbar and
 * three of them landed on top of each other with the left third of the canvas empty. Measured,
 * not predicted; `probe:screen-map` is what said so and the two smaller sizes are in it for this.
 *
 * Sorted by how far the position is from the thing it labels, so the fallback is still the
 * closest free place rather than the first one scanned. The leader is what keeps it attached, and
 * a leader is the reason a label can afford to be somewhere unexpected at all.
 */
function sweep(item: LabelBox, view: Viewport): { x: number; y: number }[] {
  const { box, width: w, height: h } = item
  const { maxX, maxY } = limits(item, view)
  const out: { x: number; y: number }[] = []
  for (let y = PAD; y <= maxY; y += h + GAP) {
    for (let x = PAD; x <= maxX; x += w + GAP) out.push({ x, y })
  }
  const cx = midX(box)
  const cy = midY(box)
  const far = (at: { x: number; y: number }) =>
    (at.x + w / 2 - cx) ** 2 + (at.y + h / 2 - cy) ** 2
  return out.sort((a, b) => far(a) - far(b))
}

/**
 * The elbow from the box to the label.
 *
 * Three segments rather than a straight line, for the same reason the node guide's leaders are
 * drawn rather than implied: a label that had to shift two rows down to find room is no longer
 * under its own button, and a diagonal across two other labels to reach it is a line the reader
 * has to trace. The vertical leaves the box, the turn happens `ELBOW` px off the label, and the
 * short segment into the label's edge is what says which label the line belongs to.
 *
 * Collinear points are left in: they collapse to nothing on screen, and taking them out would be
 * a special case in the one place the geometry is easy to check.
 */
function leaderFor(item: LabelBox, at: { x: number; y: number }): Placement['leader'] {
  const { box, width: w, height: h, side } = item
  if (side === 'inside') return []
  if (side === 'below' || side === 'above') {
    const from = midX(box)
    const to = clamp(from, at.x + ELBOW, at.x + w - ELBOW)
    const edge = side === 'below' ? at.y : at.y + h
    const turn = side === 'below' ? edge - ELBOW : edge + ELBOW
    const start = side === 'below' ? bottom(box) : box.y
    return [
      [from, start],
      [from, turn],
      [to, turn],
      [to, edge],
    ]
  }
  const from = midY(box)
  const to = clamp(from, at.y + ELBOW, at.y + h - ELBOW)
  const edge = side === 'left' ? at.x + w : at.x
  const turn = side === 'left' ? edge + ELBOW : edge - ELBOW
  const start = side === 'left' ? box.x : right(box)
  return [
    [start, from],
    [turn, from],
    [turn, to],
    [edge, to],
  ]
}

/**
 * Place every label.
 *
 * `obstacles` is anything on screen that is not a spot and must not be covered — which today is
 * the map's own panel. Passed in rather than declared here because its size is measured too, and
 * a placer that knew about the panel would be a placer that knew what the map looks like.
 *
 * Never drops one. A spot whose every candidate is taken takes the last one and overlaps, which
 * is a visible mess rather than a control that is silently unlabelled — and the map's whole
 * claim is that what is on screen is on the map. `TRIES` is large enough that this does not
 * happen at any width the probe has been run at; if it starts to, the fix is fewer spots, and
 * the overlap is what says so.
 */
export function placeLabels(
  items: readonly LabelBox[],
  view: Viewport,
  obstacles: readonly Rect[] = [],
): Placement[] {
  // Every control's own box, so a label cannot land on one. Regions are excluded — see the
  // field's note.
  const taken: Rect[] = [
    ...obstacles,
    ...items.filter((item) => !item.region).map((item) => item.box),
  ]
  const out: Placement[] = []
  for (const item of items) {
    const rect = (at: { x: number; y: number }): Rect => ({
      x: at.x,
      y: at.y,
      width: item.width,
      height: item.height,
    })
    const isFree = (at: { x: number; y: number }) =>
      !taken.some((other) => crowds(rect(at), other, GAP))
    /*
     * The preferences first, and the sweep only if none of them survived — which is both the
     * priority the docstrings describe and the cheaper order: `sweep` builds and *sorts* about a
     * hundred positions, all of them thrown away in the common case where the label goes exactly
     * where it wanted to.
     *
     * Nothing free even then: take the position that collides *least*, not the last one tried.
     * The sweep is sorted furthest-last, so falling off the end of it put a label in the opposite
     * corner of the window from the control it names — which is a worse answer than a small
     * overlap and reads as the map being broken rather than crowded. Seen on a 1024 × 720 shell,
     * where the status bar's label was swept up onto the toolbar.
     */
    const prefer = candidates(item, bandFor(item, items), view)
    let at = prefer.find(isFree)
    if (!at) {
      const rest = sweep(item, view)
      at = rest.find(isFree) ?? least([...prefer, ...rest], rect, taken)
    }
    taken.push(rect(at))
    out.push({ id: item.id, x: at.x, y: at.y, leader: leaderFor(item, at) })
  }
  return out
}
