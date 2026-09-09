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
import { MAX_COLUMNS, MAX_ROWS, portPreview } from './portPreview'

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

  it('draws a table as rows, with each column typed', () => {
    const preview = portPreview(NEURONS)
    expect(preview.rows).toHaveLength(1)
    const rows = preview.rows[0]!
    expect(rows.columns.map((c) => c.name)).toEqual(['neuronId', 'type', 'size'])
    expect(rows.columns[2]).toMatchObject({ dtype: 'i64', unit: 'nm^3' })
    expect(rows.cells).toHaveLength(2)
    // An id survives whole. It is text everywhere (invariant 8), and a truncated id is not an id.
    expect(rows.cells[0]![0]).toBe('720575940621039145')
    expect(rows.moreRows).toBe(0)
    expect(rows.moreColumns).toBe(0)
  })

  it('drops a column it cannot fit, and counts that one too', () => {
    /*
     * The defect a browser found and the unit suite could not: six columns of ids wanted ~420px
     * in a 360px panel, so CSS cut the sixth mid-cell while the footer said "+1 more columns".
     * A count is only honest if nothing else is dropping columns behind it.
     */
    const wide = tableFromRows(
      {
        columns: Array.from({ length: 8 }, (_, i) => ({
          name: `a_long_column_${i}`,
          dtype: 'str' as const,
        })),
      },
      [
        Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [`a_long_column_${i}`, 'x'.repeat(20)]),
        ),
      ],
    )
    const rows = portPreview(wide).rows[0]!
    expect(rows.columns.length).toBeLessThan(MAX_COLUMNS)
    expect(rows.columns.length).toBeGreaterThan(0)
    // Every column the table has and the panel does not draw, whichever reason it was dropped for.
    expect(rows.columns.length + rows.moreColumns).toBe(8)
    expect(rows.cells[0]).toHaveLength(rows.columns.length)
  })

  it('keeps one column even where that one column is wider than the budget', () => {
    const huge = tableFromRows({ columns: [{ name: 'note', dtype: 'str' }] }, [
      { note: 'x'.repeat(400) },
    ])
    expect(portPreview(huge).rows[0]!.columns).toHaveLength(1)
  })

  it('counts what it is not drawing rather than trailing off', () => {
    const wide = tableFromRows(
      {
        columns: Array.from({ length: 20 }, (_, i) => ({
          name: `c${i}`,
          dtype: 'i64' as const,
        })),
      },
      Array.from({ length: 40 }, () => ({ c0: 1 })),
    )
    const rows = portPreview(wide).rows[0]!
    expect(rows.columns).toHaveLength(MAX_COLUMNS)
    expect(rows.cells).toHaveLength(MAX_ROWS)
    expect(rows.moreColumns).toBe(20 - MAX_COLUMNS)
    expect(rows.moreRows).toBe(40 - MAX_ROWS)
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
    expect(preview.rows.map((r) => r.caption)).toEqual(['Nodes', 'Edges'])
    expect(preview.rows[0]!.columns.map((c) => c.name)).toEqual(['id', 'type'])
    expect(preview.rows[1]!.columns.map((c) => c.name)).toContain('weight')
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
    expect(preview.rows[0]!.columns.map((c) => c.name)).toEqual(['neuronId', 'type', 'size'])
  })

  it('labels a matrix corner, since a bare grid of numbers says nothing', () => {
    const matrix = makeMatrix(
      ['LC4', 'LC6'],
      ['PLP1', 'PLP2'],
      Float64Array.from([1, 2, 3, 4]),
      'synapses',
      'similarity',
    )
    const rows = portPreview(matrix).rows[0]!
    expect(rows.cells[0]).toEqual(['LC4', '1', '2'])
    expect(rows.cells[1]).toEqual(['LC6', '3', '4'])
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
        preview.facts.length + preview.rows.length + (preview.text === undefined ? 0 : 1)
      expect(said, value.kind).toBeGreaterThan(0)
    }
  })
})
