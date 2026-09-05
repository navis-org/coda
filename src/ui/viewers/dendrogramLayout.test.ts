/**
 * A merge tree's geometry.
 *
 * jsdom performs no layout and the viewer's brackets are SVG paths, so this is where the
 * drawing is actually checked — the same standing `networkLayout.ts` and `scatterPlot.ts`
 * have. What the component keeps is the pointer handling and the ink.
 */

import { describe, expect, it } from 'vitest'

import { labelStep } from '../format'

import type { LinkageValue } from '../../core/values'
import { makeLinkage } from '../../core/values'
import { caterpillar } from './linkageFixture'
import type { DendrogramWindow } from './dendrogramLayout'
import {
  FULL_WINDOW,
  clampWindow,
  dendrogramShape,
  isFullWindow,
  linkPath,
  observationsUnder,
  panWindow,
  pointToUnit,
  projectPoint,
  visibleLeaves,
  visibleLinks,
  windowScale,
  zoomWindow,
} from './dendrogramLayout'

/**
 * Two pairs joined at the top, with the leaf order as drawn.
 *
 *   a ─┐0.1
 *   b ─┴──┐
 *   c ─┐  ├── 0.8
 *   d ─┴──┘ 0.2
 */
function tree(clusters?: Int32Array): LinkageValue {
  return makeLinkage(
    Float64Array.from([0, 1, 0.1, 2, 2, 3, 0.2, 2, 4, 5, 0.8, 4]),
    ['a', 'b', 'c', 'd'],
    Int32Array.from([0, 1, 2, 3]),
    { method: 'average', ...(clusters ? { clusters } : {}) },
  )
}

describe('dendrogramShape', () => {
  it('puts leaves at slot centres, so the ends keep room for a label', () => {
    const shape = dendrogramShape(tree())
    expect(shape.leaves.map((l) => l.at)).toEqual([0.125, 0.375, 0.625, 0.875])
    expect(shape.leaves.map((l) => l.label)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('draws each merge as a bracket: up one child, across, down the other', () => {
    const [first] = dendrogramShape(tree()).links
    // a and b are at 0.125 and 0.375, both at height 0, joining at 0.1 / 0.8 = 0.125 unit.
    expect(first!.points).toEqual([
      { at: 0.125, height: 0 },
      { at: 0.125, height: 0.125 },
      { at: 0.375, height: 0.125 },
      { at: 0.375, height: 0 },
    ])
  })

  it('hangs a merge of two clusters off their midpoints, at their own heights', () => {
    const links = dendrogramShape(tree()).links
    const root = links[2]!
    // The two pairs' midpoints, and each child starts at the height it was formed at.
    expect(root.points[0]).toEqual({ at: 0.25, height: 0.125 })
    expect(root.points[3]).toEqual({ at: 0.75, height: 0.25 })
    expect(root.points[1]!.height).toBe(1)
  })

  it('normalises heights against the tallest merge, and reports what 1 means', () => {
    const shape = dendrogramShape(tree())
    expect(shape.maxHeight).toBeCloseTo(0.8)
    // The distance in the tree's own units is kept for the tooltip, un-normalised.
    expect(shape.links[0]!.distance).toBeCloseTo(0.1)
  })

  it('draws a tree whose merges are all at zero flat rather than dividing by it', () => {
    const flat = makeLinkage(
      Float64Array.from([0, 1, 0, 2]),
      ['a', 'b'],
      Int32Array.from([0, 1]),
    )
    const shape = dendrogramShape(flat)
    expect(shape.maxHeight).toBe(0)
    expect(shape.links[0]!.points.every((p) => Number.isFinite(p.height))).toBe(true)
  })

  it('records each branch as a contiguous run of the leaf order', () => {
    // Exact rather than approximate: the leaf order is a depth-first walk, so every subtree
    // occupies a contiguous block — which is what makes clicking a branch cheap however many
    // thousand leaves hang off it.
    const shape = dendrogramShape(tree())
    expect(shape.links.map((l) => [l.first, l.last])).toEqual([
      [0, 1],
      [2, 3],
      [0, 3],
    ])
    // Observations, not labels: a label column can name two leaves the same thing.
    expect(observationsUnder(shape, shape.links[1]!)).toEqual([2, 3])
    expect(observationsUnder(shape, shape.links[2]!)).toEqual([0, 1, 2, 3])
  })

  it('colours a branch by cluster only where everything under it agrees', () => {
    const shape = dendrogramShape(tree(Int32Array.from([1, 1, 2, 2])))
    // The two pairs are each wholly within one cluster; the root joins two and belongs to
    // neither, which is the "these groups, joined by grey" reading.
    expect(shape.links.map((l) => l.cluster)).toEqual([1, 2, 0])
    expect(shape.leaves.map((l) => l.cluster)).toEqual([1, 1, 2, 2])
  })

  it('leaves every branch uncoloured when nothing has cut the tree', () => {
    expect(dendrogramShape(tree()).links.every((l) => l.cluster === 0)).toBe(true)
  })

  it('handles a two-leaf tree, which is the smallest thing fastcore will cluster', () => {
    const pair = makeLinkage(
      Float64Array.from([0, 1, 0.5, 2]),
      ['a', 'b'],
      Int32Array.from([0, 1]),
    )
    const shape = dendrogramShape(pair)
    expect(shape.links).toHaveLength(1)
    expect(shape.leaves.map((l) => l.at)).toEqual([0.25, 0.75])
  })
})

describe('orientation', () => {
  const box = { width: 200, height: 100 }

  it('runs the distance axis right-to-left with the leaves on the right', () => {
    // Root at x = 0, leaves against the label column at the far right.
    expect(projectPoint({ at: 0.5, height: 1 }, 'right', box, FULL_WINDOW)).toEqual({
      x: 0,
      y: 50,
    })
    expect(projectPoint({ at: 0.5, height: 0 }, 'right', box, FULL_WINDOW)).toEqual({
      x: 200,
      y: 50,
    })
  })

  it('runs it top-to-bottom with the leaves at the bottom', () => {
    expect(projectPoint({ at: 0.5, height: 1 }, 'down', box, FULL_WINDOW)).toEqual({
      x: 100,
      y: 0,
    })
    expect(projectPoint({ at: 0.5, height: 0 }, 'down', box, FULL_WINDOW)).toEqual({
      x: 100,
      y: 100,
    })
  })

  it('is the only thing that differs, so the two are one picture rather than two layouts', () => {
    const shape = dendrogramShape(tree())
    const a = linkPath(shape.links[0]!, 'right', box, FULL_WINDOW)
    const b = linkPath(shape.links[0]!, 'down', box, FULL_WINDOW)
    expect(a.split(' ')).toHaveLength(4)
    expect(b.split(' ')).toHaveLength(4)
    expect(a).not.toBe(b)
    expect(a.startsWith('M')).toBe(true)
  })
})

describe('label thinning', () => {
  it('keeps every label where they all fit', () => {
    expect(labelStep(10, 200, 11)).toBe(1)
  })

  it('takes every nth rather than a chosen few', () => {
    // A subset picked by importance would leave a run of labels here and a gap there, which
    // reads as missing data on an axis whose order is meaningful.
    expect(labelStep(100, 200, 11)).toBe(6)
    expect(labelStep(40, 200, 11)).toBe(3)
  })

  it('never divides by a room of zero', () => {
    expect(labelStep(10, 0, 11)).toBe(1)
    expect(labelStep(0, 200, 11)).toBe(1)
  })
})

/**
 * The zoom window.
 *
 * Here rather than in a component test for the reason `heatmapPlot.test.ts` holds the heatmap's:
 * jsdom performs no layout and dispatches no real wheel, so everything a zoom actually *is* —
 * where the anchor lands, what the floor is, which brackets survive, how many names fit — is
 * arithmetic or it is covered by nothing.
 */
describe('the zoom window', () => {
  const box = { width: 200, height: 100 }
  /** The middle half of the leaf axis. */
  const half: DendrogramWindow = { at0: 0.25, atSpan: 0.5 }

  it('is the identity at the full window, so an unzoomed tree draws exactly as it did', () => {
    expect(projectPoint({ at: 0.5, height: 0.5 }, 'right', box, FULL_WINDOW)).toEqual({
      x: 100,
      y: 50,
    })
    expect(isFullWindow(FULL_WINDOW)).toBe(true)
    expect(windowScale(FULL_WINDOW)).toBe(1)
  })

  it('fills the leaf axis with whatever the window covers', () => {
    // `at0` lands at the axis's origin and `at0 + atSpan` at its far end — the same two pixels
    // the whole tree used to occupy.
    expect(projectPoint({ at: 0.25, height: 0 }, 'right', box, half).y).toBe(0)
    expect(projectPoint({ at: 0.75, height: 0 }, 'right', box, half).y).toBe(100)
  })

  it('leaves the distance axis whole at every zoom, which is the point of one axis', () => {
    // A merge sits at the same fraction of the plot zoomed or not, so two zoom states are
    // comparable — and the leaves never leave the picture, which the two-axis version could not
    // promise. See `DendrogramWindow`.
    for (const height of [0, 0.25, 1]) {
      expect(projectPoint({ at: 0.5, height }, 'right', box, half).x).toBe(
        projectPoint({ at: 0.5, height }, 'right', box, FULL_WINDOW).x,
      )
    }
  })

  it('is orientation-independent, so flipping the card keeps the zoom', () => {
    // The window is in unit space and orientation is a projection over it — the module's own
    // rule. A window held in screen terms would have to be transposed by the flip.
    const right = projectPoint({ at: 0.375, height: 0.25 }, 'right', box, half)
    const down = projectPoint({ at: 0.375, height: 0.25 }, 'down', box, half)
    expect(right.y / box.height).toBeCloseTo(down.x / box.width, 12)
  })

  it('round-trips a plot pixel back to the leaf under it', () => {
    // Which is what makes a zoom land where the pointer is: the anchor comes back out of
    // `pointToUnit` and goes into `zoomWindow` as the point that must not move.
    for (const orientation of ['right', 'down'] as const) {
      const point = { at: 0.4, height: 0.3 }
      const { x, y } = projectPoint(point, orientation, box, half)
      expect(pointToUnit(x, y, orientation, box, half)).toBeCloseTo(point.at, 12)
    }
  })

  it('zooms about the anchor, which is the leaf that does not move', () => {
    const next = zoomWindow(FULL_WINDOW, 0.4, 0.5, 100)
    const before = projectPoint({ at: 0.4, height: 0 }, 'right', box, FULL_WINDOW)
    const after = projectPoint({ at: 0.4, height: 0 }, 'right', box, next)
    expect(after.y).toBeCloseTo(before.y, 9)
    expect(next.atSpan).toBeCloseTo(0.5, 12)
  })

  it('stays inside the tree, so a zoom at the edge does not walk off it', () => {
    expect(zoomWindow(FULL_WINDOW, 0, 0.5, 100).at0).toBe(0)
    expect(panWindow(half, -10, 100)).toEqual({ ...half, at0: 0 })
    expect(panWindow(half, 10, 100)).toEqual({ ...half, at0: 0.5 })
  })

  it('will not zoom past one leaf filling the plot, and the floor is the leaf count', () => {
    // A four-leaf tree has nothing to show at ×1000; a four-thousand-leaf one has plenty.
    expect(zoomWindow(FULL_WINDOW, 0.5, 1e-6, 4).atSpan).toBeCloseTo(0.25, 12)
    expect(zoomWindow(FULL_WINDOW, 0.5, 1e-6, 4000).atSpan).toBeCloseTo(1 / 4000, 12)
  })

  it('reads as fitted the moment it covers everything again', () => {
    expect(isFullWindow(zoomWindow(half, 0.5, 8, 100))).toBe(true)
    expect(clampWindow({ at0: -1, atSpan: 4 }, 100)).toEqual(FULL_WINDOW)
  })

  it('clamps a stored window against the tree it is being applied to', () => {
    // The floor is one leaf, so a window kept from a 400-leaf tree is out of range the moment
    // the clustering upstream is filtered down to four.
    expect(clampWindow({ at0: 0.5, atSpan: 0.0025 }, 4).atSpan).toBe(0.25)
  })
})

describe('what the window leaves to draw', () => {
  it('hands back the same array when nothing is zoomed, so the memo sees no change', () => {
    const shape = dendrogramShape(tree())
    expect(visibleLinks(shape, FULL_WINDOW)).toBe(shape.links)
  })

  it('drops the brackets whose leaves the window does not reach', () => {
    const shape = dendrogramShape(tree())
    /*
     * Leaves land at 0.125, 0.375, 0.625, 0.875. A window over the first pair keeps their
     * bracket (merge 0) and drops the second pair's (merge 1, whose nearest leg is at 0.625).
     *
     * The **root survives**, and that is the feature rather than a leak: its crossbar spans
     * every leaf, so a zoomed picture stays attached to the tree it came from instead of
     * floating free of it.
     */
    expect(visibleLinks(shape, { at0: 0, atSpan: 0.3 }).map((l) => l.merge)).toEqual([0, 2])
  })

  it('names only the leaves in the window, and un-thins as a zoom gives them room', () => {
    const shape = dendrogramShape(caterpillar(100))
    // 100 leaves in 200px at an 11px pitch: every sixth name.
    const fitted = visibleLeaves(shape, FULL_WINDOW, 200, 11)
    expect(fitted.indices).toHaveLength(17)
    expect(fitted.thinned).toBe(true)

    // A tenth of them in the same 200px: every name fits, and nothing was thinned.
    const zoomed = visibleLeaves(shape, { at0: 0, atSpan: 0.1 }, 200, 11)
    expect(zoomed.indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(zoomed.thinned).toBe(false)
  })

  it('names every kth leaf by its own index, so a pan does not make them blink', () => {
    const shape = dendrogramShape(caterpillar(100))
    // `labelTicks` learned this one first: a modulus taken from the first *visible* leaf
    // re-picks which names are drawn on every pointer step. Two windows one leaf apart must
    // therefore agree about every leaf they both hold.
    const a = visibleLeaves(shape, { at0: 0.2, atSpan: 0.3 }, 60, 11)
    const b = visibleLeaves(shape, { at0: 0.21, atSpan: 0.3 }, 60, 11)
    const between = (i: number) => i >= 22 && i <= 49
    expect(b.indices.filter(between)).toEqual(a.indices.filter(between))
  })
})
