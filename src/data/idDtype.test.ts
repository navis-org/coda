/**
 * One dtype for a neuron id, across every source — invariant 8's last clause.
 *
 * A file of its own because the rule is *cross-source* and every other test in this tree is
 * about one backend. Each source used to answer this question for itself: neuPrint published
 * `neuronId` as `i64` on the true grounds that its own ids are nine to eleven digits and exact
 * as doubles, CAVE published `str` because an eighteen-digit root id is not, and CATMAID and
 * the mock followed neuPrint. Every one of those was locally right and the set was wrong — two
 * connectomes' tables could not be stacked (`"neuronId" is i64 above and str below`) or joined
 * without the key silently widening, and the Workflow Wizard's own cross-dataset geometry arms
 * built a graph that could not run.
 *
 * Two halves, and the second is the one that catches a mistake:
 *
 *  - **The schemas**, which is a statement anybody can grep for and nobody can violate quietly.
 *  - **The values**, walked out of a real source. `tableFromRows` and `makeTable` take cells
 *    verbatim — neither validates a cell against the dtype its column declares — so a source
 *    that keeps a `Number(id)` anywhere publishes numbers under a `str` column and every
 *    schema-level check in this file passes. That is how all four of the value sites were
 *    found, and it is the only guard against a fifth arriving.
 *
 * Only the mock can be walked offline, which is the honest limit here: the recorded-fixture
 * suites in `neuprint/`, `cave/` and `catmaid/` are where each real decoder is checked, and the
 * `live.test.ts` files are where a server is.
 */

import { describe, expect, it } from 'vitest'

import { isIdentifierColumn } from '../core/ids'
import type { DType, TableSchema } from '../core/types'
import type { CellValue, TableValue } from '../core/values'
import { registerBuiltinSources } from './builtins'
import {
  CANONICAL_SCHEMAS,
  GROUP_TOTALS_SCHEMA,
  PATH_STEP_SCHEMA,
  SYNAPSE_TOTALS_SCHEMA,
  allSources,
} from './source'
import type { SourceSchemas } from './source'
import { CATMAID_SCHEMAS } from './catmaid/schema'
import { neuronSchemaFor, schemasFor as caveSchemasFor } from './cave/schema'
import { discoverNeuronSchema, schemasFor as neuprintSchemasFor } from './neuprint/schema'
import { MockSource } from './mock/MockSource'
import { mockDatasetIds } from './mock/generate'

/**
 * Column names that identify a *neuron*, wherever they appear.
 *
 * Listed rather than derived from `isIdentifierColumn`, because that rule answers "is this
 * column a name rather than a quantity" and the answer is yes for things that are not neurons.
 * `connectorId` is the case in the tree: a CATMAID connector is that backend's own object,
 * nothing joins it against a neuron id, and it is deliberately still `i64`. A test that asked
 * `isIdentifierColumn` would demand it change, which is a different rule wearing this one's
 * name.
 */
const NEURON_ID_COLUMNS = new Set([
  'neuronId',
  'partnerId',
  'sourceId',
  'targetId',
  'preId',
  'postId',
])

function idColumnsOf(schema: TableSchema): Array<{ name: string; dtype: DType }> {
  return schema.columns.filter((c) => NEURON_ID_COLUMNS.has(c.name))
}

/**
 * Every `SourceSchemas` a backend can publish, named so a failure says which.
 *
 * The registry answers most of it. `registerBuiltinSources` is the one list of the backends —
 * its own header records what a script registering three of the four cost — so reading
 * `allSources()` puts a source added later inside this test without anybody remembering, which
 * is exactly what a hand-written fourth list of the backends does not do.
 *
 * The two *discovered* schemas are still built by hand, because they are the interesting ones
 * and a registered source carries only its default: neuPrint's shape arrives from a dataset's
 * `neuronProperties`, CAVE's from the annotation kinds a datastack publishes.
 */
function everySchema(): Array<[string, TableSchema]> {
  const named: Array<[string, SourceSchemas]> = [
    ['canonical', CANONICAL_SCHEMAS],
    ['neuprint.discovered', neuprintSchemasFor(discoverNeuronSchema({}))],
    ['cave.discovered', caveSchemasFor(neuronSchemaFor(['cell_type']))],
    ...allSources().map((source): [string, SourceSchemas] => [source.id, source.schemas]),
  ]
  return [
    ...named.flatMap(([source, schemas]) =>
      Object.entries(schemas).map(([table, schema]): [string, TableSchema] => [
        `${source}.${table}`,
        schema,
      ]),
    ),
    ['pathStep', PATH_STEP_SCHEMA],
    ['synapseTotals', SYNAPSE_TOTALS_SCHEMA],
    ['groupTotals', GROUP_TOTALS_SCHEMA],
  ]
}

// `allSources()` is empty until something registers them, and `capabilityOf` answers `true` for
// an unregistered source — so a suite that enumerates backends registers first. See `builtins.ts`.
registerBuiltinSources({ mockLatencyMs: 0 })

describe('every source declares a neuron id as text', () => {
  it('has no `i64` id column anywhere in a published schema', () => {
    const wrong: string[] = []
    let checked = 0
    for (const [name, schema] of everySchema()) {
      for (const col of idColumnsOf(schema)) {
        checked += 1
        if (col.dtype !== 'str') wrong.push(`${name}.${col.name} is ${col.dtype}`)
      }
    }
    expect(wrong).toEqual([])
    // A floor, so a refactor that renamed every column out of `NEURON_ID_COLUMNS` cannot leave
    // this test passing over nothing at all.
    expect(checked).toBeGreaterThan(10)
  })

  it('leaves an id that is not a neuron alone', () => {
    // The contrast that keeps the rule honest — see `NEURON_ID_COLUMNS`.
    const connector = CATMAID_SCHEMAS.synapses.columns.find((c) => c.name === 'connectorId')
    expect(connector?.dtype).toBe('i64')
    expect(isIdentifierColumn('connectorId')).toBe(true)
  })
})

/** Whether a cell is a legal value for the dtype its column declares. Null fits anything. */
function fits(cell: CellValue | undefined, dtype: DType): boolean {
  if (cell === null || cell === undefined) return true
  switch (dtype) {
    case 'str':
      return typeof cell === 'string'
    case 'bool':
      return typeof cell === 'boolean'
    default:
      return typeof cell === 'number'
  }
}

/** Every column of a table, checked against what its own schema promises. */
function mismatches(label: string, table: TableValue): string[] {
  const out: string[] = []
  for (const col of table.schema.columns) {
    const data = table.data[col.name] ?? []
    const bad = data.findIndex((cell) => !fits(cell, col.dtype))
    if (bad !== -1) {
      out.push(
        `${label}.${col.name} declares ${col.dtype} and row ${bad} is ${typeof data[bad]}`,
      )
    }
  }
  return out
}

describe('the values a source actually publishes', () => {
  const dataset = mockDatasetIds()[0]!
  const source = new MockSource({ latencyMs: 0 })

  it('matches every declared dtype, on every table the mock can build', async () => {
    const neurons = await source.findNeurons({ datasetId: dataset, limit: 5 })
    const neuronIds = (neurons.data['neuronId'] ?? []).map(String)

    const tables: Array<[string, TableValue]> = [
      ['findNeurons', neurons],
      [
        'connectivity',
        await source.fetchConnectivity({ datasetId: dataset, neuronIds, direction: 'outputs' }),
      ],
      ['roiCounts', await source.fetchRoiCounts({ datasetId: dataset, neuronIds })],
      [
        'synapseTotals',
        await source.fetchSynapseTotals({
          datasetId: dataset,
          neuronIds,
          side: 'outputs',
          basis: 'all',
        }),
      ],
      [
        'groupTotals',
        await source.fetchGroupTotals({
          datasetId: dataset,
          neuronIds,
          types: ['T4a'],
          side: 'outputs',
          basis: 'all',
        }),
      ],
      [
        'pathStep',
        await source.fetchPathStep({
          datasetId: dataset,
          neuronIds,
          direction: 'outputs',
          collapseTypes: false,
        }),
      ],
      [
        'skeletons',
        (await source.fetchSkeletons({ datasetId: dataset, neuronIds })).attributes,
      ],
      [
        'synapses',
        (
          await source.fetchSynapses({
            datasetId: dataset,
            neuronIds,
            // Required and resolved at the node — see `SynapseRequest.unit`; the mock declares
            // exactly one, so `[0]` is the only thing it could be.
            unit: source.synapseUnits[0],
          })
        ).attributes,
      ],
    ]

    const wrong = tables.flatMap(([label, table]) => mismatches(label, table))
    expect(wrong).toEqual([])
    // Every one of these has to have had rows, or the walk above proves nothing.
    for (const [label, table] of tables) expect(table.length, label).toBeGreaterThan(0)
  })

  it('publishes ids that are exactly what they say, not rounded through a double', async () => {
    // The property underneath the dtype: text out of a source is text somebody can paste back
    // into a query. A number here would still pass `fits` if the column were `i64`, which is
    // why the schema half above exists as well.
    const table = await source.findNeurons({ datasetId: dataset, limit: 3 })
    for (const cell of table.data['neuronId'] ?? []) {
      expect(typeof cell).toBe('string')
      expect(String(cell)).toMatch(/^\d+$/)
    }
  })
})
