/**
 * The streaming bookkeeping, where every mistake is a number rather than an error.
 *
 * A tip released one page too early carries whatever score the pages so far happened to give it:
 * a perfectly ordinary logit, lower than the truth, on a tip that will never be revisited. So the
 * tests below are mostly about *when* a tip is finished, and the one that matters asserts the
 * property the whole design rests on — that folding page by page gives what scoring everything at
 * once gives.
 */

import { describe, expect, it } from 'vitest'

import { columnNames } from '../../core/types'
import {
  CROP_SLOP_UM,
  E_TIP_UM,
  addCells,
  bestWithin,
  emptyCellPool,
  openEndsTable,
  pendingOf,
  planSweep,
  reachNm,
  settledBy,
} from './openEndsOps'
import { TIP_FIELDS, published, schemaOf } from './suggestionTables'

describe('reachNm', () => {
  /** The line the streaming argument rests on: the crop radius plus how far a tip reads. */
  it('is the window radius, the tip reach and the crop slop, in nanometres', () => {
    expect(reachNm(15)).toBe(16_500)
    expect(reachNm(15, 0)).toBe(15_500)
    expect(E_TIP_UM).toBe(1)
  })

  /**
   * The margin a crop by centroid needs. Without it the bound is short by a face, and a tip
   * settles one page before a centre that could still have raised its score.
   */
  it('leaves room for a face reaching past its own centroid', () => {
    expect(CROP_SLOP_UM).toBeGreaterThan(0.455)
  })
})

describe('planSweep', () => {
  const tips = Float32Array.from([0, 0, 0, 100_000, 0, 0])
  // Two within reach of tip 0, one of tip 1, one of neither.
  const centres = Float32Array.from([0, 0, 0, 100_000, 0, 0, 5000, 0, 0, 500_000, 0, 0])
  const plan = planSweep(tips, centres, 16_000)

  it('gives each tip the centres within reach of it', () => {
    expect([...plan.rows[0]!]).toEqual([0, 2])
    expect([...plan.rows[1]!]).toEqual([1])
    expect([...pendingOf(plan)]).toEqual([2, 1])
  })

  /** Tip by tip, so a tip's own neighbourhood is finished before the next one is started. */
  it('sweeps each tip’s own centres in turn, each centre once', () => {
    expect([...plan.order]).toEqual([0, 2, 1])
  })

  /** A window no tip can read is work whose answer is never asked for. */
  it('leaves out centres no tip needs', () => {
    expect([...plan.order]).not.toContain(3)
  })

  it('builds a shared centre once', () => {
    const close = planSweep(
      Float32Array.from([0, 0, 0, 1000, 0, 0]),
      Float32Array.from([0, 0, 0]),
      16_000,
    )
    expect([...close.order]).toEqual([0])
    expect([...pendingOf(close)]).toEqual([1, 1])
  })

  it('a tip nothing reaches waits on nothing, and is in no sweep', () => {
    const lonely = planSweep(Float32Array.from([1e9, 0, 0]), centres, 16_000)
    expect([...pendingOf(lonely)]).toEqual([0])
    expect([...lonely.order]).toEqual([])
  })

  /**
   * The three questions are answered from one set of rows, so this is what keeps them in step:
   * everything a tip waits on is in the sweep, or that tip never settles.
   */
  it('sweeps every centre some tip is waiting on', () => {
    const wanted = new Set<number>()
    for (const row of plan.rows) for (const centre of row) wanted.add(centre)
    expect([...plan.order].sort()).toEqual([...wanted].sort())
  })
})

describe('settledBy', () => {
  const tips = Float32Array.from([0, 0, 0, 100_000, 0, 0])
  const centres = Float32Array.from([0, 0, 0, 5000, 0, 0, 100_000, 0, 0])
  const plan = planSweep(tips, centres, 16_000)

  it('finishes a tip on the page that takes its count to zero, and only then', () => {
    const pending = pendingOf(plan)
    expect([...pending]).toEqual([2, 1])
    // The first page holds one of the two centres tip 0 waits on, and the one tip 1 waits on.
    expect(settledBy(pending, plan, Int32Array.from([0, 2]))).toEqual([1])
    expect([...pending]).toEqual([1, 0])
    expect(settledBy(pending, plan, Int32Array.from([1]))).toEqual([0])
    expect([...pending]).toEqual([0, 0])
  })

  /** Returned once, so a caller can publish on it without keeping a set of its own. */
  it('does not finish a tip twice', () => {
    const pending = pendingOf(plan)
    settledBy(pending, plan, Int32Array.from([0, 1, 2]))
    expect(settledBy(pending, plan, Int32Array.from([0, 1, 2]))).toEqual([])
  })
})

describe('the cell pool', () => {
  const pool = () => emptyCellPool(0.5)

  it('keeps the best score within reach and ignores cells outside it', () => {
    const cells = pool()
    addCells(
      cells,
      Float32Array.from([500, 0, 0, 900, 0, 0, 5000, 0, 0]),
      Float32Array.from([1, 2, 9]),
    )
    // The 9 sits 5 µm away, well past the 1 µm a tip reads.
    expect(bestWithin(cells, 0, 0, 0, 1000)).toBe(2)
    expect(bestWithin(cells, 100_000, 0, 0, 1000)).toBe(-Infinity)
  })

  /**
   * The property the streaming rests on: the pool's answer does not depend on how the cells
   * were split across pages. Without it a box could keep a page-local representative whose
   * position is inside a tip's micrometre while its true one is outside — a score the
   * whole-neuron reduction would never have given, always too high, never an error.
   */
  it('two pages give what one page gives', () => {
    const cells = Float32Array.from([200, 0, 0, 400, 0, 0, 600, 0, 0, 800, 0, 0])
    const scores = Float32Array.from([0.5, 2.5, 1.5, -3])
    const once = pool()
    addCells(once, cells, scores)

    const paged = pool()
    addCells(paged, cells.slice(0, 6), scores.slice(0, 2))
    addCells(paged, cells.slice(6), scores.slice(2))
    expect(bestWithin(paged, 0, 0, 0, 1000)).toBe(bestWithin(once, 0, 0, 0, 1000))
  })

  /**
   * And the case that made a running maximum wrong: one box, two pages, the better point
   * outside the tip's reach and the worse one inside. A whole-neuron reduction keeps only the
   * better point, so the box does not count at all.
   */
  it('keeps one representative per box — the best one, wherever it lies', () => {
    const cells = pool()
    // Both points sit in box (1, 1, 0) — 500 nm to 1 µm on x and y — but the tip at the origin
    // reads 849 nm to the first and 1,273 nm to the second, so only the worse one is in reach.
    addCells(cells, Float32Array.from([600, 600, 0]), Float32Array.from([1]))
    addCells(cells, Float32Array.from([900, 900, 0]), Float32Array.from([5]))
    expect(cells.best.size).toBe(1)
    expect(bestWithin(cells, 0, 0, 0, 1000)).toBe(-Infinity)
  })

  /** A negative logit is a real score, so "nothing yet" cannot be zero. */
  it('takes a negative score over nothing at all', () => {
    const cells = pool()
    addCells(cells, Float32Array.from([100, 0, 0]), Float32Array.from([-4]))
    expect(bestWithin(cells, 0, 0, 0, 1000)).toBe(-4)
  })
})

describe('openEndsTable', () => {
  const ends = [
    {
      neuronId: '648518347558097460',
      endUid: 0,
      kind: 'tip' as const,
      x: 1,
      y: 2,
      z: 3,
      eTip: -0.25,
    },
    {
      neuronId: '648518347558097460',
      endUid: 1,
      kind: 'tip' as const,
      x: 4,
      y: 5,
      z: 6,
      eTip: null,
    },
  ]

  /**
   * The reuse that is the point of this function: the same field list `seam:suggestions`
   * publishes from, so `seam:review` takes either node's table without knowing which made it.
   */
  it('publishes the suggestion set’s own Tips schema, column for column', () => {
    const table = openEndsTable(ends)
    expect(table.schema).toEqual(schemaOf(TIP_FIELDS))
    expect(Object.keys(table.data).sort()).toEqual(columnNames(table.schema).sort())
    expect(table.length).toBe(2)
  })

  /** Null, not absent: the picker downstream is offered the same columns either way. */
  it('leaves every column a later stage will fill present and null', () => {
    const table = openEndsTable(ends)
    expect(table.data['p_tip']).toEqual([null, null])
    expect(table.data['q']).toEqual([null, null])
    expect(table.data['candidateId']).toEqual([null, null])
    expect(table.data['e_tip']).toEqual([-0.25, null])
  })

  it('carries the id as text, under the column the rest of Coda recognises', () => {
    const table = openEndsTable(ends)
    const ids = table.data[published(TIP_FIELDS)[0]!.name]
    expect(ids).toEqual(['648518347558097460', '648518347558097460'])
  })

  it('an empty run is an empty table with the same schema', () => {
    const table = openEndsTable([])
    expect(table.length).toBe(0)
    expect(table.schema).toEqual(schemaOf(TIP_FIELDS))
  })
})
