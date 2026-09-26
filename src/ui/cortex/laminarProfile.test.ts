/**
 * Laminar Profile's headless half: the depth axis covers the frame and any value beyond it, and a
 * layer's count and its stored range agree with `layerOf` — so clicking a layer's count selects
 * exactly the rows the count says.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import { encodeRange, rowsInRanges } from '../../nodes/lib/chartSelection'
import { frameFor, layerOf } from '../../packs/cortex/frames'
import { facetGrid, facetGroups, layerCounts, profileScale } from './laminarProfile'
import { rowScale } from './wall'

const MINNIE = frameFor('cave', 'minnie65_public:1822')!

describe('the depth axis', () => {
  it('is the gallery’s row where the data fits inside it', () => {
    expect(profileScale(MINNIE, 20, 600, 300)).toEqual(rowScale(MINNIE, 300))
  })

  it('widens to take a value beyond the frame, either way', () => {
    const scale = profileScale(MINNIE, -100, 1200, 260)
    expect(scale.top).toBe(-100)
    expect(scale.top + 260 / scale.pxPerUm).toBeCloseTo(1200, 6)
  })

  it('is the data’s own extent without a frame', () => {
    const scale = profileScale(undefined, 100, 300, 200)
    expect(scale).toEqual({ top: 100, pxPerUm: 1 })
  })
})

describe('a layer’s count', () => {
  const depths = [-60, -10, 30, 100, 226.4, 400, 520, 700, 900, 5000]

  it('counts what `layerOf` places, and nothing it does not', () => {
    const counts = layerCounts(MINNIE, depths)
    expect(counts.map((c) => c.name)).toEqual(MINNIE.layers.map((l) => l.name))
    for (const layer of counts) {
      expect(layer.count).toBe(depths.filter((d) => layerOf(MINNIE, d) === layer.name).length)
    }
    // -60 µm is above the allowance: no layer, so in no count.
    expect(counts.reduce((sum, c) => sum + c.count, 0)).toBe(depths.length - 1)
  })

  it('selects, as a stored range, exactly the rows it counted', () => {
    const table = makeTable(tableSchema(column('depth', 'f64')), { depth: depths })
    for (const layer of layerCounts(MINNIE, depths)) {
      const selected = rowsInRanges(table, 'depth', [encodeRange(layer.range)])
      expect(selected.length, layer.name).toBe(layer.count)
    }
  })
})

describe('facets', () => {
  const table = makeTable(tableSchema(column('type', 'str')), {
    type: ['BC', '23P', 'BC', null, 'MC', 'MC', 'BC'],
  })

  it('ranks panels largest first, ties by name, the no-value panel last', () => {
    expect(facetGroups(table, 'type').map((f) => [f.label, f.rows])).toEqual([
      ['BC', [0, 2, 6]],
      ['MC', [4, 5]],
      ['23P', [1]],
      ['—', [3]],
    ])
  })

  it('tiles as many panels across as fit, never more than there are', () => {
    expect(facetGrid(3, 1000, 12)).toMatchObject({ columns: 3, rows: 1 })
    // Four at 150 px is 600, and the gaps take it past 620: three across, each wider than 150.
    const grid = facetGrid(12, 620, 12)
    expect(grid).toMatchObject({ columns: 3, rows: 4 })
    expect(grid.panelWidth).toBeGreaterThanOrEqual(150)
    expect(facetGrid(5, 80, 12)).toMatchObject({ columns: 1, rows: 5 })
  })
})
