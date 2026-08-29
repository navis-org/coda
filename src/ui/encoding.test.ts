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
import { makeTable, tableFromRows } from '../core/values'
import {
  CHART_INK,
  MAX_SERIES,
  OTHER_LABEL,
  cycleColor,
  foldByRank,
  paletteColors,
  seriesColor,
} from './colors'
import {
  LEGEND_KEYS,
  MARKER_SHAPES,
  MAX_SHAPES,
  OTHER_SHAPE,
  clusterColor,
  hexToRgbFloat,
  literalColor,
  resolveColor,
  resolveShape,
  resolveSize,
} from './encoding'
import { segmentColor } from './segmentColor'
import type { ShapeSpec } from '../nodes/lib/encodingParams'
import { readOverrides } from '../nodes/lib/encodingParams'

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

    // Twelve categories, eight colours in the default palette: the ninth comes round to the
    // first rather than folding into grey. A grey lump said only "not one of the eight", which
    // on a connectome's cell types is most of the picture.
    expect(result.legend.entries.map((e) => e.label)).not.toContain(OTHER_LABEL)
    expect(result.at(rankOf(7))).toBe(cycleColor(7, 'dark'))
    expect(result.at(rankOf(8))).toBe(cycleColor(0, 'dark'))
    expect(result.at(rankOf(11))).toBe(cycleColor(3, 'dark'))

    // The first pass round the ramp is still eight distinct hues, ranked so the commonest
    // values get them.
    const used = result.legend.entries.slice(0, MAX_SERIES).map((e) => e.color)
    expect(new Set(used).size).toBe(MAX_SERIES)

    // Twelve values, twelve keys — the cap is on the strip, not on the palette — and the
    // caption's `colours repeat` note hangs off `cycled`.
    expect(result.legend.entries).toHaveLength(LEGEND_KEYS)
    expect(result.legend.truncated).toBe(false)
    expect(result.legend.cycled).toBe(true)
  })

  it('cycles a chosen palette rather than the default one', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      type: `T${i}`,
      weight: 12 - i,
    }))
    const result = resolveColor(
      table(rows),
      { mode: 'categorical', column: 'type', constant: '0', palette: 'tab20' },
      'dark',
    )
    // Twenty hues, so twelve categories fit without repeating — which is the whole reason the
    // dropdown exists.
    const colors = new Set(rows.map((_, i) => result.at(i)))
    expect(colors.size).toBe(12)
    expect(result.legend?.kind === 'categorical' && result.legend.cycled).toBe(false)
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

describe('resolveColor — legend keys and overrides', () => {
  const data = table([
    { id: 'a', type: 'LC4', weight: 10 },
    { id: 'b', type: 'LC4', weight: 20 },
    { id: 'c', type: 'LC6', weight: 30 },
  ])

  it('says which key a row belongs to, which is what an interactive legend needs', () => {
    const result = resolveColor(data, { mode: 'categorical', column: 'type', constant: '0' }, 'dark')
    expect([0, 1, 2].map((i) => result.labelAt?.(i))).toEqual(['LC4', 'LC4', 'LC6'])
  })

  it('answers with its own value past the palette, because nothing is folded any more', () => {
    // Nine categories over eight colours. The ninth shares a hue with the first, but it is not
    // *in* a bucket with it: hiding or selecting one must not take the other with it, which is
    // exactly what an `Other` key used to do.
    const many = table(
      Array.from({ length: 9 }, (_, i) => ({ id: String(i), type: `T${i}`, weight: i })),
    )
    const result = resolveColor(many, { mode: 'categorical', column: 'type', constant: '0' }, 'dark')
    const labels = Array.from({ length: 9 }, (_, i) => result.labelAt?.(i))
    expect(labels).toEqual(Array.from({ length: 9 }, (_, i) => `T${i}`))
    expect(labels).not.toContain(OTHER_LABEL)
  })

  it('has no keys to offer where there is no legend', () => {
    for (const spec of [
      { mode: 'constant', column: undefined, constant: '0' },
      { mode: 'sequential', column: 'weight', constant: '0' },
      { mode: 'literal', column: 'type', constant: '0' },
    ] as const) {
      expect(resolveColor(data, spec, 'dark').labelAt).toBeUndefined()
    }
  })

  it('lets a hand-picked colour win, for the mark and its key alike', () => {
    // Both halves, in one test on purpose: a legend that disagrees with the thing it keys is
    // the failure this override exists inside `resolveColor` to prevent.
    const result = resolveColor(
      data,
      { mode: 'categorical', column: 'type', constant: '0', overrides: { LC4: '#123456' } },
      'dark',
    )
    expect(result.at(0)).toBe('#123456')
    expect(result.at(2)).toBe(seriesColor(1, 'dark'))
    if (result.legend?.kind !== 'categorical') throw new Error('expected categorical')
    expect(result.legend.entries.map((e) => e.color)).toEqual([
      '#123456',
      seriesColor(1, 'dark'),
    ])
  })

  it('ignores an override that is not a colour rather than painting the text', () => {
    const result = resolveColor(
      data,
      { mode: 'categorical', column: 'type', constant: '0', overrides: { LC4: 'reddish' } },
      'dark',
    )
    expect(result.at(0)).toBe(seriesColor(0, 'dark'))
  })
})

describe('resolveColor — hash', () => {
  const data = table([
    { id: 'a', type: 'LC4', weight: 10 },
    { id: 'b', type: 'LC4', weight: 20 },
    { id: 'c', type: 'LC6', weight: 30 },
  ])
  const spec = { mode: 'hash', column: 'id', constant: '0' } as const

  it('takes its colour from the value, so no two ids share one', () => {
    const result = resolveColor(data, spec, 'dark')
    expect([0, 1, 2].map((i) => result.at(i))).toEqual(
      ['a', 'b', 'c'].map((id) => segmentColor(id)),
    )
  })

  it('does not answer to the theme, unlike every palette mode', () => {
    // A hash colour is the id's, not the surface's. Flipping it by mode would be the one thing
    // that could make the same neuron a different colour in two Coda cards.
    expect(resolveColor(data, spec, 'light').at(0)).toBe(resolveColor(data, spec, 'dark').at(0))
  })

  it('hands out a colour per value where categorical only has a palette to cycle', () => {
    // Still the difference between the two modes, and still the reason `hash` exists — but the
    // categorical side is now eight hues coming round rather than eight plus one grey.
    const many = table(
      Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, type: `T${i}`, weight: i })),
    )
    const hashed = resolveColor(many, { mode: 'hash', column: 'id', constant: '0' }, 'dark')
    const cycled = resolveColor(many, { mode: 'categorical', column: 'id', constant: '0' }, 'dark')

    const hashedColors = new Set(Array.from({ length: 20 }, (_, i) => hashed.at(i)))
    const cycledColors = new Set(Array.from({ length: 20 }, (_, i) => cycled.at(i)))
    expect(hashedColors.size).toBe(20)
    expect(cycledColors.size).toBe(MAX_SERIES)
  })

  it('gives every distinct value its own key, which is what makes hiding work per neuron', () => {
    const result = resolveColor(data, spec, 'dark')
    expect([0, 1, 2].map((i) => result.labelAt?.(i))).toEqual(['a', 'b', 'c'])
  })

  it('lists the first few in table order and admits to the rest', () => {
    /*
     * First-appearance rather than by frequency, which is the opposite of `categorical`. There
     * the ranking decides which values get the most distinguishable slots; here there are no
     * slots, so the only ordering that carries information is the table's own.
     */
    const many = table(
      Array.from({ length: LEGEND_KEYS + 5 }, (_, i) => ({
        id: `n${i}`,
        type: 'T',
        weight: i,
      })),
    )
    const legend = resolveColor(many, spec, 'dark').legend
    if (legend?.kind !== 'categorical') throw new Error('expected categorical')
    expect(legend.entries).toHaveLength(LEGEND_KEYS)
    expect(legend.entries[0]?.label).toBe('n0')
    expect(legend.truncated).toBe(true)
    // And no `Other`: the unlisted ones keep their own colours, so folding them under a grey
    // key would be a claim about the picture that is not true. What the strip owes instead is
    // the count, which is the difference between "twelve neurons" and "twelve of seventeen".
    expect(legend.entries.map((e) => e.label)).not.toContain(OTHER_LABEL)
    expect(legend.unlisted).toBe(5)
  })

  it('has nothing unlisted when every value fits', () => {
    const legend = resolveColor(data, spec, 'dark').legend
    if (legend?.kind !== 'categorical') throw new Error('expected categorical')
    expect(legend.unlisted).toBe(0)
    expect(legend.truncated).toBe(false)
  })

  it('paints a null grey rather than hashing the word for it', () => {
    const withNull = table([{ id: 'a', type: null, weight: 1 }])
    const result = resolveColor(withNull, { mode: 'hash', column: 'type', constant: '0' }, 'dark')
    expect(result.at(0)).toBe(CHART_INK.dark.muted)
  })

  it('still yields to a hand-picked colour', () => {
    const result = resolveColor(
      data,
      { mode: 'hash', column: 'id', constant: '0', overrides: { a: '#123456' } },
      'dark',
    )
    expect(result.at(0)).toBe('#123456')
    expect(result.at(1)).toBe(segmentColor('b'))
  })

  it('falls back to the constant when there is no column to hash', () => {
    const result = resolveColor(data, { mode: 'hash', column: undefined, constant: '1' }, 'dark')
    expect(result.at(0)).toBe(seriesColor(1, 'dark'))
    expect(result.legend).toBeUndefined()
  })
})

describe('readOverrides', () => {
  it('reads the map the legend writes', () => {
    expect(readOverrides('{"LC4":"#ff0000"}')).toEqual({ LC4: '#ff0000' })
  })

  it('treats anything unreadable as no overrides, since it lives in a saved file', () => {
    for (const value of ['', '   ', 'not json', '[1,2]', '"a string"', 'null', undefined, 42]) {
      expect(readOverrides(value)).toEqual({})
    }
  })

  it('drops non-string values but keeps the rest of the map', () => {
    expect(readOverrides('{"a":"#fff","b":7}')).toEqual({ a: '#fff' })
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
  const table = tableFromRows(tableSchema(column('neuronId', 'i64'), column('color', 'str')), [
    { neuronId: 1, color: '#3987e5' },
    { neuronId: 2, color: '#d95926' },
    { neuronId: 3, color: 'not a colour' },
    { neuronId: 4, color: null },
  ])

  it('uses the cells as they stand', () => {
    const resolved = resolveColor(
      table,
      { mode: 'literal', column: 'color', constant: '0' },
      'dark',
    )
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
    const literal = resolveColor(
      many,
      { mode: 'literal', column: 'color', constant: '0' },
      'dark',
    )
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
    const resolved = resolveColor(
      table,
      { mode: 'literal', column: 'color', constant: '0' },
      'dark',
    )
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
    const resolved = resolveColor(
      table,
      { mode: 'literal', column: undefined, constant: '0' },
      'dark',
    )
    expect(resolved.at(0)).toBe(resolved.at(2))
  })
})

/**
 * The eight-slots-plus-achromatic rule, which four charts now depend on.
 *
 * `colors.ts`'s header calls the palette validated and the cap load-bearing, and until
 * `foldByRank` existed the rule was enforced by four copies of one loop and by nothing else.
 * Two of those copies had already drifted apart on the tie-break, which is the case below that
 * would have caught it.
 */
describe('foldByRank', () => {
  const totals = (...pairs: [string, number][]) => new Map(pairs)

  it('ranks by size and keeps the cap', () => {
    const fold = foldByRank(totals(['a', 1], ['b', 9], ['c', 5]), 2)
    expect(fold.kept).toEqual(['b', 'c'])
    expect(fold.tail).toEqual(['a'])
    expect(fold.folded).toBe(true)
  })

  it('breaks a tie by label, so insertion order cannot pick the colours', () => {
    // The drift this exists to prevent: a backend returning the same two categories in the
    // other order would otherwise swap their hues with nothing about the data having changed.
    const one = foldByRank(totals(['zebra', 5], ['alpha', 5]))
    const other = foldByRank(totals(['alpha', 5], ['zebra', 5]))
    expect(one.kept).toEqual(other.kept)
    expect(one.kept).toEqual(['alpha', 'zebra'])
  })

  it('gives a folded name the achromatic residual slot rather than a ninth hue', () => {
    const fold = foldByRank(totals(...Array.from({ length: 12 }, (_, i): [string, number] => [`t${i}`, 12 - i])))
    expect(fold.kept).toHaveLength(MAX_SERIES)
    expect(fold.slotOf('t11')).toBe(MAX_SERIES)
    expect(seriesColor(fold.slotOf('t11'), 'dark')).toBe(seriesColor(99, 'dark'))
  })

  it('adds Other to the legend only when something folded', () => {
    expect(foldByRank(totals(['a', 1])).legend).toEqual(['a'])
    expect(foldByRank(totals(['a', 1], ['b', 2]), 1).legend).toEqual(['b', OTHER_LABEL])
  })

  it('answers empty for an empty tally rather than inventing a residual', () => {
    const fold = foldByRank(totals())
    expect(fold.kept).toEqual([])
    expect(fold.legend).toEqual([])
    expect(fold.folded).toBe(false)
  })
})

/**
 * The palette table.
 *
 * Values are transcribed from published sets and the *order* is ours — see the note in
 * `colors.ts`. What is worth pinning is the part a careless edit breaks silently: the sizes,
 * which is what somebody chooses a palette by; that the saturated half of the two interleaved
 * imports comes first, since `resolveColor` gives the leading slots to the commonest values;
 * and that everything in every palette is a distinct, well-formed colour.
 */
describe('categorical palettes', () => {
  const sizes = { coda: 8, okabeIto: 8, tableau10: 10, paired: 12, tab20: 20 } as const

  it('is the size its label advertises', () => {
    for (const [name, size] of Object.entries(sizes)) {
      expect(paletteColors(name as keyof typeof sizes, 'dark')).toHaveLength(size)
      expect(paletteColors(name as keyof typeof sizes, 'light')).toHaveLength(size)
    }
  })

  it('holds distinct, well-formed colours throughout', () => {
    for (const name of Object.keys(sizes) as Array<keyof typeof sizes>) {
      for (const mode of ['light', 'dark'] as const) {
        const colors = paletteColors(name, mode)
        expect(colors.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true)
        expect(new Set(colors).size).toBe(colors.length)
      }
    }
  })

  it('puts tab20’s saturated half first, which is tableau10 exactly', () => {
    // Published interleaved, so the two commonest categories would otherwise land on two
    // shades of one blue. Rotating it makes the two palettes agree for the first ten.
    expect(paletteColors('tab20', 'dark').slice(0, 10)).toEqual(paletteColors('tableau10', 'dark'))
  })

  it('reads an unknown or missing name as the default rather than throwing', () => {
    // A saved graph can name a palette a later build removed, and a graph saved before the
    // dropdown existed names none at all.
    expect(paletteColors(undefined, 'dark')).toEqual(paletteColors('coda', 'dark'))
  })

  it('cycles, and never lands outside the palette', () => {
    const colors = paletteColors('coda', 'dark')
    expect(cycleColor(0, 'dark')).toBe(colors[0])
    expect(cycleColor(colors.length, 'dark')).toBe(colors[0])
    expect(cycleColor(colors.length + 3, 'dark')).toBe(colors[3])
  })

  it('is theme-flipped only for coda, which is the only one validated on both surfaces', () => {
    expect(paletteColors('coda', 'light')).not.toEqual(paletteColors('coda', 'dark'))
    expect(paletteColors('okabeIto', 'light')).toEqual(paletteColors('okabeIto', 'dark'))
  })
})

describe('resolveShape', () => {
  const table = (values: Array<string | null>) =>
    makeTable(tableSchema(column('kind', 'str')), { kind: values })

  const spec = (extra: Partial<ShapeSpec> = {}): ShapeSpec => ({
    mode: 'categorical',
    column: 'kind',
    constant: 'circle',
    ...extra,
  })

  it('gives the commonest value the most distinguishable mark', () => {
    // Same ranking as `resolveColor`, and for the same reason: whichever value dominates the
    // picture should be the one the eye separates most easily.
    const resolved = resolveShape(table(['a', 'b', 'b', 'b', 'a', 'c']), spec())
    expect(resolved.at(1)).toBe(MARKER_SHAPES[0])
    expect(resolved.at(0)).toBe(MARKER_SHAPES[1])
    expect(resolved.at(5)).toBe(MARKER_SHAPES[2])
  })

  it('folds the tail into a dash rather than reusing a mark', () => {
    /*
     * The deliberate difference from colour, which cycles. Six shapes is the whole vocabulary,
     * so a seventh category drawn as a second circle would say "these two are the same thing"
     * with nothing able to correct it — where a repeated *hue* is survivable because there are
     * twenty of them and the caption admits to the repeat.
     */
    const values = Array.from({ length: MAX_SHAPES + 3 }, (_, i) => `c${i}`)
    const resolved = resolveShape(table(values), spec())
    expect(resolved.legend?.entries.at(-1)).toEqual({ label: 'Other', shape: OTHER_SHAPE })
    // Everything past the cap takes the fold, and none of the six is reused for it.
    for (let row = MAX_SHAPES; row < values.length; row++) {
      expect(resolved.at(row)).toBe(OTHER_SHAPE)
    }
    expect(MARKER_SHAPES).not.toContain(OTHER_SHAPE)
  })

  it('answers with the key a folded row is drawn under', () => {
    // `labelAt` is what hide/solo reads, so a folded row has to name `Other` — hiding the fold
    // has to hide all of them, exactly as it does for colour.
    const values = Array.from({ length: MAX_SHAPES + 2 }, (_, i) => `c${i}`)
    const resolved = resolveShape(table(values), spec())
    expect(resolved.labelAt?.(0)).toBe('c0')
    expect(resolved.labelAt?.(MAX_SHAPES + 1)).toBe('Other')
  })

  it('lets a pinned `Other` reach the nodes it folded, not just its key', () => {
    /*
     * The legend and the lookup used to be two answers: `entries` applied an override to the
     * `Other` key while `at` looked a folded row up under its *own* label, so choosing a mark
     * for `Other` changed the key and not one node. They are one table now.
     */
    const values = Array.from({ length: MAX_SHAPES + 2 }, (_, i) => `c${i}`)
    const resolved = resolveShape(table(values), spec({ overrides: { Other: 'square' } }))
    expect(resolved.legend?.entries.at(-1)?.shape).toBe('square')
    expect(resolved.at(MAX_SHAPES + 1)).toBe('square')
  })

  it('lets an override win, for the mark and for its key', () => {
    const resolved = resolveShape(table(['a', 'b', 'a']), spec({ overrides: { a: 'diamond' } }))
    expect(resolved.at(0)).toBe('diamond')
    const entry = resolved.legend?.entries.find((e) => e.label === 'a')
    expect(entry?.shape).toBe('diamond')
  })

  it('ignores an override that is not a shape we can draw', () => {
    // The value is a string in a saved file. `readOverrides` deliberately does not check it,
    // so this is the only place that does.
    const resolved = resolveShape(table(['a', 'b', 'a']), spec({ overrides: { a: 'blob' } }))
    expect(resolved.at(0)).toBe(MARKER_SHAPES[0])
  })

  it('degrades to the constant when the column has one value', () => {
    // Every node the same shape carries no information, and a one-entry legend claiming
    // otherwise is worse than no legend.
    const resolved = resolveShape(table(['a', 'a', 'a']), spec({ constant: 'square' }))
    expect(resolved.at(0)).toBe('square')
    expect(resolved.legend).toBeUndefined()
  })

  it('treats a null as a category of its own, as colour does', () => {
    const resolved = resolveShape(table(['a', null, null, null]), spec())
    expect(resolved.legend?.entries.map((e) => e.label)).toEqual(['—', 'a'])
  })

  it('falls back to the constant on a missing column or constant mode', () => {
    expect(resolveShape(table(['a', 'b']), spec({ column: 'nope' })).at(0)).toBe('circle')
    expect(resolveShape(table(['a', 'b']), spec({ mode: 'constant' })).legend).toBeUndefined()
    expect(resolveShape(undefined, spec()).at(0)).toBe('circle')
  })

})
