/**
 * The expanded list's column model: what a stored column means, and when it is not drawn.
 *
 * Headless for the reason `rowPlots.test.ts` is — jsdom lays nothing out, so the rules have to be
 * checkable without a component. The header's clicks are `explore.test.tsx`'.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { RowFields } from './rowFields'
import {
  MAX_PARTS,
  automaticColumns,
  automaticLayout,
  columnLabel,
  columnWidth,
  decodeEntry,
  encodeChip,
  encodeColumn,
  encodeLayout,
  hideField,
  isEmptyLayout,
  moveColumn,
  offerableFields,
  placeAsChip,
  placeAsColumn,
  placeOf,
  printsFigures,
  removeColumn,
  renderersFor,
  resolveLayout,
  rowSpecFor,
  setColumn,
  toggleField,
} from './rowColumns'
import type { ColumnSpec, Layout } from './rowColumns'

/** The column half of an entry, for the assertions below that are about columns alone. */
const decodeColumn = (raw: unknown): ColumnSpec | undefined => {
  const entry = decodeEntry(raw)
  return entry && 'column' in entry ? entry.column : undefined
}

/** fish2's shape: the four compartment counts, beside a text field and the id. */
const FISH2 = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('pre', 'i64'),
  column('post', 'i64'),
  column('axonIn', 'i64'),
  column('axonOut', 'i64'),
  column('dendriteIn', 'i64'),
  column('dendriteOut', 'i64'),
  column('AF10_Tectum(L)', 'i64'),
)

const FIELDS: RowFields = {
  primary: 'type',
  secondary: [],
  columns: ['class'],
  chips: [],
  stats: ['pre', 'post'],
  tags: undefined,
}

describe('renderersFor', () => {
  it('offers a figure or a mark for one number, and text for one string', () => {
    expect(renderersFor(['pre'], FISH2)).toEqual(['number', 'bar', 'logBar', 'rank'])
    expect(renderersFor(['type'], FISH2)).toEqual(['text'])
  })

  it('offers a split or a line of text for several numbers — which is what merging is', () => {
    expect(renderersFor(['axonIn', 'axonOut', 'dendriteIn', 'dendriteOut'], FISH2)).toEqual([
      'stacked',
      'bars',
      'donut',
      'text',
    ])
  })

  it('refuses a text field merged with anything, since a share needs every part to be a count', () => {
    expect(renderersFor(['type', 'pre'], FISH2)).toEqual([])
  })

  it('refuses more parts than the palette has colours', () => {
    const wide = tableSchema(
      ...Array.from({ length: MAX_PARTS + 1 }, (_, i) => column(`n${i}`, 'i64')),
    )
    const names = wide.columns.map((c) => c.name)
    expect(renderersFor(names.slice(0, MAX_PARTS), wide)).toEqual([
      'stacked',
      'bars',
      'donut',
      'text',
    ])
    expect(renderersFor(names, wide)).toEqual([])
  })

  it('refuses a field the dataset does not have', () => {
    expect(renderersFor(['somaSide'], FISH2)).toEqual([])
    expect(renderersFor([], FISH2)).toEqual([])
  })
})

describe('encodeColumn / decodeColumn', () => {
  it('round-trips, including a field name no delimiter would survive', () => {
    const merged: ColumnSpec = { render: 'stacked', fields: ['AF10_Tectum(L)', 'axonIn'] }
    expect(encodeColumn(merged)).toBe(
      '{"render":"stacked","fields":["AF10_Tectum(L)","axonIn"]}',
    )
    expect(decodeColumn(encodeColumn(merged))).toEqual(merged)
  })

  it('carries a name, and writes none where there is none', () => {
    const named: ColumnSpec = {
      render: 'bars',
      fields: ['axonIn', 'dendriteIn'],
      label: 'inputs',
    }
    expect(decodeColumn(encodeColumn(named))).toEqual(named)
    expect(encodeColumn({ render: 'number', fields: ['pre'] })).not.toContain('label')
    expect(decodeColumn('{"render":"number","fields":["pre"],"label":7}')).toBeUndefined()
  })

  it('carries the readable flag, and writes none where it is off', () => {
    const readable: ColumnSpec = { render: 'number', fields: ['nodes'], readable: true }
    expect(decodeColumn(encodeColumn(readable))).toEqual(readable)
    // Off is the default, so it is the absence — a stored column says only what differs.
    expect(
      encodeColumn({ render: 'number', fields: ['nodes'], readable: false }),
    ).not.toContain('readable')
    expect(
      decodeColumn('{"render":"number","fields":["nodes"],"readable":"yes"}'),
    ).toBeUndefined()
  })

  it('reads a chip entry as a chip, never as a column', () => {
    expect(decodeEntry(encodeChip('dimorphism'))).toEqual({ chip: 'dimorphism' })
    expect(decodeColumn(encodeChip('dimorphism'))).toBeUndefined()
    expect(decodeEntry('{"chip":7}')).toBeUndefined()
  })

  it('stores a column normalised, whoever writes it', () => {
    // A name equal to the automatic one, and a `readable` a bar has no digits for, are not stored.
    expect(encodeColumn({ render: 'number', fields: ['pre'], label: ' pre ' })).not.toContain(
      'label',
    )
    expect(encodeColumn({ render: 'bar', fields: ['pre'], readable: true })).not.toContain(
      'readable',
    )
    expect(
      decodeColumn(encodeColumn({ render: 'number', fields: ['pre'], label: 'out' })),
    ).toEqual({
      render: 'number',
      fields: ['pre'],
      label: 'out',
    })
  })

  it('drops what it cannot read rather than throwing — a hand-edited file is the other way in', () => {
    expect(decodeColumn('not json')).toBeUndefined()
    expect(decodeColumn('["sparkline","pre"]')).toBeUndefined()
    expect(decodeColumn('[1,2]')).toBeUndefined()
    expect(decodeColumn(42)).toBeUndefined()
  })
})

describe('columnLabel', () => {
  it('is the name somebody gave, else the automatic one', () => {
    expect(columnLabel({ render: 'bars', fields: ['axonIn', 'dendriteIn'] })).toBe(
      'axonIn/dendriteIn',
    )
    expect(
      columnLabel({ render: 'bars', fields: ['axonIn', 'dendriteIn'], label: 'inputs' }),
    ).toBe('inputs')
    expect(columnLabel({ render: 'text', fields: ['pre', 'post'] })).toBe('pre/post')
  })
})

describe('automaticColumns', () => {
  it('is today’s three mechanisms in the order the row always drew them', () => {
    const columns = automaticColumns(FIELDS, {
      balance: { pre: 'pre', post: 'post' },
      percentile: 'size',
      regions: true,
    })
    expect(columns).toEqual([
      { render: 'text', fields: ['class'] },
      // The pre/post balance bar was a two-part stacked bar all along.
      { render: 'stacked', fields: ['pre', 'post'] },
      { render: 'rank', fields: ['size'] },
      { render: 'regions', fields: [] },
      // Readable, as the figures always drew: the first edit must not change how they look.
      { render: 'number', fields: ['pre'], readable: true },
      { render: 'number', fields: ['post'], readable: true },
    ])
    expect(columns.map(columnLabel)).toEqual([
      'class',
      'pre/post',
      'size rank',
      'regions',
      'pre',
      'post',
    ])
  })
})

describe('resolveLayout', () => {
  const merged = encodeColumn({
    render: 'donut',
    fields: ['axonIn', 'axonOut', 'dendriteIn', 'dendriteOut'],
  })
  const pre = encodeColumn({ render: 'number', fields: ['pre'] })

  it('answers the automatic list while nothing is stored', () => {
    expect(resolveLayout([], FISH2, undefined)).toEqual({ layout: undefined, unseen: [] })
  })

  it('splits a stored list into columns and chips, each in its own order', () => {
    const stored = encodeLayout({
      columns: [
        { render: 'donut', fields: ['axonIn', 'axonOut', 'dendriteIn', 'dendriteOut'] },
        { render: 'number', fields: ['pre'] },
      ],
      chips: ['type', 'post'],
    })!
    const { layout, unseen } = resolveLayout(stored, FISH2, undefined)
    expect(layout!.columns.map(columnLabel)).toEqual([
      'axonIn/axonOut/dendriteIn/dendriteOut',
      'pre',
    ])
    expect(layout!.chips).toEqual(['type', 'post'])
    expect(unseen).toEqual([])
  })

  it('keeps what this dataset cannot draw, verbatim, for the next edit to write back', () => {
    /*
     * `fits` decides what is drawn, never what is kept. Written the other way, a rename made while
     * a graph pointed at hemibrain erased the fish2 columns it was built with.
     */
    const hemibrain = tableSchema(
      column('neuronId', 'i64'),
      column('pre', 'i64'),
      column('axonIn', 'i64'),
    )
    const stored = [merged, pre, encodeChip('axonOut')]
    const { layout, unseen } = resolveLayout(stored, hemibrain, undefined)
    // Lost whole from the drawing — a split of something else under the same header …
    expect(layout!.columns.map(columnLabel)).toEqual(['pre'])
    // … and kept whole in the list.
    expect(unseen).toEqual([merged, encodeChip('axonOut')])
    expect(encodeLayout(layout!, unseen)).toEqual([pre, merged, encodeChip('axonOut')])
  })

  it('answers the automatic list when the stored one names nothing here, and still keeps it', () => {
    const elsewhere = tableSchema(column('neuronId', 'i64'), column('size', 'i64'))
    expect(resolveLayout([merged], elsewhere, undefined)).toEqual({
      layout: undefined,
      unseen: [merged],
    })
  })

  it('drops the region donut where the dataset cannot answer one', () => {
    const stored = [encodeColumn({ render: 'regions', fields: [] }), merged]
    expect(resolveLayout(stored, FISH2, { regions: true }).layout!.columns).toHaveLength(2)
    expect(resolveLayout(stored, FISH2, {}).layout!.columns).toHaveLength(1)
  })

  it('drops a column whose renderer no longer fits, and a chip the dataset lacks', () => {
    const stored = [
      encodeColumn({ render: 'rank', fields: ['type'] }),
      encodeChip('somaSide'),
      merged,
    ]
    const { layout, unseen } = resolveLayout(stored, FISH2, undefined)
    expect(layout!.columns).toHaveLength(1)
    expect(layout!.chips).toEqual([])
    expect(unseen).toHaveLength(2)
  })

  it('keeps the tag column out of both, since it draws as its own row', () => {
    const stored = [
      encodeChip('type'),
      encodeColumn({ render: 'text', fields: ['type'] }),
      encodeChip('pre'),
    ]
    const { layout } = resolveLayout(stored, FISH2, undefined, 'type')
    expect(layout!.columns).toEqual([])
    expect(layout!.chips).toEqual(['pre'])
  })
})

describe('encodeLayout', () => {
  it('writes nothing for an empty list, which would read back as the automatic one', () => {
    expect(encodeLayout({ columns: [], chips: [] }, [encodeChip('elsewhere')])).toBeUndefined()
  })
})

describe('placing and hiding a field', () => {
  const layout: Layout = {
    columns: [
      { render: 'stacked', fields: ['pre', 'post'] },
      { render: 'number', fields: ['pre'] },
      { render: 'regions', fields: [] },
    ],
    chips: ['type'],
  }

  it('says where a field is, its own column winning over a merged one', () => {
    expect(placeOf(layout, 'pre')).toBe('column')
    expect(placeOf(layout, 'post')).toBe('merged')
    expect(placeOf(layout, 'type')).toBe('chip')
    expect(placeOf(layout, 'axonIn')).toBe('none')
  })

  it('moves a field between the header and the chips, leaving merged columns alone', () => {
    const chipped = placeAsChip(layout, 'pre')
    expect(chipped.columns.map(columnLabel)).toEqual(['pre/post', 'regions'])
    expect(chipped.chips).toEqual(['type', 'pre'])
    const promoted = placeAsColumn(chipped, 'type', false)
    expect(promoted.columns.at(-1)).toEqual({ render: 'text', fields: ['type'] })
    expect(promoted.chips).toEqual(['pre'])
    expect(placeAsColumn(layout, 'axonIn', true).columns.at(-1)).toEqual({
      render: 'number',
      fields: ['axonIn'],
    })
  })

  it('hides a field from wherever it stands on its own', () => {
    const hidden = hideField(hideField(layout, 'pre'), 'type')
    expect(hidden.columns.map(columnLabel)).toEqual(['pre/post', 'regions'])
    expect(hidden.chips).toEqual([])
  })

  it('refuses only an edit that would empty the list — asked of the result', () => {
    // A field held twice on its own: counting entries beforehand said "two, so hide is fine".
    const twice: Layout = {
      columns: [
        { render: 'number', fields: ['pre'] },
        { render: 'rank', fields: ['pre'] },
      ],
      chips: [],
    }
    expect(isEmptyLayout(hideField(twice, 'pre'))).toBe(true)
    expect(isEmptyLayout(hideField(layout, 'type'))).toBe(false)
    expect(encodeLayout(hideField(twice, 'pre'))).toBeUndefined()
  })
})

describe('the column edits', () => {
  const layout: Layout = {
    columns: [
      { render: 'number', fields: ['pre'] },
      { render: 'number', fields: ['post'] },
    ],
    chips: ['type'],
  }

  it('appends or replaces a column, leaving the chips alone', () => {
    const bar: ColumnSpec = { render: 'bar', fields: ['pre'] }
    expect(setColumn(layout, null, bar).columns.at(-1)).toBe(bar)
    expect(setColumn(layout, 0, bar).columns).toEqual([bar, layout.columns[1]])
    expect(setColumn(layout, 0, bar).chips).toEqual(['type'])
  })

  it('moves a column one step, and refuses a step off either end', () => {
    expect(moveColumn(layout, 1, -1).columns.map(columnLabel)).toEqual(['post', 'pre'])
    expect(moveColumn(layout, 0, -1)).toBe(layout)
    expect(moveColumn(layout, 1, 1)).toBe(layout)
  })

  it('removes one column', () => {
    expect(removeColumn(layout, 0).columns.map(columnLabel)).toEqual(['post'])
  })
})

describe('toggleField', () => {
  const numeric = new Set(['pre', 'post', 'axonIn'])

  it('lets a text field stand alone, and a number replace it', () => {
    expect(toggleField(['pre', 'post'], 'type', numeric)).toEqual(['type'])
    expect(toggleField(['type'], 'pre', numeric)).toEqual(['pre'])
  })

  it('merges numbers in the order ticked, and unticks', () => {
    expect(toggleField(['post'], 'pre', numeric)).toEqual(['post', 'pre'])
    expect(toggleField(['post', 'pre'], 'post', numeric)).toEqual(['pre'])
  })

  it('refuses a number past the palette, where renderersFor would refuse the merge', () => {
    const many = new Set(Array.from({ length: MAX_PARTS + 1 }, (_, i) => `n${i}`))
    const full = [...many].slice(0, MAX_PARTS)
    expect(toggleField(full, `n${MAX_PARTS}`, many)).toEqual(full)
  })
})

describe('automaticLayout', () => {
  it('is the automatic columns and chips together, as the first edit writes them', () => {
    const fields: RowFields = { ...FIELDS, chips: ['dimorphism'] }
    expect(automaticLayout(fields, undefined)).toEqual({
      columns: automaticColumns(fields, undefined),
      chips: ['dimorphism'],
    })
  })
})

describe('rowSpecFor', () => {
  const automatic: RowFields = { ...FIELDS, chips: ['dimorphism'] }

  it('draws the automatic spec until the list is edited', () => {
    expect(rowSpecFor(automatic, undefined, false)).toBe(automatic)
  })

  it('shows only what the list holds once it is', () => {
    expect(rowSpecFor(automatic, { columns: [], chips: ['status'] }, false).chips).toEqual([
      'status',
    ])
  })

  it('draws a card’s text columns as chips, ahead of its own', () => {
    const listed: Layout = {
      columns: [
        { render: 'text', fields: ['class'] },
        { render: 'number', fields: ['pre'] },
      ],
      chips: ['status'],
    }
    expect(rowSpecFor(automatic, listed, true).chips).toEqual(['class', 'status'])
  })
})

describe('printsFigures / columnWidth', () => {
  it('offers the formatting choice only where a column prints figures', () => {
    expect(printsFigures({ render: 'number', fields: ['pre'] })).toBe(true)
    expect(printsFigures({ render: 'text', fields: ['pre', 'post'] })).toBe(true)
    // A bar or a rank has no digits to format, and one text field is not a number.
    expect(printsFigures({ render: 'bar', fields: ['pre'] })).toBe(false)
    expect(printsFigures({ render: 'text', fields: ['type'] })).toBe(false)
  })

  it('gives an exact figure — the default — the wider track its digits need', () => {
    expect(columnWidth({ render: 'number', fields: ['pre'] })).toBe('6.5rem')
    expect(columnWidth({ render: 'number', fields: ['pre'], readable: true })).toBe('4.5rem')
  })
})

describe('offerableFields', () => {
  it('offers every drawable field but the id itself', () => {
    expect(offerableFields(FISH2)).not.toContain('neuronId')
    expect(offerableFields(FISH2)).toContain('axonIn')
    expect(offerableFields(FISH2)).toContain('type')
  })
})
