/**
 * Compare Connectivity — the node's contract.
 *
 * The algorithm is pinned in `lib/edgeComparison.test.ts`; what is worth pinning here is the
 * half that fails silently:
 *
 *  - `inferOutputs` publishes exactly the columns `evaluate` returns, at every arity and under
 *    every set of names (invariant 3). This node is the first whose output *schema* is derived
 *    from params rather than declared, so the two halves have a real chance to disagree;
 *  - two datasets given the same name do not collapse two `weight_` columns onto one key;
 *  - the sockets are variadic in *pairs*, and `datasetCount` drives both the ports and the
 *    per-dataset params;
 *  - the pickers resolve through `ctx.column` so the provenance key and the columns read agree
 *    (invariant 5).
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams, makeInferContext, resolveColumn } from '../../core/node'
import type { ColumnParam, ParamValues } from '../../core/node'
import { inputPorts, outputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, schemaOf, tableSchema } from '../../core/types'
import type { CodaType } from '../../core/types'
import { tableFromRows } from '../../core/values'
import type { TableValue } from '../../core/values'
import '../index'

const EDGES = tableSchema(column('preId', 'str'), column('postId', 'str'), column('weight', 'i64'))
const LABELS = tableSchema(column('neuronId', 'str'), column('label', 'str'))

const def = requireNodeDef('compare.connectivity')

function edges(rows: Array<[string, string, number]>): TableValue {
  return tableFromRows(
    EDGES,
    rows.map(([preId, postId, weight]) => ({ preId, postId, weight })),
  )
}

function labels(pairs: Array<[string, string]>): TableValue {
  return tableFromRows(
    LABELS,
    pairs.map(([neuronId, label]) => ({ neuronId, label })),
  )
}

/** Two datasets that share LC4 and DNp01, where only the first has LPLC1. */
const WIRED = {
  edges1: edges([
    ['1', '3', 20],
    ['7', '3', 4],
  ]),
  labels1: labels([
    ['1', 'LC4'],
    ['3', 'DNp01'],
    ['7', 'LPLC1'],
  ]),
  edges2: edges([['11', '13', 6]]),
  labels2: labels([
    ['11', 'LC4'],
    ['13', 'DNp01'],
  ]),
} as const

function inputsFor(count = 2): Record<string, CodaType | undefined> {
  const inputs: Record<string, CodaType | undefined> = {}
  for (let i = 1; i <= count; i++) {
    inputs[`edges${i}`] = T.table(EDGES)
    inputs[`labels${i}`] = T.table(LABELS)
  }
  return inputs
}

/** `evaluate`'s context, with pickers resolved exactly as the editor resolves them. */
function run(params: ParamValues = {}, tables: Record<string, TableValue> = { ...WIRED }) {
  const all = { ...defaultParams(def), ...params }
  const inputs = inputsFor(Number(all.datasetCount ?? 2))
  const ctx = {
    params: all,
    input: (id: string) => tables[id],
    column: (id: string) =>
      resolveColumn(def.params?.find((p) => p.id === id) as ColumnParam, all, inputs),
    warn: () => {},
  }
  return (def.evaluate as (c: unknown) => { comparison: TableValue; counts: TableValue })(ctx)
}

describe('the sockets', () => {
  it('repeats a pair per dataset, keeping each pair adjacent', () => {
    const params = { ...defaultParams(def), datasetCount: 3 }
    expect(inputPorts(def, params).map((p) => p.id)).toEqual([
      'edges1',
      'labels1',
      'edges2',
      'labels2',
      'edges3',
      'labels3',
    ])
    // The outputs are fixed: the arity lands in `comparison`'s columns, not in its ports.
    expect(outputPorts(def, params).map((p) => p.id)).toEqual(['comparison', 'counts'])
  })

  it('starts at two, because a comparison of one is not one', () => {
    const count = def.params?.find((p) => p.id === 'datasetCount')
    expect(count).toMatchObject({ min: 2, max: 4, default: 2 })
    expect(inputPorts(def, defaultParams(def))).toHaveLength(4)
  })

  it('hides the per-dataset params past the count, so an unseen picker cannot stale a run', () => {
    // Invariant 4: hidden params are outside the provenance key. A picker for a dataset nobody
    // has connected must not re-run everything downstream when it resolves differently.
    const params = { ...defaultParams(def), datasetCount: 2 }
    const hidden = def.params?.filter((p) => p.visibleIf && !p.visibleIf(params)).map((p) => p.id)
    expect(hidden).toEqual(['name3', 'pre3', 'post3', 'weight3', 'name4', 'pre4', 'post4', 'weight4'])
  })
})

describe('the published schema', () => {
  it('is exactly what evaluate returns, at every arity', () => {
    for (const count of [2, 3, 4]) {
      const params = { ...defaultParams(def), datasetCount: count }
      const inferred = def.inferOutputs?.(makeInferContext(def, params, inputsFor(count)))
      const tables: Record<string, TableValue> = {}
      for (let i = 1; i <= count; i++) {
        tables[`edges${i}`] = WIRED.edges2
        tables[`labels${i}`] = WIRED.labels2
      }
      const out = run(params, tables)
      expect(columnNames(schemaOf(inferred?.comparison))).toEqual(columnNames(out.comparison.schema))
    }
  })

  it('names the columns after the datasets, before anything has run', () => {
    const params = { ...defaultParams(def), name1: 'flywire', name2: 'hemibrain' }
    const inferred = def.inferOutputs?.(makeInferContext(def, params, inputsFor()))
    expect(columnNames(schemaOf(inferred?.comparison))).toEqual([
      'preLabel',
      'postLabel',
      'weight_flywire',
      'weight_hemibrain',
      'present_flywire',
      'present_hemibrain',
    ])
  })

  it('publishes counts from its declared type rather than deriving it twice', () => {
    // Long form, so this half is a constant whatever the arity — the trade `edgeComparison.ts`
    // records. `inferOutputs` deliberately says nothing about it.
    expect(def.inferOutputs?.(makeInferContext(def, defaultParams(def), inputsFor()))).not.toHaveProperty(
      'counts',
    )
    const published = inferGraph(pipeline()).nodes.cmp?.outputs.counts
    expect(columnNames(schemaOf(published))).toEqual([
      'label',
      'dataset',
      'nNeurons',
      'outWeight',
      'inWeight',
    ])
  })
})

describe('duplicate names', () => {
  it('suffixes rather than collapsing two datasets onto one column', () => {
    /*
     * `makeTable` keys its data by column name, so two datasets called "A" would write one
     * `weight_A` and the second would win — a table with a column silently missing rather than
     * an error. `uniqueName` is the codebase's one collision rule.
     */
    const params = { ...defaultParams(def), name1: 'A', name2: 'A' }
    const out = run(params)
    expect(columnNames(out.comparison.schema)).toEqual([
      'preLabel',
      'postLabel',
      'weight_A',
      'weight_A_2',
      'present_A',
      'present_A_2',
    ])
    const inferred = def.inferOutputs?.(makeInferContext(def, params, inputsFor()))
    expect(columnNames(schemaOf(inferred?.comparison))).toEqual(columnNames(out.comparison.schema))
  })

  it('says so on the card, since the name somebody typed is not the one they got', () => {
    const issues = def.validate?.(
      makeInferContext(def, { ...defaultParams(def), name1: 'A', name2: 'A' }, inputsFor()),
    )
    expect(issues?.join(' ')).toMatch(/already called "A"/)
  })

  it('falls back to the letter where a name is blank', () => {
    const out = run({ ...defaultParams(def), name1: '', name2: '  ' })
    expect(columnNames(out.comparison.schema)).toContain('weight_A')
    expect(columnNames(out.comparison.schema)).toContain('weight_B')
  })
})

describe('the run', () => {
  it('puts the same connection side by side, and tells absent from unasked', () => {
    const { comparison } = run()
    const rows = new Map(
      Array.from({ length: comparison.length }, (_, i) => [
        `${comparison.data.preLabel![i]}->${comparison.data.postLabel![i]}`,
        i,
      ]),
    )
    const at = rows.get('LC4->DNp01')!
    expect(comparison.data.weight_A![at]).toBe(20)
    expect(comparison.data.weight_B![at]).toBe(6)

    // B holds both LC4 and DNp01, so its 0 would be a finding; it holds no LPLC1, so that is null.
    const unasked = rows.get('LPLC1->DNp01')!
    expect(comparison.data.weight_B![unasked]).toBeNull()
    expect(comparison.data.present_B![unasked]).toBe(false)
  })

  it('counts each row as one where the weight picker is empty', () => {
    const out = run({ ...defaultParams(def), weight1: '', weight2: '' })
    const at = (comparison: TableValue, pre: string) =>
      Array.from({ length: comparison.length }, (_, i) => i).find(
        (i) => comparison.data.preLabel![i] === pre,
      )!
    expect(out.comparison.data.weight_A![at(out.comparison, 'LC4')]).toBe(1)
  })

  it('refuses where an id column is not selected rather than comparing nothing', () => {
    // Reachable only before the schemas arrive; with one in hand `resolveColumn` falls back to a
    // first column, which is what a picker on a known table must do.
    const blind: Record<string, CodaType | undefined> = { edges1: T.table(), labels1: T.table() }
    const all = defaultParams(def)
    const ctx = {
      params: all,
      input: (id: string) => (WIRED as Record<string, TableValue>)[id],
      column: (id: string) =>
        resolveColumn(def.params?.find((p) => p.id === id) as ColumnParam, all, blind),
      warn: () => {},
    }
    // `preId` is the declared default and resolves; `weight` is optional. Blank the required one.
    const blanked = { ...ctx, column: (id: string) => (id === 'pre1' ? undefined : ctx.column(id)) }
    expect(() => (def.evaluate as (c: unknown) => unknown)(blanked)).toThrow(/pre and post/)
  })

  it('warns about incomparable totals and still returns the table', () => {
    const warnings: string[] = []
    const all = { ...defaultParams(def) }
    const inputs = inputsFor()
    const lopsided: Record<string, TableValue> = {
      ...WIRED,
      edges2: edges([['11', '13', 1]]),
    }
    const ctx = {
      params: all,
      input: (id: string) => lopsided[id],
      column: (id: string) =>
        resolveColumn(def.params?.find((p) => p.id === id) as ColumnParam, all, inputs),
      warn: (message: string) => warnings.push(message),
    }
    const out = (def.evaluate as (c: unknown) => { comparison: TableValue })(ctx)
    expect(warnings.join(' ')).toMatch(/factor of/)
    expect(out.comparison.length).toBeGreaterThan(0)
  })
})

describe('wired up', () => {
  it('takes Match Cell Types’ Labels output on every Labels socket', () => {
    const inferred = inferGraph(pipeline())
    // Both label ports carry a real schema, which is what makes the id/label pickers resolve.
    expect(columnNames(schemaOf(inferred.nodes.cmp?.inputs?.labels1))).toEqual([
      'neuronId',
      'label',
    ])
  })
})

/** A Match Cell Types feeding both Labels sockets of a Compare Connectivity. */
function pipeline() {
  let g = emptyGraph('compare')
  g = addNode(g, node('match', 'compare.matchTypes'))
  g = addNode(g, node('cmp', 'compare.connectivity'))
  for (const [out, into] of [
    ['labels1', 'labels1'],
    ['labels2', 'labels2'],
  ] as const) {
    g = addEdge(g, { source: 'match', sourceHandle: out, target: 'cmp', targetHandle: into })
  }
  return g
}

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}
