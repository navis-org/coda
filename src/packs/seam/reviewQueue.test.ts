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
  acceptedElsewhere,
  acceptedPieces,
  arrangeRows,
  arrangeTree,
  buildQueue,
  currentOfQueue,
  decodeExtend,
  decodeVerdicts,
  DEFAULT_FILTERS,
  estimateLabel,
  encodeExtend,
  encodeVerdicts,
  extendBlocked,
  extendedKeys,
  extendLabel,
  extendPress,
  extendProgress,
  IN_NEURON_NOTE,
  isLargePiece,
  judgedParams,
  autoFirsts,
  autoUnavailable,
  extendMenu,
  extendParams,
  extendPlanFrom,
  reviewGrowth,
  reviewStateOf,
  autoJudged,
  autoOffered,
  planTexts,
  rowExtend,
  leavesWith,
  liveQueue,
  neuronsOf,
  pickedNeuron,
  scenePieces,
  sizeOf,
  stillToSearch,
  tipKey,
  tipsOf,
  verdictFor,
  verdictPress,
  withExtended,
  withVerdict,
} from './reviewQueue'
import { LARGE_PIECE_CHUNKS, pairsOf } from './pieces'
import type { ExtendPair } from './pieces'

/** What is extended, as pairs: `extendedKeys` read back. */
const extendedPairs = (extend: unknown, verdicts: Verdicts) =>
  pairsOf(extendedKeys(extend, verdicts))
/** The tree of the pairs alone, with no Auto-extend: `reviewGrowth`'s. */
const liveTree = (queue: readonly QueueTip[], pairs: readonly ExtendPair[]) =>
  reviewGrowth(queue, { pairs, roots: new Set(), refused: new Set() }).tree
/** The verdicts as everything downstream reads them. */
const reviewedVerdicts = (
  params: Readonly<Record<string, unknown>>,
  queue: readonly QueueTip[],
) => reviewStateOf(params, queue).verdicts
import type { Candidate, QueueFilters, QueueTip, Verdict, Verdicts } from './reviewQueue'

const tipsTable = (
  rows: {
    end: number
    neuron?: string
    q?: number
    r?: number
    shown?: boolean | null
    kind?: string
  }[],
): TableValue =>
  makeTable(
    tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('end_uid', 'i64'),
      column('kind', 'str'),
      column('x', 'f64'),
      column('y', 'f64'),
      column('z', 'f64'),
      column('q', 'f64'),
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
      q: rows.map((r) => r.q ?? null),
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
    organelle?: boolean | null
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
      column('organelle', 'bool'),
    ),
    {
      [ID_COLUMN_NAME]: rows.map((r) => r.neuron ?? 'n1'),
      end_uid: rows.map((r) => r.end),
      candidateId: rows.map((r) => r.id),
      organelle: rows.map((r) => r.organelle ?? null),
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

  /** A `seam:suggestions` set from before rv4: its parquet publishes no chunk count. */
  it('falls back to the in-box volume where it does not', () => {
    expect(sizeOf(candidate({ volumeUm3: 0.25 }))).toEqual({ value: 0.25, of: 'um3' })
  })

  /**
   * **One unit per table.** A gap in `n_l2` leaves that row with no size, never one in µm³: a
   * sort or `Min size` over the queue would otherwise compare chunks with cubic micrometres.
   */
  it('gives a row without a chunk count no size, where the table has chunk counts', () => {
    const queue = buildQueue(
      tipsTable([{ end: 1 }, { end: 2 }]),
      candidatesTable([
        { end: 1, id: 'counted', rank: 1, l2: 3, vol: 0.5 },
        { end: 2, id: 'missing', rank: 1, vol: 0.5 },
      ]),
    )
    expect(queue.map((tip) => sizeOf(tip.candidates[0]))).toEqual([
      { value: 3, of: 'chunks' },
      undefined,
    ])
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
      tableSchema(
        column(ID_COLUMN_NAME, 'str'),
        column('end_uid', 'i64'),
        column('searched', 'bool'),
      ),
      {
        [ID_COLUMN_NAME]: states.map(() => 'n1'),
        end_uid: states.map((_, i) => i),
        searched: [...states],
      },
      'table',
      states.length,
    )
  /** Over the tips as the card lists them, which is what the count is taken over. */
  const waiting = (table: TableValue | undefined) =>
    stillToSearch(table, buildQueue(table, undefined))

  it('counts the tips not yet reached', () => {
    expect(waiting(searchedTips([true, true, null, null, null]))).toBe(3)
  })

  /** The run is over: the rows it could not reach are `false`, not waiting. */
  it('reaches zero even where some tips were never searchable', () => {
    expect(waiting(searchedTips([true, false, true, false]))).toBe(0)
  })

  /**
   * **Absent is not zero.** A `seam:suggestions` table is a published set, complete by
   * definition and carrying no such column; reported as 0 it would print the same as a run that
   * has just finished, which is a number about a run that never happened.
   */
  it('says nothing at all about a table without the column', () => {
    expect(waiting(tipsTable([{ end: 1 }]))).toBeUndefined()
    expect(waiting(undefined)).toBeUndefined()
  })
})

describe('arranging the queue', () => {
  const queue = buildQueue(
    tipsTable([
      { end: 1, q: 0.9, shown: true },
      { end: 2, q: 0.4 },
      { end: 3, q: 0.6 },
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

  /** Equal rows must not shuffle between renders, or a reader loses their place. */
  it('breaks ties the same way every time', () => {
    const flat = buildQueue(
      tipsTable([
        { end: 9, q: 0.5 },
        { end: 4, q: 0.5 },
        { end: 6, q: 0.5 },
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
      { end: 1, q: 0.2 },
      { end: 2, q: 0.9 },
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
    const here = currentOfQueue(queue, 'n1|1', 1)!
    expect(here.tip.endUid).toBe(1)
    const narrowed = arrangeRows(queue, { ...DEFAULT_FILTERS, minConfidence: 0.5 })
    expect(narrowed.map((r) => r.tip.endUid)).toEqual([2])
    // The queue, not the narrowed list, is what the cursor resolves against.
    expect(currentOfQueue(queue, 'n1|1', 1)!.tip.endUid).toBe(1)
  })

  it('pages within a tip', () => {
    expect(currentOfQueue(queue, 'n1|1', 2)!.candidate.candidateId).toBe('b')
  })

  /** Paging past the end is a gesture, not an error. */
  it('falls back to the suggestion for a rank the tip does not have', () => {
    expect(currentOfQueue(queue, 'n1|1', 99)!.candidate.rank).toBe(1)
  })

  it('is nothing when unset, or when the tip is gone', () => {
    expect(currentOfQueue(queue, '', 1)).toBeUndefined()
    expect(currentOfQueue(queue, 'n1|404', 1)).toBeUndefined()
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
      { end: 1, q: 0.9, shown: true },
      { end: 2, q: 0.3 },
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
   * `q` is the tip's (SEAM, 2026-11-18: never `r`, a staircase over it); `conf` is
   * `p_tip × p_cand` and belongs to one candidate.
   */
  it('leads with q per tip and with the candidate’s own conf per candidate', () => {
    expect(per('tip').map((r) => r.score)).toEqual([0.9, 0.3])
    // `candidatesTable` sets conf from the rank, so the order is by that rather than by `q`.
    const scores = per('candidate').map((r) => r.score)
    expect(scores).toEqual([...scores].sort((a, b) => (b ?? 0) - (a ?? 0)))
  })

  it('narrows on the row’s own number', () => {
    expect(per('tip', { minConfidence: 0.5 }).map((r) => r.tip.endUid)).toEqual([1])
    // Per candidate the same threshold reads each candidate's conf, not its tip's q.
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
    const queue = buildQueue(tipsTable([{ end: 1 }, { end: 2, q: -0.5 }]), candidatesTable([]))
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
      { end: 1, neuron: 'n1', q: 0.2 },
      { end: 2, neuron: 'n2', q: 0.9 },
      { end: 3, neuron: 'n1', q: 0.5 },
      { end: 4, neuron: 'n3', q: 0.7 },
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
    expect(currentOfQueue(tipsOf(queue, 'n1'), 'n2|2', 1)).toBeUndefined()
    expect(currentOfQueue(tipsOf(queue, 'n2'), 'n2|2', 1)?.candidate.candidateId).toBe('c')
  })

  it('counts only the picked neuron’s tips still to search', () => {
    const tips = makeTable(
      tableSchema(
        column(ID_COLUMN_NAME, 'str'),
        column('end_uid', 'i64'),
        column('searched', 'bool'),
      ),
      {
        [ID_COLUMN_NAME]: ['n1', 'n2', 'n1', 'n2', 'n2'],
        end_uid: [0, 1, 2, 3, 4],
        searched: [true, null, null, null, false],
      },
      'table',
      5,
    )
    const listed = buildQueue(tips, undefined)
    expect(stillToSearch(tips, tipsOf(listed, 'n1'))).toBe(1)
    expect(stillToSearch(tips, tipsOf(listed, 'n2'))).toBe(2)
    expect(stillToSearch(tips, listed)).toBe(3)
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

/**
 * A neuron and the pieces it is extended with (`docs/seam-extend-plan.md`).
 *
 * Suggest Merges publishes a piece's tips in the same table as the neuron's: `ID` is the piece,
 * `seed` the neuron being grown. The fixture is one neuron, `n1`, with a piece `p1` accepted on
 * it and a piece `p2` accepted on `p1` — and **every root has a tip 0**, which is the case a
 * cursor or a row key read as a bare `end_uid` gets wrong.
 */
describe('a neuron and the pieces it is extended with', () => {
  type Row = {
    id: string
    end: number
    seed: string
    steps?: number
    junction?: boolean
    searched?: boolean | null
  }
  const grownTips = (rows: Row[]): TableValue =>
    makeTable(
      tableSchema(
        column(ID_COLUMN_NAME, 'str'),
        column('end_uid', 'i64'),
        column('x', 'f64'),
        column('y', 'f64'),
        column('z', 'f64'),
        column('seed', 'str'),
        column('steps', 'i64'),
        column('junction', 'bool'),
        column('searched', 'bool'),
      ),
      {
        [ID_COLUMN_NAME]: rows.map((r) => r.id),
        end_uid: rows.map((r) => r.end),
        x: rows.map(() => 1),
        y: rows.map(() => 2),
        z: rows.map(() => 3),
        seed: rows.map((r) => r.seed),
        steps: rows.map((r) => r.steps ?? 0),
        junction: rows.map((r) => r.junction ?? false),
        searched: rows.map((r) => (r.searched === undefined ? true : r.searched)),
      },
    )
  const TIPS = grownTips([
    { id: 'n1', end: 0, seed: 'n1' },
    { id: 'n2', end: 0, seed: 'n2' },
    { id: 'p1', end: 0, seed: 'n1', steps: 1, junction: true, searched: false },
    { id: 'p1', end: 1, seed: 'n1', steps: 1 },
    { id: 'p2', end: 0, seed: 'n1', steps: 2, junction: true, searched: false },
    { id: 'p2', end: 1, seed: 'n1', steps: 2, searched: null },
    { id: 'p2', end: 2, seed: 'n1', steps: 2, searched: null },
  ])
  const CANDIDATES = candidatesTable([
    { neuron: 'n1', end: 0, id: 'p1', rank: 1 },
    { neuron: 'n1', end: 0, id: 'x', rank: 2 },
    { neuron: 'n2', end: 0, id: 'y', rank: 1 },
    { neuron: 'p1', end: 1, id: 'p2', rank: 1 },
  ])
  const all = buildQueue(TIPS, CANDIDATES)
  const VERDICTS = decodeVerdicts('n1/p1=accept;p1/p2=accept')
  const EXTEND = 'n1/p1;p1/p2'
  const names = (tips: readonly { neuronId: string; endUid: number }[]) =>
    tips.map((tip) => tipKey(tip.neuronId, tip.endUid))

  it('reads which neuron a tip belongs to and what the run did with it', () => {
    expect(all.map((tip) => [tip.neuronId, tip.seed, tip.junction, tip.search])).toEqual([
      ['n1', 'n1', false, 'done'],
      ['n2', 'n2', false, 'done'],
      ['p1', 'n1', true, 'never'],
      ['p1', 'n1', false, 'done'],
      ['p2', 'n1', true, 'never'],
      ['p2', 'n1', false, 'waiting'],
      ['p2', 'n1', false, 'waiting'],
    ])
  })

  /** A published set has none of these columns, and reads exactly as it did. */
  it('takes a tip’s own root for its neuron where the table has no seed', () => {
    const queue = buildQueue(tipsTable([{ end: 1 }, { end: 2, neuron: 'n2' }]), undefined)
    expect(queue.map((tip) => [tip.seed, tip.junction, tip.search])).toEqual([
      ['n1', false, 'done'],
      ['n2', false, 'done'],
    ])
  })

  describe('what is extended', () => {
    it('is a pair that is in the list and still accepted', () => {
      expect(extendedPairs(EXTEND, VERDICTS)).toEqual([
        { parent: 'n1', piece: 'p1' },
        { parent: 'p1', piece: 'p2' },
      ])
      // Accepted and not asked for is not extended: an accept starts nothing.
      expect(extendedPairs('', VERDICTS)).toEqual([])
      expect(extendedPairs(EXTEND, decodeVerdicts('n1/p1=accept;p1/p2=reject'))).toEqual([
        { parent: 'n1', piece: 'p1' },
      ])
      expect(extendedPairs(EXTEND, decodeVerdicts('n1/p1=unsure'))).toEqual([])
    })

    /** The list is in a provenance key, and the tables are built in its order. */
    it('comes out the same whatever order the pieces were pressed in', () => {
      const one = withExtended(withExtended('', 'p1', 'p2', true), 'n1', 'p1', true)
      const other = withExtended(withExtended('', 'n1', 'p1', true), 'p1', 'p2', true)
      expect(one).toBe(other)
      expect(one).toBe(EXTEND)
      expect(extendedPairs(one, VERDICTS)).toEqual(extendedPairs(other, VERDICTS))
      // Twice is once, and taking one out leaves the other.
      expect(withExtended(EXTEND, 'n1', 'p1', true)).toBe(EXTEND)
      expect(withExtended(EXTEND, 'n1', 'p1', false)).toBe('p1/p2')
    })

    it('drops what is not a pair, so a hand edit cannot name half of one', () => {
      expect([...decodeExtend('n1/p1; ;p2;/p3;n4/;n1/p1')]).toEqual(['n1/p1'])
      expect(encodeExtend(['b/c', 'a/b', 'b/c'])).toBe('a/b;b/c')
    })
  })

  describe('the rows there are to review', () => {
    const tree = liveTree(all, extendedPairs(EXTEND, VERDICTS))

    it('derives the tree as the search does, from the queue’s neurons', () => {
      expect(tree.map((piece) => [piece.id, piece.seed, piece.depth])).toEqual([
        ['p1', 'n1', 1],
        ['p2', 'n1', 2],
      ])
    })

    it('lists a neuron’s own tips and its pieces’, less each joining end', () => {
      const queue = liveQueue(all, tree)
      expect(names(queue)).toEqual(['n1|0', 'n2|0', 'p1|1', 'p2|1', 'p2|2'])
      expect(names(tipsOf(queue, 'n1'))).toEqual(['n1|0', 'p1|1', 'p2|1', 'p2|2'])
      expect(names(tipsOf(queue, 'n2'))).toEqual(['n2|0'])
      // A piece is not a neuron to pick.
      expect(neuronsOf(queue, VERDICTS).map((n) => [n.neuronId, n.tips, n.judged])).toEqual([
        ['n1', 4, 2],
        ['n2', 1, 0],
      ])
      expect(pickedNeuron(queue, 'p1')).toBe('n1')
    })

    /**
     * The click, before the search has run again: the rows are still in the table, and they
     * are off the list. Everything beyond the piece goes with it.
     */
    it('takes a piece’s rows off the moment it is no longer accepted, and those beyond it', () => {
      const gone = decodeVerdicts('n1/p1=reject;p1/p2=accept')
      const queue = liveQueue(all, liveTree(all, extendedPairs(EXTEND, gone)))
      expect(names(queue)).toEqual(['n1|0', 'n2|0'])
      // The verdict beyond it is kept and unread — nothing of that neuron lists `p2` now.
      expect(neuronsOf(queue, gone).find((n) => n.neuronId === 'n1')?.judged).toBe(1)
      expect(acceptedPieces(tipsOf(queue, 'n1'), gone).size).toBe(0)
    })

    it('leaves the pieces beyond one that is only no longer extended unreachable, not deleted', () => {
      const queue = liveQueue(all, liveTree(all, extendedPairs('p1/p2', VERDICTS)))
      expect(names(queue)).toEqual(['n1|0', 'n2|0'])
      // Extended again, they are back without another press.
      const back = liveQueue(all, liveTree(all, extendedPairs(EXTEND, VERDICTS)))
      expect(names(tipsOf(back, 'n1'))).toContain('p2|1')
    })

    /** Every root has a tip 0: the cursor names the root too, or it lands on the neuron's. */
    it('resolves the cursor by root and number together', () => {
      const mine = tipsOf(liveQueue(all, tree), 'n1')
      expect(currentOfQueue(mine, 'p1|1', 1)?.candidate.candidateId).toBe('p2')
      expect(currentOfQueue(mine, 'n1|0', 1)?.candidate.candidateId).toBe('p1')
      // A cursor saved before pieces, as a bare number, is on nothing.
      expect(currentOfQueue(mine, '0', 1)).toBeUndefined()
      // A joining end is not listed, so not something to be on either.
      expect(currentOfQueue(mine, 'p1|0', 1)).toBeUndefined()
    })

    it('counts a neuron’s tips still to search with its pieces’', () => {
      const queue = liveQueue(all, tree)
      expect(stillToSearch(TIPS, tipsOf(queue, 'n1'))).toBe(2)
      expect(stillToSearch(TIPS, tipsOf(queue, 'n2'))).toBe(0)
    })

    /**
     * Stopping a piece runs nothing, so its rows stay in the table, still waiting, until the
     * search next runs. They are off the list, and so off the count.
     */
    it('does not count the waiting tips of a piece that is no longer extended', () => {
      const dropped = liveQueue(all, liveTree(all, extendedPairs('n1/p1', VERDICTS)))
      expect(stillToSearch(TIPS, tipsOf(dropped, 'n1'))).toBe(0)
    })

    /** Two pieces accepted on one tip: the row names the first, and the second's rows say so. */
    it('has the rows of a second piece on one tip name their piece', () => {
      const both = buildQueue(
        grownTips([
          { id: 'n1', end: 0, seed: 'n1' },
          { id: 'a1', end: 1, seed: 'n1', steps: 1 },
          { id: 'a2', end: 1, seed: 'n1', steps: 1 },
        ]),
        candidatesTable([
          { neuron: 'n1', end: 0, id: 'a1', rank: 1 },
          { neuron: 'n1', end: 0, id: 'a2', rank: 2 },
        ]),
      )
      const verdicts = decodeVerdicts('n1/a1=accept;n1/a2=accept')
      const grown = liveTree(both, extendedPairs('n1/a1;n1/a2', verdicts))
      const rows = arrangeTree(
        tipsOf(liveQueue(both, grown), 'n1'),
        'n1',
        grown,
        DEFAULT_FILTERS,
      )
      expect(
        rows.map((row) => [tipKey(row.tip.neuronId, row.tip.endUid), row.depth, row.adrift]),
      ).toEqual([
        ['n1|0', 0, false],
        ['a1|1', 1, false],
        ['a2|1', 1, true],
      ])
      expect(rows[0]!.hosted?.candidateId).toBe('a1')
    })

    it('is on nothing with a cursor cut short, rather than on tip 0', () => {
      const mine = tipsOf(liveQueue(all, tree), 'n1')
      expect(currentOfQueue(mine, 'n1|', 1)).toBeUndefined()
      expect(currentOfQueue(mine, 'n1|x', 1)).toBeUndefined()
      expect(currentOfQueue(mine, 'n1|0', 1)?.tip.endUid).toBe(0)
    })

    it('shows every accepted piece of the tree in the scene, under the one neuron', () => {
      const mine = tipsOf(liveQueue(all, tree), 'n1')
      const here = currentOfQueue(mine, 'p1|1', 1)
      // The neuron, the piece the tip is on, then what is proposed for it.
      // The candidate in hand is accepted, and drawn in focus among the green pieces.
      expect(scenePieces(mine, 'n1', here, VERDICTS, true)).toEqual([
        { id: 'n1', part: 'neuron' },
        { id: 'p1', part: 'accepted' },
        { id: 'p2', part: 'focus' },
      ])
      // With `Show accepted` off the piece under the cursor is still drawn: a candidate beside
      // the neuron, and nothing between them, is a pair nobody can judge.
      expect(scenePieces(mine, 'n1', here, VERDICTS, false)).toEqual([
        { id: 'n1', part: 'neuron' },
        { id: 'p1', part: 'accepted' },
        { id: 'p2', part: 'candidate' },
      ])
      // On one of the neuron's own tips nothing is added.
      expect(scenePieces(mine, 'n1', currentOfQueue(mine, 'n1|0', 2), VERDICTS, false)).toEqual(
        [
          { id: 'n1', part: 'neuron' },
          { id: 'x', part: 'candidate' },
        ],
      )
    })
  })

  /**
   * The list as it is drawn (user, 2026-11-16): a piece's tips beneath the row the piece was
   * accepted on, a level in, each level narrowed and sorted on its own.
   */
  describe('the list as a tree', () => {
    type Tip = Row & { q?: number }
    const scored = (rows: Tip[]): TableValue => {
      const table = grownTips(rows)
      return makeTable(tableSchema(...table.schema.columns, column('q', 'f64')), {
        ...table.data,
        q: rows.map((row) => row.q ?? null),
      })
    }
    // The neuron's tips 0 (0.2) and 1 (0.9); `p1` accepted on tip 0, `p2` on `p1`'s tip 1.
    const tips = scored([
      { id: 'n1', end: 0, seed: 'n1', q: 0.2 },
      { id: 'n1', end: 1, seed: 'n1', q: 0.9 },
      { id: 'p1', end: 0, seed: 'n1', steps: 1, junction: true, searched: false },
      { id: 'p1', end: 1, seed: 'n1', steps: 1, q: 0.95 },
      { id: 'p1', end: 2, seed: 'n1', steps: 1, q: 0.99 },
      { id: 'p2', end: 1, seed: 'n1', steps: 2, q: 0.5 },
    ])
    const candidates = candidatesTable([
      { neuron: 'n1', end: 0, id: 'p1', rank: 1, l2: 9 },
      { neuron: 'n1', end: 1, id: 'z', rank: 1, l2: 9 },
      { neuron: 'p1', end: 1, id: 'p2', rank: 1, l2: 1 },
      { neuron: 'p1', end: 2, id: 'w', rank: 1, l2: 9 },
      { neuron: 'p2', end: 1, id: 'v', rank: 1, l2: 9 },
    ])
    const whole = buildQueue(tips, candidates)
    const drawn = (
      filters: Partial<typeof DEFAULT_FILTERS> = {},
      extend = EXTEND,
      verdicts = VERDICTS,
      queue = whole,
    ) => {
      const tree = liveTree(queue, extendedPairs(extend, verdicts))
      const mine = tipsOf(liveQueue(queue, tree), 'n1')
      return arrangeTree(mine, 'n1', tree, { ...DEFAULT_FILTERS, ...filters }).map(
        (row) => `${'>'.repeat(row.depth)}${tipKey(row.tip.neuronId, row.tip.endUid)}`,
      )
    }

    it('puts a piece’s tips under the row it was accepted on, each level in its own order', () => {
      // Flat, by confidence, this would be p1|2, p1|1, n1|1, p2|1, n1|0.
      expect(drawn()).toEqual(['n1|1', 'n1|0', '>p1|2', '>p1|1', '>>p2|1'])
      expect(drawn({ sortBy: 'tip' })).toEqual(['n1|0', '>p1|1', '>>p2|1', '>p1|2', 'n1|1'])
    })

    it('is the neuron’s own rows where nothing is extended, as before', () => {
      expect(drawn({}, '')).toEqual(['n1|1', 'n1|0'])
      expect(arrangeTree(tipsOf(whole, 'n1'), undefined, [], DEFAULT_FILTERS)).toEqual([])
    })

    /** Filtered out, the rows beneath would hang from nothing. */
    it('lists the row a piece hangs beneath whatever the filters say, and narrows the rest', () => {
      // 0.6 drops n1|0 (0.2) and p2|1 (0.5) on its own level; n1|0 stays for what is under it.
      expect(drawn({ minConfidence: 0.6 })).toEqual(['n1|1', 'n1|0', '>p1|2', '>p1|1'])
      // 0.97 leaves only p1|2 of the rows nothing hangs beneath — and every row on the way to it.
      expect(drawn({ minConfidence: 0.97 })).toEqual(['n1|0', '>p1|2', '>p1|1'])
      // The size filter reads each row's own candidate: p1|1's is one chunk, and it stays too.
      expect(drawn({ minSize: 5 })).toEqual(['n1|1', 'n1|0', '>p1|2', '>p1|1', '>>p2|1'])
    })

    it('says which candidate a tip’s row is showing the ends of', () => {
      const tree = liveTree(whole, extendedPairs(EXTEND, VERDICTS))
      const rows = arrangeTree(
        tipsOf(liveQueue(whole, tree), 'n1'),
        'n1',
        tree,
        DEFAULT_FILTERS,
      )
      expect(rows.map((row) => row.hosted?.candidateId ?? '')).toEqual(['', 'p1', '', 'p2', ''])
      expect(rows.every((row) => !row.adrift)).toBe(true)
    })

    it('hangs them under the piece’s own row where a row is a candidate', () => {
      const more = buildQueue(
        tips,
        candidatesTable([
          { neuron: 'n1', end: 0, id: 'other', rank: 1 },
          { neuron: 'n1', end: 0, id: 'p1', rank: 2 },
          { neuron: 'p1', end: 1, id: 'p2', rank: 1 },
        ]),
      )
      const tree = liveTree(more, extendedPairs('n1/p1', VERDICTS))
      const rows = arrangeTree(tipsOf(liveQueue(more, tree), 'n1'), 'n1', tree, {
        ...DEFAULT_FILTERS,
        mode: 'candidate',
      })
      expect(
        rows.map(
          (row) => `${'>'.repeat(row.depth)}${row.tip.neuronId}:${row.candidate?.candidateId}`,
        ),
      ).toEqual(['n1:other', 'n1:p1', '>p1:p2'])
      expect(rows.every((row) => row.hosted === undefined)).toBe(true)
    })

    /** A piece touching the neuron at two tips is under one of them: where the gap is smallest. */
    it('hangs a piece listed at two tips under the nearer one', () => {
      const twice = buildQueue(
        tips,
        candidatesTable([
          { neuron: 'n1', end: 0, id: 'p1', rank: 1, gap: 0.4 },
          { neuron: 'n1', end: 1, id: 'p1', rank: 2, gap: 0.1 },
          { neuron: 'p1', end: 1, id: 'q', rank: 1 },
        ]),
      )
      expect(drawn({}, 'n1/p1', VERDICTS, twice)).toEqual(['n1|1', '>p1|2', '>p1|1', 'n1|0'])
    })

    /**
     * A listing with no contact point is no place to be joined at — the search takes no joining
     * end from one either (`pieceContacts`) — so the piece hangs under the listing that has one.
     */
    it('does not hang a piece under a listing that says nothing of where they touch', () => {
      const listed = candidatesTable([
        { neuron: 'n1', end: 0, id: 'p1', rank: 1, gap: 0.1 },
        { neuron: 'n1', end: 1, id: 'p1', rank: 2, gap: 0.4 },
        { neuron: 'p1', end: 1, id: 'q', rank: 1 },
      ])
      // The nearer listing loses its contact; the further one still has it.
      const blind = makeTable(listed.schema, {
        ...listed.data,
        contact_x: [null, ...listed.data['contact_x']!.slice(1)],
      })
      expect(drawn({}, 'n1/p1', VERDICTS, buildQueue(tips, blind))).toEqual([
        'n1|1',
        '>p1|2',
        '>p1|1',
        'n1|0',
      ])
    })

    /** Its parent's rows do not list it — searched by another run, say. Still listed, and it says so. */
    it('lists a piece no row names after its parent’s rows, saying which piece it is', () => {
      const unnamed = buildQueue(
        tips,
        candidatesTable([{ neuron: 'p1', end: 1, id: 'q', rank: 1 }]),
      )
      const tree = liveTree(unnamed, [{ parent: 'n1', piece: 'p1' }])
      const rows = arrangeTree(
        tipsOf(liveQueue(unnamed, tree), 'n1'),
        'n1',
        tree,
        DEFAULT_FILTERS,
      )
      expect(
        rows.map(
          (row) => `${'>'.repeat(row.depth)}${tipKey(row.tip.neuronId, row.tip.endUid)}`,
        ),
      ).toEqual(['n1|1', 'n1|0', '>p1|2', '>p1|1'])
      expect(rows.map((row) => row.adrift)).toEqual([false, false, true, true])
    })

    it('lists every tip of the neuron once', () => {
      const tree = liveTree(whole, extendedPairs(EXTEND, VERDICTS))
      const mine = tipsOf(liveQueue(whole, tree), 'n1')
      const rows = arrangeTree(mine, 'n1', tree, DEFAULT_FILTERS)
      expect(new Set(rows.map((row) => row.tip)).size).toBe(mine.length)
      expect(rows).toHaveLength(mine.length)
    })
  })

  /**
   * What a press on a verdict does. The candidate's size and whatever stands in the way of
   * extending it are handed over as facts; the rules — the pair kept in step with the verdict,
   * `Extend on accept`, a large piece left to its button — are decided here, not on the card.
   */
  const piece = (candidateId: string, l2Chunks = 3) => ({ candidateId, l2Chunks }) as Candidate
  describe('a press on a verdict', () => {
    const params = { verdicts: 'n1/p1=accept;p1/p2=accept', extend: EXTEND }
    const press = (
      from: Record<string, unknown>,
      neuron: string,
      id: string,
      verdict: Verdict,
    ) => judgedParams(from, neuron, piece(id), verdict, undefined)

    it('takes a piece no longer accepted out of the extended ones, in the same edit', () => {
      expect(press(params, 'n1', 'p1', 'reject')).toEqual({
        // The piece beyond keeps its entry: it is back if this one is extended again.
        write: { verdicts: 'n1/p1=reject;p1/p2=accept', extend: 'p1/p2' },
        search: false,
        said: 'reject',
      })
      // Pressing Accept again clears it, which is un-accepting too.
      expect(press(params, 'n1', 'p1', 'accept')).toEqual({
        write: { verdicts: 'p1/p2=accept', extend: 'p1/p2' },
        search: false,
        said: undefined,
      })
    })

    /** So that accepting it again does not start a search nobody pressed Extend for. */
    it('does not extend a piece by accepting it', () => {
      const rejected = press(params, 'n1', 'p1', 'reject').write
      const again = press({ ...params, ...rejected }, 'n1', 'p1', 'accept')
      expect(again).toEqual({
        write: { verdicts: 'n1/p1=accept;p1/p2=accept' },
        search: false,
        said: 'accept',
      })
      // `p1` is accepted and not extended, so nothing is reached — `p2`'s entry waits.
      const pairs = extendedPairs(rejected.extend, decodeVerdicts(again.write.verdicts))
      expect(pairs).toEqual([{ parent: 'p1', piece: 'p2' }])
      expect(liveTree(all, pairs)).toEqual([])
    })

    it('writes the verdict alone where nothing extended is touched', () => {
      expect(press(params, 'n1', 'x', 'reject').write).toEqual({
        verdicts: 'n1/p1=accept;n1/x=reject;p1/p2=accept',
      })
      expect(press({ verdicts: '', extend: '' }, 'n1', 'p1', 'accept')).toEqual({
        write: { verdicts: 'n1/p1=accept' },
        search: false,
        said: 'accept',
      })
    })

    /** What the card sends: the verdict after the press, none where the press took it back. */
    it('says the verdict the press left, Ends included, and none where it cleared one', () => {
      expect(press({ verdicts: '' }, 'n1', 'p1', 'ends').said).toBe('ends')
      expect(press({ verdicts: 'n1/p1=ends' }, 'n1', 'p1', 'ends').said).toBeUndefined()
      expect(press({ verdicts: 'n1/p1=ends' }, 'n1', 'p1', 'reject').said).toBe('reject')
    })

    /** A hand edit can leave a pair extended and re-judged; a press keeps what is there. */
    it('leaves an accepted pair that is already extended as it is', () => {
      const odd = { verdicts: 'n1/p1=unsure', extend: 'n1/p1' }
      expect(press(odd, 'n1', 'p1', 'accept')).toEqual({
        write: { verdicts: 'n1/p1=accept' },
        search: false,
        said: 'accept',
      })
    })
  })

  /** `Extend on accept` (user, 2026-11-16): a press that accepts a piece extends it in the same edit. */
  describe('a press on Accept with auto-extend', () => {
    const on = { verdicts: '', extend: '', extendOnAccept: true }

    it('writes the pair into the extended ones with the verdict, and asks for the search', () => {
      expect(judgedParams(on, 'n1', piece('p1'), 'accept', undefined)).toEqual({
        write: { verdicts: 'n1/p1=accept', extend: 'n1/p1' },
        search: true,
        said: 'accept',
      })
      // Onto what is there, sorted as the param always is.
      expect(
        judgedParams(
          { ...on, verdicts: 'n1/p1=accept', extend: 'n1/p1' },
          'p1',
          piece('p2'),
          'accept',
          undefined,
        ).write,
      ).toEqual({ verdicts: 'n1/p1=accept;p1/p2=accept', extend: 'n1/p1;p1/p2' })
    })

    it('extends nothing with the toggle off, which is how it is unless asked', () => {
      for (const params of [
        { verdicts: '', extend: '' },
        { ...on, extendOnAccept: false },
      ]) {
        expect(judgedParams(params, 'n1', piece('p1'), 'accept', undefined)).toEqual({
          write: { verdicts: 'n1/p1=accept' },
          search: false,
          said: 'accept',
        })
      }
    })

    it('extends nothing on any other verdict', () => {
      for (const verdict of ['reject', 'ends', 'unsure'] as const) {
        expect(judgedParams(on, 'n1', piece('p1'), verdict, undefined)).toEqual({
          write: { verdicts: `n1/p1=${verdict}` },
          search: false,
          said: verdict,
        })
      }
    })

    /** Accepted, and left to its button: a search of one can take minutes. */
    it('leaves a large piece to its button', () => {
      expect(judgedParams(on, 'n1', piece('p1', 41), 'accept', undefined)).toEqual({
        write: { verdicts: 'n1/p1=accept' },
        search: false,
        said: 'accept',
      })
      expect(judgedParams(on, 'n1', piece('p1', 40), 'accept', undefined).search).toBe(true)
    })

    it('extends nothing where the piece cannot be extended', () => {
      expect(judgedParams(on, 'n1', piece('p1'), 'accept', 'no wire back')).toEqual({
        write: { verdicts: 'n1/p1=accept' },
        search: false,
        said: 'accept',
      })
    })

    /** Accept pressed on an accepted piece clears the verdict, and the toggle must not undo that. */
    it('still takes the pair out when the press un-accepts, and starts nothing', () => {
      const extended = { ...on, verdicts: 'n1/p1=accept', extend: 'n1/p1' }
      expect(judgedParams(extended, 'n1', piece('p1'), 'accept', undefined)).toEqual({
        write: { verdicts: '', extend: '' },
        search: false,
        said: undefined,
      })
      expect(judgedParams(extended, 'n1', piece('p1'), 'reject', undefined)).toEqual({
        write: { verdicts: 'n1/p1=reject', extend: '' },
        search: false,
        said: 'reject',
      })
    })

    it('calls a piece large from 41 level-2 chunks, and never by a volume', () => {
      const sized = (l2Chunks: number | undefined, volumeUm3?: number) =>
        ({ l2Chunks, volumeUm3 }) as Candidate
      expect(LARGE_PIECE_CHUNKS).toBe(41)
      expect(isLargePiece(sized(40))).toBe(false)
      expect(isLargePiece(sized(41))).toBe(true)
      // A published set carries µm³ inside the search box, which says nothing of the whole piece.
      expect(isLargePiece(sized(undefined, 5000))).toBe(false)
      expect(isLargePiece(undefined)).toBe(false)
    })
  })

  /** The Extend button: what it reads, what its title says, whether it can be pressed. */
  describe('the Extend button', () => {
    const blockedBy = (change: Partial<Parameters<typeof extendBlocked>[0]>) =>
      extendBlocked({ wired: true, done: undefined, outdated: false, ...change })
    const button = (change: Partial<Parameters<typeof extendPress>[0]> = {}) =>
      extendPress({
        candidate: piece('p1', 14),
        progress: undefined,
        blocked: undefined,
        extendOnAccept: false,
        goesWith: '',
        choice: 'off',
        held: false,
        heldBy: undefined,
        took: 0,
        ...change,
      })

    it('says why a piece cannot be extended, in the order a reader would fix it', () => {
      expect(blockedBy({})).toBeUndefined()
      expect(blockedBy({ wired: false, done: 'merged', outdated: true })).toMatch(
        /Wire this card’s `Extended` output.*published set cannot be extended/,
      )
      expect(blockedBy({ done: 'merged', outdated: true })).toMatch(/Merged by Submit/)
      expect(blockedBy({ done: 'elsewhere' })).toMatch(/another neuron/)
      expect(blockedBy({ outdated: true })).toMatch(/edited since it was suggested/)
    })

    it('says how big the piece is before the press, and when that is large', () => {
      expect(button()).toMatchObject({
        label: 'Extend',
        title: 'Search this piece’s own open ends for what continues it. It is 14 L2 chunks.',
        disabled: false,
      })
      const large = button({ candidate: piece('p1', 61) })
      expect(large.label).toBe('Extend (large)')
      expect(large.title).toMatch(/It is 61 L2 chunks\. That is large/)
      // Said, never refused.
      expect(large.disabled).toBe(false)
      expect(large.title).not.toMatch(/Extend on accept/)
      expect(button({ candidate: piece('p1', 61), extendOnAccept: true }).title).toMatch(
        /Extend on accept leaves a piece this size to this button/,
      )
    })

    it('is off with the reason where the piece cannot be extended', () => {
      expect(button({ blocked: 'No wire back.' })).toMatchObject({
        label: 'Extend',
        title: 'No wire back.',
        disabled: true,
      })
    })

    /** Stopping is always allowed, whatever would stand in the way of starting. */
    it('says how far the search has got once extended, and can always be pressed', () => {
      const pressed = button({
        progress: { state: 'searching', done: 3, of: 7 },
        blocked: 'No wire back.',
        goesWith: leavesWith([], 'p1'),
      })
      expect(pressed).toMatchObject({
        label: 'searching 3 of 7',
        title:
          'This piece’s own open ends are searched and listed with the neuron’s. Press to ' +
          'stop extending it, which takes its ends off the list.',
        disabled: false,
      })
    })

    it('says what goes with a piece that has pieces beyond it', () => {
      const tree = liveTree(all, extendedPairs(EXTEND, VERDICTS))
      expect(leavesWith(tree, 'p1')).toBe(
        'takes its ends, and those of the 1 piece extended beyond it, off the list',
      )
      expect(leavesWith(tree, 'p2')).toBe('takes its ends off the list')
    })

    /** The verdict buttons: fixed once merged or in the neuron already; else what a change takes. */
    it('says when a verdict is fixed, and what changing one takes with it', () => {
      const at = { verdict: 'reject' as const, done: undefined, inNeuron: false, goesWith: '' }
      expect(verdictPress(at)).toEqual({
        title: 'This piece does not belong: it is not the continuation.',
        disabled: false,
      })
      expect(verdictPress({ ...at, done: 'merged', inNeuron: true })).toEqual({
        title: 'Merged by Submit.',
        disabled: true,
      })
      expect(verdictPress({ ...at, inNeuron: true })).toEqual({
        title: IN_NEURON_NOTE,
        disabled: true,
      })
      expect(verdictPress({ ...at, goesWith: 'takes its ends off the list' })).toEqual({
        title:
          'This piece does not belong: it is not the continuation. This piece is extended: changing its verdict takes its ' +
          'ends off the list.',
        disabled: false,
      })
    })

    /** A second accept of one piece would be a second merge of it. */
    it('knows a piece that is in the neuron already by another road', () => {
      const accepted = new Map([['p2', []]])
      expect(acceptedElsewhere(accepted, undefined, 'p2')).toBe(true)
      expect(acceptedElsewhere(accepted, 'reject', 'p2')).toBe(true)
      // Where it was accepted, it is an ordinary accepted row.
      expect(acceptedElsewhere(accepted, 'accept', 'p2')).toBe(false)
      expect(acceptedElsewhere(accepted, undefined, 'x')).toBe(false)
    })

    /** The card memoises on the keys joined: a string says whether the set moved. */
    it('gives what is extended as sorted keys, and as pairs from them', () => {
      expect(extendedKeys('p1/p2;n1/p1;n1/x', VERDICTS)).toEqual(['n1/p1', 'p1/p2'])
      expect(pairsOf(['n1/p1', 'half', 'p1/p2'])).toEqual([
        { parent: 'n1', piece: 'p1' },
        { parent: 'p1', piece: 'p2' },
      ])
    })
  })

  describe('how far the search of a piece has got', () => {
    const idle = { running: false, finished: false }
    const running = { running: true, finished: false }
    const finished = { running: false, finished: true }

    it('reads it off the rows the piece has published', () => {
      // `p1`: a joining end and one searched end.
      expect(extendProgress(all, 'n1', 'p1', finished)).toEqual({ state: 'searched', ends: 1 })
      // `p2`: a joining end and two still to come.
      expect(extendProgress(all, 'n1', 'p2', running)).toEqual({
        state: 'searching',
        done: 0,
        of: 2,
      })
      // The same rows with nothing running: a search that was stopped part way.
      expect(extendProgress(all, 'n1', 'p2', idle)).toEqual({
        state: 'stopped',
        done: 0,
        of: 2,
      })
    })

    it('tells a piece with no open end from one that published nothing', () => {
      const only = buildQueue(
        grownTips([
          { id: 'n1', end: 0, seed: 'n1' },
          { id: 'p1', end: 0, seed: 'n1', steps: 1, junction: true, searched: false },
          { id: 'p1', end: 1, seed: 'n1', steps: 1, searched: false },
        ]),
        undefined,
      )
      expect(extendProgress(only, 'n1', 'p1', finished)).toEqual({ state: 'no ends' })
      expect(extendProgress(only, 'n1', 'p9', running)).toEqual({ state: 'waiting' })
      expect(extendProgress(only, 'n1', 'p9', finished)).toEqual({ state: 'nothing' })
      expect(extendProgress(only, 'n1', 'p9', idle)).toEqual({ state: 'not run' })
      // A search that ended in an error is not one that was never run.
      expect(extendProgress(only, 'n1', 'p9', { ...idle, failed: true })).toEqual({
        state: 'failed',
      })
      expect(extendProgress(only, 'n1', 'p9', { ...running, failed: true })).toEqual({
        state: 'waiting',
      })
      // Another neuron's piece of the same id is not this one's.
      expect(extendProgress(only, 'n2', 'p1', finished)).toEqual({ state: 'nothing' })
    })

    it('says each in a few words', () => {
      expect(extendLabel({ state: 'waiting' })).toBe('waiting…')
      expect(extendLabel({ state: 'searching', done: 3, of: 7 })).toBe('searching 3 of 7')
      expect(extendLabel({ state: 'stopped', done: 3, of: 7 })).toBe('3 of 7 ends searched')
      expect(extendLabel({ state: 'searched', ends: 1 })).toBe('1 end searched')
      expect(extendLabel({ state: 'searched', ends: 7 })).toBe('7 ends searched')
      expect(extendLabel({ state: 'no ends' })).toBe('no open ends')
      expect(extendLabel({ state: 'nothing' })).toBe('nothing to search')
      expect(extendLabel({ state: 'not run' })).toBe('not searched yet')
      expect(extendLabel({ state: 'failed' })).toBe('search failed')
    })
  })
})

/**
 * `Exclude organelles`: a reading aid like the other filters, reading the row's own candidate —
 * per tip its first, so a tip whose suggestion is an organelle goes and one whose second is stays;
 * per candidate the row itself. The foot's count reads rows the same way.
 */
describe('leaving out organelles', () => {
  const queue = buildQueue(
    tipsTable([{ end: 1, q: 0.9, shown: true }, { end: 2, q: 0.4 }, { end: 3 }, { end: 4 }]),
    candidatesTable([
      // Tip 1's suggestion is an organelle; tip 2's second is; tip 3's flag was never measured;
      // tip 4 has nothing but organelles.
      { end: 1, id: 'a1', rank: 1, organelle: true },
      { end: 1, id: 'a2', rank: 2, organelle: false },
      { end: 2, id: 'b1', rank: 1, organelle: false },
      { end: 2, id: 'b2', rank: 2, organelle: true },
      { end: 3, id: 'c1', rank: 1, organelle: null },
      { end: 4, id: 'd1', rank: 1, organelle: true },
    ]),
  )
  const rows = (filters: Partial<QueueFilters>) =>
    arrangeRows(queue, { ...DEFAULT_FILTERS, sortBy: 'tip', ...filters })

  it('is on by default, as the node’s own param is', () => {
    expect(DEFAULT_FILTERS.excludeOrganelles).toBe(true)
  })

  /**
   * Per tip, a tip whose first candidate is an organelle stays, leading with the next that is not
   * (user, 2026-11-17): the second candidate may be the continuation. SEAM's `q` and `shown` are
   * about the first, so that row carries neither.
   */
  it('keeps a tip whose first candidate is an organelle, leading with the next, without its q', () => {
    const byTip = new Map(rows({}).map((row) => [row.tip.endUid, row]))
    expect([...byTip.keys()].sort()).toEqual([1, 2, 3, 4])
    expect(byTip.get(1)).toMatchObject({ candidate: { candidateId: 'a2' }, passedOver: true })
    expect(byTip.get(1)!.score).toBeUndefined()
    // A flag further down, or never measured, changes nothing about the row.
    expect(byTip.get(2)).toMatchObject({ candidate: { candidateId: 'b1' }, score: 0.4 })
    expect(byTip.get(2)!.passedOver).toBeUndefined()
    expect(byTip.get(3)!.candidate?.candidateId).toBe('c1')
    // Nothing but organelles: listed, with nothing to lead with.
    expect(byTip.get(4)).toMatchObject({ candidate: undefined, passedOver: true })
  })

  it('reads the tip as SEAM has it with the filter off', () => {
    const first = rows({ excludeOrganelles: false }).find((row) => row.tip.endUid === 1)!
    expect(first).toMatchObject({ candidate: { candidateId: 'a1' }, score: 0.9 })
  })

  it('never counts a passed-over row as shown, nor lets its q pass a confidence filter', () => {
    const ends = (filters: Partial<QueueFilters>) => rows(filters).map((row) => row.tip.endUid)
    const shown = (filters: Partial<QueueFilters>) =>
      rows(filters)
        .filter((row) => row.shown)
        .map((row) => row.tip.endUid)
    expect(shown({ excludeOrganelles: false })).toEqual([1])
    expect(shown({})).toEqual([])
    expect(ends({ minConfidence: 0.5, excludeOrganelles: false })).toEqual([1])
    expect(ends({ minConfidence: 0.5 })).toEqual([])
  })

  it('leaves out every flagged candidate, per candidate', () => {
    const ids = rows({ mode: 'candidate' }).map((row) => row.candidate!.candidateId)
    expect(ids.sort()).toEqual(['a2', 'b1', 'c1'])
  })

  it('changes nothing in a set that carries no flag', () => {
    const plain = buildQueue(
      tipsTable([{ end: 1, q: 0.7 }]),
      candidatesTable([{ end: 1, id: 'a', rank: 1 }]),
    )
    expect(arrangeRows(plain, DEFAULT_FILTERS)).toEqual([
      { tip: plain[0], candidate: plain[0]!.candidates[0], score: 0.7, shown: false },
    ])
  })
})

/**
 * SEAM, 2026-11-18: "the filter hides; it should not promote". A row that passes over an organelle
 * leads with the next candidate (user) but carries none of the first candidate's numbers, and
 * Coda's re-scoring without organelles (2026-11-17) is not read — a `Tips` table from a run that
 * still published it keeps the columns, and they change nothing.
 */
describe('a tip whose list holds an organelle', () => {
  const tips = makeTable(
    tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('end_uid', 'i64'),
      column('q', 'f64'),
      column('r', 'f64'),
      column('shown', 'bool'),
      column('q_no_organelles', 'f64'),
      column('r_no_organelles', 'f64'),
      column('shown_no_organelles', 'bool'),
    ),
    {
      [ID_COLUMN_NAME]: ['n1', 'n1'],
      end_uid: [1, 2],
      q: [0.9, 0.4],
      r: [0.95, 0.5],
      shown: [true, false],
      q_no_organelles: [0.7, 0.55],
      r_no_organelles: [0.8, 0.6],
      shown_no_organelles: [true, true],
    },
  )
  const queue = buildQueue(
    tips,
    candidatesTable([
      // Tip 1 leads with an organelle, tip 2 holds one further down.
      { end: 1, id: 'a1', rank: 1, organelle: true },
      { end: 1, id: 'a2', rank: 2, organelle: false },
      { end: 2, id: 'b1', rank: 1, organelle: false },
      { end: 2, id: 'b2', rank: 2, organelle: true },
    ]),
  )
  const byTip = new Map(
    arrangeRows(queue, { ...DEFAULT_FILTERS, sortBy: 'tip' }).map((row) => [
      row.tip.endUid,
      row,
    ]),
  )

  it('leads past an organelle with no q, no r and never shown, whatever the table re-scored', () => {
    expect(byTip.get(1)).toMatchObject({
      candidate: { candidateId: 'a2' },
      score: undefined,
      shown: false,
      passedOver: true,
    })
    expect(byTip.get(1)!.estimate).toBeUndefined()
  })

  it('keeps SEAM’s numbers where the organelle is further down', () => {
    expect(byTip.get(2)).toEqual({
      tip: queue[1],
      candidate: queue[1]!.candidates[0],
      score: 0.4,
      estimate: 0.5,
      shown: false,
    })
  })
})

/**
 * SEAM, 2026-11-18: `r` is shown only as a rounded label, marked an estimate — 14 steps fitted
 * on ~335 judged tips have no second decimal, and the low ones rest on a handful each.
 */
describe('r as a label', () => {
  it('rounds to tens, and leaves both ends open', () => {
    expect(estimateLabel(0.93)).toBe('≥90%')
    expect(estimateLabel(0.86)).toBe('≈90%')
    expect(estimateLabel(0.5)).toBe('≈50%')
    expect(estimateLabel(0.14)).toBe('≈10%')
    expect(estimateLabel(0.03)).toBe('<10%')
  })

  /** A sort or a filter on `r` ties thousands of tips that `q` keeps apart. */
  it('is never what a tip row sorts by', () => {
    const queue = buildQueue(
      tipsTable([
        { end: 1, q: 0.5, r: 0.9 },
        { end: 2, q: 0.6, r: 0.9 },
      ]),
      candidatesTable([]),
    )
    const ranked = arrangeRows(queue, { ...DEFAULT_FILTERS, sortBy: 'confidence' })
    expect(ranked.map((row) => [row.tip.endUid, row.score, row.estimate])).toEqual([
      [2, 0.6, 0.9],
      [1, 0.5, 0.9],
    ])
  })
})

/**
 * Auto-extend on the card (`docs/seam-auto-extend-plan.md`): the reader pressed it on piece
 * `201`, accepted on neuron `100`. The card grows the tree from the published rows by the
 * search's own rule, so the accepts it shows are the ones the search searched — and Submit merges.
 * The ids are numbers because Auto-extend takes only a real chunkedgraph id.
 *
 * `201`'s ends: tip 1 offers `301` (cleared), tip 2 an organelle (`302`), tip 3 nothing that
 * cleared (`303`). `301`'s ends: tip 1 a large piece (`401`), tip 2 `402`.
 */
describe('Auto-extend, as the card reads it', () => {
  type Row = { id: string; end: number; steps: number; junction?: boolean; shown?: boolean }
  const tips = (rows: Row[]): TableValue =>
    makeTable(
      tableSchema(
        column(ID_COLUMN_NAME, 'str'),
        column('end_uid', 'i64'),
        column('x', 'f64'),
        column('y', 'f64'),
        column('z', 'f64'),
        column('seed', 'str'),
        column('steps', 'i64'),
        column('junction', 'bool'),
        column('searched', 'bool'),
        column('shown', 'bool'),
      ),
      {
        [ID_COLUMN_NAME]: rows.map((r) => r.id),
        end_uid: rows.map((r) => r.end),
        x: rows.map(() => 1),
        y: rows.map(() => 2),
        z: rows.map(() => 3),
        seed: rows.map(() => '100'),
        steps: rows.map((r) => r.steps),
        junction: rows.map((r) => r.junction ?? false),
        searched: rows.map((r) => !r.junction),
        shown: rows.map((r) => r.shown ?? false),
      },
    )
  const TIPS = tips([
    { id: '100', end: 0, steps: 0, shown: true },
    { id: '201', end: 0, steps: 1, junction: true },
    { id: '201', end: 1, steps: 1, shown: true },
    { id: '201', end: 2, steps: 1, shown: true },
    { id: '201', end: 3, steps: 1, shown: false },
    { id: '301', end: 0, steps: 2, junction: true },
    { id: '301', end: 1, steps: 2, shown: true },
    { id: '301', end: 2, steps: 2, shown: true },
  ])
  const CANDIDATES = candidatesTable([
    { neuron: '100', end: 0, id: '201', rank: 1, l2: 2 },
    { neuron: '201', end: 1, id: '301', rank: 1, l2: 3 },
    { neuron: '201', end: 2, id: '302', rank: 1, l2: 1, organelle: true },
    { neuron: '201', end: 3, id: '303', rank: 1, l2: 1 },
    { neuron: '301', end: 1, id: '401', rank: 1, l2: LARGE_PIECE_CHUNKS + 20 },
    { neuron: '301', end: 2, id: '402', rank: 1, l2: 2 },
  ])
  const all = buildQueue(TIPS, CANDIDATES)
  const PRESSED = { verdicts: '100/201=accept', extend: '100/201', autoRoots: '100/201' }

  it('takes what clears the cutoff, and no organelle or large piece', () => {
    const firsts = autoFirsts(all)
    const piece = (id: string) => ({
      id,
      seed: '100',
      parent: '100',
      depth: 1,
      path: ['100', id],
    })
    expect(firsts(piece('201'))).toEqual(['301'])
    expect(firsts(piece('301'))).toEqual(['402'])
    // Another neuron's rows on the same root are not this piece's.
    expect(firsts({ ...piece('201'), seed: '999' })).toEqual([])
  })

  it('accepts what Auto-extend took, where the reader said nothing', () => {
    const verdicts = reviewedVerdicts(PRESSED, all)
    expect(verdicts.get('201/301')).toBe('accept')
    expect(verdicts.get('301/402')).toBe('accept')
    expect(verdicts.has('201/302')).toBe(false)
    expect(verdicts.has('301/401')).toBe(false)
    // The pieces it took are on the list, and so are their tips.
    const tree = reviewGrowth(all, extendPlanFrom(PRESSED, decodeVerdicts(PRESSED.verdicts)))
    expect(tree.tree.map((piece) => piece.id)).toEqual(['201', '301', '402'])
    expect(liveQueue(all, tree.tree).map((tip) => tip.neuronId)).toContain('301')
  })

  it('accepts nothing where Auto-extend was not pressed, or the piece is not extended', () => {
    expect(reviewedVerdicts({ ...PRESSED, autoRoots: '' }, all).has('201/301')).toBe(false)
    // Pressed, then no longer extended: the press is dead with it.
    expect(reviewedVerdicts({ ...PRESSED, extend: '' }, all).has('201/301')).toBe(false)
    // And un-accepted.
    const rejected = { ...PRESSED, verdicts: '100/201=reject' }
    expect(reviewedVerdicts(rejected, all).has('201/301')).toBe(false)
  })

  it('lets the reader’s verdict win, and drops what lies beyond a refused piece', () => {
    // As the press writes it: the verdict, and the refusal beside it (`judgedParams`).
    const verdicts = reviewedVerdicts(
      { ...PRESSED, verdicts: '100/201=accept;201/301=reject', autoRefused: '201/301' },
      all,
    )
    expect(verdicts.get('201/301')).toBe('reject')
    expect(verdicts.has('301/402')).toBe(false)
  })

  it('tells the search what it was pressed on, and the refusals only while one is live', () => {
    // A refusal is one the press wrote down, and is still the reader's word.
    const stored = decodeVerdicts('100/201=accept;201/301=reject;100/109=reject')
    const params = { ...PRESSED, autoRefused: '201/301;201/303' }
    expect(planTexts(params, stored).refused).toBe('201/301')
    const live = extendPlanFrom(params, stored)
    expect([...live.roots]).toEqual(['201'])
    expect([...live.refused]).toEqual(['201/301'])
    // No press: no refusals on the wire, so a reject re-keys no search.
    const none = extendPlanFrom({ ...params, autoRoots: '' }, stored)
    expect(none.roots.size).toBe(0)
    expect(none.refused.size).toBe(0)
    // A press on a pair that is not extended is not live.
    expect(extendPlanFrom({ ...params, extend: '' }, stored).roots.size).toBe(0)
  })

  it('knows which pairs it could take anywhere in the queue', () => {
    expect([...autoOffered(all)].sort()).toEqual(['100/201', '201/301', '301/402'])
  })

  /** A reject of a pair it could take moves the search's key; a reject of anything else must not. */
  it('writes a refusal down only for a pair it could take, and keeps it with the verdict', () => {
    const at = (neuron: string, end: number) =>
      all.find((tip) => tip.neuronId === neuron && tip.endUid === end)!.candidates[0]!
    const params = { ...PRESSED, autoRefused: '' }
    const offered = judgedParams(params, '201', at('201', 1), 'reject', undefined, true)
    expect(offered.write.autoRefused).toBe('201/301')
    const other = judgedParams(params, '201', at('201', 3), 'reject', undefined, false)
    expect(other.write.autoRefused).toBeUndefined()
    // Taken back, or turned into an accept, the refusal goes with it.
    const refused = { ...params, ...offered.write }
    expect(
      judgedParams(refused, '201', at('201', 1), 'reject', undefined, true).write.autoRefused,
    ).toBe('')
    expect(
      judgedParams(refused, '201', at('201', 1), 'accept', undefined, true).write.autoRefused,
    ).toBe('')
  })

  it('writes down, when pressed, the refusals given before it could take the pair', () => {
    const params = { verdicts: '100/201=accept;201/301=reject;100/109=reject', extend: '' }
    const written = extendParams(params, '100', '201', 'auto', false, autoOffered(all))
    expect(written.autoRefused).toBe('201/301')
    expect(
      extendParams(params, '100', '201', 'extend', false, autoOffered(all)).autoRefused,
    ).toBeUndefined()
  })

  describe('what a press writes', () => {
    it('writes Auto-extend into both lists, and stopping takes it out of both', () => {
      const params = { verdicts: '100/201=accept', extend: '', autoRoots: '' }
      const on = extendParams(params, '100', '201', 'auto', false)
      expect(on).toEqual({ extend: '100/201', autoRoots: '100/201' })
      const plain = extendParams({ ...params, ...on }, '100', '201', 'extend', false)
      expect(plain).toEqual({ extend: '100/201', autoRoots: '' })
      expect(extendParams({ ...params, ...on }, '100', '201', 'off', false)).toEqual({
        extend: '',
        autoRoots: '',
      })
    })

    /** `extend` counts only a pair the reader accepted, so choosing to extend one confirms it. */
    it('confirms a piece Auto-extend took when the reader extends it', () => {
      const written = extendParams(PRESSED, '201', '301', 'extend', true)
      expect(decodeVerdicts(written.verdicts).get('201/301')).toBe('accept')
      expect(written.extend).toBe('100/201;201/301')
    })

    it('takes the press away with the accept it was pressed on', () => {
      const piece = all.find((tip) => tip.neuronId === '100')!.candidates[0]!
      const { write } = judgedParams(PRESSED, '100', piece, 'reject', undefined)
      expect(write.extend).toBe('')
      expect(write.autoRoots).toBe('')
    })
  })

  describe('the Extend button', () => {
    const piece = all.find((tip) => tip.neuronId === '201' && tip.endUid === 1)!.candidates[0]!
    const base = {
      candidate: piece,
      blocked: undefined,
      extendOnAccept: false,
      goesWith: '',
      held: false,
      heldBy: undefined,
      took: 0,
    }

    it('says how far a piece Auto-extend searches has got, and cannot be pressed', () => {
      const face = extendPress({
        ...base,
        progress: { state: 'searched', ends: 2 },
        choice: 'off',
        held: true,
        heldBy: '201',
      })
      expect(face).toMatchObject({ label: '2 ends searched', disabled: true })
      expect(face.title).toMatch(/Auto-extend on 201/)
    })

    it('says what a press on its face writes: Extend, or stopping what the reader chose', () => {
      expect(extendPress({ ...base, progress: undefined, choice: 'off' }).writes).toBe('extend')
      const searched = { state: 'searched', ends: 1 } as const
      expect(extendPress({ ...base, progress: searched, choice: 'extend' }).writes).toBe('off')
      expect(extendPress({ ...base, progress: searched, choice: 'auto' }).writes).toBe('off')
    })

    it('offers Extend on a piece of its last layer, which it did not search', () => {
      const face = extendPress({ ...base, progress: undefined, choice: 'off', heldBy: '201' })
      expect(face).toMatchObject({ label: 'Extend', disabled: false })
      expect(face.title).toMatch(/last layer/)
    })

    it('marks the piece it was pressed on, and counts what it took', () => {
      const face = extendPress({
        ...base,
        progress: { state: 'searched', ends: 2 },
        choice: 'auto',
        took: 2,
      })
      expect(face.label).toBe('auto · 2 ends searched')
      expect(face.title).toMatch(/2 pieces so far/)
    })

    it('ticks the reader’s choice, whose press stops it', () => {
      const menu = extendMenu({
        choice: 'auto',
        blocked: undefined,
        held: false,
        noAuto: undefined,
      })
      expect(menu.map((item) => [item.value, item.disabled, item.writes])).toEqual([
        ['extend', false, 'extend'],
        ['auto', false, 'off'],
      ])
      expect(menu[1]!.title).toMatch(/Stop extending/)
    })

    it('offers no Auto-extend where the tables have no cutoff', () => {
      // `tipsTable` carries `shown`; a table without it is a search with no assessor.
      expect(autoUnavailable(tipsTable([{ end: 1 }]))).toBeUndefined()
      const bare = makeTable(tableSchema(column('end_uid', 'i64')), { end_uid: [1] })
      const noAuto = autoUnavailable(bare)
      expect(noAuto).toMatch(/Assessor/)
      const menu = extendMenu({ choice: 'off', blocked: undefined, held: false, noAuto })
      expect(menu[1]).toMatchObject({ disabled: true, title: noAuto })
      expect(menu[0]!.disabled).toBe(false)
    })
  })
})

describe('Auto-extend: what is the reader\u2019s and what is not', () => {
  it('counts an Auto-extend accept only where the reader has said nothing', () => {
    const stored = decodeVerdicts('1/2=accept;2/3=reject')
    const accepted = new Map([
      ['2/3', '2'],
      ['2/4', '2'],
    ])
    const { verdicts, unjudged } = autoJudged(stored, accepted)
    expect(verdicts.get('2/3')).toBe('reject')
    expect(verdicts.get('2/4')).toBe('accept')
    expect([...unjudged]).toEqual([['2/4', '2']])
    // Nothing taken: the reader's own map, untouched.
    expect(autoJudged(stored, new Map()).verdicts).toBe(stored)
  })

  describe('a row of the list', () => {
    const at = {
      extended: new Set(['1/2', '2/3']),
      autoPressed: new Set(['2/3']),
      accepted: new Map([
        ['3/4', '3'],
        ['4/5', '3'],
      ]),
      unjudged: new Map([
        ['3/4', '3'],
        ['4/5', '3'],
      ]),
      searched: new Set(['2', '3', '4']),
    }

    it('says how the reader extended it', () => {
      expect(rowExtend('1/2', at)).toMatchObject({
        choice: 'extend',
        held: false,
        extended: true,
      })
      expect(rowExtend('2/3', at)).toMatchObject({ choice: 'auto', extended: true })
      expect(rowExtend('9/9', at)).toMatchObject({ choice: 'off', extended: false })
    })

    it('is held by the press that took and searches it', () => {
      expect(rowExtend('3/4', at)).toEqual({
        choice: 'off',
        autoFrom: '3',
        heldBy: '3',
        held: true,
        extended: true,
      })
    })

    /** The reader's Accept makes the verdict theirs; the search goes on searching the piece. */
    it('stays held once the reader accepts it, and loses only its tag', () => {
      const judged = { ...at, unjudged: new Map([['4/5', '3']]) }
      expect(rowExtend('3/4', judged)).toEqual({
        choice: 'off',
        autoFrom: undefined,
        heldBy: '3',
        held: true,
        extended: true,
      })
    })

    /** Its last layer: taken, not searched — the reader may extend it. */
    it('is not held where Auto-extend took it and did not search it', () => {
      expect(rowExtend('4/5', at)).toEqual({
        choice: 'off',
        autoFrom: '3',
        heldBy: '3',
        held: false,
        extended: false,
      })
    })
  })
})
