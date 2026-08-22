/**
 * The shared visual-encoding layer.
 *
 * This is the piece both cornerstone widgets lean on, so the palette rules are pinned down
 * here rather than trusted to each viewer: eight categorical slots in fixed order, a ninth
 * folding into an achromatic Other, ranking by frequency so the commonest values get the
 * most distinguishable hues, and a legend whenever colour carries meaning.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../core/types'
import { tableFromRows } from '../core/values'
import { MAX_SERIES, OTHER_LABEL, seriesColor } from './colors'
import { clusterColor, hexToRgbFloat, literalColor, resolveColor, resolveSize } from './encoding'

const SCHEMA = tableSchema(column('id', 'str'), column('type', 'str'), column('weight', 'f64'))

function table(rows: Array<{ id: string; type: string | null; weight: number | null }>) {
  return tableFromRows(SCHEMA, rows)
}

describe('resolveColor', () => {
  const data = table([
    { id: 'a', type: 'LC4', weight: 10 },
    { id: 'b', type: 'LC4', weight: 20 },
    { id: 'c', type: 'LC6', weight: 30 },
  ])

  it('returns a flat colour in constant mode and no legend', () => {
    const result = resolveColor(
      data,
      { mode: 'constant', column: undefined, constant: '0' },
      'dark',
    )
    expect(result.at(0)).toBe(seriesColor(0, 'dark'))
    expect(result.at(2)).toBe(seriesColor(0, 'dark'))
    expect(result.legend).toBeUndefined()
  })

  it('supports an achromatic constant', () => {
    const result = resolveColor(
      data,
      { mode: 'constant', column: undefined, constant: 'muted' },
      'dark',
    )
    expect(result.at(0)).toBe('#898781')
  })

  it('assigns categorical slots by frequency, commonest first', () => {
    const result = resolveColor(
      data,
      { mode: 'categorical', column: 'type', constant: '0' },
      'dark',
    )
    // LC4 appears twice, so it takes slot 0.
    expect(result.at(0)).toBe(seriesColor(0, 'dark'))
    expect(result.at(1)).toBe(seriesColor(0, 'dark'))
    expect(result.at(2)).toBe(seriesColor(1, 'dark'))
  })

  it('emits a categorical legend, because colour must never be the only channel', () => {
    const result = resolveColor(
      data,
      { mode: 'categorical', column: 'type', constant: '0' },
      'dark',
    )
    expect(result.legend?.kind).toBe('categorical')
    if (result.legend?.kind !== 'categorical') throw new Error('expected categorical')
    expect(result.legend.entries.map((e) => e.label)).toEqual(['LC4', 'LC6'])
    expect(result.legend.truncated).toBe(false)
  })

  it('folds a ninth category into an achromatic Other rather than reusing a hue', () => {
    // Distinct frequencies, so the ranking is unambiguous rather than decided by the
    // label tie-break: type i appears (12 - i) times, so rank == i.
    const rows: Array<{ id: string; type: string; weight: number }> = []
    for (let type = 0; type < 12; type++) {
      for (let n = 0; n < 12 - type; n++) {
        rows.push({ id: `n${type}-${n}`, type: `T${type}`, weight: type })
      }
    }
    const many = table(rows)
    const rankOf = (type: number) => rows.findIndex((r) => r.type === `T${type}`)
    const result = resolveColor(
      many,
      { mode: 'categorical', column: 'type', constant: '0' },
      'dark',
    )
    if (result.legend?.kind !== 'categorical') throw new Error('expected categorical')

    expect(result.legend.truncated).toBe(true)
    expect(result.legend.entries).toHaveLength(MAX_SERIES + 1)
    expect(result.legend.entries.at(-1)?.label).toBe(OTHER_LABEL)
    // Ranks 0-7 keep their slot; rank 8 onward is grey. A repeated hue would imply two
    // categories are the same thing.
    expect(result.at(rankOf(7))).toBe(seriesColor(7, 'dark'))
    expect(result.at(rankOf(8))).toBe('#898781')
    expect(result.at(rankOf(11))).toBe('#898781')

    const used = result.legend.entries.slice(0, MAX_SERIES).map((e) => e.color)
    expect(new Set(used).size).toBe(MAX_SERIES)
  })

  it('maps a numeric column onto a single-hue ramp with a domain legend', () => {
    const result = resolveColor(
      data,
      { mode: 'sequential', column: 'weight', constant: '0' },
      'dark',
    )
    expect(result.legend?.kind).toBe('sequential')
    if (result.legend?.kind !== 'sequential') throw new Error('expected sequential')
    expect(result.legend.domain).toEqual([10, 30])
    expect(result.legend.stops).toHaveLength(9)
    // Low and high ends differ; the middle sits between them.
    expect(result.at(0)).not.toBe(result.at(2))
  })

  it('greys out nulls in a sequential encoding rather than treating them as zero', () => {
    const withNull = table([
      { id: 'a', type: 'x', weight: 10 },
      { id: 'b', type: 'x', weight: null },
    ])
    const result = resolveColor(
      withNull,
      { mode: 'sequential', column: 'weight', constant: '0' },
      'dark',
    )
    expect(result.at(1)).toBe('#898781')
  })

  it('degrades to the constant colour when the column has gone', () => {
    const result = resolveColor(
      data,
      { mode: 'categorical', column: 'gone', constant: '2' },
      'dark',
    )
    expect(result.at(0)).toBe(seriesColor(2, 'dark'))
    expect(result.legend).toBeUndefined()
  })

  it('degrades when there is no attribute table at all', () => {
    const result = resolveColor(
      undefined,
      { mode: 'categorical', column: 'type', constant: '0' },
      'dark',
    )
    expect(result.at(0)).toBe(seriesColor(0, 'dark'))
  })

  it('picks mode-appropriate hues for light and dark', () => {
    const spec = { mode: 'categorical' as const, column: 'type', constant: '0' }
    expect(resolveColor(data, spec, 'light').at(0)).not.toBe(
      resolveColor(data, spec, 'dark').at(0),
    )
  })
})

describe('resolveSize', () => {
  const data = table([
    { id: 'a', type: 'x', weight: 0 },
    { id: 'b', type: 'x', weight: 50 },
    { id: 'c', type: 'x', weight: 100 },
  ])

  it('is constant at the minimum when no column is chosen', () => {
    const result = resolveSize(data, { column: undefined, min: 4, max: 20 })
    expect(result.at(0)).toBe(4)
    expect(result.at(2)).toBe(4)
    expect(result.domain).toBeUndefined()
  })

  it('spans the range across the column domain', () => {
    const result = resolveSize(data, { column: 'weight', min: 4, max: 20 })
    expect(result.at(0)).toBe(4)
    expect(result.at(2)).toBe(20)
    expect(result.domain).toEqual([0, 100])
  })

  it('scales by area, so the midpoint is not the middle radius', () => {
    const result = resolveSize(data, { column: 'weight', min: 0, max: 100 })
    // sqrt(0.5) ≈ 0.707 — a value scaling with area, which is what readers compare.
    expect(result.at(1)).toBeCloseTo(70.71, 1)
  })

  it('can scale linearly, which is right for line widths', () => {
    const result = resolveSize(
      data,
      { column: 'weight', min: 0, max: 100 },
      { areaScaled: false },
    )
    expect(result.at(1)).toBeCloseTo(50, 5)
  })

  it('falls back to the minimum for a missing column or a null cell', () => {
    expect(resolveSize(data, { column: 'nope', min: 3, max: 9 }).at(0)).toBe(3)
    const withNull = table([
      { id: 'a', type: 'x', weight: null },
      { id: 'b', type: 'x', weight: 10 },
    ])
    expect(resolveSize(withNull, { column: 'weight', min: 3, max: 9 }).at(0)).toBe(3)
  })

  it('handles a zero-width domain without dividing by zero', () => {
    const flat = table([
      { id: 'a', type: 'x', weight: 7 },
      { id: 'b', type: 'x', weight: 7 },
    ])
    const result = resolveSize(flat, { column: 'weight', min: 5, max: 15 })
    expect(Number.isFinite(result.at(0))).toBe(true)
  })
})

describe('hexToRgbFloat', () => {
  it('converts to the 0..1 triplet three.js buffers want', () => {
    expect(hexToRgbFloat('#ffffff')).toEqual([1, 1, 1])
    expect(hexToRgbFloat('#000000')).toEqual([0, 0, 0])
    const [r, g, b] = hexToRgbFloat('#3987e5')
    expect(r).toBeCloseTo(0x39 / 255, 5)
    expect(g).toBeCloseTo(0x87 / 255, 5)
    expect(b).toBeCloseTo(0xe5 / 255, 5)
  })

  it('expands shorthand and survives nonsense', () => {
    expect(hexToRgbFloat('#fff')).toEqual([1, 1, 1])
    expect(hexToRgbFloat('not-a-colour')).toEqual([1, 1, 1])
  })
})

// ---------------------------------------------------------------------------
// Colours somebody else already decided
// ---------------------------------------------------------------------------

describe('literalColor', () => {
  it('takes the three hex forms this palette actually emits', () => {
    expect(literalColor('#3987e5')).toBe('#3987e5')
    expect(literalColor('#abc')).toBe('#abc')
    // `withAlpha` produces eight digits, and a link colour arrives that way.
    expect(literalColor('#3987e5cc')).toBe('#3987e5cc')
    expect(literalColor('  #3987E5  ')).toBe('#3987E5')
  })

  it('refuses anything that is not one, rather than coercing it', () => {
    // A column of cell types under this mode is a mistake. Painting it grey says so, where
    // hashing the text into a hue would produce a picture that looks deliberate.
    expect(literalColor('LC4')).toBeUndefined()
    expect(literalColor('red')).toBeUndefined()
    expect(literalColor('3987e5')).toBeUndefined()
    expect(literalColor('#12345')).toBeUndefined()
    expect(literalColor(null)).toBeUndefined()
    expect(literalColor(42)).toBeUndefined()
  })
})

describe('clusterColor', () => {
  it('gives cluster 1 the leading slot, so the leftmost group leads', () => {
    expect(clusterColor(1, 'dark')).toBe(seriesColor(0, 'dark'))
    expect(clusterColor(2, 'dark')).toBe(seriesColor(1, 'dark'))
  })

  it('cycles past the eighth rather than going achromatic', () => {
    // The one place this departs from `resolveColor`'s categorical rule, and deliberately:
    // clusters sit in leaf order along one axis, so two sharing a hue are visibly far apart.
    expect(clusterColor(MAX_SERIES + 1, 'dark')).toBe(seriesColor(0, 'dark'))
  })

  it('gives an uncut leaf the achromatic ink, not a palette slot', () => {
    // Belonging to no group is not being a ninth category.
    expect(clusterColor(0, 'dark')).not.toBe(seriesColor(0, 'dark'))
    expect(clusterColor(0, 'dark')).toBe(clusterColor(-1, 'dark'))
  })

  it('follows the theme, which is why the node pins one', () => {
    expect(clusterColor(1, 'light')).not.toBe(clusterColor(1, 'dark'))
  })
})

describe('resolveColor — literal', () => {
  const table = tableFromRows(
    tableSchema(column('neuronId', 'i64'), column('color', 'str')),
    [
      { neuronId: 1, color: '#3987e5' },
      { neuronId: 2, color: '#d95926' },
      { neuronId: 3, color: 'not a colour' },
      { neuronId: 4, color: null },
    ],
  )

  it('uses the cells as they stand', () => {
    const resolved = resolveColor(table, { mode: 'literal', column: 'color', constant: '0' }, 'dark')
    expect(resolved.at(0)).toBe('#3987e5')
    expect(resolved.at(1)).toBe('#d95926')
  })

  it('does not rank by frequency, which is the whole reason the mode exists', () => {
    /*
     * `categorical` gives the most common value the leading slot. A dendrogram numbers its
     * clusters left to right, so colouring by the cluster *number* hands the biggest group the
     * hue the first group was drawn in — the two agree only by luck.
     */
    const many = tableFromRows(tableSchema(column('color', 'str')), [
      { color: '#d95926' },
      { color: '#d95926' },
      { color: '#3987e5' },
    ])
    const literal = resolveColor(many, { mode: 'literal', column: 'color', constant: '0' }, 'dark')
    expect(literal.at(2)).toBe('#3987e5')

    const categorical = resolveColor(
      many,
      { mode: 'categorical', column: 'color', constant: '0' },
      'dark',
    )
    // The commonest value takes slot 0, so the rarer one is *not* the colour it names.
    expect(categorical.at(2)).not.toBe('#3987e5')
  })

  it('greys a cell that is not a colour, and a null', () => {
    const resolved = resolveColor(table, { mode: 'literal', column: 'color', constant: '0' }, 'dark')
    expect(resolved.at(2)).toBe(resolved.at(3))
    expect(resolved.at(2)).not.toBe('#3987e5')
  })

  it('offers no legend, because a hex is not a name', () => {
    // Every swatch would be labelled with the colour beside it.
    expect(
      resolveColor(table, { mode: 'literal', column: 'color', constant: '0' }, 'dark').legend,
    ).toBeUndefined()
  })

  it('falls back to the flat colour with no column picked', () => {
    const resolved = resolveColor(table, { mode: 'literal', column: undefined, constant: '0' }, 'dark')
    expect(resolved.at(0)).toBe(resolved.at(2))
  })
})
