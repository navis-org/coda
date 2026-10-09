/**
 * Filter Table on a Link Table file: a condition that rides on the file to whatever reads its rows.
 *
 * The property that matters is **agreement**: a condition applied as a file's rows are read keeps
 * exactly the rows `filterTable` keeps from the same rows once read — the same predicate on the
 * same decoded cell (`core/rowPredicate.ts`), or a threshold would move when a Read Rows is added
 * in front of it. Held here over every operator family, both formats and a keyed read; then the
 * edge-list build, and the node wiring end to end.
 */

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'

import type { FilterOp } from '../../core/rowPredicate'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import type { TableFileFilter, TableFileValue } from '../../core/values'
import { isTableFileValue, isTableValue, makeTable } from '../../core/values'
import { blobBytes } from '../../data/files/bytes'
import { fileTableSchema, textColumnsFor } from '../../data/files/columns'
import { rowConditions } from '../../data/files/filters'
import type { ReadRowsRequest } from '../../data/files/read'
import { openTableFile, readRows } from '../../data/files/read'
import { holdLocalFile, resetTableFiles } from '../../data/files/registry'
import { readTableFileEdgesJob } from '../../data/edges/tableFile'
import { filterTable } from '../lib/tableOps'
import { sourcelessScheduler } from '../../test/scheduler'
import { node } from '../../test/graph'
import '../index'

const FIXTURES = 'src/data/files/__fixtures__/'
const BASE = 720575940600000000n

/** A file as its Link Table would hand it on, with `filters` on it. */
async function fileValue(name: string, filters: TableFileFilter[] = []) {
  const blob = new Blob([readFileSync(FIXTURES + name)])
  const reader = await openTableFile(blobBytes(blob))
  const { summary } = reader
  const schema = fileTableSchema(summary, textColumnsFor(summary, true, []))
  const value = { schema, columns: summary.columns, filters } as Pick<
    TableFileValue,
    'schema' | 'columns' | 'filters'
  >
  return { reader, summary, schema, value }
}

/** Every column but `hash` (past 2^53, so refused as a number), read with the file's conditions. */
async function readAll(
  name: string,
  filters: TableFileFilter[],
  rest: Partial<ReadRowsRequest> = {},
) {
  const { reader, summary, schema, value } = await fileValue(name, filters)
  const columns = summary.columns
    .map((column, i) => ({ column, dtype: schema.columns[i]!.dtype }))
    .filter(({ column }) => column.name !== 'hash')
  const out = await readRows(reader, {
    fingerprint: summary.fingerprint,
    columns,
    filters: rowConditions(value),
    limit: Infinity,
    ...rest,
  })
  const outSchema = { columns: schema.columns.filter((c) => c.name !== 'hash') }
  return makeTable(outSchema, out.data)
}

const CONDITIONS: Array<[string, FilterOp, string]> = [
  ['score', 'ge', '0.5'],
  ['size', 'ne', '13'],
  ['region', 'eq', 'R1'],
  ['region', 'isEmpty', ''],
  ['region', 'matches', '^R[02]$'],
  ['pre_pt_root_id', 'endsWith', '2'],
]

describe('a condition read out of a file', () => {
  for (const name of ['synapses.parquet', 'synapses.feather']) {
    for (const [column, op, value] of CONDITIONS) {
      it(`keeps what Filter Table keeps: ${column} ${op} ${value}, ${name}`, async () => {
        const whole = await readAll(name, [])
        const filtered = await readAll(name, [{ column, op, value }])
        expect(filtered.length).toBeGreaterThan(0)
        expect(filtered.length).toBeLessThan(whole.length)
        expect(filtered.data).toEqual(filterTable(whole, column, op, value).data)
      })
    }
  }

  it('applies after a lookup by id, and counts only kept rows towards the cap', async () => {
    const key = { names: ['pre_pt_root_id'], ids: [String(BASE + 1n), String(BASE + 2n)] }
    const looked = await readAll('synapses.parquet', [], { key })
    const both = await readAll(
      'synapses.parquet',
      [{ column: 'score', op: 'gt', value: '0.4' }],
      { key },
    )
    expect(both.data).toEqual(filterTable(looked, 'score', 'gt', '0.4').data)
    const capped = await readAll(
      'synapses.parquet',
      [{ column: 'score', op: 'gt', value: '0.4' }],
      { key, limit: 2 },
    )
    expect(capped.length).toBe(2)
    expect(capped.data.score).toEqual(both.data.score!.slice(0, 2))
  })

  it('ANDs several conditions, in any order', async () => {
    const two: TableFileFilter[] = [
      { column: 'score', op: 'ge', value: '0.3' },
      { column: 'region', op: 'notEmpty', value: '' },
    ]
    const whole = await readAll('synapses.parquet', [])
    const want = filterTable(filterTable(whole, 'score', 'ge', '0.3'), 'region', 'notEmpty', '')
    expect((await readAll('synapses.parquet', two)).data).toEqual(want.data)
    expect((await readAll('synapses.parquet', [...two].reverse())).data).toEqual(want.data)
  })
})

describe('an edge list read with a condition', () => {
  it('builds only from the rows passing it, by words and by cells alike', async () => {
    for (const name of ['synapses.parquet', 'synapses.feather']) {
      const { summary, value } = await fileValue(name, [
        { column: 'score', op: 'ge', value: '0.5' },
      ])
      const spec = { kind: 'blob' as const, blob: new Blob([readFileSync(FIXTURES + name)]) }
      const encoded = await readTableFileEdgesJob(
        {
          spec,
          request: {
            fingerprint: summary.fingerprint,
            pre: 'pre_pt_root_id',
            post: 'post_pt_root_id',
            filters: rowConditions(value),
          },
        },
        {},
      )
      // Scores are 0.0 … 1.1 by tenths: rows 5 to 11 pass, every one its own pair.
      expect(encoded.report.rowsRead).toBe(7)
      expect(encoded.edges).toBe(7)
    }
  })
})

describe('the node', () => {
  beforeEach(() => resetTableFiles())

  function wired(filterParams: Record<string, unknown>) {
    const file = new File([readFileSync(FIXTURES + 'synapses.parquet')], 'synapses.parquet')
    let g = addNode(
      emptyGraph('filter-file'),
      node('f', 'core.linkTable', {
        fileId: holdLocalFile(file),
        fileName: 'synapses.parquet',
      }),
    )
    g = addNode(g, node('flt', 'core.filterTable', filterParams))
    g = addNode(g, node('r', 'core.readRows', { columns: ['size', 'score'] }))
    g = addEdge(g, { source: 'f', sourceHandle: 'file', target: 'flt', targetHandle: 'in' })
    return addEdge(g, { source: 'flt', sourceHandle: 'out', target: 'r', targetHandle: 'file' })
  }

  it('hands on a file, not a table, and Read Rows below it reads only the rows passing', async () => {
    const g = wired({ column: 'score', op: 'ge', value: '0.5' })
    const scheduler = sourcelessScheduler()
    await scheduler.run(g, { mode: 'full' })
    const handed = scheduler.output('flt', 'out')
    expect(isTableFileValue(handed) && handed.filters).toEqual([
      { column: 'score', op: 'ge', value: '0.5' },
    ])
    expect(inferGraph(g).nodes['flt']?.outputs.out?.kind).toBe('tableFile')
    const out = scheduler.output('r', 'out')
    expect(isTableValue(out) && out.data.size).toEqual([15, 16, 17, 18, 19, 20, 21])
  })

  it('refuses a value the operator cannot use on its own card, before anything reads', async () => {
    const scheduler = sourcelessScheduler()
    await scheduler.run(wired({ column: 'score', op: 'ge', value: 'high' }), { mode: 'full' })
    expect(scheduler.info('flt').error).toMatch(/not a number/)
  })
})
