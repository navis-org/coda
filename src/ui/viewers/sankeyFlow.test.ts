/**
 * Reading a table as layered flow.
 *
 * The cases here are the ones where a plausible implementation is quietly wrong: a label that
 * repeats down the diagram merged into one node (which turns the flow into a graph with cycles),
 * a fold that changes a column total (which would make the caption report a leak the data does
 * not have), a sink column counted as a leak, and a first column counted as one too.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { foldSankey, nodeKey, sankeyFlow } from './sankeyFlow'

const SCHEMA = tableSchema(
  column('layer', 'i64'),
  column('source', 'str'),
  column('target', 'str'),
  column('value', 'f64'),
)

type Row = [number, string | null, string | null, number | null]

function flowOf(rows: Row[]) {
  return sankeyFlow(
    tableFromRows(
      SCHEMA,
      rows.map(([layer, source, target, value]) => ({ layer, source, target, value })),
    ),
    {
      layerColumn: 'layer',
      sourceColumn: 'source',
      targetColumn: 'target',
      valueColumn: 'value',
    },
  )
}

/** A chain that conserves: 10 in at layer 0, 10 out at layer 1. */
const CHAIN: Row[] = [
  [0, 'B', 'A', 6],
  [0, 'C', 'A', 4],
  [1, 'A', 'S', 10],
]

describe('sankeyFlow', () => {
  it('makes a node of each (layer, label) pair, so a label may repeat down the diagram', () => {
    // An influence walk is not a BFS, so a cell type carries drive at several depths. Keyed on
    // the label alone these merge into one node and the flow acquires a cycle.
    const flow = flowOf([
      [0, 'M', 'X', 5],
      [1, 'X', 'M', 5],
      [2, 'M', 'S', 5],
    ])
    const labels = flow.nodes.filter((n) => n.label === 'M').map((n) => n.layer)
    expect(labels.sort()).toEqual([0, 2])
    expect(flow.nodes.map((n) => n.id)).toContain(nodeKey(2, 'M'))
  })

  it('sizes a node by the larger of what it receives and what it passes on', () => {
    const flow = flowOf(CHAIN)
    const a = flow.nodes.find((n) => n.label === 'A')!
    expect(a).toMatchObject({ in: 10, out: 10, size: 10 })
    const s = flow.nodes.find((n) => n.label === 'S')!
    // A sink has no outflow and must still have a height, or the last column vanishes.
    expect(s).toMatchObject({ in: 10, out: 0, size: 10 })
  })

  it('reports no leak on a flow that conserves', () => {
    const flow = flowOf(CHAIN)
    expect(flow.shortfall.size).toBe(0)
    expect(flow.leak).toBe(0)
  })

  it('counts a column that passes on less than it received', () => {
    const flow = flowOf([
      [0, 'B', 'A', 10],
      [1, 'A', 'S', 6],
    ])
    expect(flow.shortfall.get(1)).toBeCloseTo(4, 10)
    expect(flow.leak).toBeCloseTo(0.4, 10)
  })

  it('does not call the sink column a leak', () => {
    // The last column has no outflow at all. Reported as a shortfall it would make every
    // conserving diagram look like it lost everything at the end.
    const flow = flowOf(CHAIN)
    expect(flow.shortfall.has(2)).toBe(false)
  })

  it('does not call the first column a leak either', () => {
    // Layer 0 has no inflow by construction — it is where the picture was cut off, not a loss.
    const flow = flowOf(CHAIN)
    expect(flow.shortfall.has(0)).toBe(false)
  })

  it('counts a row it cannot use rather than dropping it in silence', () => {
    const flow = flowOf([
      [0, 'B', 'A', 6],
      [0, null, 'A', 4],
      [0, 'C', null, 4],
      [0, 'D', 'A', 0],
      [0, 'E', 'A', null],
    ])
    expect(flow.dropped).toBe(4)
    expect(flow.ribbons).toHaveLength(1)
  })

  it('answers empty for unresolved pickers rather than throwing', () => {
    const table = tableFromRows(SCHEMA, [{ layer: 0, source: 'a', target: 'b', value: 1 }])
    expect(
      sankeyFlow(table, {
        layerColumn: undefined,
        sourceColumn: 'source',
        targetColumn: 'target',
      }).nodes,
    ).toHaveLength(0)
  })

  it('renumbers layers densely, so 0/2/5 draw as three adjacent columns', () => {
    const flow = flowOf([
      [0, 'A', 'B', 1],
      [2, 'B', 'C', 1],
      [5, 'C', 'D', 1],
    ])
    expect(flow.layerCount).toBe(4)
    expect(flow.ribbons.map((r) => r.layer)).toEqual([0, 1, 2])
  })
})

describe('foldSankey', () => {
  /** Five sources into one target, so a fold of two leaves three plus an "others" box. */
  const WIDE: Row[] = [
    [0, 'a', 'T', 10],
    [0, 'b', 'T', 8],
    [0, 'c', 'T', 3],
    [0, 'd', 'T', 2],
    [0, 'e', 'T', 1],
  ]

  it('keeps the largest and folds the tail', () => {
    const folded = foldSankey(flowOf(WIDE), 2)
    const first = folded.nodes.filter((n) => n.layer === 0)
    expect(first.map((n) => n.label)).toEqual(['a', 'b', '+3 others'])
    expect(first.find((n) => n.folded.length > 0)?.folded).toEqual(['c', 'd', 'e'])
  })

  it('preserves the column total exactly, which is what makes folding safe here', () => {
    // `out.flowChart`'s fold had to be lossy because its boxes carry no additive quantity. Here
    // the quantity *is* the mark, so a fold that changed a total would make the caption report a
    // leak the data does not have.
    const before = flowOf(WIDE)
    const after = foldSankey(before, 2)
    const total = (flow: typeof before, layer: number) =>
      flow.nodes.filter((n) => n.layer === layer).reduce((sum, n) => sum + n.size, 0)
    expect(total(after, 0)).toBeCloseTo(total(before, 0), 10)
    expect(total(after, 1)).toBeCloseTo(total(before, 1), 10)
    expect(after.leak).toBeCloseTo(before.leak, 10)
  })

  it('merges the ribbons behind a folded box and says how many', () => {
    const folded = foldSankey(flowOf(WIDE), 2)
    const merged = folded.ribbons.find((r) => r.source === nodeKey(0, ' others'))!
    expect(merged.value).toBe(6)
    expect(merged.merged).toBe(3)
    // A merged ribbon is nobody's row: borrowing the first would point colour and tooltip at one
    // arbitrary member.
    expect(merged.row).toBe(-1)
  })

  it('leaves a column that already fits untouched', () => {
    const flow = flowOf(CHAIN)
    expect(foldSankey(flow, 5)).toBe(flow)
  })

  it('keeps the data’s own order among the survivors, not the ranking’s', () => {
    // The ranking decides *which* boxes stay, never where they sit.
    const folded = foldSankey(
      flowOf([
        [0, 'small', 'T', 1],
        [0, 'big', 'T', 10],
        [0, 'tiny', 'T', 0.5],
      ]),
      2,
    )
    expect(folded.nodes.filter((n) => n.layer === 0).map((n) => n.label)).toEqual([
      'small',
      'big',
      '+1 others',
    ])
  })
})
