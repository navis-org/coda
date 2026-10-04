import { describe, expect, it } from 'vitest'

import { overlaps } from '../../layout/place'
import type { LabelRequest, PlacementOptions } from './scatterLabels'
import { placePointLabels } from './scatterLabels'

const BOUNDS = { x: 0, y: 0, width: 400, height: 300 }

function request(index: number, x: number, y: number, extra: Partial<LabelRequest> = {}) {
  return { index, text: `n${index}`, x, y, r: 4, width: 30, height: 12, priority: 1, ...extra }
}

function place(requests: LabelRequest[], options: Partial<PlacementOptions> = {}) {
  return placePointLabels(requests, {
    bounds: BOUNDS,
    obstacles: requests.map(({ index, x, y, r }) => ({ index, x, y, r })),
    leaders: false,
    unplaced: 'hide',
    ...options,
  })
}

describe('placing labels beside points', () => {
  it('puts a lone label to the right of its point, clear of the mark', () => {
    const [label] = place([request(0, 100, 100)])
    expect(label!.x).toBeGreaterThan(104)
    expect(label!.y + label!.height / 2).toBeCloseTo(100)
  })

  it('moves a label off another point rather than covering it', () => {
    const neighbour = { index: 9, x: 125, y: 100, r: 4 }
    const [label] = place([request(0, 100, 100)], {
      obstacles: [{ index: 0, x: 100, y: 100, r: 4 }, neighbour],
    })
    expect(
      label!.x + label!.width <= 121 ||
        label!.x >= 129 ||
        label!.y >= 104 ||
        label!.y + label!.height <= 96,
    ).toBe(true)
  })

  it('keeps every placed label clear of the others, and inside the plot', () => {
    const crowd = Array.from({ length: 12 }, (_, i) =>
      request(i, 60 + (i % 4) * 22, 60 + Math.floor(i / 4) * 16),
    )
    const labels = place(crowd)
    expect(labels.length).toBeGreaterThan(4)
    for (const [i, a] of labels.entries()) {
      expect(a.x >= 0 && a.y >= 0 && a.x + a.width <= 400 && a.y + a.height <= 300).toBe(true)
      for (const b of labels.slice(i + 1)) expect(overlaps(a, b)).toBe(false)
    }
  })

  it('turns a label at the plot’s edge inward', () => {
    const [label] = place([request(0, 395, 150)])
    expect(label!.x + label!.width).toBeLessThanOrEqual(395)
  })

  it('tries the slot a label had last time first, so a pan does not flip it', () => {
    const [first] = place([request(0, 100, 100)])
    expect(first!.slot).toBe(0)
    const [again] = place([request(0, 100, 100)], { previous: [{ ...first!, slot: 5 }] })
    expect(again!.slot).toBe(5)
  })

  it('names a selected point first when two compete for the same space', () => {
    // Two points so close only one label fits around them in a narrow plot.
    const bounds = { x: 0, y: 0, width: 80, height: 14 }
    const a = request(0, 20, 7)
    const b = request(1, 26, 7, { priority: 0 })
    const labels = place([a, b], { bounds })
    expect(labels.map((l) => l.index)).toEqual([1])
  })

  it('leaves out a label that fits nowhere, or draws it faintly under the rest', () => {
    const bounds = { x: 0, y: 0, width: 20, height: 20 }
    const tight = [request(0, 10, 10)]
    expect(place(tight, { bounds })).toEqual([])
    const [dimmed] = place(tight, { bounds, unplaced: 'dim' })
    expect(dimmed!.dim).toBe(true)
  })

  it('draws a leader from the mark’s edge to the label’s nearest corner or side', () => {
    const [label] = place([request(0, 100, 100)], { leaders: true })
    const [x0, y0, x1, y1] = label!.line!
    expect(Math.hypot(x0 - 100, y0 - 100)).toBeCloseTo(4)
    expect(x1).toBeCloseTo(label!.x)
    expect(y1).toBeCloseTo(100)
  })
})
