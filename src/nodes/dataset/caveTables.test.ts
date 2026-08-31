/**
 * The two CAVE discovery nodes.
 *
 * What is worth asserting here is *not* the fetching — `data/cave/cave.test.ts` covers that
 * against recorded bodies. It is the three things the nodes add on top:
 *
 * - **A schema that does not move.** Both publish a fixed set of columns, which is what makes
 *   them useful upstream of a Filter, and `kind` in particular stays put when Include views is
 *   turned off. A schema that gained and lost a column with a checkbox would take every column
 *   picker downstream with it.
 * - **Both halves of "which datastack" refused on the card.** This is the failure
 *   `annotation.caveTable` had and the reason `foreignBackend` exists: a neuPrint dataset on a
 *   port that names a datastack used to be reported as a *grammar* error thrown three layers
 *   below the field that caused it.
 * - **The warning before the wait.** A view cannot be sampled cheaply, and a guard rail warns
 *   rather than refusing — so the node says so and then goes ahead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T } from '../../core/types'
import type { CodaType } from '../../core/types'
import type { TableValue, Value } from '../../core/values'
import { resetCache } from '../../data/cache'
import { resetCredentials, setToken } from '../../data/cave/credentials'
import { resetCaveState, tableListFor } from '../../data/cave/tables'
import { installCaveFetch } from '../../test/caveStubs'
import '../index'
import { makeInferContext } from '../../core/node'

const DATASET = 'flywire_fafb_public:783'

/** A hand-built `EvalContext`, the shape `updateRootIds.test.ts` uses. */
function run(
  type: string,
  params: ParamValues,
  options: { dataset?: Value; warn?: (message: string) => void } = {},
) {
  return requireNodeDef(type).evaluate({
    params,
    refresh: false,
    input: (portId) => (portId === 'dataset' ? options.dataset : undefined),
    inputKey: () => undefined,
    column: () => '',
    columns: () => [],
    inputPorts: () => [],
    outputPorts: () => [],
    resolveSource: () => {
      throw new Error('no source')
    },
    signal: new AbortController().signal,
    progress: () => undefined,
    reportFetched: () => undefined,
    warn: options.warn ?? (() => undefined),
    publish: () => undefined,
  })
}

/** The edit-time half, with only the two things these nodes read off it. */
function issues(type: string, params: ParamValues, dataset?: CodaType): string[] {
  const def = requireNodeDef(type)
  return def.validate?.(makeInferContext(def, params, { dataset })) ?? []
}

beforeEach(() => {
  resetCache()
  resetCaveState()
  resetCredentials()
  setToken('token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetCredentials()
})

// ---------------------------------------------------------------------------

describe('List CAVE tables', () => {
  it('publishes the same two columns whether or not views are included', async () => {
    installCaveFetch()
    const both = (await run('cave.tables', { datastack: DATASET, includeViews: true }))
      .out as TableValue
    const tablesOnly = (await run('cave.tables', { datastack: DATASET, includeViews: false }))
      .out as TableValue

    const names = (t: TableValue) => t.schema.columns.map((c) => c.name)
    expect(names(both)).toEqual(['table', 'kind'])
    expect(names(tablesOnly)).toEqual(['table', 'kind'])
    /*
     * With views off the column reads `table` on every row rather than disappearing. That is the
     * decision: a Filter or a column picker configured against this node must not break because
     * somebody unticked a checkbox.
     */
    expect(new Set(tablesOnly.data.kind)).toEqual(new Set(['table']))
    expect(new Set(both.data.kind)).toEqual(new Set(['table', 'view']))
  })

  it('answers the tables sorted with the views after them', async () => {
    installCaveFetch()
    const out = (await run('cave.tables', { datastack: DATASET, includeViews: true }))
      .out as TableValue
    expect(out.data.table?.slice(0, 2)).toEqual([
      'fly_synapses_neuropil_v6',
      'hierarchical_neuron_annotations',
    ])
    expect(out.data.table?.at(-1)).toBe('valid_connection_v2')
    expect(out.length).toBe(9)
  })

  it('takes the datastack from a wired Dataset over its own field', async () => {
    installCaveFetch()
    const out = (
      await run(
        'cave.tables',
        { datastack: 'not_a_datastack:1', includeViews: false },
        { dataset: { kind: 'dataset', sourceId: 'cave', datasetId: DATASET, label: DATASET } },
      )
    ).out as TableValue
    expect(out.length).toBe(6)
  })

  it('infers what it evaluates, before anything has run', async () => {
    installCaveFetch()
    const def = requireNodeDef('cave.tables')
    const inferred = def.inferOutputs?.(
      makeInferContext(def, { datastack: DATASET, includeViews: true }, {}),
    )
    const out = (await run('cave.tables', { datastack: DATASET, includeViews: true }))
      .out as TableValue
    expect(inferred?.out).toEqual(T.table(out.schema))
  })
})

// ---------------------------------------------------------------------------

describe('CAVE table info', () => {
  it('reads the columns off one sampled row, keeping a wide id as exact text', async () => {
    installCaveFetch()
    const out = (await run('cave.tableInfo', { datastack: DATASET, table: 'nuclei_v1' }))
      .columns as TableValue
    expect(out.schema.columns.map((c) => c.name)).toEqual(['column', 'type', 'example'])

    const at = out.data.column?.indexOf('pt_root_id') ?? -1
    expect(at).toBeGreaterThanOrEqual(0)
    // Invariant 8 reaching the card: eighteen digits, unrounded, and reported as `str` because
    // that is what any consumer of this table actually gets.
    expect(out.data.example?.[at]).toBe('720575940626838909')
    expect(out.data.type?.[at]).toBe('str')

    // The documented hole: one sampled row says nothing about a column whose value is null.
    const nulled = out.data.column?.indexOf('superceded_id') ?? -1
    expect(out.data.type?.[nulled]).toBe('')
    expect(out.data.example?.[nulled]).toBe('')
  })

  /*
   * A guard rail warns; it does not refuse, and time is never a refusal (`docs/limits.md`). CAVE
   * does not push a row limit into an aggregating view, so this is a wait that has to be named
   * before it starts — and then entered.
   */
  it('warns before sampling a view, and samples it anyway', async () => {
    installCaveFetch()
    const warnings: string[] = []
    const out = (
      await run(
        'cave.tableInfo',
        { datastack: DATASET, table: 'valid_connection_v2' },
        { warn: (m) => warnings.push(m) },
      )
    ).columns as TableValue
    expect(warnings.join(' ')).toMatch(/view.*row limit/s)
    expect(out.length).toBeGreaterThan(0)
  })

  it('says so rather than inventing columns for a table that answers no rows', async () => {
    installCaveFetch({ overrides: { '/query': '[]' } })
    const warnings: string[] = []
    const out = (
      await run(
        'cave.tableInfo',
        { datastack: DATASET, table: 'nuclei_v1' },
        { warn: (m) => warnings.push(m) },
      )
    ).columns as TableValue
    expect(out.length).toBe(0)
    expect(warnings.join(' ')).toMatch(/no rows/)
  })

  it('names the tables in the datastack when the one asked for is not one of them', async () => {
    installCaveFetch()
    await expect(
      run('cave.tableInfo', { datastack: DATASET, table: 'nuclei_v2' }),
    ).rejects.toThrow(/Available: fly_synapses_neuropil_v6/)
  })
})

// ---------------------------------------------------------------------------

describe('which datastack, refused on the card', () => {
  const both = ['cave.tables', 'cave.tableInfo']

  /*
   * The wire half. This port names a datastack, so a Dataset from any other backend used to be
   * handed straight through as one — `male-cns:v1.0` split on the colon gives a version of
   * `v1.0`, and the message that came back was about the grammar rather than about the wire.
   */
  it.each(both)('%s refuses a Dataset from another backend, naming it', (type) => {
    const neuprint = T.dataset('neuprint', 'hemibrain:v1.2.1')
    expect(issues(type, { datastack: '', table: 'nuclei_v1' }, neuprint)[0]).toMatch(
      /neuPrint dataset names no CAVE datastack/,
    )
  })

  // The typed half. `datastack:materialization` is the whole grammar and a bare name is the
  // obvious thing to type; it used to reach the same throw two layers down.
  it.each(both)('%s refuses a typed datastack with no materialization', (type) => {
    expect(issues(type, { datastack: 'flywire_fafb_public', table: 'nuclei_v1' })[0]).toMatch(
      /names no materialization.*:783/,
    )
  })

  it.each(both)('%s asks for a datastack when neither is given', (type) => {
    expect(issues(type, { datastack: '', table: 'nuclei_v1' })[0]).toMatch(/Name a datastack/)
  })

  it.each(both)('%s says nothing once a valid datastack is named', (type) => {
    expect(issues(type, { datastack: DATASET, table: 'nuclei_v1' })).toEqual([])
  })

  /*
   * `peekTableList` answers `undefined` for "not yet", and that is not a problem to report — a
   * card saying "no such table" for the second between a graph loading and its listing arriving
   * would be accusing every saved graph of being broken. Once it *has* landed, a name that is
   * not in it is a real problem and names the alternatives.
   */
  it('says nothing about an unknown table until the listing has landed, then names it', async () => {
    installCaveFetch()
    expect(issues('cave.tableInfo', { datastack: DATASET, table: 'nuclei_v2' })).toEqual([])
    await tableListFor('flywire_fafb_public', 783)
    expect(issues('cave.tableInfo', { datastack: DATASET, table: 'nuclei_v2' })[0]).toMatch(
      /is not in flywire_fafb_public:783.*Available:/s,
    )
    expect(issues('cave.tableInfo', { datastack: DATASET, table: 'nuclei_v1' })).toEqual([])
  })
})
