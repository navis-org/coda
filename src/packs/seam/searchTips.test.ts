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
import type { LoadedManifest, ModelManifest } from '../../ml/manifest'
import { makeTable } from '../../core/values'
import {
  ASSESSED_CANDIDATE_FIELDS,
  ASSESSED_TIP_FIELDS,
  candidatesTable,
  LINEAGE_FIELDS,
  ORGANELLE_CUT,
  modelVersion,
  runSource,
  searchOnly,
  tipFields,
  tipsByNeuron,
  tipsFromTable,
  tipsSchema,
  tipsWithFirsts,
} from './searchTips'
import type { PublishedEnd } from './searchTips'
import { OPEN_END_FIELDS } from './openEndsOps'
import { published, schemaOf } from './suggestionTables'
import type { Piece } from './pieces'
import { pieceLineage } from './pieces'
import { concatBatches } from '../../nodes/lib/tableOps'

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
    ...extra.map((name) =>
      column(name, ['candidateId', 'source', 'tip_sv'].includes(name) ? 'str' : 'f64'),
    ),
  )
  const data: Record<string, CellValue[]> = {}
  for (const col of schema.columns) {
    data[col.name] = rows.map((row) => row[col.name] ?? null)
  }
  return makeTable(schema, data, 'table', rows.length)
}

function end(at: number, candidates: readonly { root: string; dist: number }[]): PublishedEnd {
  return searchOnly({
    tip: at,
    // Told apart from every root, so a column written from the wrong array shows.
    tipSupervoxel: 73889314911551000n + BigInt(at),
    rows: candidates.length,
    candRoot: BigUint64Array.from(candidates, (c) => BigInt(c.root)),
    repSupervoxel: BigUint64Array.from(candidates, (c) => 73889314911551000n + BigInt(c.root)),
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
  })
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
      false,
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
    const table = candidatesTable([end(0, [{ root: '100', dist: 0.1 }])], rows, false)
    for (const name of ['p_cand', 'conf', 'logit', 'score_s0', 'filled', 'shown']) {
      expect(table.data[name], name).toBeUndefined()
    }
  })

  it('is empty, and still the published shape, when nothing was searched', () => {
    const table = candidatesTable([], [], false)
    expect(table.data[ID_COLUMN_NAME]).toEqual([])
    expect(table.schema.columns.map((c) => c.name)).toEqual([
      ID_COLUMN_NAME,
      'seed',
      'end_uid',
      'candidateId',
      'cand_sv',
      'rank',
      'geo_rank',
      'vol_um3',
      'n_l2',
      'min_dist_um',
      'contact_x',
      'contact_y',
      'contact_z',
      'organelle_score',
      'organelle',
    ])
  })
})

/**
 * "Every row this run means to search", which is what a test that is not about the `searched`
 * column wants to say. The column's own three states have their own cases below.
 */
function attempted(rows: readonly { row: number }[]): ReadonlySet<number> {
  return new Set(rows.map((one) => one.row))
}

/**
 * The two supervoxels a review card follows a split by (`docs/seam-split-review-plan.md`): a
 * split never changes a supervoxel, so each one's root afterwards says which part it went with.
 */
describe('the supervoxels a split is followed by', () => {
  it('writes each candidate’s own contact supervoxel, as exact text, from its own row', () => {
    const { rows } = tipsFromTable(
      tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 7, x: 0, y: 0, z: 0 }]),
    )
    const table = candidatesTable(
      [
        end(0, [
          { root: '100', dist: 0.1 },
          { root: '101', dist: 0.2 },
        ]),
      ],
      rows,
      false,
    )
    // `end` puts each candidate's contact supervoxel at 73889314911551000 plus its root: 18
    // digits, which a float64 on the way would round.
    expect(table.data['cand_sv']).toEqual(['73889314911551100', '73889314911551101'])
    expect(table.schema.columns.find((c) => c.name === 'cand_sv')?.dtype).toBe('str')
  })

  it('writes the tip’s own supervoxel on the row it searched, and only there', () => {
    const table = tipsTable([
      // Another run's anchor on a row this one does not reach: not this run's measurement.
      { [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0, tip_sv: '5' },
      { [ID_COLUMN_NAME]: '720', end_uid: 1, x: 0, y: 0, z: 0 },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [end(1, [])], rows, false, attempted(rows))
    expect(out.data['tip_sv']).toEqual([null, String(73889314911551000n + 1n)])
    // Not the first candidate's: the tip row carries no contact supervoxel.
    expect(out.schema.columns.map((c) => c.name)).not.toContain('cand_sv')
  })

  it('writes null where no voxel of the neuron lay near the tip', () => {
    const table = tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0 }])
    const { rows } = tipsFromTable(table)
    const one = end(0, [])
    const out = tipsWithFirsts(
      table,
      [{ ...one, end: { ...one.end, tipSupervoxel: undefined } }],
      rows,
      false,
      attempted(rows),
    )
    expect(out.data['tip_sv']).toEqual([null])
  })

  it('writes this run’s over a tip supervoxel the incoming table carried', () => {
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0, tip_sv: '5' },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [end(0, [])], rows, false, attempted(rows))
    expect(out.data['tip_sv']).toEqual([String(73889314911551000n)])
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
    const out = tipsWithFirsts(
      table,
      [end(1, [{ root: '999', dist: 0.4 }])],
      rows,
      false,
      attempted(rows),
    )
    expect(out.data['candidateId']).toEqual([null, null, '999'])
    expect(out.data['min_dist_um']).toEqual([null, null, 0.4])
  })

  it('does not take another neuron’s row with the same end_uid', () => {
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '800', end_uid: 4, x: 0, y: 0, z: 0 },
      { [ID_COLUMN_NAME]: '900', end_uid: 4, x: 0, y: 0, z: 0 },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(
      table,
      [end(1, [{ root: '55', dist: 0.2 }])],
      rows,
      false,
      attempted(rows),
    )
    expect(out.data['candidateId']).toEqual([null, '55'])
  })

  it('leaves a tip it did not search exactly as it arrived', () => {
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '800', end_uid: 0, x: 0, y: 0, z: 0, e_tip: 0.8 },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [], rows, false, attempted(rows))
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
    const out = tipsWithFirsts(table, [end(0, [])], rows, false, attempted(rows))
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
    const out = tipsWithFirsts(
      table,
      [end(0, [{ root: '55', dist: 0.2 }])],
      rows,
      false,
      attempted(rows),
    )
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
    const out = tipsWithFirsts(
      table,
      [end(0, [{ root: '55', dist: 0.2 }])],
      rows,
      false,
      attempted(rows),
    )
    expect(out.data['candidateId']).toEqual(['55'])
    for (const name of ['p_top', 'q', 'r', 'shown']) {
      expect(out.data[name], name).toEqual([null])
    }
  })

  it('writes the contact under the tip’s own column names', () => {
    const table = tipsTable([{ [ID_COLUMN_NAME]: '800', end_uid: 0, x: 0, y: 0, z: 0 }])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(
      table,
      [end(0, [{ root: '1', dist: 0.1 }])],
      rows,
      false,
      attempted(rows),
    )
    expect(out.data['contact_x']).toEqual([100])
    expect(out.data['contact_y']).toEqual([200])
    expect(out.data['contact_z']).toEqual([300])
    expect(out.data['vol_um3']).toEqual([0.5])
  })
})

describe('which fits a searched tip’s numbers come from', () => {
  const read = (id: string, digest: string): LoadedManifest => ({
    manifest: { id } as ModelManifest,
    url: `https://example.invalid/${id}/manifest.json`,
    digest,
  })
  const RANKER = read('trees_sizes_tip', 'd0da2c7b5fe6a1b2c3d4e5f6')
  const ASSESSOR = read('n3_mal_mask_s0', 'c1a615400751a1b2c3d4e5f6')

  it('names the ranker and the assessor by id and the start of their manifests’ digests', () => {
    expect(runSource(RANKER, ASSESSOR)).toBe(
      'model:trees_sizes_tip@d0da2c7b5fe6/n3_mal_mask_s0@c1a615400751',
    )
    expect(runSource(RANKER, undefined)).toBe('model:trees_sizes_tip@d0da2c7b5fe6/none')
  })

  it('keys a model by its whole digest, so a refit under the same id is another model', () => {
    expect(modelVersion(RANKER)).toBe('trees_sizes_tip@d0da2c7b5fe6a1b2c3d4e5f6')
    expect(modelVersion(read('trees_sizes_tip', 'ffff'))).not.toBe(modelVersion(RANKER))
  })

  it('publishes the column whether or not an assessor ran', () => {
    for (const assessed of [false, true]) {
      expect(tipFields(assessed).map((one) => one.name)).toContain('source')
    }
  })

  /**
   * A `Tips` table from `seam:suggestions` arrives labelled with its set. A row this run searched
   * now carries this run's numbers, so it carries this run's label; a row it did not search still
   * carries the set's numbers, so it keeps the set's.
   */
  it('labels the rows it searched with its own, and leaves the set’s on the rest', () => {
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '800', end_uid: 0, x: 0, y: 0, z: 0, source: 'set:rv4-ad75ed161bb6' },
      { [ID_COLUMN_NAME]: '800', end_uid: 1, x: 0, y: 0, z: 0, source: 'set:rv4-ad75ed161bb6' },
    ])
    const { rows } = tipsFromTable(table)
    const label = runSource(RANKER, ASSESSOR)
    const out = tipsWithFirsts(
      table,
      [end(0, [{ root: '55', dist: 0.2 }])],
      rows,
      false,
      attempted(rows),
      [],
      label,
    )
    expect(out.data['source']).toEqual([label, 'set:rv4-ad75ed161bb6'])
  })

  it('labels a searched row null where the caller does not say, so nothing sends it', () => {
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '800', end_uid: 0, x: 0, y: 0, z: 0, source: 'set:rv4-ad75ed161bb6' },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [end(0, [])], rows, false, attempted(rows))
    expect(out.data['source']).toEqual([null])
  })
})

describe('the published tips schema', () => {
  it('keeps a column the incoming table brought, in its own place', () => {
    const incoming = tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('mine', 'f64'),
      column('end_uid', 'i64'),
    )
    const schema = tipsSchema(incoming, false)
    expect(schema.columns.map((c) => c.name).slice(0, 3)).toEqual([
      ID_COLUMN_NAME,
      'mine',
      'end_uid',
    ])
    expect(schema.columns.map((c) => c.name)).toContain('candidateId')
  })

  it('is the columns it folds on, when nothing is wired', () => {
    // `tipFields`, not `SEARCH_TIP_FIELDS`: the published shape is the candidate's columns plus
    // `searched`, which is about the run rather than about any candidate — and then the lineage,
    // which says where a tip sits in a neuron being extended.
    expect(tipsSchema(undefined, false)).toEqual(
      schemaOf([...tipFields(false), ...LINEAGE_FIELDS]),
    )
  })

  it('does not take `seed` for a measurement of the first candidate', () => {
    // It is on the candidate row and on the tip row, and it is the tip's own on both. Derived
    // into the first-candidate columns it would be cleared on every searched tip.
    const table = tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 1, y: 2, z: 3 }])
    const out = tipsWithFirsts(
      table,
      [end(0, [{ root: '900', dist: 0.1 }])],
      tipsFromTable(table).rows,
      false,
      new Set([0]),
    )
    expect(out.data['seed']).toEqual(['720'])
    expect(out.data['candidateId']).toEqual(['900'])
  })

  it('makes every tip of a neuron nobody has extended its own seed', () => {
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '720', end_uid: 0, x: 1, y: 2, z: 3 },
      { [ID_COLUMN_NAME]: '730', end_uid: 0, x: 4, y: 5, z: 6 },
      // A row that cannot be searched is still a row of its neuron.
      { [ID_COLUMN_NAME]: '730', end_uid: 1 },
    ])
    const out = tipsWithFirsts(table, [], tipsFromTable(table).rows, false, new Set([0, 1]))
    expect(out.data['seed']).toEqual(['720', '730', '730'])
    expect(out.data['accepted_on']).toEqual([null, null, null])
    expect(out.data['steps']).toEqual([0, 0, 0])
    expect(out.data['junction']).toEqual([false, false, false])
  })

  it('writes a piece’s rows as the lineage says, on the piece’s own root', () => {
    const piece: Piece = {
      id: '801',
      seed: '720',
      parent: '720',
      depth: 1,
      path: ['720', '801'],
    }
    const seed = tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 1, y: 2, z: 3 }])
    const own = tipsTable([
      { [ID_COLUMN_NAME]: '801', end_uid: 0, x: 7, y: 8, z: 9 },
      { [ID_COLUMN_NAME]: '801', end_uid: 1, x: 7, y: 8, z: 10 },
    ])
    const table = concatBatches([seed, own])
    const lineage = [undefined, ...pieceLineage(piece, 2, 1)]
    const out = tipsWithFirsts(
      table,
      [],
      tipsFromTable(table).rows,
      false,
      new Set([0, 1]),
      lineage,
    )
    expect(out.data[ID_COLUMN_NAME]).toEqual(['720', '801', '801'])
    expect(out.data['seed']).toEqual(['720', '720', '720'])
    expect(out.data['accepted_on']).toEqual([null, '720', '720'])
    expect(out.data['steps']).toEqual([0, 1, 1])
    expect(out.data['junction']).toEqual([false, false, true])
    // The end it joins by is not among the rows attempted, so it reads "will not be searched".
    expect(out.data['searched']).toEqual([null, null, false])
  })

  it('does not write over a reader’s own `parent` or `depth`', () => {
    // Names a reader may well have joined onto the tips above this node — a skeleton's parent
    // node, a depth in the arbour. The lineage is published under names that are not those.
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '720', end_uid: 0, x: 1, y: 2, z: 3, parent: 41, depth: 7 },
    ])
    const out = tipsWithFirsts(table, [], tipsFromTable(table).rows, false, new Set([0]))
    expect(out.data['parent']).toEqual([41])
    expect(out.data['depth']).toEqual([7])
    expect(out.data['steps']).toEqual([0])
  })

  it('writes the lineage over one a table brought with it, where that column already sat', () => {
    // This node's own output fed back round: another run's statement about another tree.
    const fed = tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 1, y: 2, z: 3, seed: 5 }])
    const out = tipsWithFirsts(fed, [], tipsFromTable(fed).rows, false, new Set([0]))
    expect(out.data['seed']).toEqual(['720'])
    expect(out.schema.columns.map((one) => one.name).indexOf('seed')).toBe(
      fed.schema.columns.map((one) => one.name).indexOf('seed'),
    )
  })

  /**
   * Invariant 3, for the composition the node actually makes. `inferOutputs` promises
   * `tipsSchema(incoming)` to every picker below before anything has run; the run publishes
   * `tipsWithFirsts` over the incoming table with the pieces' rows added. For a round the
   * lineage was written by a second function ahead of the fold, and the four columns came out
   * *before* the first candidate's where the schema promised them after — same names, another
   * order, and nothing compared the two.
   */
  it.each([false, true])(
    'publishes the shape it promised, pieces or none (assessed: %s)',
    (assessed) => {
      const piece: Piece = {
        id: '801',
        seed: '720',
        parent: '720',
        depth: 1,
        path: ['720', '801'],
      }
      const incoming = tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 1, y: 2, z: 3 }])
      const promised = tipsSchema(incoming.schema, assessed)

      const alone = tipsWithFirsts(
        incoming,
        [],
        tipsFromTable(incoming).rows,
        assessed,
        new Set([0]),
      )
      expect(alone.schema).toEqual(promised)
      expect(Object.keys(alone.data)).toEqual(promised.columns.map((one) => one.name))

      const own = tipsTable([{ [ID_COLUMN_NAME]: '801', end_uid: 0, x: 7, y: 8, z: 9 }])
      const grown = concatBatches([incoming, own])
      const withPiece = tipsWithFirsts(
        grown,
        [end(1, [{ root: '900', dist: 0.1 }])],
        tipsFromTable(grown).rows,
        assessed,
        new Set([0, 1]),
        [undefined, ...pieceLineage(piece, 1, undefined)],
      )
      expect(withPiece.schema).toEqual(promised)
      expect(Object.keys(withPiece.data)).toEqual(promised.columns.map((one) => one.name))
      for (const cells of Object.values(withPiece.data)) expect(cells).toHaveLength(2)
    },
  )

  it('says which neuron a candidate’s tip belongs to, which is not always the root it is on', () => {
    // A piece's tip: on the piece's own root, in the neuron being extended.
    const tips = [
      { neuronId: '720', endUid: 0, nm: [0, 0, 0] as const, eTip: undefined, row: 0 },
      {
        neuronId: '801',
        endUid: 0,
        nm: [9, 9, 9] as const,
        eTip: undefined,
        row: 1,
        seed: '720',
      },
    ]
    const table = candidatesTable(
      [end(0, [{ root: '900', dist: 0.1 }]), end(1, [{ root: '901', dist: 0.2 }])],
      tips,
      false,
    )
    expect(table.data[ID_COLUMN_NAME]).toEqual(['720', '801'])
    expect(table.data['seed']).toEqual(['720', '720'])
  })
})

/**
 * The two tables when an assessor ran.
 *
 * The shape, not the arithmetic — `singleSeed.test.ts` holds that against SEAM's own numbers.
 * What can go wrong here is a column promised and not written, a row published in the search's
 * order under a `rank` that is the assessor's, or a tip left looking unsearched.
 */
describe('an assessed run', () => {
  const scored = (one: PublishedEnd, order: readonly number[]): PublishedEnd => ({
    ...one,
    order: Int32Array.from(order),
    scores: {
      columns: {
        score_s0: Float64Array.from(order, (_, i) => i),
        logit: Float64Array.from(order, (_, i) => i),
        p_cand: Float64Array.from(order, () => 0.5),
        conf: Float64Array.from(order, () => 0.25),
      },
      filled: order.map(() => '' as const),
      tip: {
        segclr: 1.5,
        p_tip: 0.4,
        p_top: 0.9,
        q: 0.36,
        r: 0.8,
        shown: true,
      },
    },
  })

  it('publishes the stage-6 columns beside the search’s, and only when asked', () => {
    const { rows } = tipsFromTable(
      tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0 }]),
    )
    const one = scored(
      end(0, [
        { root: '100', dist: 0.1 },
        { root: '101', dist: 0.2 },
      ]),
      [1, 0],
    )
    const assessed = candidatesTable([one], rows, true)
    // `[1, 0]`, because the rows go out in `order` and `score_s0` is in the list's own order —
    // the one place the two orders have to be kept apart, which is why it is checked here.
    expect(assessed.data['score_s0']).toEqual([1, 0])
    expect(assessed.data['conf']).toEqual([0.25, 0.25])
    expect(assessed.data['filled']).toEqual(['', ''])
    expect(candidatesTable([one], rows, false).data['p_cand']).toBeUndefined()
  })

  /**
   * **The row order is `order`'s and `rank` counts along it, while `geo_rank` stays the
   * forest's.** A `rank` that counted the list's own index would number the published rows
   * 2, 1 — believable, and read by `seam:review` as the queue's order.
   */
  it('numbers the rows by the order it publishes them in', () => {
    const { rows } = tipsFromTable(
      tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0 }]),
    )
    const table = candidatesTable(
      [
        scored(
          end(0, [
            { root: '100', dist: 0.1 },
            { root: '101', dist: 0.2 },
          ]),
          [1, 0],
        ),
      ],
      rows,
      true,
    )
    expect(table.data['candidateId']).toEqual(['101', '100'])
    expect(table.data['rank']).toEqual([1, 2])
    expect(table.data['geo_rank']).toEqual([2, 1])
  })

  it('folds the tip’s own numbers onto its row, under SEAM’s names', () => {
    const table = tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0 }])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(
      table,
      [scored(end(0, [{ root: '55', dist: 0.2 }]), [0])],
      rows,
      true,
      attempted(rows),
    )
    expect(out.data['p_tip']).toEqual([0.4])
    expect(out.data['q']).toEqual([0.36])
    expect(out.data['r']).toEqual([0.8])
    expect(out.data['shown']).toEqual([true])
    expect(out.data['candidateId']).toEqual(['55'])
  })

  /**
   * The three states of `searched`, which is the one tip column about the **run** rather than
   * about a candidate — and the one `seam:review` counts to say how many tips are still coming.
   *
   * The middle row is the whole point. It was searched and its box held nothing, so it has no
   * row in `Candidates` and, on a geometry-only run, no tip score either: without this column it
   * is written exactly like the row below it, which the run has not reached.
   */
  it('tells a searched tip, an unreachable one and one still queued apart', () => {
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0 },
      { [ID_COLUMN_NAME]: '720', end_uid: 1, x: 0, y: 0, z: 0 },
      { [ID_COLUMN_NAME]: '720', end_uid: 2, x: 0, y: 0, z: 0 },
      { [ID_COLUMN_NAME]: '720', end_uid: 3, x: 0, y: 0, z: 0 },
    ])
    const { rows } = tipsFromTable(table)
    // Row 2 is outside the volume, so this run will never attempt it.
    const attempting = new Set([0, 1, 3])
    const out = tipsWithFirsts(
      table,
      [end(0, [{ root: '55', dist: 0.2 }]), end(1, [])],
      rows,
      false,
      attempting,
    )
    expect(out.data['searched']).toEqual([true, true, false, null])
    // And the searched-but-empty row carries no candidate, which is the half that is missing.
    expect(out.data['candidateId']).toEqual(['55', null, null, null])
  })

  /**
   * **This run's statement, never the incoming table's.** A `Tips` table can arrive already
   * carrying `searched` — from `seam:suggestions`, or from this node's own output fed back
   * round — and that one is about another box and another filter. Carried through, it would say
   * "searched" about rows this run has not begun, which is the one cell a reader is counting.
   */
  it('overwrites a `searched` column the incoming table already had', () => {
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0, searched: true },
      { [ID_COLUMN_NAME]: '720', end_uid: 1, x: 0, y: 0, z: 0, searched: true },
    ])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [], rows, false, new Set([0, 1]))
    expect(out.data['searched']).toEqual([null, null])
  })

  /**
   * A tip with no candidates still has a `segclr`, a `p_tip` and a verdict — SEAM publishes
   * one, and a row left null would read as a tip nobody searched. Its *candidate* columns stay
   * empty, which is the half that really is missing.
   */
  it('writes a searched tip’s own numbers even where its list is empty', () => {
    const table = tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0 }])
    const { rows } = tipsFromTable(table)
    const out = tipsWithFirsts(table, [scored(end(0, []), [])], rows, true, attempted(rows))
    expect(out.data['p_tip']).toEqual([0.4])
    expect(out.data['candidateId']).toEqual([null])
    expect(out.data['min_dist_um']).toEqual([null])
  })

  /**
   * **Invariant 3, inside one feature.** `scoreEnds.ts` writes the stage-6 values and
   * `searchTips.ts` declares their columns, in two files — so this holds the two lists equal.
   *
   * It is what the typed `AssessedTip` and `EndScores.columns` are for, and this is the half a
   * type cannot do: a name declared on a `Field` list and never written arrives as an all-null
   * column under a perfectly good schema, which is a picker offered `p_cand` and given nulls.
   */
  it('declares exactly the stage-6 columns a scored end carries', () => {
    const one = scored(end(0, [{ root: '55', dist: 0.2 }]), [0])
    expect(Object.keys(one.scores!.tip).sort()).toEqual(
      ASSESSED_TIP_FIELDS.map((field) => field.name).sort(),
    )
    expect([...Object.keys(one.scores!.columns), 'filled'].sort()).toEqual(
      ASSESSED_CANDIDATE_FIELDS.map((field) => field.name).sort(),
    )
  })

  it('offers the stage-6 columns in the schema, so a picker below sees them', () => {
    const named = tipsSchema(undefined, true).columns.map((one) => one.name)
    for (const name of ['segclr', 'p_tip', 'p_top', 'q', 'r', 'shown']) {
      expect(named, name).toContain(name)
    }
    expect(tipsSchema(undefined, false).columns.map((one) => one.name)).not.toContain('q')
  })
})

describe('the columns a run requires', () => {
  /**
   * Not a per-row question: a tip Model E found no cell near has a null `e_tip` and takes the
   * fit's floor, which is designed. A missing **column** floors every tip, and `p_tip`'s weight
   * on `e_tip` is about its weight on `segclr` — the whole run comes out underconfident and
   * shows a fraction of what it should, with nothing saying why.
   *
   * **Asked by the reader, not beside it.** There were two doors into this for a round and
   * nothing made a caller open both; one list computed from one flag is what closed that.
   */
  it('refuses an assessed run a Tips table with no e_tip column', () => {
    // Built bare rather than through `tipsTable`, whose schema is Find Open Ends' and always
    // carries `e_tip` — which is the point: this is about a table that came from somewhere else.
    const bare = makeTable(
      tableSchema(
        column(ID_COLUMN_NAME, 'str'),
        column('end_uid', 'i64'),
        column('x', 'f64'),
        column('y', 'f64'),
        column('z', 'f64'),
      ),
      { [ID_COLUMN_NAME]: ['720'], end_uid: [0], x: [0], y: [0], z: [0] },
    )
    expect(() => tipsFromTable(bare, true)).toThrow(/nothing to score a tip with/)
    // And the same table is perfectly good for a geometry-only run, which never reads it.
    expect(() => tipsFromTable(bare, false)).not.toThrow()
  })

  it('takes a table whose e_tip is there but null', () => {
    const table = tipsTable([
      { [ID_COLUMN_NAME]: '720', end_uid: 0, x: 0, y: 0, z: 0, e_tip: null },
    ])
    expect(() => tipsFromTable(table, true)).not.toThrow()
    expect(tipsFromTable(table, true).rows[0]!.eTip).toBeUndefined()
  })
})

/**
 * The organelle flag (SEAM, 2026-11-14): `organelle_score` is SEAM's `enclosed`, and `organelle`
 * is it at or above `ORGANELLE_CUT` — worked out in one place for the candidate rows and the tip's
 * first candidate. A flag, never a rank: nothing here may move.
 */
describe('the organelle flag', () => {
  /** An end whose candidates carry the pool's `enclosed`, as the search's Python step adds it. */
  function enclosedEnd(enclosed: readonly number[]): PublishedEnd {
    const plain = end(
      0,
      enclosed.map((_, i) => ({ root: String(720575940000000001n + BigInt(i)), dist: 0.1 })),
    )
    return {
      ...plain,
      end: {
        ...plain.end,
        columns: { ...plain.end.columns, enclosed: Float64Array.from(enclosed) },
      },
    }
  }
  const tips = tipsFromTable(
    tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 1, y: 2, z: 3 }]),
  ).rows

  it('scores each candidate by its enclosure, and flags it from the cut up', () => {
    const at = ORGANELLE_CUT
    const table = candidatesTable([enclosedEnd([0.92, at, at - 1e-9, Number.NaN])], tips, false)
    expect(table.data['organelle_score']).toEqual([0.92, at, at - 1e-9, null])
    // At the cut is an organelle, as SEAM's `>=` has it; an unmeasured piece is not said to be.
    expect(table.data['organelle']).toEqual([true, true, false, null])
    // And the order is the search's: a flag moves nothing.
    expect(table.data['rank']).toEqual([1, 2, 3, 4])
  })

  it('puts the first candidate’s flag on the tip, as it does every first-candidate column', () => {
    const tipsOut = tipsWithFirsts(
      tipsTable([{ [ID_COLUMN_NAME]: '720', end_uid: 0, x: 1, y: 2, z: 3 }]),
      [enclosedEnd([0.8, 0.1])],
      tips,
      false,
      new Set([0]),
    )
    expect(tipsOut.data['organelle']).toEqual([true])
    // The score stays on Candidates: SEAM's tips file carries the flag alone.
    expect(tipsOut.data['organelle_score']).toBeUndefined()
  })

  it('says nothing about a pool that was not measured for it', () => {
    const table = candidatesTable([end(0, [{ root: '1', dist: 0.1 }])], tips, false)
    expect(table.data['organelle_score']).toEqual([null])
    expect(table.data['organelle']).toEqual([null])
  })
})
