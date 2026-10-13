/**
 * Painted regions: strokes over the skeleton's own labels, in order, later over earlier; filed by
 * neuron; one that lands nowhere counted. What the build makes of them is `build.test.ts`'.
 */

import { describe, expect, it } from 'vitest'

import type { RegionStroke } from './regions'
import { paintedRegions, readRegionStrokes, writeRegionStroke } from './regions'
import { neuron } from './testFixtures'

const skeleton = neuron().items[0]!
const SOMA: [number, number, number] = [0, 0, 0]
const at = (x: number, y = 0): [number, number, number] => [x, y, 0]
const stroke = (over: Partial<RegionStroke>): RegionStroke => ({
  neuron: '7',
  at: at(30_000, 10_000),
  scope: 'distal',
  region: 'branch',
  root: SOMA,
  ...over,
})
const named = (painted: ReturnType<typeof paintedRegions>) =>
  Array.from(painted.label, (i) => painted.names[i])

describe('paintedRegions', () => {
  it('is the skeleton’s own labels with no strokes', () => {
    const painted = paintedRegions(skeleton, [])
    expect(painted.names).toEqual(['unlabelled', 'soma', 'dendrite'])
    expect(painted.stale).toBe(0)
  })

  it('paints distal of a point under a new name, and a later stroke over it', () => {
    const one = paintedRegions(skeleton, [stroke({})])
    expect(one.names).toEqual(['unlabelled', 'soma', 'dendrite', 'branch'])
    expect(named(one).slice(0, 10)).toEqual([
      'soma',
      'soma',
      'dendrite',
      'dendrite',
      'dendrite',
      'dendrite',
      'dendrite',
      'dendrite',
      'branch',
      'branch',
    ])
    // Distal of x = 30 µm takes the branch back: later wins, and every node is in one region.
    const two = paintedRegions(skeleton, [
      stroke({}),
      stroke({ at: at(30_000), region: 'axon' }),
    ])
    expect(named(two).slice(0, 10)).toEqual([
      'soma',
      'soma',
      'dendrite',
      'dendrite',
      'axon',
      'axon',
      'axon',
      'axon',
      'axon',
      'axon',
    ])
  })

  it('paints everything else, the soma included, and leaves the fragment off the walk alone', () => {
    const painted = paintedRegions(skeleton, [stroke({ scope: 'proximal', region: 'rest' })])
    expect(named(painted)).toEqual([
      'rest',
      'rest',
      'rest',
      'rest',
      'rest',
      'rest',
      'rest',
      'rest',
      'dendrite',
      'dendrite',
      'dendrite',
      'dendrite',
    ])
  })

  it('reads only this neuron’s strokes, and counts one that lands nowhere', () => {
    const painted = paintedRegions(skeleton, [
      stroke({ neuron: '8' }),
      stroke({ at: at(900_000) }),
    ])
    expect(painted.stale).toBe(1)
    expect(painted.names).not.toContain('branch')
  })
})

describe('the stored strokes', () => {
  it('round-trip, and drop anything that does not read as one', () => {
    const s = stroke({ region: '  SIZ ' })
    const read = readRegionStrokes([
      writeRegionStroke(s),
      'not json',
      JSON.stringify({ ...s, scope: 'sideways' }),
      JSON.stringify({ ...s, region: '   ' }),
      JSON.stringify({ ...s, at: [1, 2] }),
    ])
    expect(read).toEqual([{ ...s, region: 'SIZ' }])
    expect(readRegionStrokes('nope')).toEqual([])
  })
})
