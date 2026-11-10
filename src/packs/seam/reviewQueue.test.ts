/**
 * The review queue's own decisions, which the card only draws.
 *
 * Three of them are worth more than the rest, because each would be invisible on screen:
 * the cursor is a tip's identity rather than a position in the list, so a filter cannot move it;
 * a verdict is keyed on the (tip, candidate) **pair**, because a piece can be on two tips' lists;
 * and the verdicts encode in a stable order, because that string is a param and so is in the
 * provenance key.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import type { TableValue } from '../../core/values'
import {
  DEFAULT_FILTERS,
  arrangeRows,
  buildQueue,
  currentOfQueue,
  decodeVerdicts,
  encodeVerdicts,
  verdictFor,
  withVerdict,
} from './reviewQueue'

const tipsTable = (
  rows: { end: number; neuron?: string; r?: number; shown?: boolean; kind?: string }[],
): TableValue =>
  makeTable(
    tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('end_uid', 'i64'),
      column('kind', 'str'),
      column('x', 'f64'),
      column('y', 'f64'),
      column('z', 'f64'),
      column('r', 'f64'),
      column('shown', 'bool'),
    ),
    {
      [ID_COLUMN_NAME]: rows.map((r) => r.neuron ?? 'n1'),
      end_uid: rows.map((r) => r.end),
      kind: rows.map((r) => r.kind ?? 'tip'),
      x: rows.map(() => 1),
      y: rows.map(() => 2),
      z: rows.map(() => 3),
      r: rows.map((r) => r.r ?? null),
      shown: rows.map((r) => r.shown ?? false),
    },
  )

const candidatesTable = (
  rows: { end: number; id: string; rank: number; vol?: number }[],
): TableValue =>
  makeTable(
    tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('end_uid', 'i64'),
      column('candidateId', 'str'),
      column('rank', 'i64'),
      column('vol_um3', 'f64'),
      column('contact_x', 'f64'),
      column('contact_y', 'f64'),
      column('contact_z', 'f64'),
      column('conf', 'f64'),
      column('shown', 'bool'),
    ),
    {
      [ID_COLUMN_NAME]: rows.map(() => 'n1'),
      end_uid: rows.map((r) => r.end),
      candidateId: rows.map((r) => r.id),
      rank: rows.map((r) => r.rank),
      vol_um3: rows.map((r) => r.vol ?? 1),
      contact_x: rows.map(() => 10),
      contact_y: rows.map(() => 20),
      contact_z: rows.map(() => 30),
      // A candidate's own confidence, falling with its rank as a real list's does.
      conf: rows.map((r) => 1 / (r.rank + 1)),
      shown: rows.map((r) => r.rank === 1),
    },
  )

describe('building the queue', () => {
  it('gives each tip its own candidates, in rank order', () => {
    const queue = buildQueue(
      tipsTable([{ end: 7 }, { end: 8 }]),
      // Deliberately out of order: the file's row order is nobody's promise.
      candidatesTable([
        { end: 7, id: 'b', rank: 2 },
        { end: 8, id: 'c', rank: 1 },
        { end: 7, id: 'a', rank: 1 },
      ]),
    )
    expect(queue.map((t) => t.endUid)).toEqual([7, 8])
    expect(queue[0]!.candidates.map((c) => c.candidateId)).toEqual(['a', 'b'])
    expect(queue[0]!.candidates[0]!.contactNm).toEqual([10, 20, 30])
  })

  /** Seventeen of rv2's tips have no list, and "nothing found here" is an answer. */
  it('keeps a tip whose search found nothing', () => {
    const queue = buildQueue(tipsTable([{ end: 1 }]), candidatesTable([]))
    expect(queue).toHaveLength(1)
    expect(queue[0]!.candidates).toEqual([])
  })
})

describe('arranging the queue', () => {
  const queue = buildQueue(
    tipsTable([
      { end: 1, r: 0.9, shown: true },
      { end: 2, r: 0.4 },
      { end: 3, r: 0.6 },
    ]),
    candidatesTable([
      { end: 1, id: 'a', rank: 1, vol: 0.05 },
      { end: 2, id: 'b', rank: 1, vol: 5 },
      { end: 3, id: 'c', rank: 1, vol: 0.5 },
    ]),
  )

  it('orders by confidence, highest first', () => {
    expect(arrangeRows(queue, DEFAULT_FILTERS).map((r) => r.tip.endUid)).toEqual([1, 3, 2])
  })

  it('orders by the first candidate’s size when asked', () => {
    const got = arrangeRows(queue, { ...DEFAULT_FILTERS, sortBy: 'size' })
    expect(got.map((r) => r.tip.endUid)).toEqual([2, 3, 1])
  })

  it('narrows by confidence and by size', () => {
    expect(
      arrangeRows(queue, { ...DEFAULT_FILTERS, minConfidence: 0.5 }).map((r) => r.tip.endUid),
    ).toEqual([1, 3])
    expect(
      arrangeRows(queue, { ...DEFAULT_FILTERS, minVolumeUm3: 0.4 }).map((r) => r.tip.endUid),
    ).toEqual([3, 2])
  })

  /** `shown` is SEAM's absolute cutoff, read from the data and never recomputed here. */
  it('can keep only SEAM’s shown set', () => {
    expect(
      arrangeRows(queue, { ...DEFAULT_FILTERS, shownOnly: true }).map((r) => r.tip.endUid),
    ).toEqual([1])
  })

  /** Equal rows must not shuffle between renders, or a reader loses their place. */
  it('breaks ties the same way every time', () => {
    const flat = buildQueue(
      tipsTable([
        { end: 9, r: 0.5 },
        { end: 4, r: 0.5 },
        { end: 6, r: 0.5 },
      ]),
      candidatesTable([
        { end: 9, id: 'a', rank: 1 },
        { end: 4, id: 'b', rank: 1 },
        { end: 6, id: 'c', rank: 1 },
      ]),
    )
    expect(arrangeRows(flat, DEFAULT_FILTERS).map((r) => r.tip.endUid)).toEqual([4, 6, 9])
  })
})

describe('the cursor', () => {
  const queue = buildQueue(
    tipsTable([
      { end: 1, r: 0.2 },
      { end: 2, r: 0.9 },
    ]),
    candidatesTable([
      { end: 1, id: 'a', rank: 1 },
      { end: 1, id: 'b', rank: 2 },
      { end: 2, id: 'c', rank: 1 },
    ]),
  )

  /**
   * By identity, not by position. A filter that drops the rows above the current one must not
   * leave a reader judging a different tip than the one they are looking at.
   */
  it('follows the tip, not its place in the list', () => {
    const here = currentOfQueue(queue, '1', 1)!
    expect(here.tip.endUid).toBe(1)
    const narrowed = arrangeRows(queue, { ...DEFAULT_FILTERS, minConfidence: 0.5 })
    expect(narrowed.map((r) => r.tip.endUid)).toEqual([2])
    // The queue, not the narrowed list, is what the cursor resolves against.
    expect(currentOfQueue(queue, '1', 1)!.tip.endUid).toBe(1)
  })

  it('pages within a tip', () => {
    expect(currentOfQueue(queue, '1', 2)!.candidate.candidateId).toBe('b')
  })

  /** Paging past the end is a gesture, not an error. */
  it('falls back to the suggestion for a rank the tip does not have', () => {
    expect(currentOfQueue(queue, '1', 99)!.candidate.rank).toBe(1)
  })

  it('is nothing when unset, or when the tip is gone', () => {
    expect(currentOfQueue(queue, '', 1)).toBeUndefined()
    expect(currentOfQueue(queue, '404', 1)).toBeUndefined()
  })
})

describe('verdicts', () => {
  /**
   * The pair, not the candidate. A piece can sit on two tips' lists — it can touch the neuron in
   * two places — so "belongs" on one and "not it" on the other is two answers, not a conflict.
   */
  it('keys on the tip and the candidate together', () => {
    let said = withVerdict(new Map(), 1, 'x', 'accept')
    said = withVerdict(said, 2, 'x', 'reject')
    expect(verdictFor(said, 1, 'x')).toBe('accept')
    expect(verdictFor(said, 2, 'x')).toBe('reject')
  })

  it('clears when the same verdict is given twice', () => {
    const once = withVerdict(new Map(), 1, 'x', 'accept')
    expect(verdictFor(withVerdict(once, 1, 'x', 'accept'), 1, 'x')).toBeUndefined()
    expect(verdictFor(withVerdict(once, 1, 'x', 'reject'), 1, 'x')).toBe('reject')
  })

  /**
   * This string is a param, so it is in the provenance key: an unstable encoding would re-key
   * the node — and re-run everything downstream — on a map that happened to iterate differently.
   */
  it('encodes in a stable order, whatever order the verdicts were made in', () => {
    const a = encodeVerdicts(
      new Map([
        ['2:b', 'reject'],
        ['1:a', 'accept'],
      ] as const),
    )
    const b = encodeVerdicts(
      new Map([
        ['1:a', 'accept'],
        ['2:b', 'reject'],
      ] as const),
    )
    expect(a).toBe(b)
  })

  it('round-trips, and ignores anything hand-edited into nonsense', () => {
    const said = withVerdict(withVerdict(new Map(), 1, 'x', 'unsure'), 2, 'y', 'accept')
    expect(decodeVerdicts(encodeVerdicts(said))).toEqual(said)
    expect(decodeVerdicts('1:x=maybe;rubbish;=accept').size).toBe(0)
  })
})

/**
 * The two grains.
 *
 * `tip` is the unit SEAM calibrated — the cutoff, `p_tip` and `r` were all fitted on *first*
 * candidates — so a row there is a suggestion somebody made. `candidate` is the same data one
 * level down, where nothing is calibrated but every candidate has its own `conf`.
 */
describe('one row per candidate', () => {
  const queue = buildQueue(
    tipsTable([
      { end: 1, r: 0.9, shown: true },
      { end: 2, r: 0.3 },
    ]),
    candidatesTable([
      { end: 1, id: 'a', rank: 1, vol: 1 },
      { end: 1, id: 'b', rank: 2, vol: 2 },
      { end: 2, id: 'c', rank: 1, vol: 3 },
    ]),
  )
  const per = (mode: 'tip' | 'candidate', extra: Partial<typeof DEFAULT_FILTERS> = {}) =>
    arrangeRows(queue, { ...DEFAULT_FILTERS, mode, ...extra })

  it('gives a row to every candidate, not to every tip', () => {
    expect(per('tip')).toHaveLength(2)
    expect(per('candidate').map((r) => r.candidate?.candidateId)).toHaveLength(3)
  })

  /**
   * The number the row leads with changes with the grain, and so does what the filters read.
   * `r` is the tip's; `conf` is `p_tip × p_cand` and belongs to one candidate.
   */
  it('leads with r per tip and with the candidate’s own conf per candidate', () => {
    expect(per('tip').map((r) => r.score)).toEqual([0.9, 0.3])
    // `candidatesTable` sets conf from the rank, so the order is by that rather than by `r`.
    const scores = per('candidate').map((r) => r.score)
    expect(scores).toEqual([...scores].sort((a, b) => (b ?? 0) - (a ?? 0)))
  })

  it('narrows on the row’s own number', () => {
    expect(per('tip', { minConfidence: 0.5 }).map((r) => r.tip.endUid)).toEqual([1])
    // Per candidate the same threshold reads each candidate's conf, not its tip's r.
    for (const row of per('candidate', { minConfidence: 0.5 })) {
      expect(row.score).toBeGreaterThanOrEqual(0.5)
    }
  })

  /** A tip whose search found nothing is an answer per tip, and no row at all per candidate. */
  it('keeps an empty tip in one mode and not the other', () => {
    const bare = buildQueue(tipsTable([{ end: 5 }]), candidatesTable([]))
    expect(arrangeRows(bare, { ...DEFAULT_FILTERS, mode: 'tip' })).toHaveLength(1)
    expect(arrangeRows(bare, { ...DEFAULT_FILTERS, mode: 'candidate' })).toHaveLength(0)
  })
})
