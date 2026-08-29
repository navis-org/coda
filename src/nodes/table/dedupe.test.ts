/**
 * Deduplicate — `pandas.drop_duplicates`, and the node that decides what to do about an
 * annotation base disagreeing with itself.
 *
 * The three `keep` modes are not three flavours of one answer. `first` and `last` say "one row
 * per neuron" and differ only in which row a Sort upstream has put where; `none` says "only the
 * rows nobody disagrees about", which is a different question and the conservative one when a
 * repeated root id carries two different values rather than a copy.
 *
 * What is worth pinning here is mostly what is *not* obvious from the name: that an empty picker
 * compares whole rows rather than nothing, that row order survives all three modes, that a null
 * is not the string "null", and that the kind comes through.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { GraphNode } from '../../core/graph'
import { checkConnection, inferGraph } from '../../core/inference'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import '../index'
import type { TableValue } from '../../core/values'
import { makeTable, tableFromRows } from '../../core/values'
import { dedupeTable } from '../lib/tableOps'

/** Four rows over two neurons, with a column the repeats disagree about. */
function base(): TableValue {
  return tableFromRows(
    tableSchema(column('neuronId', 'str'), column('side', 'str'), column('n', 'i64')),
    [
      { neuronId: '1', side: 'left', n: 1 },
      { neuronId: '2', side: 'right', n: 2 },
      { neuronId: '1', side: 'center', n: 3 },
      { neuronId: '3', side: 'left', n: 4 },
    ],
  )
}

describe('keep', () => {
  it('keeps the first row of a repeated set, in the input’s order', () => {
    const out = dedupeTable(base(), ['neuronId'], 'first')
    expect(out.data.neuronId).toEqual(['1', '2', '3'])
    expect(out.data.n).toEqual([1, 2, 4])
  })

  it('keeps the last, and leaves it where it was rather than at the end', () => {
    /*
     * pandas does the same, and the difference is invisible until something downstream depends
     * on the order — a dedupe that also reordered would be two operations wearing one name.
     * Neuron 1 survives as row 3 of the input, so it comes *after* neuron 2.
     */
    const out = dedupeTable(base(), ['neuronId'], 'last')
    expect(out.data.neuronId).toEqual(['2', '1', '3'])
    expect(out.data.n).toEqual([2, 3, 4])
  })

  it('drops every row of a repeated set under "none", not one of them', () => {
    // `keep=False`. Neuron 1 is gone entirely — both of its rows — leaving only the neurons that
    // were already unique. That is the answer when a repeat is a conflict rather than a copy.
    const out = dedupeTable(base(), ['neuronId'], 'none')
    expect(out.data.neuronId).toEqual(['2', '3'])
  })
})

describe('which columns', () => {
  it('compares whole rows when nothing is picked', () => {
    /*
     * `drop_duplicates()`'s own default, and `Select`'s reading of an empty picker. It is also
     * the useful default: an unconfigured node answers "this file has exact duplicates in it"
     * with nothing set. Here no two rows are identical across all three columns, so nothing goes
     * — even though `neuronId` repeats.
     */
    expect(dedupeTable(base(), [], 'first').length).toBe(4)

    const exact = tableFromRows(tableSchema(column('a', 'str')), [
      { a: 'x' },
      { a: 'x' },
      { a: 'y' },
    ])
    expect(dedupeTable(exact, [], 'first').data.a).toEqual(['x', 'y'])
  })

  it('compares on several, so a row is a duplicate only when every one matches', () => {
    const out = dedupeTable(base(), ['neuronId', 'side'], 'first')
    // Neuron 1's two rows differ in `side`, so neither is a duplicate of the other.
    expect(out.length).toBe(4)
  })

  it('refuses columns this table does not have, rather than comparing on fewer', () => {
    /*
     * `groupByTable`'s rule. Silently comparing on what is left keeps *more* rows, and on a table
     * whose upstream schema moved that reads as a dedupe that simply did not work.
     */
    expect(() => dedupeTable(base(), ['nope'], 'first')).toThrow(/nope/)
  })
})

describe('the traps', () => {
  it('does not read a null as the string "null"', () => {
    /*
     * `String(null)` is the four-letter word, and a `str` column of somebody's annotation base
     * very plausibly contains it — at which point a real absence and a typed "null" would
     * deduplicate against each other. `rowKey` is what keeps them apart.
     */
    const table = makeTable(tableSchema(column('a', 'str')), { a: [null, 'null', null] })
    const out = dedupeTable(table, ['a'], 'first')
    expect(out.data.a).toEqual([null, 'null'])
  })

  it('does not let two columns run together', () => {
    // `["ab","c"]` and `["a","bc"]` are different rows; without a separator both concatenate to
    // `abc`. The collision `uploads.ts` records for its own content address.
    const table = makeTable(tableSchema(column('a', 'str'), column('b', 'str')), {
      a: ['ab', 'a'],
      b: ['c', 'bc'],
    })
    expect(dedupeTable(table, ['a', 'b'], 'first').length).toBe(2)
  })

  it('keeps the kind, because a subset of neurons is still neurons', () => {
    const neurons = makeTable(
      tableSchema(column('neuronId', 'str')),
      { neuronId: ['1', '1', '2'] },
      'neurons',
    )
    const out = dedupeTable(neurons, ['neuronId'], 'first')
    expect(out.kind).toBe('neurons')
    expect(out.schema.columns.map((c) => c.name)).toEqual(['neuronId'])
  })
})

// ---------------------------------------------------------------------------

describe('the node', () => {
  const def = requireNodeDef('core.dedupe')

  it('publishes the schema and the kind it was given', () => {
    // `core.filterTable`'s rule: every column survives with the values it had, so a picker downstream
    // is unchanged — and neurons-ness comes through, which is what lets this stand between an
    // annotation source and a Dataset.
    const neurons = T.neurons(tableSchema(column('neuronId', 'str'), column('side', 'str')))
    const out = def.inferOutputs?.(makeInferContext(def, defaultParams(def), { in: neurons }))
    expect(out?.out).toEqual(neurons)
  })

  it('says nothing about a table it cannot see yet', () => {
    // A Pivot upstream publishes no schema until it has run; unknown is not empty.
    const out = def.inferOutputs?.(makeInferContext(def, defaultParams(def), { in: T.table() }))
    expect(out?.out).toEqual(T.table())
  })

  it('takes an annotation source and hands a Dataset something it can use', () => {
    /*
     * The wiring this node was added for: `FlyTable → Deduplicate → Dataset`, deciding in the
     * open what the providers used to decide silently. Asserted through `checkConnection` because
     * `addEdge` takes the handle it is given — the trap `export.test.ts` records.
     */
    let g = emptyGraph('dedupe-chain')
    g = addNode(g, graphNode('fly', 'annotation.flyTable', { base: 'main', table: 'info' }))
    g = addNode(g, graphNode('dd', 'core.dedupe', { columns: ['neuronId'], keep: 'first' }))
    g = addNode(
      g,
      graphNode('ds', 'dataset.cave', {
        datastack: 'test_stack',
        version: '1',
        neuronTable: 'neurons',
      }),
    )
    g = addEdge(g, {
      source: 'fly',
      sourceHandle: 'annotations',
      target: 'dd',
      targetHandle: 'in',
    })
    g = addEdge(g, {
      source: 'dd',
      sourceHandle: 'out',
      target: 'ds',
      targetHandle: 'annotations',
    })

    const inf = inferGraph(g)
    for (const [from, to] of [
      [
        { nodeId: 'fly', portId: 'annotations' },
        { nodeId: 'dd', portId: 'in' },
      ],
      [
        { nodeId: 'dd', portId: 'out' },
        { nodeId: 'ds', portId: 'annotations' },
      ],
    ] as const) {
      expect(checkConnection(g, inf, from, to).ok).toBe(true)
    }
  })
})

function graphNode(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}
