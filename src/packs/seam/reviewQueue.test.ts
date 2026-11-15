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
  sizeOf,
  stillToSearch,
  verdictFor,
  withVerdict,
} from './reviewQueue'
import type { Candidate } from './reviewQueue'

const tipsTable = (
  rows: { end: number; neuron?: string; r?: number; shown?: boolean | null; kind?: string }[],
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
      // `?? false` would swallow an explicit null, which is the case under test.
      shown: rows.map((r) => (r.shown === undefined ? false : r.shown)),
    },
  )

const candidatesTable = (
  rows: { end: number; id: string; rank: number; vol?: number; l2?: number }[],
): TableValue =>
  makeTable(
    tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('end_uid', 'i64'),
      column('candidateId', 'str'),
      column('rank', 'i64'),
      column('vol_um3', 'f64'),
      column('n_l2', 'i64'),
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
      n_l2: rows.map((r) => r.l2 ?? null),
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

/**
 * How many tips are still to come, which the foot of the card reports while a run streams.
 *
 * Read off `searched` rather than counted as "rows with nothing on them", and the middle case is
 * why: a tip the run will never reach is published `false`, so a count of empty rows would stall
 * above zero at the end of a run and read as a search that stopped early.
 */
/**
 * What "size" means in the queue, which is two quantities with one control.
 *
 * `vol_um3` is the candidate's voxels inside the search box — how much of the piece is near
 * the tip. The level-2 chunk count is of the **object**, wherever it reaches, which is the better
 * proxy for "fragment or neuron" and so what the card sorts and filters on. A published set
 * carries no chunk count, and the fallback is what keeps the control working there.
 */
describe("a candidate's size", () => {
  const candidate = (over: Partial<Candidate>): Candidate =>
    ({ candidateId: 'c', rank: 1, contactNm: [0, 0, 0], ...over }) as Candidate

  /**
   * One pair of candidates for both of the tests below, because the point of the fixture is the
   * disagreement between the two quantities: tip 1's piece is the larger *object* and the
   * smaller presence in the box, so a sort or a filter that fell back to the volume would put
   * them the other way round. Built twice, a change to it could quietly stop testing that.
   */
  const bigAndSmall = () =>
    buildQueue(
      tipsTable([{ end: 1 }, { end: 2 }]),
      candidatesTable([
        { end: 1, id: 'big', rank: 1, vol: 0.1, l2: 40 },
        { end: 2, id: 'small', rank: 1, vol: 9, l2: 2 },
      ]),
    )

  it('is what `Sort by: size` orders on, in preference to the volume', () => {
    const rows = arrangeRows(bigAndSmall(), { ...DEFAULT_FILTERS, sortBy: 'size' })
    expect(rows.map((r) => r.candidate?.candidateId)).toEqual(['big', 'small'])
  })

  it('is what `Min size` counts, so a count filters a count', () => {
    const rows = arrangeRows(bigAndSmall(), { ...DEFAULT_FILTERS, minSize: 10 })
    expect(rows.map((r) => r.candidate?.candidateId)).toEqual(['big'])
  })

  it('is the chunk count where the table carries one', () => {
    expect(sizeOf(candidate({ l2Chunks: 14, volumeUm3: 0.25 }))).toEqual({
      value: 14,
      of: 'chunks',
    })
  })

  /** A `seam:suggestions` set: SEAM's own parquet publishes no chunk count. */
  it('falls back to the in-box volume where it does not', () => {
    expect(sizeOf(candidate({ volumeUm3: 0.25 }))).toEqual({ value: 0.25, of: 'um3' })
  })

  it('is nothing at all for a candidate measured neither way, or for no candidate', () => {
    expect(sizeOf(candidate({}))).toBeUndefined()
    expect(sizeOf(undefined)).toBeUndefined()
  })

  /**
   * **A zero chunk count is a size, not an absence.** `??` on the number rather than a check on
   * its presence would read it as "no chunk count" and fall through to the volume, which is a
   * different quantity — and the chunkedgraph does list roots with no level-2 chunks.
   */
  it('reads a chunk count of zero as a size', () => {
    expect(sizeOf(candidate({ l2Chunks: 0, volumeUm3: 0.25 }))).toEqual({
      value: 0,
      of: 'chunks',
    })
  })
})

describe('how many tips are still to search', () => {
  const searchedTips = (states: readonly (boolean | null)[]): TableValue =>
    makeTable(
      tableSchema(column(ID_COLUMN_NAME, 'str'), column('searched', 'bool')),
      {
        [ID_COLUMN_NAME]: states.map(() => 'n1'),
        searched: [...states],
      },
      'table',
      states.length,
    )

  it('counts the tips not yet reached', () => {
    expect(stillToSearch(searchedTips([true, true, null, null, null]))).toBe(3)
  })

  /** The run is over: the rows it could not reach are `false`, not waiting. */
  it('reaches zero even where some tips were never searchable', () => {
    expect(stillToSearch(searchedTips([true, false, true, false]))).toBe(0)
  })

  /**
   * **Absent is not zero.** A `seam:suggestions` table is a published set, complete by
   * definition and carrying no such column; reported as 0 it would print the same as a run that
   * has just finished, which is a number about a run that never happened.
   */
  it('says nothing at all about a table without the column', () => {
    expect(stillToSearch(tipsTable([{ end: 1 }]))).toBeUndefined()
    expect(stillToSearch(undefined)).toBeUndefined()
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
      arrangeRows(queue, { ...DEFAULT_FILTERS, minSize: 0.4 }).map((r) => r.tip.endUid),
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

/**
 * A `Tips`/`Candidates` pair from `seam:suggestMerges`: ranked by geometry, with none of the
 * calibrated columns, because the stage that produces them cannot run in a browser yet.
 */
const geometryOnly = () => ({
  tips: makeTable(
    tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('end_uid', 'i64'),
      column('kind', 'str'),
      column('x', 'f64'),
      column('y', 'f64'),
      column('z', 'f64'),
      column('e_tip', 'f64'),
      column('candidateId', 'str'),
      column('geo_rank', 'i64'),
    ),
    {
      [ID_COLUMN_NAME]: ['n1', 'n1'],
      end_uid: [7, 8],
      kind: ['tip', 'tip'],
      x: [1, 1],
      y: [2, 2],
      z: [3, 3],
      // The second end looks far more like a cut-off neurite than the first.
      e_tip: [-0.9, 0.8],
      candidateId: ['100', '200'],
      geo_rank: [1, 1],
    },
  ),
  candidates: makeTable(
    tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('end_uid', 'i64'),
      column('candidateId', 'str'),
      column('rank', 'i64'),
      column('geo_rank', 'i64'),
      column('vol_um3', 'f64'),
      column('min_dist_um', 'f64'),
      column('contact_x', 'f64'),
      column('contact_y', 'f64'),
      column('contact_z', 'f64'),
    ),
    {
      [ID_COLUMN_NAME]: ['n1', 'n1'],
      end_uid: [7, 8],
      candidateId: ['100', '200'],
      rank: [1, 1],
      geo_rank: [1, 1],
      vol_um3: [0.5, 0.5],
      min_dist_um: [0.1, 0.1],
      contact_x: [10, 10],
      contact_y: [20, 20],
      contact_z: [30, 30],
    },
  ),
})

describe('a queue with no calibration at all', () => {
  /**
   * **Absent is not excluded.** `shown` is SEAM's cutoff applied, and a table that has no such
   * column is one nobody applied a cutoff to. Read as `=== true` every row was hidden, which
   * emptied `seam:review`'s annotation layer and its `Shown only` filter without a word.
   */
  it('treats a missing `shown` column as nothing having been cut', () => {
    const { tips, candidates } = geometryOnly()
    expect(buildQueue(tips, candidates).every((tip) => tip.shown)).toBe(true)
  })

  /** A set that *was* cut keeps being cut — the column's value is still the answer. */
  it('still honours a `shown` column that is there', () => {
    const queue = buildQueue(tipsTable([{ end: 1, shown: false }]), candidatesTable([]))
    expect(queue[0]!.shown).toBe(false)
  })

  /**
   * **A cleared `shown` is not a hidden row.** `tipsWithFirsts` nulls every first-candidate
   * column when it searches a tip, so a `seam:suggestions` table fed through
   * `seam:suggestMerges` keeps the *column* and holds `null` in it — the old run's verdict about
   * a candidate this run replaced.
   */
  it('treats a cleared `shown` cell the same as a missing column', () => {
    const queue = buildQueue(tipsTable([{ end: 1, shown: null }]), candidatesTable([]))
    expect(queue[0]!.shown).toBe(true)
  })

  /**
   * There is no confidence to sort by, so the order falls through to the `end_uid` tie-break —
   * the table's own order. Deliberately not patched by substituting the open-end score: that is
   * a logit, not a chance, and it would sort, filter and *print* under a heading that means
   * something else.
   */
  it('keeps the table’s order when nothing has a confidence', () => {
    const { tips, candidates } = geometryOnly()
    const rows = arrangeRows(buildQueue(tips, candidates), {
      ...DEFAULT_FILTERS,
      sortBy: 'confidence',
    })
    expect(rows.map((row) => row.tip.endUid)).toEqual([7, 8])
  })

  /**
   * The sentinel for "no such number" has to sort below every real one. `-1` was inside the
   * range being compared, so an unmeasured row outranked a measured negative.
   */
  it('sorts a row with no confidence below one with a negative confidence', () => {
    const queue = buildQueue(tipsTable([{ end: 1 }, { end: 2, r: -0.5 }]), candidatesTable([]))
    const rows = arrangeRows(queue, { ...DEFAULT_FILTERS, sortBy: 'confidence' })
    expect(rows.map((row) => row.tip.endUid)).toEqual([2, 1])
  })
})
