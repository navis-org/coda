/**
 * The review queue's own decisions, which the card only draws.
 *
 * Three of them are worth more than the rest, because each would be invisible on screen:
 * the cursor is a tip's identity rather than a position in the list, so a filter cannot move it;
 * a verdict is keyed on the neuron and the piece, never on the tip, whose number a re-run reuses;
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
  acceptedPieces,
  arrangeRows,
  buildQueue,
  currentOfQueue,
  decodeVerdicts,
  encodeVerdicts,
  neuronsOf,
  pickedNeuron,
  scenePieces,
  sizeOf,
  stillToSearch,
  tipsOf,
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
  rows: {
    end: number
    id: string
    rank: number
    neuron?: string
    vol?: number
    l2?: number
    gap?: number
  }[],
): TableValue =>
  makeTable(
    tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('end_uid', 'i64'),
      column('candidateId', 'str'),
      column('rank', 'i64'),
      column('vol_um3', 'f64'),
      column('n_l2', 'i64'),
      column('min_dist_um', 'f64'),
      column('contact_x', 'f64'),
      column('contact_y', 'f64'),
      column('contact_z', 'f64'),
      column('conf', 'f64'),
      column('shown', 'bool'),
    ),
    {
      [ID_COLUMN_NAME]: rows.map((r) => r.neuron ?? 'n1'),
      end_uid: rows.map((r) => r.end),
      candidateId: rows.map((r) => r.id),
      rank: rows.map((r) => r.rank),
      vol_um3: rows.map((r) => r.vol ?? 1),
      n_l2: rows.map((r) => r.l2 ?? null),
      min_dist_um: rows.map((r) => r.gap ?? null),
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

  /** A zero is a real place; a merge looked for there would be a merge somewhere else. */
  it('leaves a missing contact undefined, never at the origin', () => {
    const table = candidatesTable([{ end: 7, id: 'a', rank: 1 }])
    const without = makeTable(
      table.schema,
      { ...table.data, contact_x: [null] },
      table.kind,
      table.length,
    )
    const queue = buildQueue(tipsTable([{ end: 7 }]), without)
    expect(queue[0]!.candidates[0]!.contactNm).toBeUndefined()
  })

  /** Two runs stacked into one table, each numbering its tips from 0: a list is its own neuron's. */
  it('joins a tip to its list on the neuron as well as the tip number', () => {
    const queue = buildQueue(
      tipsTable([
        { end: 0, neuron: 'n1' },
        { end: 0, neuron: 'n2' },
      ]),
      candidatesTable([
        { end: 0, id: 'a', rank: 1, neuron: 'n1' },
        { end: 0, id: 'b', rank: 1, neuron: 'n2' },
      ]),
    )
    expect(queue.map((tip) => tip.candidates.map((c) => c.candidateId))).toEqual([['a'], ['b']])
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
  /** The neuron and the piece: the same piece is a separate question for another neuron. */
  it('keys on the neuron and the candidate together', () => {
    let said = withVerdict(new Map(), 'n1', 'x', 'accept')
    said = withVerdict(said, 'n2', 'x', 'reject')
    expect(verdictFor(said, 'n1', 'x')).toBe('accept')
    expect(verdictFor(said, 'n2', 'x')).toBe('reject')
  })

  it('clears when the same verdict is given twice', () => {
    const once = withVerdict(new Map(), 'n1', 'x', 'accept')
    expect(verdictFor(withVerdict(once, 'n1', 'x', 'accept'), 'n1', 'x')).toBeUndefined()
    expect(verdictFor(withVerdict(once, 'n1', 'x', 'reject'), 'n1', 'x')).toBe('reject')
  })

  /**
   * The audit of 77c0625 (2026-11-16): `end_uid` counts one run's tips, so a re-run reuses it. A
   * verdict keyed on it attached to whichever tip took the number — on another neuron, whose tip
   * listed the same piece, it was an accept nobody gave, planned by Submit.
   */
  it('does not carry an accept to another neuron’s tip of the same number', () => {
    const run2 = buildQueue(
      tipsTable([{ end: 5, neuron: '200' }]),
      candidatesTable([{ end: 5, id: '900', rank: 1, neuron: '200' }]),
    )
    const said = withVerdict(new Map(), '100', '900', 'accept')
    expect(acceptedPieces(run2, said).size).toBe(0)
    expect(verdictFor(said, '200', '900')).toBeUndefined()
  })

  /** One verdict, one judgement: a piece listed at two tips is counted once. */
  it('counts a piece judged once, however many tips list it', () => {
    const queue = buildQueue(
      tipsTable([{ end: 1 }, { end: 2 }]),
      candidatesTable([
        { end: 1, id: 'p', rank: 1 },
        { end: 2, id: 'p', rank: 1 },
      ]),
    )
    const said = withVerdict(new Map(), 'n1', 'p', 'accept')
    expect(neuronsOf(queue, said)).toEqual([{ neuronId: 'n1', tips: 2, judged: 1 }])
  })

  /** Kept in the param, so nothing is deleted, and read as no verdict on anything (user). */
  it('keeps a key of the old tip shape, and never reads it', () => {
    const queue = buildQueue(
      tipsTable([{ end: 5 }]),
      candidatesTable([{ end: 5, id: '900', rank: 1 }]),
    )
    const old = decodeVerdicts('5:900=accept')
    expect(acceptedPieces(queue, old).size).toBe(0)
    expect(neuronsOf(queue, old)[0]!.judged).toBe(0)
    const kept = encodeVerdicts(withVerdict(old, 'n1', '901', 'reject'))
    expect(kept).toBe('5:900=accept;n1/901=reject')
  })

  /**
   * This string is a param, so it is in the provenance key: an unstable encoding would re-key
   * the node — and re-run everything downstream — on a map that happened to iterate differently.
   */
  it('encodes in a stable order, whatever order the verdicts were made in', () => {
    const a = encodeVerdicts(
      new Map([
        ['n2/b', 'reject'],
        ['n1/a', 'accept'],
      ] as const),
    )
    const b = encodeVerdicts(
      new Map([
        ['n1/a', 'accept'],
        ['n2/b', 'reject'],
      ] as const),
    )
    expect(a).toBe(b)
  })

  it('round-trips, and ignores anything hand-edited into nonsense', () => {
    const said = withVerdict(withVerdict(new Map(), 'n1', 'x', 'unsure'), 'n2', 'y', 'accept')
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

/**
 * One neuron at a time. The tables carry several neurons when Find Open Ends was given several,
 * and a list mixing them is a reader judging one neuron's tip next to another's without a word.
 *
 * The neurons are **interleaved** in the fixture, so a test that passed by taking the first rows
 * of a table sorted by neuron cannot pass here.
 */
describe('one neuron at a time', () => {
  const queue = buildQueue(
    tipsTable([
      { end: 1, neuron: 'n1', r: 0.2 },
      { end: 2, neuron: 'n2', r: 0.9 },
      { end: 3, neuron: 'n1', r: 0.5 },
      { end: 4, neuron: 'n3', r: 0.7 },
    ]),
    candidatesTable([
      { end: 1, id: 'a', rank: 1 },
      { end: 1, id: 'b', rank: 2 },
      { end: 2, id: 'c', rank: 1, neuron: 'n2' },
      { end: 3, id: 'd', rank: 1 },
    ]),
  )

  /** Table order, which is the order the search runs in: the first neuron is the first ready. */
  it('lists each neuron once, in the order the table first names it', () => {
    expect(neuronsOf(queue, new Map()).map((n) => n.neuronId)).toEqual(['n1', 'n2', 'n3'])
  })

  /** Counted over pairs, so a verdict on a rank 2 counts towards its own neuron and no other. */
  it('counts each neuron’s tips and its judged pairs apart', () => {
    let verdicts = withVerdict(new Map(), 'n1', 'a', 'accept')
    verdicts = withVerdict(verdicts, 'n1', 'b', 'reject')
    verdicts = withVerdict(verdicts, 'n2', 'c', 'unsure')
    // The piece of n1's, judged for n2: a question about n2, counted there and not on n1.
    verdicts = withVerdict(verdicts, 'n2', 'a', 'reject')
    expect(neuronsOf(queue, verdicts)).toEqual([
      { neuronId: 'n1', tips: 2, judged: 2 },
      { neuronId: 'n2', tips: 1, judged: 1 },
      { neuronId: 'n3', tips: 1, judged: 0 },
    ])
  })

  it('is on the first neuron until one is picked', () => {
    expect(pickedNeuron(queue, '')).toBe('n1')
    expect(pickedNeuron(queue, '  ')).toBe('n1')
  })

  it('is on the picked neuron where the queue holds it', () => {
    expect(pickedNeuron(queue, 'n3')).toBe('n3')
  })

  /**
   * The user's decision (2026-11-15): a root id no longer in the table — edited, or a different
   * set upstream — falls back to the first rather than leaving an empty card.
   */
  it('falls back to the first neuron for a root id the queue no longer holds', () => {
    expect(pickedNeuron(queue, 'n9')).toBe('n1')
  })

  it('is on nothing when there is no queue', () => {
    expect(pickedNeuron([], 'n1')).toBeUndefined()
    expect(tipsOf([], undefined)).toEqual([])
  })

  it('keeps only the picked neuron’s tips, in queue order', () => {
    expect(tipsOf(queue, 'n1').map((t) => t.endUid)).toEqual([1, 3])
  })

  /** A cursor on another neuron's tip resolves to nothing, never to that neuron's pair. */
  it('does not resolve a cursor left on another neuron', () => {
    expect(currentOfQueue(tipsOf(queue, 'n1'), '2', 1)).toBeUndefined()
    expect(currentOfQueue(tipsOf(queue, 'n2'), '2', 1)?.candidate.candidateId).toBe('c')
  })

  it('counts only the picked neuron’s tips still to search', () => {
    const tips = makeTable(
      tableSchema(column(ID_COLUMN_NAME, 'str'), column('searched', 'bool')),
      {
        [ID_COLUMN_NAME]: ['n1', 'n2', 'n1', 'n2', 'n2'],
        searched: [true, null, null, null, false],
      },
      'table',
      5,
    )
    expect(stillToSearch(tips, 'n1')).toBe(1)
    expect(stillToSearch(tips, 'n2')).toBe(2)
    expect(stillToSearch(tips)).toBe(3)
  })
})

/** A piece can touch the neuron at two tips; accepted at both, it is still one segment. */
describe('the pieces sent to the scene', () => {
  it('lists a piece accepted on two tips once', () => {
    const queue = buildQueue(
      tipsTable([{ end: 1 }, { end: 2 }]),
      candidatesTable([
        { end: 1, id: 'p', rank: 1 },
        { end: 2, id: 'p', rank: 1 },
      ]),
    )
    const verdicts = withVerdict(new Map(), 'n1', 'p', 'accept')
    expect(scenePieces(queue, 'n1', undefined, verdicts, true)).toEqual([
      { id: 'n1', part: 'neuron' },
      { id: 'p', part: 'accepted' },
    ])
  })
})

/** After Submit: the neuron at its root now, and a neuron merged into another drawn as that one. */
describe('the scene after merges', () => {
  const queue = buildQueue(
    tipsTable([{ end: 1 }]),
    candidatesTable([
      { end: 1, id: 'p', rank: 1 },
      { end: 1, id: 'q', rank: 2 },
    ]),
  )
  let verdicts = withVerdict(new Map(), 'n1', 'p', 'accept')
  verdicts = withVerdict(verdicts, 'n1', 'q', 'accept')
  const merged = {
    currentRoot: 'n1b',
    roots: ['n1', 'n1b'],
    pieces: new Set(['p']),
    otherRoots: new Set<string>(),
    elsewhere: new Set<string>(),
    unsettled: [],
    absorbedInto: undefined,
  }

  it('shows the neuron at its new root, and only the pieces still to merge', () => {
    expect(scenePieces(queue, 'n1', undefined, verdicts, true, merged)).toEqual([
      { id: 'n1b', part: 'neuron' },
      { id: 'q', part: 'accepted' },
    ])
  })

  it('draws a neuron merged into another as that one', () => {
    const absorbed = { ...merged, absorbedInto: 'm9' }
    expect(scenePieces(queue, 'n1', undefined, verdicts, true, absorbed)[0]).toEqual({
      id: 'm9',
      part: 'neuron',
    })
  })
})

/**
 * The one rule for "accepted", read by the scene's green pieces and by Submit's plan alike: a
 * piece accepted for the neuron is accepted, once, with every row it is listed on.
 */
describe('the accepted pieces', () => {
  const queue = buildQueue(
    tipsTable([{ end: 1 }, { end: 2 }, { end: 3 }]),
    candidatesTable([
      { end: 1, id: 'p', rank: 1, gap: 0.5 },
      { end: 1, id: 'q', rank: 2 },
      { end: 2, id: 'p', rank: 3, gap: 0.1 },
      { end: 2, id: 'r', rank: 1 },
      { end: 3, id: 'p', rank: 1 },
      { end: 3, id: 'q', rank: 2, gap: 2 },
    ]),
  )
  let verdicts = withVerdict(new Map(), 'n1', 'p', 'accept')
  verdicts = withVerdict(verdicts, 'n1', 'q', 'accept')
  verdicts = withVerdict(verdicts, 'n1', 'r', 'unsure')

  it('lists each piece once, in the order the reader met it', () => {
    expect([...acceptedPieces(queue, verdicts).keys()]).toEqual(['p', 'q'])
  })

  /** One verdict per pair: a later reject is the reader's word, on every row of the piece. */
  it('drops a piece once it is rejected, on whichever row', () => {
    const rejected = withVerdict(verdicts, 'n1', 'q', 'reject')
    expect([...acceptedPieces(queue, rejected).keys()]).toEqual(['p'])
  })

  it('keeps every row a piece is listed on, nearest gap first and an unmeasured one last', () => {
    expect(
      acceptedPieces(queue, verdicts)
        .get('p')!
        .map((row) => row.endUid),
    ).toEqual([2, 1, 3])
    expect(
      acceptedPieces(queue, verdicts)
        .get('q')!
        .map((row) => row.endUid),
    ).toEqual([3, 1])
  })

  it('is what the scene shows in green', () => {
    const green = scenePieces(queue, 'n1', undefined, verdicts, true)
      .filter((piece) => piece.part === 'accepted')
      .map((piece) => piece.id)
    expect(green).toEqual([...acceptedPieces(queue, verdicts).keys()])
  })
})
