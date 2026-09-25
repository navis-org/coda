/**
 * The wall's arithmetic, which jsdom can check because it lays nothing out: a skeleton projected
 * once and centred on its soma, a cell's width, and rows packed to the space there is. What the
 * wall *looks like* is the browser probe's.
 */

import { describe, expect, it } from 'vitest'

import type { SkeletonGeometry } from '../../core/values'
import { frameFor } from '../../packs/cortex/frames'
import {
  MIN_COLUMN_UM,
  cellGeometry,
  columnWidths,
  evenColumnWidth,
  layoutWall,
  packRows,
  wallColumns,
} from './wall'

const MINNIE = frameFor('cave', 'minnie65_public:1822')!

/** A soma at the pia point, a dendrite 50 µm up-and-across, an axon 100 µm down. */
function neuron(): SkeletonGeometry {
  const [x, y] = [183013 * 4, 83535 * 4]
  return {
    id: '1',
    positions: new Float32Array([
      x,
      y + 200_000,
      0,
      x - 50_000,
      y + 150_000,
      0,
      x,
      y + 300_000,
      0,
    ]),
    radii: new Float32Array(3),
    parents: new Int32Array([-1, 0, 0]),
    compartments: new Uint8Array([1, 3, 2]),
  }
}

describe('a cell in the frame', () => {
  it('is centred on its soma, with each segment in the ink its label names', () => {
    const geometry = cellGeometry(neuron(), MINNIE)
    expect(geometry.segments.dendrite.length).toBe(4)
    expect(geometry.segments.axon.length).toBe(4)
    expect(geometry.segments.neutral.length).toBe(0)
    // The dendrite reaches ~50 µm to one side; nothing reaches the other.
    expect(geometry.left).toBeLessThan(-40)
    expect(geometry.right).toBeGreaterThan(-1)
  })

  it('takes the root for the soma where no point is labelled soma', () => {
    const unlabelled = { ...neuron(), compartments: new Uint8Array([3, 3, 2]) }
    // The root is point 0, at 200 µm below the pia point's y — the depth of the soma.
    expect(cellGeometry(unlabelled, MINNIE).somaDepth).toBeCloseTo(
      cellGeometry(neuron(), MINNIE).somaDepth,
      3,
    )
  })

  it('is projected once per skeleton object', () => {
    const skeleton = neuron()
    expect(cellGeometry(skeleton, MINNIE)).toBe(cellGeometry(skeleton, MINNIE))
  })
})

describe('column widths', () => {
  const base = {
    segments: {
      axon: new Float32Array(),
      dendrite: new Float32Array(),
      neutral: new Float32Array(),
    },
    somaDepth: 0,
  }
  const cells = [
    { ...base, left: -100, right: 50 },
    { ...base, left: -20, right: 400 },
    { ...base, left: -300, right: 300 },
  ]

  it('decides in µm, so two scales — a card and full size — make the same decision', () => {
    for (const mode of [{ mode: 'fit' as const }, { mode: 'even' as const }]) {
      const card = columnWidths(cells, 0.16, mode)
      const full = columnWidths(cells, 0.37, mode)
      // The same widths, only scaled: every ratio between two cells agrees.
      expect(card.map((w) => w / card[0]!)).toEqual(
        full.map((w) => expect.closeTo(w / full[0]!, 1)),
      )
    }
  })

  it('fits each cell to its own extent, never below the floor, a loading cell at the floor', () => {
    expect(columnWidths([...cells, undefined], 1, { mode: 'fit' })).toEqual([
      200,
      800,
      600,
      MIN_COLUMN_UM,
    ])
  })

  it('makes every column one width: the one asked for, or the median extent in 50 µm steps', () => {
    expect(columnWidths(cells, 1, { mode: 'even', um: 250 })).toEqual([250, 250, 250])
    // Extents 200, 800, 600: the median is 600, already a step.
    expect(evenColumnWidth(cells, undefined)).toBe(600)
    expect(evenColumnWidth([{ ...base, left: -10, right: 311 }], undefined)).toBe(650)
    // Nothing landed yet: the floor, so the wall is laid out before the first skeleton.
    expect(evenColumnWidth([undefined, undefined], undefined)).toBe(MIN_COLUMN_UM)
  })
})

const OPTIONS = { ruler: 30, gap: 2, columnGap: 10 }

describe('laying the wall out', () => {
  it('fills each row as far as it goes, in order', () => {
    expect(packRows([40, 40, 40, 40], 90, 2)).toEqual([
      [0, 1],
      [2, 3],
    ])
  })

  it('gives a cell wider than the row a row of its own rather than losing it', () => {
    expect(packRows([40, 300, 40], 100, 2)).toEqual([[0], [1], [2]])
  })

  it('places every cell after its row’s ruler', () => {
    const layout = layoutWall([40, 40, 40], 130, [[{ members: [0, 1, 2] }]], OPTIONS)
    expect(layout.rows).toBe(2)
    // The first row is full, so its 98 px less 82 used is shared: 8 px each. The last keeps 40.
    expect(layout.cells).toEqual([
      { x: 32, row: 0, width: 48 },
      { x: 82, row: 0, width: 48 },
      { x: 32, row: 1, width: 40 },
    ])
    // Each row's band spans its whole column, under the ruler and the cells alike.
    expect(layout.rulers).toEqual([
      { x: 0, row: 0, width: 130 },
      { x: 0, row: 1, width: 130 },
    ])
  })

  it('justifies every full row to one right edge, in whole pixels, and leaves the last alone', () => {
    // 99 px inside the ruler; two 40 px cells and a gap leave 17, shared 9 and 8.
    const layout = layoutWall([40, 40, 40], 131, [[{ members: [0, 1, 2] }]], OPTIONS)
    const [a, b, c] = layout.cells
    expect([a!.width, b!.width]).toEqual([49, 48])
    expect(b!.x + b!.width).toBe(131)
    expect(c!.width).toBe(40)
  })

  it('starts each section on a row of its own, labelled', () => {
    const layout = layoutWall(
      [40, 40, 40],
      400,
      [
        [
          { members: [0, 1], label: 'A' },
          { members: [2], label: 'B' },
        ],
      ],
      OPTIONS,
    )
    expect(layout.cells.map((c) => c!.row)).toEqual([0, 0, 1])
    expect(layout.labels).toEqual([
      { x: 0, row: 0, text: 'A' },
      { x: 0, row: 1, text: 'B' },
    ])
  })

  it('sets two columns side by side, each with its own rulers, as tall as the taller', () => {
    const layout = layoutWall(
      [40, 40, 40],
      210,
      [[{ members: [0, 1] }], [{ members: [2] }]],
      OPTIONS,
    )
    // Each half is 100 px: 30 ruler, 2 gap, then one 40 px cell per row with a 2 px gap. The left
    // half's first row is full and takes all 68 px; each half's last row keeps its own width.
    expect(layout.cells).toEqual([
      { x: 32, row: 0, width: 68 },
      { x: 32, row: 1, width: 40 },
      { x: 142, row: 0, width: 40 },
    ])
    expect(layout.rulers.map((r) => r.x)).toEqual([0, 0, 110])
    expect(layout.rows).toBe(2)
  })

  it('arranges the groups by mode: run on unlabelled, one under another, or side by side', () => {
    const sections = [
      { members: [0, 1], label: 'A' },
      { members: [2], label: 'B' },
    ]
    expect(wallColumns('lineup', sections)).toEqual([[{ members: [0, 1, 2] }]])
    expect(wallColumns('rows', sections)).toEqual([sections])
    expect(wallColumns('compare', sections)).toEqual([[sections[0]], [sections[1]]])
  })
})
