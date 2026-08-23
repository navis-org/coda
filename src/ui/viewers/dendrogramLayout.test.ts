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
import { dendrogramShape, linkPath, observationsUnder, projectPoint } from './dendrogramLayout'

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
    expect(projectPoint({ at: 0.5, height: 1 }, 'right', box)).toEqual({ x: 0, y: 50 })
    expect(projectPoint({ at: 0.5, height: 0 }, 'right', box)).toEqual({ x: 200, y: 50 })
  })

  it('runs it top-to-bottom with the leaves at the bottom', () => {
    expect(projectPoint({ at: 0.5, height: 1 }, 'down', box)).toEqual({ x: 100, y: 0 })
    expect(projectPoint({ at: 0.5, height: 0 }, 'down', box)).toEqual({ x: 100, y: 100 })
  })

  it('is the only thing that differs, so the two are one picture rather than two layouts', () => {
    const shape = dendrogramShape(tree())
    const a = linkPath(shape.links[0]!, 'right', box)
    const b = linkPath(shape.links[0]!, 'down', box)
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
