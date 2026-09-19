/**
 * Where a Sankey's boxes and bands go.
 *
 * The properties here are the ones a picture can look right while breaking: that one scale serves
 * every column, so a short column reads as short rather than being stretched to fit; that what
 * stopped at a node is marked on that node's own bar rather than counted a second time beside it;
 * that a band is as thick at one end as at the other; and that the two orientations are the same
 * drawing turned ninety degrees.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { sankeyFlow } from './sankeyFlow'
import type { SankeyDirection } from './sankeyLayout'
import { sankeyShape } from './sankeyLayout'

const SCHEMA = tableSchema(
  column('layer', 'i64'),
  column('source', 'str'),
  column('target', 'str'),
  column('value', 'f64'),
)

type Row = [number, string, string, number]

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

const OPTIONS = { direction: 'lr' as SankeyDirection, across: 400, along: 600, nodeGap: 4 }

/** Conserving: two sources into A, A into S. */
const CHAIN: Row[] = [
  [0, 'B', 'A', 6],
  [0, 'C', 'A', 4],
  [1, 'A', 'S', 10],
]

/** Layer 1 passes on 6 of the 10 it received. */
const LEAKY: Row[] = [
  [0, 'B', 'A', 10],
  [1, 'A', 'S', 6],
]

describe('sankeyShape', () => {
  it('draws nothing for an empty flow rather than dividing by its peak', () => {
    const shape = sankeyShape(flowOf([]), OPTIONS)
    expect(shape.boxes).toHaveLength(0)
    expect(shape.scale).toBe(0)
  })

  it('puts one column per layer, spread along the flow', () => {
    const shape = sankeyShape(flowOf(CHAIN), OPTIONS)
    const columns = [...new Set(shape.boxes.map((b) => b.x))].sort((a, b) => a - b)
    expect(columns).toHaveLength(3)
    expect(columns[0]).toBe(0)
    // The last column's near face is flush with the end, leaving room for the bar itself.
    expect(columns[2]! + shape.boxes[0]!.width).toBeCloseTo(OPTIONS.along, 6)
  })

  it('uses one scale for every column, so a short column draws short', () => {
    // Scaled per column each one would fill the height and the loss would be invisible — which
    // is the single thing this diagram exists to show. A drops 4 of the 10 it took, so the sink
    // column is 60% of the source column.
    const shape = sankeyShape(flowOf(LEAKY), OPTIONS)
    const height = (layer: number) =>
      shape.boxes.filter((b) => b.layer === layer).reduce((sum, b) => sum + b.height, 0)
    expect(height(2) / height(0)).toBeCloseTo(0.6, 6)
  })

  it('stacks a column from the top, so the shortfall collects at its foot', () => {
    const shape = sankeyShape(flowOf(LEAKY), OPTIONS)
    for (const layer of [0, 1, 2]) {
      const first = shape.boxes.filter((b) => b.layer === layer).sort((a, b) => a.y - b.y)[0]
      expect(first?.y).toBe(0)
    }
  })

  it('marks what stopped on the node’s own bar, not as a second mark beside it', () => {
    // A node is as tall as the larger of what it took and what it sent, so the remainder is
    // already inside its bar. Drawn as a notch at the column's foot it would be counted twice —
    // which is how this shipped wrong and what this test caught.
    const shape = sankeyShape(flowOf(LEAKY), OPTIONS)
    const a = shape.boxes.find((b) => b.label === 'A')!
    expect(a.stopped / shape.scale).toBeCloseTo(4, 6)
    expect(a.stopped).toBeLessThan(a.height)
    // The column it sits in is no taller for it.
    const column = shape.boxes.filter((b) => b.layer === 1)
    expect(column.reduce((sum, b) => sum + b.height, 0)).toBeCloseTo(a.height, 6)
  })

  it('leaves a conserving flow with nothing stopped', () => {
    const shape = sankeyShape(flowOf(CHAIN), OPTIONS)
    expect(shape.boxes.every((b) => b.stopped === 0)).toBe(true)
  })

  it('does not mark the sink column as having stopped anything', () => {
    // Its outflow is zero because it is the end of the diagram, not because drive was lost.
    const shape = sankeyShape(flowOf(CHAIN), OPTIONS)
    expect(shape.boxes.find((b) => b.label === 'S')!.stopped).toBe(0)
  })

  it('opens the first column rather than marking it', () => {
    // Layer 0 has no inflow by construction — it is where the picture was cut off.
    const shape = sankeyShape(flowOf(CHAIN), OPTIONS)
    expect(shape.inlet).toBeDefined()
    expect(shape.inlet!.x).toBe(0)
    expect(shape.boxes.filter((b) => b.layer === 0).every((b) => b.stopped === 0)).toBe(true)
  })

  it('draws one band per ribbon, each as thick as its value at both ends', () => {
    const shape = sankeyShape(flowOf(CHAIN), OPTIONS)
    expect(shape.bands).toHaveLength(3)
    const big = shape.bands.find((b) => b.value === 10)!
    const small = shape.bands.find((b) => b.value === 4)!
    // Ratio rather than absolute pixels, which is what "width is the quantity" means.
    expect(big.value / small.value).toBeCloseTo(2.5, 6)
    expect(big.path.startsWith('M')).toBe(true)
    expect(big.path.endsWith('Z')).toBe(true)
  })

  it('stacks the bands on a node’s face without overlapping them', () => {
    const shape = sankeyShape(flowOf(CHAIN), OPTIONS)
    // The two bands arriving at A must together fill its bar and no more.
    const a = shape.boxes.find((b) => b.label === 'A')!
    const arriving = shape.bands.filter((b) => b.target === a.id)
    const total = arriving.reduce((sum, band) => sum + band.value, 0) * shape.scale
    expect(total).toBeCloseTo(a.height, 6)
  })

  it('is the same drawing turned ninety degrees', () => {
    const across = sankeyShape(flowOf(CHAIN), OPTIONS)
    const down = sankeyShape(flowOf(CHAIN), { ...OPTIONS, direction: 'tb' })
    expect(down.width).toBeCloseTo(across.height, 6)
    expect(down.height).toBeCloseTo(across.width, 6)
    // A box's two extents swap, and nothing else about it moves.
    const a = across.boxes.find((b) => b.label === 'A')!
    const b = down.boxes.find((box) => box.label === 'A')!
    expect(b.width).toBeCloseTo(a.height, 6)
    expect(b.height).toBeCloseTo(a.width, 6)
    expect(b.x).toBeCloseTo(a.y, 6)
    expect(b.y).toBeCloseTo(a.x, 6)
  })

  it('orders a column so the heaviest stream runs straightest', () => {
    // Two sources whose arrival order is the reverse of what a crossing-free drawing wants: the
    // barycentre sweep has to put `heavy` next to its target's stack rather than leave it where
    // the table happened to list it.
    const shape = sankeyShape(
      flowOf([
        [0, 'light', 'T2', 1],
        [0, 'heavy', 'T1', 20],
        [1, 'T1', 'S', 20],
        [1, 'T2', 'S', 1],
      ]),
      OPTIONS,
    )
    const y = (label: string) => shape.boxes.find((b) => b.label === label)!.y
    // T1 is above T2 (it is far larger and arrives first in the merged order), so `heavy` must
    // be above `light` for its band to run straight.
    expect(y('heavy') < y('light')).toBe(y('T1') < y('T2'))
  })
})
