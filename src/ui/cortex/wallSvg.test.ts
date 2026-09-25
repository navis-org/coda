// @vitest-environment jsdom
/**
 * The gallery's exported figure: a well-formed document drawing the whole wall through the
 * canvas's own geometry, a branch as one run of path, and a legend that says what it left out.
 */

import { describe, expect, it } from 'vitest'

import { frameFor } from '../../packs/cortex/frames'
import { serializeSvg } from '../export'
import type { CellGeometry } from './wall'
import { layoutWall, rowMetrics, rowScale } from './wall'
import { wallToSvg } from './wallSvg'

const MINNIE = frameFor('cave', 'minnie65_public:1822')!

/** A chain of three segments down from the soma, dendrite then axon. */
const CELL: CellGeometry = {
  segments: {
    dendrite: new Float32Array([0, 100, 0, 150, 0, 60, 0, 100]),
    axon: new Float32Array([5, 200, 0, 150]),
    neutral: new Float32Array(),
  },
  somaDepth: 150,
  left: 0,
  right: 5,
}

function picture(cells: number, width: number) {
  const widths = Array.from({ length: cells }, () => 40)
  const layout = layoutWall(widths, width, [[{ members: widths.map((_, i) => i) }]], {
    ruler: 30,
    gap: 2,
    columnGap: 10,
  })
  return wallToSvg({
    frame: MINNIE,
    layout,
    stripes: widths.map(() => ['#123456', '#abcdef']),
    geometries: widths.map(() => CELL),
    drawn: widths,
    scale: rowScale(MINNIE, 130),
    metrics: rowMetrics(130, false, 2),
    width,
    mode: 'dark',
    title: 'Cortex Gallery — minnie65',
    legend: [
      { entries: [{ label: 'dendrite', color: '#00f' }] },
      { title: 'mtype', entries: [{ label: 'L2a', color: '#f00' }], more: 2 },
    ],
    note: 'colours repeat',
  })
}

describe('the wall as a figure', () => {
  it('serialises to a document a parser accepts', () => {
    const text = serializeSvg(picture(3, 300))
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
    expect(parsed.querySelector('parsererror')).toBeNull()
    expect(parsed.querySelector('title')?.textContent).toBe('Cortex Gallery — minnie65')
    // One font declaration, the builder's: a second from the serializer would say `sans-serif`.
    expect(parsed.querySelectorAll('style')).toHaveLength(1)
  })

  it('draws every row, not only those scrolled into view', () => {
    // 98 px inside the ruler holds two 40 px cells a row: seven cells are four rows.
    const svg = picture(7, 130)
    expect(svg.querySelectorAll('g[clip-path^="url(#band-"]')).toHaveLength(4)
    expect(svg.querySelectorAll('circle')).toHaveLength(7)
    // Two stripes a cell, each the width of its place.
    expect(svg.querySelectorAll('rect[fill="#abcdef"]')).toHaveLength(7)
  })

  it('draws a branch as one run rather than a move per segment', () => {
    const dendrite = picture(1, 300).querySelector('path[stroke]')!.getAttribute('d')!
    expect(dendrite.match(/M/g)).toHaveLength(1)
    expect(dendrite.match(/L/g)).toHaveLength(2)
  })

  it('keys the legend and says what it had no room for', () => {
    const text = picture(1, 300).textContent ?? ''
    expect(text).toContain('mtype')
    expect(text).toContain('+2 more')
    expect(text).toContain('colours repeat')
  })
})
