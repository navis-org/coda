/**
 * The table layer around the search: which rows can be searched at all, the ranked lists as
 * one `Candidates` table, and the first candidate written back onto its tip.
 *
 * The search itself is not here — `searchRun.test.ts` holds its order over fakes, and
 * `pnpm probe:candidate-search` holds its answers against SEAM's own published list for a real
 * end. What this file covers is everything between a `TableValue` and those two, which is where
 * a row can go to the wrong neuron without anything failing.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import { column, tableSchema } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import type { SearchedEnd } from './searchRun'
import {
  SEARCH_TIP_FIELDS,
  candidatesTable,
  tipsByNeuron,
  tipsFromTable,
  tipsSchema,
  tipsWithFirsts,
} from './searchTips'
import { OPEN_END_FIELDS } from './openEndsOps'
import { published, schemaOf } from './suggestionTables'

/**
 * A tips table as `seam:openEnds` publishes one, plus any column a case names.
 *
 * The extra keys are how the cases that stand in for a `seam:suggestions` table are written —
 * that one carries a first candidate of its own, which this node has to clear.
 */
function tipsTable(rows: readonly Partial<Record<string, CellValue>>[]): TableValue {
  const extra = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(
    (name) => !published(OPEN_END_FIELDS).some((one) => one.name === name),
  )
  const schema = tableSchema(
    ...schemaOf(OPEN_END_FIELDS).columns,
    ...extra.map((name) => column(name, name === 'candidateId' ? 'str' : 'f64')),
  )
  const data: Record<string, CellValue[]> = {}
  for (const col of schema.columns) {
    data[col.name] = rows.map((row) => row[col.name] ?? null)
  }
  return makeTable(schema, data, 'table', rows.length)
}

function end(at: number, candidates: readonly { root: string; dist: number }[]): SearchedEnd {
  return {
    tip: at,
    rows: candidates.length,
    candRoot: BigUint64Array.from(candidates, (c) => BigInt(c.root)),
    columns: {
      geo_rank: Float64Array.from(candidates, (_, i) => i + 1),
      min_dist_um: Float64Array.from(candidates, (c) => c.dist),
      vol_um3: Float64Array.from(candidates, () => 0.5),
      contact_x_nm: Float64Array.from(candidates, () => 100),
      contact_y_nm: Float64Array.from(candidates, () => 200),
      contact_z_nm: Float64Array.from(candidates, () => 300),
    },
    missingQuery: false,
    pooled: candidates.length,
    tooFar: 0,
    anothersTip: 0,
  }
}

describe('reading a Tips table', () => {
  it('refuses a table missing a column the search needs, by name', () => {
    const schema = tableSchema(column(ID_COLUMN_NAME, 'str'), column('end_uid', 'i64'))
    const table = makeTable(schema, { [ID_COLUMN_NAME]: ['1'], end_uid: [0] })
    expect(() => tipsFromTable(table)).toThrow(/`x`, `y`, `z`/)
  })

  it('drops a row with no position and says how many', () => {
    const { rows, dropped } = tipsFromTable(
      tipsTable([
        { [ID_COLUMN_NAME]: '720', end_uid: 0, x: 1, y: 2, z: 3 },
        { [ID_COLUMN_NAME]: '720', end_uid: 1, x: null, y: 2, z: 3 },
        { [ID_COLUMN_NAME]: '', end_uid: 2, x: 4, y: 5, z: 6 },
      ]),
    )
    expect(rows).toHaveLength(1)
    expect(dropped).toBe(2)
    // `row` is the table's own row number, not the position in this list — see `TipRow`.
    expect(rows[0]).toEqual({ neuronId: '720', endUid: 0, nm: [1, 2, 3], row: 0 })
  })

  /**
   * `idText` answers "is this a sound id", and a neuron *name* is one — `LC4` is a perfectly
   * good id in a neuPrint table. The search needs a chunkedgraph root, which `BigInt` parses,
   * and a name reaches that as a raw `SyntaxError` after the forest and the volume have been
   * fetched. So the narrower grammar applies here, where the row can still be counted.
   */
  it('drops a neuron that is not a chunkedgraph id', () => {
    const { rows, dropped } = tipsFromTable(
      tipsTable([
        { [ID_COLUMN_NAME]: 'LC4', end_uid: 0, x: 1, y: 2, z: 3 },
        { [ID_COLUMN_NAME]: '720', end_uid: 1, x: 1, y: 2, z: 3 },
      ]),
    )
    expect(rows.map((row) => row.neuronId)).toEqual(['720'])
    expect(dropped).toBe(1)
  })

  /**
   * `end_uid` is this tip's identity downstream — `reviewQueue` merges a tip with its candidate
   * list on `(neuron, end_uid)` alone — so a row index standing in for a missing one can collide
   * with another row's real `end_uid` and silently merge two tips' lists.
   */
  it('drops a row with no end_uid rather than numbering it by position', () => {
    const { rows, dropped } = tipsFromTable(
      tipsTable([
        { [ID_COLUMN_NAME]: '720', end_uid: null, x: 1, y: 2, z: 3 },
        { [ID_COLUMN_NAME]: '720', end_uid: 0, x: 1, y: 2, z: 3 },
      ]),
    )
    expect(rows.map((row) => row.endUid)).toEqual([0])
    expect(dropped).toBe(1)
  })

  it('groups by neuron in the order the table lists them', () => {
    const { rows } = tipsFromTable(
      tipsTable([
        { [ID_COLUMN_NAME]: '900', end_uid: 0, x: 0, y: 0, z: 0 },
        { [ID_COLUMN_NAME]: '800', end_uid: 1, x: 0, y: 0, z: 0 },
        { [ID_COLUMN_NAME]: '900', end_uid: 2, x: 0, y: 0, z: 0 },
      ]),
    )
    expect([...tipsByNeuron(rows)]).toEqual([
      ['900', [0, 2]],
      ['800', [1]],
    ])
  })
})

describe('the Candidates table', () => {
  it('numbers each end from one and carries the tip it belongs to', () => {
    const { rows } = tipsFromTable(
      tipsTable([
        { [ID_COLUMN_NAME]: '720', end_uid: 7, x: 0, y: 0, z: 0 },
        { [ID_COLUMN_NAME]: '721', end_uid: 7, x: 0, y: 0, z: 0 },
      ]),
    )
    const table = candidatesTable(
      [
        end(0, [
          { root: '100', dist: 0.1 },
          { root: '101', dist: 0.2 },
        ]),
        end(1, [{ root: '200', dist: 0.3 }]),
      ],
      rows,
    )
    expect(table.data[ID_COLUMN_NAME]).toEqual(['720', '720', '721'])
    // `end_uid` repeats across neurons on purpose here: it is only unique within one.
    expect(table.data['end_uid']).toEqual([7, 7, 7])
    expect(table.data['candidateId']).toEqual(['100', '101', '200'])
    expect(table.data['rank']).toEqual([1, 2, 1])
    expect(table.data['geo_rank']).toEqual([1, 2, 1])
    expect(table.data['min_dist_um']).toEqual([0.1, 0.2, 0.3])
  })

  /**
   * **Absent, not null.** An earlier draft published `seam:suggestions`' full shape with eleven
   * nulls so the two tables matched column for column; that coupling is gone, because the node
   * it was matching is modelled on an earlier SEAM pipeline and is going to move. A picker
   * offered `p_cand` on a node that can never fill it is worse than not being offered it.
   */
  it('carries no column the search cannot answer', () => {
    const { rows } = tipsFromTable(
      tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0 }]),
    )
    const table = candidatesTable([end(0, [{ root: '100', dist: 0.1 }])], rows)
    for (const name of ['p_cand', 'conf', 'logit', 'score_s0', 'filled', 'shown']) {
      expect(table.data[name], name).toBeUndefined()
    }
  })

  it('is empty, and still the published shape, when nothing was searched', () => {
    const table = candidatesTable([], [])
    expect(table.data[ID_COLUMN_NAME]).toEqual([])
    expect(table.schema.columns.map((c) => c.name)).toEqual([
      ID_COLUMN_NAME,
      'end_uid',
      'candidateId',
      'rank',
      'geo_rank',
      'vol_um3',
      'min_dist_um',
      'contact_x',
      'contact_y',
      'contact_z',
    ])
  })
})

describe('the first candidate on the tip row', () => {
  it('writes onto the row the tip came from, not the row at its index', () => {
    /*
     * The regression this is for: `tipsFromTable` drops rows, so the second *searchable* tip is
     * the third row of the table. Keyed by index, its candidate would land on row 1 — a
     * plausible id and distance on a tip nobody searched, and nothing downstream could tell.
     */
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0 },
      { [ID_COLUMN_NAME]: '720', end_uid: 1, x: null, y: 0, z: 0 },
      { [ID_COLUMN_NAME]: '720', end_uid: 2, x: 0, y: 0, z: 0 },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [end(1, [{ root: '999', dist: 0.4 }])], rows)
    expect(out.data['candidateId']).toEqual([null, null, '999'])
    expect(out.data['min_dist_um']).toEqual([null, null, 0.4])
  })

  it('does not take another neuron’s row with the same end_uid', () => {
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '800', end_uid: 4, x: 0, y: 0, z: 0 },
      { [ID_COLUMN_NAME]: '900', end_uid: 4, x: 0, y: 0, z: 0 },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [end(1, [{ root: '55', dist: 0.2 }])], rows)
    expect(out.data['candidateId']).toEqual([null, '55'])
  })

  it('leaves a tip it did not search exactly as it arrived', () => {
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '800', end_uid: 0, x: 0, y: 0, z: 0, e_tip: 0.8 },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [], rows)
    expect(out.data['e_tip']).toEqual([0.8])
  })

  /**
   * A `Tips` table from `seam:suggestions` already carries a first candidate, and that one
   * belongs to another run. Left in place beside this node's own `Candidates`, the tip would
   * name a `candidateId` with no row in the published list — the one inconsistency
   * `seam:review` cannot see, since it reads the two tables separately.
   */
  it('clears an incoming first candidate from a tip it searched and found nothing at', () => {
    const table = tipsTable([
      {
        [ID_COLUMN_NAME]: '800',
        end_uid: 0,
        x: 0,
        y: 0,
        z: 0,
        candidateId: '111',
        min_dist_um: 9,
      },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [end(0, [])], rows)
    expect(out.data['candidateId']).toEqual([null])
    expect(out.data['min_dist_um']).toEqual([null])
  })

  /**
   * `p_top` is the first candidate's calibrated confidence, which this node cannot compute. An
   * incoming one is another run's, and left in place it would sit beside this run's own
   * `candidateId` as if it described it.
   */
  it('clears `p_top` as well, which no column of the search fills', () => {
    const table = tipsTable([
      {
        [ID_COLUMN_NAME]: '800',
        end_uid: 0,
        x: 0,
        y: 0,
        z: 0,
        p_top: 0.97,
        candidateId: '111',
      },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [end(0, [{ root: '55', dist: 0.2 }])], rows)
    expect(out.data['candidateId']).toEqual(['55'])
    expect(out.data['p_top']).toEqual([null])
  })

  /**
   * Every one of these is the *previous* run's reading of the *previous* run's first candidate.
   * Left in place beside this node's own `candidateId`, `seam:review` would sort on `r`, filter
   * on `shown` and show `p_top` as if they described it.
   */
  it('clears every calibrated column an earlier run left on the tip', () => {
    const table = tipsTable([
      {
        [ID_COLUMN_NAME]: '800',
        end_uid: 0,
        x: 0,
        y: 0,
        z: 0,
        candidateId: '111',
        p_top: 0.97,
        q: 0.8,
        r: 0.9,
        shown: 1,
      },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [end(0, [{ root: '55', dist: 0.2 }])], rows)
    expect(out.data['candidateId']).toEqual(['55'])
    for (const name of ['p_top', 'q', 'r', 'shown']) {
      expect(out.data[name], name).toEqual([null])
    }
  })

  it('writes the contact under the tip’s own column names', () => {
    const table = tipsTable([{ [ID_COLUMN_NAME]: '800', end_uid: 0, x: 0, y: 0, z: 0 }])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [end(0, [{ root: '1', dist: 0.1 }])], rows)
    expect(out.data['contact_x']).toEqual([100])
    expect(out.data['contact_y']).toEqual([200])
    expect(out.data['contact_z']).toEqual([300])
    expect(out.data['vol_um3']).toEqual([0.5])
  })
})

describe('the published tips schema', () => {
  it('keeps a column the incoming table brought, in its own place', () => {
    const incoming = tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('mine', 'f64'),
      column('end_uid', 'i64'),
    )
    const schema = tipsSchema(incoming)
    expect(schema.columns.map((c) => c.name).slice(0, 3)).toEqual([
      ID_COLUMN_NAME,
      'mine',
      'end_uid',
    ])
    expect(schema.columns.map((c) => c.name)).toContain('candidateId')
  })

  it('is the columns it folds on, when nothing is wired', () => {
    expect(tipsSchema(undefined)).toEqual(schemaOf(SEARCH_TIP_FIELDS))
  })
})
