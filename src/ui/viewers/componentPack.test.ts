/**
 * Packing separately-laid-out components.
 *
 * Only one property here is load-bearing and it is the one a picture cannot show you: boxes
 * must not overlap. Two overlapping components draw as one tangled component, which is
 * exactly the failure the packing exists to prevent and is indistinguishable, on screen, from
 * a layout that simply came out badly.
 */

import { describe, expect, it } from 'vitest'

import { groupByComponent, shelfPack } from './componentPack'
import type { Box } from './componentPack'

const overlaps = (boxes: readonly Box[], at: Array<{ x: number; y: number }>): boolean => {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = { ...at[i]!, ...boxes[i]! }
      const b = { ...at[j]!, ...boxes[j]! }
      if (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
      ) {
        return true
      }
    }
  }
  return false
}

/** Deterministic spread of sizes: a few big, many small — the real graph's shape. */
const boxes = (count: number): Box[] =>
  Array.from({ length: count }, (_, i) => ({
    width: 10 + ((i * 37) % 90),
    height: 10 + ((i * 53) % 70),
  }))

describe('shelf packing', () => {
  it('never overlaps two boxes', () => {
    const set = boxes(120)
    const packed = shelfPack(set, 6)
    expect(overlaps(set, packed.at)).toBe(false)
  })

  it('never overlaps them with no gap at all', () => {
    // The gap is what hides an off-by-one in the shelf arithmetic, so the honest test removes it.
    const set = boxes(120)
    const packed = shelfPack(set, 0)
    expect(overlaps(set, packed.at)).toBe(false)
  })

  it('reports a field that contains every box', () => {
    const set = boxes(60)
    const packed = shelfPack(set, 8)
    set.forEach((box, i) => {
      expect(packed.at[i]!.x + box.width).toBeLessThanOrEqual(packed.width + 1e-9)
      expect(packed.at[i]!.y + box.height).toBeLessThanOrEqual(packed.height + 1e-9)
    })
  })

  it('comes out roughly square rather than one long row', () => {
    // A row of 12,000 components is technically a packing and is unreadable at any zoom.
    const packed = shelfPack(boxes(400), 10)
    const aspect = packed.width / packed.height
    expect(aspect).toBeGreaterThan(0.5)
    expect(aspect).toBeLessThan(2)
  })

  it('gives the same answer twice, and one that does not depend on input order', () => {
    // Positions reach a picture that is recomputed on every presentational edit; a packing
    // that depended on iteration order would reshuffle the whole field when a colour changed.
    const set = boxes(50)
    expect(shelfPack(set, 5).at).toEqual(shelfPack(set, 5).at)

    const shuffled = [...set].reverse()
    const a = shelfPack(set, 5)
    const b = shelfPack(shuffled, 5)
    expect(b.width).toBe(a.width)
    expect(b.height).toBe(a.height)
  })

  it('gives a box wider than the target a shelf of its own', () => {
    const set: Box[] = [{ width: 4000, height: 20 }, ...boxes(20)]
    const packed = shelfPack(set, 5)
    expect(overlaps(set, packed.at)).toBe(false)
    expect(packed.width).toBeGreaterThanOrEqual(4000)
  })

  it('handles nothing and one', () => {
    expect(shelfPack([], 5)).toEqual({ at: [], width: 0, height: 0 })
    const one = shelfPack([{ width: 30, height: 40 }], 5)
    expect(one.at).toEqual([{ x: 0, y: 0 }])
    expect(one.width).toBe(30)
    expect(one.height).toBe(40)
  })

  it('tolerates zero-sized boxes, which a one-node component is', () => {
    // 13,000 of the real graph's components are two nodes and plenty are one, so a box with
    // no extent is the common case rather than an edge case.
    const set: Box[] = Array.from({ length: 40 }, () => ({ width: 0, height: 0 }))
    const packed = shelfPack(set, 10)
    expect(packed.at.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
    expect(new Set(packed.at.map((p) => `${p.x},${p.y}`)).size).toBe(40)
  })
})

describe('grouping by component label', () => {
  it('collects each label’s members in node order', () => {
    expect(groupByComponent([1, 2, 1, 3, 2, 1])).toEqual([[0, 2, 5], [1, 4], [3]])
  })

  it('orders the groups by label, which is by size', () => {
    // `componentLabels` numbers largest-first, so group 0 is the largest component and the
    // packing's height-descending sort has something consistent to work from.
    const groups = groupByComponent([2, 1, 1, 1, 2])
    expect(groups[0]).toEqual([1, 2, 3])
    expect(groups[1]).toEqual([0, 4])
  })

  it('handles an empty set', () => {
    expect(groupByComponent([])).toEqual([])
  })
})
