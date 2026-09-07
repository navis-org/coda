/**
 * The column packer: that it fills slack, that it refuses the moves that would read badly, and
 * that it leaves alone every graph it cannot improve.
 *
 * The last of those is the one worth writing first. This pass runs on every arrange, so a graph it
 * has nothing to offer must come out exactly as ELK left it — otherwise every existing workflow's
 * arrange changes for no benefit, and the change is invisible in a suite that only checks bounding
 * boxes. `packColumns` reports that as `moved: false`, and `useArrange` reads the flag to decide
 * whether ELK's edge routes still describe the picture; the positions come back equal either way.
 *
 * The worked case is the FlyWire workflow this was built for, at the sizes a real browser reports,
 * so the numbers here are the ones in the module note rather than an abstraction of them.
 */

import { describe, expect, it } from 'vitest'

import type { GraphEdge } from '../core/graph'
import type { LayoutNode, MeasuredSizes, NodeSize } from './elkGraph'
import { PACK_MAX_NODES, packColumns } from './pack'
import { DEFAULT_LAYOUT_OPTIONS, PACK_TARGET_ASPECT } from './options'
import type { XY } from './place'
import { union } from './place'

const OPTIONS = DEFAULT_LAYOUT_OPTIONS

/** A node the packer will accept: it reads only the id, and sizes come from the map. */
const card = (id: string): LayoutNode =>
  ({ id, type: 'test', position: { x: 0, y: 0 }, params: {} }) as LayoutNode

const wire = (source: string, target: string): GraphEdge => ({
  id: `${source}>${target}`,
  source,
  sourceHandle: 'out',
  target,
  targetHandle: 'in',
})

/** Through `union`, so "the bounding box" means here what it means to `dodge` and `anchorTo`. */
function box(positions: ReadonlyMap<string, XY>, sizes: MeasuredSizes) {
  return union([...positions].map(([id, at]) => ({ ...at, ...sizes.get(id)! })))!
}

/** Which cards share a column, by their x after packing. */
function columns(positions: ReadonlyMap<string, XY>): string[][] {
  const byX = new Map<number, string[]>()
  for (const [id, at] of positions) {
    const key = Math.round(at.x)
    if (!byX.has(key)) byX.set(key, [])
    byX.get(key)!.push(id)
  }
  return [...byX.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids.sort())
}

// ---------------------------------------------------------------------------
// The worked case
// ---------------------------------------------------------------------------

/**
 * The FlyWire FAFB workflow, at the sizes and positions a real browser produced.
 *
 * `dataset` is 425 tall rather than 247 because its Description is pinned under it and the
 * companion pass grew the box — this pass sees what ELK saw, which is the point of running after
 * it rather than beside it.
 */
const FLYWIRE_SIZES: MeasuredSizes = new Map<string, NodeSize>([
  ['box', { width: 232, height: 124 }],
  ['dataset', { width: 248, height: 425 }],
  ['explore', { width: 520, height: 257 }],
  ['ngl', { width: 651, height: 851 }],
  ['picked', { width: 522, height: 341 }],
])

/** What ELK laid out: five columns, `picked` stranded beside the tall Neuroglancer card. */
const FLYWIRE_LAID = new Map<string, XY>([
  ['box', { x: 0, y: 0 }],
  ['dataset', { x: 328, y: 19 }],
  ['explore', { x: 672, y: 878 }],
  ['ngl', { x: 1288, y: 19 }],
  ['picked', { x: 1288, y: 918 }],
])

const FLYWIRE_EDGES = [
  wire('box', 'dataset'),
  wire('dataset', 'explore'),
  wire('dataset', 'ngl'),
  wire('explore', 'ngl'),
  wire('explore', 'picked'),
]

const FLYWIRE_NODES = [...FLYWIRE_SIZES.keys()].map(card)

describe('the FlyWire workflow this was built for', () => {
  const run = packColumns(
    FLYWIRE_NODES,
    FLYWIRE_EDGES,
    FLYWIRE_LAID,
    FLYWIRE_SIZES,
    OPTIONS,
    1.9,
  )
  const packed = run.positions

  it('reports that it moved something, which is what keeps the edge routes honest', () => {
    // `useArrange` drops ELK's waypoints on this flag. It used to compare map identity, which
    // every "nothing to do" exit broke by building a fresh map — so the routes went on every
    // arrange, including the graphs the pass declines to touch.
    expect(run.moved).toBe(true)
  })

  it('puts the leaf table in its predecessor’s column', () => {
    // The move a person makes and layered cannot: `Explore ▸ Table` is one column, so the space
    // beside the tall Neuroglancer card gets used instead of reserved.
    const together = columns(packed).find((ids) => ids.includes('picked'))
    expect(together).toEqual(['explore', 'picked'])
  })

  it('comes out smaller and closer to the shape it was given', () => {
    const before = box(FLYWIRE_LAID, FLYWIRE_SIZES)
    const after = box(packed, FLYWIRE_SIZES)
    expect(after.width * after.height).toBeLessThan(before.width * before.height * 0.75)
    // Asked for 1.9 and lands within a tenth of it, where ELK's own answer was 1.56.
    expect(after.width / after.height).toBeGreaterThan(1.8)
  })

  it('never puts a card left of something that feeds it', () => {
    for (const edge of FLYWIRE_EDGES) {
      expect(packed.get(edge.source)!.x).toBeLessThanOrEqual(packed.get(edge.target)!.x)
    }
  })

  it('never puts a card above something that feeds it in the same column', () => {
    /*
     * The asymmetry that keeps this readable. A node joins a column at its bottom, so sharing one
     * with a *predecessor* draws the wire downwards — fine, and the whole point. Sharing one with
     * a *successor* would draw it back up the column, and minimising the box with that rule
     * missing put the annotation box *below* the dataset it feeds.
     */
    for (const edge of FLYWIRE_EDGES) {
      const from = packed.get(edge.source)!
      const to = packed.get(edge.target)!
      if (Math.round(from.x) === Math.round(to.x)) expect(from.y).toBeLessThan(to.y)
    }
  })
})

// ---------------------------------------------------------------------------
// What it must not do
// ---------------------------------------------------------------------------

describe('packColumns', () => {
  it('returns its input unchanged when there is nothing to gain', () => {
    /*
     * A straight chain of equal cards is already one node per column with no slack anywhere, so
     * the packer has nothing to offer — and every existing workflow's arrange has to be untouched
     * by this pass, not merely similar. The whole map rather than a key at a time, so a stray
     * entry would fail too; `moved` is the half `useArrange` reads.
     */
    const ids = ['a', 'b', 'c', 'd']
    const sizes: MeasuredSizes = new Map(ids.map((id) => [id, { width: 200, height: 200 }]))
    const laid = new Map(ids.map((id, i) => [id, { x: i * 300, y: 0 }]))
    const out = packColumns(
      ids.map(card),
      [wire('a', 'b'), wire('b', 'c'), wire('c', 'd')],
      laid,
      sizes,
      OPTIONS,
      PACK_TARGET_ASPECT,
    )
    expect(out.moved).toBe(false)
    expect(out.positions).toEqual(laid)
  })

  it('keeps ELK’s vertical order within a column', () => {
    // This pass moves cards between columns and never reorders one, so whatever crossing
    // minimisation decided still holds. Reordering here would undo the most valuable thing
    // running after ELK buys.
    const sizes: MeasuredSizes = new Map([
      ['head', { width: 200, height: 600 }],
      ['top', { width: 200, height: 100 }],
      ['bottom', { width: 200, height: 100 }],
    ])
    const laid = new Map([
      ['head', { x: 0, y: 0 }],
      ['top', { x: 300, y: 0 }],
      ['bottom', { x: 300, y: 300 }],
    ])
    const out = packColumns(
      ['head', 'top', 'bottom'].map(card),
      [wire('head', 'top'), wire('head', 'bottom')],
      laid,
      sizes,
      OPTIONS,
      6,
    )
    expect(out.positions.get('top')!.y).toBeLessThan(out.positions.get('bottom')!.y)
  })

  it('declines a graph in more than one piece', () => {
    /*
     * Not caution — the model does not describe that layout. With `packComponents` on, its
     * default, ELK lays disconnected pieces out separately and packs the results in two
     * dimensions, so the answer is not a row of columns and summing column widths is the width of
     * a single strip. The fixture is chosen so the pass would *act* without the gate: `q` moving
     * into `p`'s column shortens the tall column and improves the score, and `a` — which shares
     * that column and belongs to nothing — would be silently regrouped with them.
     */
    const sizes: MeasuredSizes = new Map([
      ['p', { width: 200, height: 100 }],
      ['q', { width: 200, height: 100 }],
      ['a', { width: 200, height: 900 }],
    ])
    const laid = new Map([
      ['p', { x: 0, y: 0 }],
      ['a', { x: 300, y: 0 }],
      ['q', { x: 300, y: 1000 }],
    ])
    const out = packColumns(
      ['p', 'q', 'a'].map(card),
      [wire('p', 'q')],
      laid,
      sizes,
      OPTIONS,
      4,
    )
    expect(out.moved).toBe(false)
  })

  /**
   * A head and `n - 1` leaves hanging off it, all in the next column — a tall second column with
   * nothing but slack in it, which is the shape the packer exists for and the shape that costs it
   * the most passes.
   */
  function fanOut(n: number) {
    const ids = ['head', ...Array.from({ length: n - 1 }, (_, i) => `leaf${i}`)]
    const sizes: MeasuredSizes = new Map(ids.map((id) => [id, { width: 200, height: 100 }]))
    const laid = new Map(
      ids.map((id, i) => [id, i === 0 ? { x: 0, y: 0 } : { x: 300, y: i * 150 }]),
    )
    const edges = ids.slice(1).map((id) => wire('head', id))
    return packColumns(ids.map(card), edges, laid, sizes, OPTIONS, 4)
  }

  it('stands down above the node ceiling rather than stalling the frame', () => {
    /*
     * The greedy is `passes × nodes × columns` trials, and `passes` grows with the graph on
     * exactly this shape. `PACK_MAX_NODES` carries the re-measured table; the short version is
     * that the worst legal shape costs 33 ms at the ceiling and 200 ms at 120, synchronously in a
     * promise continuation, so it would eat the frame the arrange animation starts on. Past the
     * ceiling the answer is ELK's, which is what shipped before this existed.
     *
     * Pinned at the boundary, because a fixture the packer would decline anyway proves nothing:
     * one card under the ceiling it acts, one card over it does not.
     */
    expect(fanOut(PACK_MAX_NODES).moved).toBe(true)
    expect(fanOut(PACK_MAX_NODES + 1).moved).toBe(false)
  })

  it('does nothing with fewer than two cards, or a single column', () => {
    const sizes: MeasuredSizes = new Map([['only', { width: 200, height: 200 }]])
    const one = new Map([['only', { x: 5, y: 7 }]])
    expect(
      packColumns([card('only')], [], one, sizes, OPTIONS, PACK_TARGET_ASPECT).positions.get(
        'only',
      ),
    ).toEqual({ x: 5, y: 7 })

    const stacked: MeasuredSizes = new Map([
      ['a', { width: 200, height: 200 }],
      ['b', { width: 200, height: 200 }],
    ])
    const same = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 0, y: 300 }],
    ])
    const out = packColumns(
      ['a', 'b'].map(card),
      [],
      same,
      stacked,
      OPTIONS,
      PACK_TARGET_ASPECT,
    )
    expect(out.positions.get('b')).toEqual({ x: 0, y: 300 })
  })

  it('groups near-equal x into one column', () => {
    /*
     * Layered left-aligns a layer, but a node whose predecessors are all short comes out a few
     * units off its neighbours. Read by exact `x` that reports one column as two, and the pass
     * both has less to merge and re-lays those phantom columns apart.
     *
     * Observed through the *output*: `a` and `b` are 16 units apart going in, and a run that
     * treated them as one column puts them at the same `x` coming out. Asserting on the grouping
     * directly would need the internals; asserting on the count cannot work, because a pass that
     * makes no move returns the input untouched and the phantom split is still visible in it.
     */
    const sizes: MeasuredSizes = new Map([
      ['a', { width: 200, height: 100 }],
      ['b', { width: 200, height: 100 }],
      ['tall', { width: 200, height: 600 }],
      ['leaf', { width: 200, height: 100 }],
    ])
    const laid = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 16, y: 200 }],
      ['tall', { x: 400, y: 0 }],
      ['leaf', { x: 400, y: 700 }],
    ])
    // `leaf` strands the second column at 748 tall; moving it back into the first is the win, and
    // there is only a first column at all if the 16-unit split was absorbed.
    const out = packColumns(
      ['a', 'b', 'tall', 'leaf'].map(card),
      // `b` is wired in rather than left floating: a disconnected card makes this two
      // components, which the pass declines outright.
      [wire('a', 'b'), wire('a', 'tall'), wire('a', 'leaf')],
      laid,
      sizes,
      OPTIONS,
      4,
    )
    // The grouping says it: `a` and `b` are one column only if the 16-unit split was absorbed.
    expect(columns(out.positions)).toEqual([['a', 'b', 'leaf'], ['tall']])
  })
})
