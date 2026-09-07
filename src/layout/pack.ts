/**
 * Packing an arrangement into the shape of the canvas, after ELK has decided what goes where.
 *
 * ELK layered gives every node its own layer, and a layer is a column of the picture. That is the
 * right default — it is what makes a pipeline read left to right — but it spends a whole column on
 * a card that is only ever a leaf, and it makes the graph as tall as its tallest column whatever
 * else is going on. On a hand-tidied FlyWire workflow the difference was 1939 × 1259 against
 * 1743 × 857: **63% more area for the same six cards**, most of it an L-shaped void.
 *
 * The move a person makes and layered cannot is to put a card in its *predecessor's* column,
 * drawn below it. `Explore ▸ Table` becomes one column rather than two, and the space beside a
 * tall Neuroglancer card gets used instead of reserved. That is a layer violation by construction,
 * so no amount of ELK configuration produces it — which was measured rather than assumed, and the
 * numbers are worth keeping because they are what rules the cheaper options out:
 *
 * | what was tried                       | area   | aspect | vs hand-placed              |
 * | ------------------------------------ | ------ | ------ | --------------------------- |
 * | `layered`, as it shipped             | 2404k  | 1.56   | +61%                        |
 * | all four `nodePlacement` strategies  | 2404k  | 1.56   | +61% — no change at all     |
 * | `postCompaction`, all five           | 2216k  | 1.44   | +48%                        |
 * | `mrtree` / `force`                   | ~2280k | ~1.3   | +49% / +57%                 |
 * | `rectpacking` / `box`                | 1617k  | 0.92   | +8%, by ignoring every edge |
 * | **this pass**                        | 1652k  | 2.28   | **+11%**                    |
 *
 * In a browser, end to end, that is 1939 × 1259 becoming 1941 × 851: the width does not move at
 * all and a third of the height goes. It stops short of the hand-placed 1494k because it stops as
 * soon as the graph is wide enough rather than packing on for its own sake — see `score`. A
 * variant minimising area outright reached 1373k, 8% *better* than the hand-placed version, and
 * was rejected: it also folded a four-card chain into one vertical column, which is a worse
 * drawing of a better layout.
 *
 * `elk.partitioning` was tried as a way to hand the columns *back* to ELK and let it do the rest;
 * it ignored the assignment and spread the graph to 2557 wide, worse than not asking.
 *
 * ## Why this is a post-pass and not an algorithm
 *
 * Run standalone it produces the same answer as it does over ELK's output — the same box, on the
 * worked case. So there is nothing to gain by replacing layered, and a great deal to lose:
 * crossing minimisation, the within-layer ordering, and the port-order work that makes a wire
 * arrive at the right socket. This reads ELK's answer and moves cards *leftwards into slack*,
 * which is why it composes with the algorithm choice instead of being one.
 *
 * **What it costs is ELK's edge routes.** A bend point describes a gap between two cards at the
 * positions ELK chose, so once a card has moved to another column the whole set is stale in the
 * way `routeKey` exists to catch — `useArrange` gives them up whenever this pass moved anything.
 * The `orthogonal` wire mode survives it, because it steps *every* wire rather than only the ones
 * ELK bent; what is lost is the routed-around-a-card half of it. That is the same trade
 * `EdgeRouting`'s note already records, and it is why `moved` is part of the **return type**: a
 * graph the packer cannot help has to keep every route it would have had, and that promise rode
 * on map identity for one round — which every early return quietly broke, each building a fresh
 * `Map`. The routes were being discarded on every layered arrange, the ordinary wide pipeline
 * this pass declines to touch included. A flag the compiler can see replaces a convention three
 * doc comments described and nothing enforced.
 *
 * The gate and the target live in `options.ts` beside `aspectRatioApplies` (`packApplies`,
 * `targetAspect`), for that predicate's reason: the checkbox's enabled state and the pass must not
 * drift, and the target is a policy about the *window* rather than about this algorithm.
 */

import type { GraphEdge } from '../core/graph'
import type { LayoutNode, MeasuredSizes, NodeSize } from './elkGraph'
import { resolveSize } from './elkGraph'
import type { LayoutOptions } from './options'
import type { XY } from './place'

/**
 * Above this many cards the pass stands down rather than running.
 *
 * A guard against a visible hitch, and the number is measured — **re-measured**, because the
 * figures that first justified it were taken before `boxOf` stopped allocating and no longer
 * described this code. Timed on the shape the tests pin (a head and its leaves, two columns) and
 * on the worst *legal* shape (a chain of n/2 columns with n/2 leaves parked in the last, so every
 * earlier column is a candidate for every leaf):
 *
 * | cards | fan-out | worst case |
 * | ----- | ------- | ---------- |
 * | 10    | 0.05 ms | 0.06 ms    |
 * | 40    | 0.5 ms  | 2.3 ms     |
 * | 80    | 2.7 ms  | **33 ms**  |
 * | 120   | 12 ms   | **200 ms** |
 *
 * An ordinary layered pipeline is not on either curve: it is already wider than the target, scores
 * zero, evaluates one box and leaves — about 0.1 ms whatever its size.
 *
 * 80 rather than 120 because standing down is free and the difference is not: this runs
 * synchronously inside a promise continuation, so the worst case eats the frame that starts the
 * arrange animation, and 200 ms there is a hitch somebody sees. Every graph the feature exists for
 * is far below it — the worked case is five cards and a four-dataset wizard build is thirty-three.
 * Past the ceiling the arrangement is ELK's, which is what shipped before this existed.
 */
export const PACK_MAX_NODES = 80

/**
 * How much **taller** than the target shape a box is. Zero once it is wide enough.
 *
 * **One-sided, and that is the whole character of the feature.** Scoring the distance to the
 * target in both directions makes the packer fight a graph for being too *wide*, which is not a
 * problem anybody has: a long pipeline laid out as a long row is exactly right, and a canvas
 * scrolls. Measured on a four-card chain — perfectly good at an aspect of 5.4 — a two-sided score
 * folded it into a single vertical column to "reach" 1.6, which is a worse drawing of a better
 * layout and would have changed the arrangement of every existing workflow.
 *
 * With this, a graph already at or past the target scores zero, no move can improve on zero, and
 * the pass returns its input untouched. So it does nothing at all except on the graphs the
 * complaint was about — the ones that come out squarer than the screen they are framed into. It
 * also makes the target a *threshold* rather than a goal, which is why the difference between a
 * measured pane and the fallback changes the answer only on graphs that sit between them.
 *
 * In log space so that being half as wide as the target costs what being twice as tall does; a
 * linear difference makes the same improvement look bigger on a wide graph than on a tall one,
 * and the tall ones are the point.
 */
function score(width: number, height: number, target: number): number {
  if (!(width > 0) || !(height > 0)) return Infinity
  return Math.max(0, Math.log(target) - Math.log(width / height))
}

/** What the pass answers: where the cards go, and whether it moved any of them. */
export interface PackResult {
  positions: Map<string, XY>
  /**
   * Whether anything actually moved.
   *
   * Read by `useArrange` to decide whether ELK's edge routes still describe the picture. A
   * returned field rather than a comparison the caller makes, because the caller cannot see the
   * difference: every "nothing to do" exit here builds its own map.
   */
  moved: boolean
}

/**
 * Move cards leftwards into columns that have room, keeping the picture ELK drew.
 *
 * The order within a column is ELK's, by `y`. Columns are its layers, by `x`. Neither is
 * recomputed — this pass has no opinion about which node belongs beside which, only about how many
 * columns the answer needs.
 */
export function packColumns(
  nodes: readonly LayoutNode[],
  edges: readonly GraphEdge[],
  positions: ReadonlyMap<string, XY>,
  sizes: MeasuredSizes,
  options: LayoutOptions,
  target: number,
): PackResult {
  const unchanged = (): PackResult => ({ positions: new Map(positions), moved: false })

  const placed = nodes.filter((node) => positions.has(node.id))
  if (placed.length < 2 || placed.length > PACK_MAX_NODES) return unchanged()
  const ids = placed.map((node) => node.id)

  /*
   * Resolved once, into a table every later read hits — the greedy asks for a size thousands of
   * times and `resolveSize` walks a fallback chain. Through `resolveSize` rather than
   * `sizes.get(id) ?? resolveSize(...)`: the `??` looks like a fast path and is a second opinion
   * about what a size is, since `resolveSize` rejects a zero-sized measurement (a card mid-mount)
   * where a bare `get` would take it and hand `boxOf` a column of width 0.
   */
  const sizeOf = new Map<string, NodeSize>(
    placed.map((node) => [node.id, resolveSize(node, sizes)]),
  )

  /*
   * Columns are read off ELK's `x`, not recomputed from the graph, and the tolerance is the point:
   * layered left-aligns a layer, but a node whose predecessors are all short can be nudged a few
   * units off its neighbours. Grouping by exact `x` then reports one column as several and the
   * pass has nothing to merge. Half the layer gap is wide enough to absorb that and far too narrow
   * to join two real columns, which are a card's width apart.
   */
  const tolerance = Math.max(1, options.layerSpacing / 2)
  const sorted = [...ids].sort((a, b) => positions.get(a)!.x - positions.get(b)!.x)
  /** Which column each card is in. Mutated in place as moves are accepted. */
  const current = new Map<string, number>()
  let count = 0
  let edge = -Infinity
  for (const id of sorted) {
    const x = positions.get(id)!.x
    if (count === 0 || x - edge > tolerance) {
      count += 1
      edge = x
    }
    current.set(id, count - 1)
  }

  const preds = new Map(ids.map((id) => [id, [] as string[]]))
  const succs = new Map(ids.map((id) => [id, [] as string[]]))
  for (const link of edges) {
    if (!preds.has(link.target) || !succs.has(link.source)) continue
    preds.get(link.target)!.push(link.source)
    succs.get(link.source)!.push(link.target)
  }

  /*
   * **One connected piece only, and that is a correctness gate rather than caution.** With
   * `packComponents` on — its default — ELK lays disconnected pieces out separately and packs the
   * results in two dimensions, so its answer is not a row of columns at all and `boxOf` below does
   * not describe it: summing column widths is the width of a *single* strip. Run over a packed
   * multi-component layout this would both mis-score and merge a column of one component with an
   * unrelated column of another, dismantling the packing the option above it asked for. The two
   * features are complements — `elk.aspectRatio` shapes a multi-component graph and can do nothing
   * for a single chain, which its own note records as a measurement, and this shapes the chain.
   *
   * **Conditional on `packComponents`, because that is what the argument above is conditional on.**
   * With it off ELK gives every node one shared set of layers, the answer *is* a row of columns,
   * and the model holds however many pieces the graph is in — so an unconditional gate would be
   * over-broad by its own reasoning.
   *
   * Worth knowing what this costs, because it is not rare: an unwired card is a second component,
   * so packing stands down while a graph is being built and comes back when the last wire lands.
   * And it counts components of the **layout** graph, which `arrangeScope` has already stripped of
   * reference edges — a card joined only through one is its own piece here while the canvas shows
   * it connected. Both are a missed improvement rather than a worse arrangement: the answer is
   * ELK's, which is what an unpacked arrange gives anyway.
   */
  if (options.packComponents) {
    const seen = new Set<string>([ids[0]!])
    const queue = [ids[0]!]
    while (queue.length > 0) {
      const id = queue.pop()!
      for (const next of [preds.get(id)!, succs.get(id)!].flat()) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    if (seen.size !== ids.length) return unchanged()
  }

  /*
   * Reused across every trial rather than allocated per call. The greedy evaluates thousands of
   * candidate assignments on a graph of any size, and columns are dense integers, so two buffers
   * indexed by column number replace two `Map`s built and thrown away each time — measured at
   * roughly 11× over the run as a whole. Only scalars escape `boxOf`, so nothing aliases them, and
   * the re-stack below reads them once the assignment has settled.
   */
  const widths = new Float64Array(count)
  const heights = new Float64Array(count)

  /**
   * The box the current assignment produces, optionally with one card moved.
   *
   * The trial move is an argument rather than a mutation of `current` the caller then undoes, so
   * `current` is written once per *accepted* move instead of twice per candidate.
   *
   * **The per-column buffers come back with the answer**, which is what lets the re-stack below
   * read them. They are the same two arrays every call, so nothing may evaluate a trial between
   * the call and the reads — returning them says that in the type instead of in a paragraph, and
   * makes inserting one there visibly wrong rather than silently wrong.
   */
  const boxOf = (move?: { id: string; to: number }) => {
    widths.fill(0)
    heights.fill(-options.nodeSpacing)
    for (const id of ids) {
      const c = move && move.id === id ? move.to : current.get(id)!
      const size = sizeOf.get(id)!
      if (size.width > widths[c]!) widths[c] = size.width
      heights[c] = heights[c]! + size.height + options.nodeSpacing
    }
    let width = -options.layerSpacing
    let height = 0
    for (let c = 0; c < count; c++) {
      // A column a move emptied contributes nothing — not a zero-width column and a gap.
      if (widths[c] === 0) continue
      width += widths[c]! + options.layerSpacing
      height = Math.max(height, heights[c]!)
    }
    return { width, height, widths, heights }
  }

  /** How far from the target a candidate lands. The two are never wanted apart. */
  const scoreOf = (move?: { id: string; to: number }) => {
    const { width, height } = boxOf(move)
    return score(width, height, target)
  }

  /*
   * The leftmost column `id` may legally move to. The loop runs from here up to its current one,
   * so every candidate is a move *leftwards*.
   *
   * A node joins a column at its **bottom**, so sharing a column with a *predecessor* is fine —
   * the wire runs downwards, which is the move a person makes — while sharing one with a
   * *successor* would draw the wire back up the column. That asymmetry is the whole difference
   * between the readable version of this and the ugly one: an earlier draft minimising area with
   * no such rule put a dataset's annotation chain *below* the dataset it feeds.
   *
   * **Only the predecessor half is checked, and the successor half was removed after a mutation
   * test showed it changed nothing.** Two facts make it unnecessary, and both are worth stating
   * because each on its own looks like the whole reason. This floor keeps every node at or right
   * of all its predecessors — ELK's layering starts that way and `to >= floor` preserves it, while
   * only relaxing the constraint on anything downstream — so a successor is never in an earlier
   * column and a leftward move cannot land on one. And the bound below is itself only an
   * optimisation: **a rightward move can never improve a one-sided score at all**, since moving a
   * card into a later column never widens the box (the column it leaves can only narrow or empty)
   * and never shortens it (the column it joins can only grow). Trying to pin the bound with a test
   * showed exactly that — allowing rightward moves changes no output, so there is nothing to
   * assert. A check that cannot fire reads as load-bearing and is not.
   */
  const floorFor = (id: string) => {
    let floor = 0
    for (const p of preds.get(id)!) floor = Math.max(floor, current.get(p)!)
    return floor
  }

  let best = scoreOf()
  let moved = false

  /*
   * Greedy, and bounded by the node count: every accepted move strictly reduces the score, and a
   * node only ever moves to a lower column, so the walk cannot cycle. A graph already wide enough
   * scores zero, nothing beats zero, and the loop leaves on its first pass having evaluated one
   * box — which is the ordinary left-to-right pipeline's whole cost.
   */
  for (let pass = 0; pass < ids.length; pass++) {
    let take: { id: string; to: number; score: number } | undefined
    for (const id of ids) {
      for (let to = floorFor(id); to < current.get(id)!; to++) {
        const s = scoreOf({ id, to })
        if (s < best - 1e-9 && (!take || s < take.score)) take = { id, to, score: s }
      }
    }
    if (!take) break
    current.set(take.id, take.to)
    best = take.score
    moved = true
  }

  if (!moved) return unchanged()

  // --- lay the columns out again ------------------------------------------
  // The buffers come back with the box, so the stacking arithmetic is *read* from them rather
  // than written a second time, where the two spellings would have to go on agreeing about how
  // gaps are counted.
  const { height: total, widths: colWidth, heights: colHeight } = boxOf()
  const members = new Map<number, string[]>()
  for (const id of ids) {
    const c = current.get(id)!
    if (!members.has(c)) members.set(c, [])
    members.get(c)!.push(id)
  }

  const out = new Map(positions)
  let x = 0
  for (const c of [...members.keys()].sort((a, b) => a - b)) {
    // ELK's own vertical order, kept: this pass moves cards between columns and never reorders
    // one, so whatever crossing minimisation decided still holds within the column.
    const stack = members.get(c)!.sort((a, b) => positions.get(a)!.y - positions.get(b)!.y)
    // Centred rather than top-aligned, which is what layered does within a layer — so a column
    // nothing joined comes out where it already was, and a straight chain does not develop a
    // stair-step it did not have.
    let y = (total - colHeight[c]!) / 2
    for (const id of stack) {
      out.set(id, { x, y })
      y += sizeOf.get(id)!.height + options.nodeSpacing
    }
    x += colWidth[c]! + options.layerSpacing
  }
  return { positions: out, moved: true }
}
