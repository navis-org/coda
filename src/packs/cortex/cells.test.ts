/**
 * The gallery's cells: the schema and value halves agree (invariant 3), and the wall's sample is a
 * seeded, per-type, depth-ordered draw that changing one type does not reshuffle.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import {
  DEPTH_COLUMN,
  LAYER_COLUMN,
  cellsSchema,
  cellsTable,
  compareGroups,
  proofreadingMissing,
  readColumnWidths,
  wallGroups,
} from './cells'
import type { WallOptions } from './cells'
import { frameFor } from './frames'

const MINNIE = frameFor('cave', 'minnie65_public:1822')!

/** A pia point's y, so a soma `depth` µm down sits at depth `depth` (the x is the pia's own). */
const PIA_X = 183013 * 4
const somaAt = (depth: number): [number, number, number] => {
  // Invert the rigid transform along y at the pia's x: y such that depth(x, y) = depth.
  const angle = (5 * Math.PI) / 180
  const piaY = 83535 * 4
  return [PIA_X, piaY + (depth * 1000) / Math.cos(angle), 0]
}

function index(rows: { id: string; type: string | null; dendrite?: string; axon?: string }[]) {
  const schema = tableSchema(
    column('neuronId', 'str'),
    column('type', 'str'),
    column('dendrite_cleaned', 'str'),
    column('axon_cleaned', 'str'),
  )
  return makeTable(
    schema,
    {
      neuronId: rows.map((r) => r.id),
      type: rows.map((r) => r.type),
      dendrite_cleaned: rows.map((r) => r.dendrite ?? 't'),
      axon_cleaned: rows.map((r) => r.axon ?? 't'),
    },
    'neurons',
  )
}

describe('the cell table', () => {
  it('adds depth and layer, and the two halves agree', () => {
    const table = index([
      { id: '1', type: '23P' },
      { id: '2', type: 'BC' },
      { id: '3', type: 'BC' },
    ])
    const somata = new Map([
      ['1', somaAt(150)],
      ['2', somaAt(420)],
    ])
    const cells = cellsTable(table, somata, MINNIE)
    expect(cells.schema).toEqual(cellsSchema(table.schema))
    expect((cells.data[DEPTH_COLUMN] as number[])[0]).toBeCloseTo(150, 1)
    expect(cells.data[LAYER_COLUMN]).toEqual(['L2/3', 'L5', null])
    // A cell with no single soma has no depth rather than a guessed one.
    expect(cells.data[DEPTH_COLUMN]![2]).toBeNull()
  })
})

describe('the wall', () => {
  const table = index([
    ...Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, type: '23P' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, type: 'BC' })),
    { id: 'u', type: null },
    { id: 'raw', type: 'BC', axon: 'f' },
  ])
  const somata = new Map<string, [number, number, number]>()
  for (let i = 0; i < 10; i++) {
    somata.set(`p${i}`, somaAt(100 + i * 10))
    somata.set(`b${i}`, somaAt(400 + i * 10))
  }
  somata.set('u', somaAt(600))
  somata.set('raw', somaAt(450))
  const cells = cellsTable(table, somata, MINNIE)
  const options: WallOptions = {
    groupBy: 'type',
    types: [],
    proofread: 'both',
    perType: 3,
    seed: 1,
    order: 'depth',
  }
  const ids = (groups: ReturnType<typeof wallGroups>) =>
    groups.map((g) => g.rows.map((r) => cells.data['neuronId']![r]))

  it('groups by type in depth order, samples each, and puts untyped cells in a group of their own', () => {
    const groups = wallGroups(cells, MINNIE, options)
    expect(groups.map((g) => g.type)).toEqual(['23P', 'BC', 'untyped'])
    expect(groups.map((g) => g.rows.length)).toEqual([3, 3, 1])
    // Shallowest first within a group.
    for (const group of groups) {
      const depths = group.rows.map((r) => cells.data[DEPTH_COLUMN]![r] as number)
      expect([...depths].sort((a, b) => a - b)).toEqual(depths)
    }
  })

  it('orders the groups by depth, name, size, or a seeded shuffle', () => {
    const types = (order: WallOptions['order'], seed = 1) =>
      wallGroups(cells, MINNIE, { ...options, perType: 0, order, seed }).map((g) => g.type)
    expect(types('depth')).toEqual(['23P', 'BC', 'untyped'])
    // `AAA` shallowest and `23P` below it, where by name the digits come first: the two disagree.
    const deep = cellsTable(
      index([
        { id: 'a', type: 'AAA' },
        ...Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, type: '23P' })),
      ]),
      new Map([
        ['a', somaAt(50)],
        ...[0, 1, 2].map((i) => [`p${i}`, somaAt(300)] as [string, [number, number, number]]),
      ]),
      MINNIE,
    )
    const deepTypes = (order: WallOptions['order']) =>
      wallGroups(deep, MINNIE, { ...options, order }).map((g) => g.type)
    expect(deepTypes('depth')).toEqual(['AAA', '23P'])
    expect(deepTypes('name')).toEqual(['23P', 'AAA'])
    // Ten each proofread in both, so a tie goes by name; with the axon unasked BC has eleven.
    expect(types('count')).toEqual(['23P', 'BC', 'untyped'])
    expect(
      wallGroups(cells, MINNIE, { ...options, order: 'count', proofread: 'dendrite' }).map(
        (g) => g.type,
      ),
    ).toEqual(['BC', '23P', 'untyped'])
    expect(types('shuffled')).toEqual(types('shuffled'))
    expect(new Set(types('shuffled'))).toEqual(new Set(types('depth')))
    const seeds = new Set([1, 2, 3, 4, 5, 6].map((seed) => types('shuffled', seed).join()))
    expect(seeds.size).toBeGreaterThan(1)
  })

  it('compares two groups by name, falling back to the first and the next', () => {
    const groups = wallGroups(cells, MINNIE, options)
    const pair = (a: string, b: string) => compareGroups(groups, a, b).map((g) => g.type)
    expect(pair('BC', '23P')).toEqual(['BC', '23P'])
    expect(pair('', '')).toEqual(['23P', 'BC'])
    // The same name twice, or a vanished one, is not a comparison: the next group stands in.
    expect(pair('BC', 'BC')).toEqual(['BC', '23P'])
    expect(pair('gone', 'untyped')).toEqual(['23P', 'untyped'])
    expect(compareGroups(groups.slice(0, 1), '', '')).toHaveLength(1)
  })

  it('draws the same sample for the same seed, and another for another', () => {
    expect(ids(wallGroups(cells, MINNIE, options))).toEqual(
      ids(wallGroups(cells, MINNIE, options)),
    )
    expect(ids(wallGroups(cells, MINNIE, { ...options, seed: 2 }))).not.toEqual(
      ids(wallGroups(cells, MINNIE, options)),
    )
  })

  it("leaves one type's sample alone when another type is filtered out", () => {
    const both = wallGroups(cells, MINNIE, options)
    const onlyBc = wallGroups(cells, MINNIE, { ...options, types: ['BC'] })
    expect(ids(onlyBc)[0]).toEqual(ids(both)[1])
  })

  it('shows every cell, and says why, where the table carries no proofreading flags', () => {
    // A dataset without its annotation chain: an empty wall would read as no neurons at all.
    const bare = cellsTable(
      makeTable(
        tableSchema(column('neuronId', 'str'), column('type', 'str')),
        { neuronId: ['p0'], type: ['23P'] },
        'neurons',
      ),
      somata,
      MINNIE,
    )
    expect(proofreadingMissing(bare, MINNIE, 'both')).toMatch(/dendrite_cleaned/)
    expect(proofreadingMissing(bare, MINNIE, 'any')).toBeUndefined()
    expect(wallGroups(bare, MINNIE, options)[0]!.total).toBe(1)
  })

  it('keeps a cell whose axon was not proofread off a wall asking for both', () => {
    const bc = wallGroups(cells, MINNIE, { ...options, perType: 0 }).find(
      (g) => g.type === 'BC',
    )!
    expect(bc.total).toBe(10)
    const loose = wallGroups(cells, MINNIE, { ...options, perType: 0, proofread: 'dendrite' })
    expect(loose.find((g) => g.type === 'BC')!.total).toBe(11)
  })
})

describe('column widths, as typed', () => {
  it('reads fit unless even is chosen, and an even width only when it is a positive number', () => {
    expect(readColumnWidths({ columnMode: 'fit', columnUm: '250' })).toEqual({
      widths: { mode: 'fit' },
    })
    expect(readColumnWidths({ columnMode: 'even', columnUm: ' 250 ' })).toEqual({
      widths: { mode: 'even', um: 250 },
    })
    // Empty is automatic, and says nothing.
    expect(readColumnWidths({ columnMode: 'even', columnUm: '' })).toEqual({
      widths: { mode: 'even' },
    })
  })

  it('ignores a width that is not one, automatic standing in, and says so', () => {
    for (const typed of ['abc', '-5', '0']) {
      const read = readColumnWidths({ columnMode: 'even', columnUm: typed })
      expect(read.widths).toEqual({ mode: 'even' })
      expect(read.problem).toMatch(/automatic/)
    }
  })
})
