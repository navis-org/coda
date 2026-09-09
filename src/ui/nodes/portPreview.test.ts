/**
 * What a hover over an output socket says about each kind of value.
 *
 * Headless, and total over the union on purpose: a kind that fell through to an empty panel
 * would be indistinguishable on screen from the "nothing has run yet" case the hover is
 * deliberately silent about, and there is no other test that would notice.
 */

import { describe, expect, it } from 'vitest'

import type { NetworkValue, SkeletonsValue, Value } from '../../core/values'
import { describeValue, makeMatrix, tableFromRows } from '../../core/values'
import { MAX_FIELDS, portPreview } from './portPreview'

const NEURONS = tableFromRows(
  {
    columns: [
      { name: 'neuronId', dtype: 'str' },
      { name: 'type', dtype: 'str' },
      { name: 'size', dtype: 'i64', unit: 'nm^3' },
    ],
  },
  [
    { neuronId: '720575940621039145', type: 'LC4', size: 12345 },
    { neuronId: '720575940608665253', type: 'LC6', size: 6789 },
  ],
  'neurons',
)

describe('portPreview', () => {
  it('leads with the same line the card footer draws', () => {
    // Not a second spelling: two answers to "what is on this wire", one under the card and one
    // beside the socket, is the drift this reuse exists to make impossible.
    expect(portPreview(NEURONS).headline).toBe(describeValue(NEURONS))
  })

  it('draws every column down the panel, typed, with one row across', () => {
    /*
     * The pivot. Which columns a table carries is the thing a reader cannot get anywhere else —
     * the count is on the card already and the values are the Table node's job — and read across
     * the page a wide table spent its whole width on four of them.
     */
    const preview = portPreview(NEURONS)
    expect(preview.tables).toHaveLength(1)
    const table = preview.tables[0]!
    expect(table.fields.map((f) => f.name)).toEqual(['neuronId', 'type', 'size'])
    expect(table.fields[2]!.type).toBe('i64 · nm^3')
    // An id survives whole. It is text everywhere (invariant 8), and a truncated id is not an id.
    expect(table.fields[0]!.values).toEqual(['720575940621039145'])
    expect(table.moreFields).toBe(0)
    // The head names all three, and the field noun is the footer's too, so they cannot disagree.
    expect(table.fieldNoun).toBe('column')
    expect(table.headers).toEqual(['first row'])
  })

  it('draws one row across whatever the table is, so every preview is the same shape', () => {
    /*
     * A fixed one, not as many as fit. Spending the leftover width drew four sample rows on a
     * narrow table, two on a neuron table and none on an empty one — the same feature looking
     * like three, off arithmetic nothing on screen explained. One is also the only count that
     * never has to cut an eighteen-digit id in half to make room (invariant 8).
     */
    const narrow = tableFromRows({ columns: [{ name: 'n', dtype: 'i64' }] }, [
      { n: 1 },
      { n: 2 },
      { n: 3 },
      { n: 4 },
      { n: 5 },
    ])
    const wide = tableFromRows(
      {
        columns: [
          { name: 'a_rather_long_column', dtype: 'str' },
          { name: 'another_long_column', dtype: 'str' },
        ],
      },
      Array.from({ length: 9 }, (_, i) => ({
        a_rather_long_column: `72057594062103914${i}`,
        another_long_column: `72057594060866525${i}`,
      })),
    )
    for (const value of [NEURONS, narrow, wide]) {
      for (const field of portPreview(value).tables[0]!.fields) {
        expect(field.values).toHaveLength(1)
      }
    }
  })

  it('keeps the value column on a table with no rows, drawn empty rather than as a null', () => {
    // The Explore card's `Selected` port with nothing ticked. An empty table is recognisably the
    // same drawing as a full one with the value missing; a dash would read as a null in a row
    // that does not exist. `TableSummary` draws the same distinction.
    const empty = tableFromRows(
      {
        columns: [
          { name: 'neuronId', dtype: 'str' },
          { name: 'type', dtype: 'str' },
        ],
      },
      [],
    )
    const table = portPreview(empty).tables[0]!
    expect(table.headers).toEqual(['first row'])
    expect(table.fields.map((f) => f.values)).toEqual([[''], ['']])
  })

  it('keeps every column of a wide table, where the pre-pivot panel kept five', () => {
    const wide = tableFromRows(
      {
        columns: Array.from({ length: 18 }, (_, i) => ({
          name: `field_${i}`,
          dtype: 'i64' as const,
        })),
      },
      [Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`field_${i}`, i]))],
    )
    const table = portPreview(wide).tables[0]!
    expect(table.fields).toHaveLength(18)
    expect(table.moreFields).toBe(0)
  })

  it('counts the columns past the height budget rather than drawing them', () => {
    const huge = tableFromRows(
      {
        columns: Array.from({ length: 60 }, (_, i) => ({
          name: `c${i}`,
          dtype: 'i64' as const,
        })),
      },
      [Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`c${i}`, 1]))],
    )
    const table = portPreview(huge).tables[0]!
    expect(table.fields).toHaveLength(MAX_FIELDS)
    expect(table.moreFields).toBe(60 - MAX_FIELDS)
  })

  it('cuts a field name and its type, since both are paid for before any value', () => {
    const verbose = tableFromRows(
      {
        columns: [
          {
            name: 'a_column_name_of_some_considerable_length',
            dtype: 'i64',
            unit: 'a_long_unit',
          },
        ],
      },
      [{ a_column_name_of_some_considerable_length: 1 }],
    )
    const field = portPreview(verbose).tables[0]!.fields[0]!
    expect(field.name.length).toBeLessThanOrEqual(22)
    expect(field.type!.length).toBeLessThanOrEqual(16)
    expect(field.values).toEqual(['1'])
  })

  it('shows a network as two tables, because one of them is always the wrong one', () => {
    const network: NetworkValue = {
      kind: 'network',
      directed: true,
      nodes: tableFromRows(
        {
          columns: [
            { name: 'id', dtype: 'str' },
            { name: 'type', dtype: 'str' },
          ],
        },
        [{ id: 'a', type: 'LC4' }],
      ),
      edges: tableFromRows(
        {
          columns: [
            { name: 'source', dtype: 'str' },
            { name: 'target', dtype: 'str' },
            { name: 'weight', dtype: 'i64' },
          ],
        },
        [{ source: 'a', target: 'b', weight: 12 }],
      ),
    }
    const preview = portPreview(network)
    expect(preview.tables.map((t) => t.caption)).toEqual(['Nodes', 'Edges'])
    expect(preview.tables[0]!.fields.map((f) => f.name)).toEqual(['id', 'type'])
    expect(preview.tables[1]!.fields.map((f) => f.name)).toContain('weight')
    // Direction is not derivable from any count, so it is said.
    expect(preview.facts).toContainEqual({ label: 'Direction', value: 'directed' })
  })

  it('shows a geometry collection through the attribute table it carries', () => {
    /*
     * Which is the collection's own table and not necessarily the one that named its neurons —
     * after a `Carry fields` join those differ, and this is the half a reader can check.
     */
    const skeletons: SkeletonsValue = {
      kind: 'skeletons',
      items: [],
      attributes: NEURONS,
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    }
    const preview = portPreview(skeletons)
    expect(preview.tables[0]!.fields.map((f) => f.name)).toEqual(['neuronId', 'type', 'size'])
  })

  it('labels a matrix corner, since a bare grid of numbers says nothing', () => {
    const matrix = makeMatrix(
      ['LC4', 'LC6'],
      ['PLP1', 'PLP2'],
      Float64Array.from([1, 2, 3, 4]),
      'synapses',
      'similarity',
    )
    const table = portPreview(matrix).tables[0]!
    // Not turned: a matrix is already a grid with a label on each axis, so its rows stay rows —
    // and its nouns are therefore the other way round from a table's.
    expect(table.headers).toEqual(['PLP1', 'PLP2'])
    expect(table.fields.map((f) => f.name)).toEqual(['LC4', 'LC6'])
    expect(table.fields[0]!.values).toEqual(['1', '2'])
    expect(table.fields[1]!.values).toEqual(['3', '4'])
    expect(table.fields[0]!.type).toBeUndefined()
    expect(table.fieldNoun).toBe('row')
    // Four columns across where a table gets one: a matrix's labels are short and its cells are
    // numbers, and a single column of a grid says nothing about it.
    expect(table.fields[0]!.values).toHaveLength(2)
    expect(portPreview(matrix).facts).toContainEqual({ label: 'Measure', value: 'similarity' })
  })

  it('says only what the headline cannot, for a linkage', () => {
    // `describeValue` already composes "N leaves · method · K clusters"; the panel adds the one
    // thing it says by omission, an uncut tree.
    const tree = {
      kind: 'linkage' as const,
      merges: Float64Array.from([0, 1, 0.5, 2]),
      labels: ['a', 'b'],
      order: Int32Array.from([0, 1]),
      method: 'ward',
    }
    expect(portPreview(tree).facts).toEqual([{ label: 'Cut', value: 'not cut' }])
    expect(portPreview({ ...tree, clusters: Int32Array.from([1, 2]) }).facts).toEqual([])
  })

  it('keeps the head of a long string, which the footer has to elide', () => {
    // A Neuroglancer link carries a whole viewer state — 70 kB on male-CNS — and its beginning
    // is where the origin and the dataset are.
    const url = `https://neuroglancer-demo.appspot.com/#!${'x'.repeat(400)}`
    const preview = portPreview({ kind: 'string', value: url })
    expect(preview.text?.startsWith('https://neuroglancer-demo')).toBe(true)
    expect(preview.facts[0]?.label).toBe('Length')
    // Cut on the way out, not by CSS: the panel measures itself before its first paint, so a
    // 70 kB text node would line-break a few thousand line boxes to paint six.
    expect(preview.text!.length).toBeLessThan(1000)
    // And the fact still reports the *whole* size, so the cut admits to itself.
    expect(preview.facts[0]!.value).toBe(`${url.length.toLocaleString()} characters`)
  })

  it('says something about every kind of value', () => {
    const values: Value[] = [
      NEURONS,
      { ...NEURONS, kind: 'table' },
      makeMatrix(['a'], ['b'], Float64Array.from([1])),
      { kind: 'dataset', sourceId: 'mock', datasetId: 'optic-lobe-mini', label: 'Optic lobe' },
      { kind: 'number', value: 42 },
      { kind: 'string', value: 'short' },
      { kind: 'boolean', value: true },
      {
        kind: 'network',
        directed: false,
        nodes: tableFromRows({ columns: [{ name: 'id', dtype: 'str' }] }, []),
        edges: tableFromRows(
          {
            columns: [
              { name: 'source', dtype: 'str' },
              { name: 'target', dtype: 'str' },
            ],
          },
          [],
        ),
      },
      {
        kind: 'skeletons',
        items: [],
        attributes: NEURONS,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      },
      {
        kind: 'meshes',
        items: [],
        attributes: NEURONS,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      },
      {
        kind: 'points',
        positions: new Float32Array(0),
        attributes: NEURONS,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      },
      { kind: 'layout', positions: { a: { x: 1, y: 2 } }, algorithm: 'ELK layered' },
      {
        kind: 'linkage',
        merges: Float64Array.from([0, 1, 0.5, 2]),
        labels: ['a', 'b'],
        order: Int32Array.from([0, 1]),
        method: 'ward',
      },
      {
        kind: 'transform',
        id: 't',
        source: new Float64Array(3),
        target: new Float64Array(3),
        count: 1,
      },
      { kind: 'layers', items: [{ type: 'segmentation' }] },
    ]
    /*
     * The kinds whose headline is the whole answer, listed rather than derived — a kind that
     * *fell through* to an empty panel would look on screen exactly like the not-run case, and
     * an exemption computed from the output could not tell the two apart. A scalar's headline is
     * its value; the other three are `describeValue` lines the panel would only be taking apart
     * and setting again underneath themselves.
     */
    const HEADLINE_ONLY = new Set([
      'number',
      'string',
      'boolean',
      'layout',
      'transform',
      'layers',
    ])
    expect(values.map((v) => v.kind)).toEqual(expect.arrayContaining([...HEADLINE_ONLY]))
    for (const value of values) {
      const preview = portPreview(value)
      expect(preview.headline.length, value.kind).toBeGreaterThan(0)
      if (HEADLINE_ONLY.has(value.kind)) continue
      const said =
        preview.facts.length + preview.tables.length + (preview.text === undefined ? 0 : 1)
      expect(said, value.kind).toBeGreaterThan(0)
    }
  })
})
