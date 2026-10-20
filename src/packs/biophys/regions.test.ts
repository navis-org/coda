/**
 * Painted regions: strokes over the skeleton's own labels, in order, later over earlier; filed by
 * neuron; one that lands nowhere counted. What the build makes of them is `build.test.ts`'.
 */

import { describe, expect, it } from 'vitest'

import type { ModelRegionOptions, RegionStroke } from './regions'
import { modelRegions, readRegionStrokes, writeRegionStroke } from './regions'
import { emSoma, neuron } from './testFixtures'

const skeleton = neuron().items[0]!
/** The skeleton's labels with strokes painted on, the soma kept as is so the taper paints nothing. */
const paintedRegions = (on: typeof skeleton, strokes: RegionStroke[]) =>
  modelRegions(on, { strokes, somaMode: 'asIs', somaDiameter: 0, defaultRadius: 100 })
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

describe('the soma and ignored regions', () => {
  const em = emSoma().items[0]!
  // The emSoma nodes, by where they are.
  const node = (k: number): [number, number, number] =>
    [em.positions[k * 3]!, em.positions[k * 3 + 1]!, 0] as [number, number, number]
  const emStroke = (over: Partial<RegionStroke>): RegionStroke =>
    stroke({ neuron: '7', root: node(0), ...over })
  const regions = (strokes: RegionStroke[] = [], over: Partial<ModelRegionOptions> = {}) =>
    modelRegions(em, {
      strokes,
      somaMode: 'replace',
      somaDiameter: 0,
      defaultRadius: 100,
      ...over,
    })
  const members = (set: Uint8Array) => Array.from(set.keys()).filter((v) => set[v])

  it('paints up to a node: the path from the soma and the twigs dying before it, not a neurite', () => {
    const painted = paintedRegions(em, [
      emStroke({ at: node(5), scope: 'upTo', region: 'body' }),
    ])
    const body = painted.names.indexOf('body')
    expect(
      members(painted.label.map((l) => (l === body ? 1 : 0)) as unknown as Uint8Array),
    ).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('starts the soma at the taper and its dead ends, and lets strokes move it', () => {
    const start = regions()
    expect(start.source).toBe('labelled')
    expect(start.somaDiameter).toBe(6)
    expect(members(start.somaSet)).toEqual([0, 1, 2, 3, 4])
    // Painted off it, the fibre's start is cable again; painted on, the soma reaches further.
    expect(members(regions([emStroke({ at: node(4), region: 'axon' })]).somaSet)).toEqual([
      0, 1, 2, 3,
    ])
    expect(
      members(regions([emStroke({ at: node(5), scope: 'upTo', region: 'soma' })]).somaSet),
    ).toEqual([0, 1, 2, 3, 4, 5])
    // Soma painted where it does not touch the soma is soma membrane, and stays cable.
    expect(members(regions([emStroke({ at: node(8), region: 'soma' })]).somaSet)).toEqual([
      0, 1, 2, 3, 4,
    ])
  })

  it('keeps the skeleton as it is when told to: nothing replaced, no diameter', () => {
    const asIs = regions([], { somaMode: 'asIs', somaDiameter: 8 })
    expect(members(asIs.somaSet)).toEqual([])
    expect(asIs.somaDiameter).toBe(0)
    expect(asIs.source).toBe('labelled')
  })

  it('ignores a subtree whole, and refuses a stroke that would ignore the soma', () => {
    const ignored = regions([emStroke({ at: node(7), region: '', ignore: true })])
    expect(members(ignored.ignored)).toEqual([7, 8])
    expect(ignored.refused).toBe(0)
    const everythingElse = regions([
      emStroke({ at: node(7), scope: 'proximal', region: '', ignore: true }),
    ])
    expect(members(everythingElse.ignored)).toEqual([])
    expect(everythingElse.refused).toBe(1)
  })

  it('keeps a region somebody named "ignored" a region: ignoring is a flag, never a name', () => {
    const named = regions([emStroke({ at: node(7), region: 'ignored' })])
    expect(members(named.ignored)).toEqual([])
    expect(named.names).toContain('ignored')
    expect(named.label[8]).toBe(named.names.indexOf('ignored'))
  })

  it('leaves no ignored code behind on a fragment the walk never reached', () => {
    // Ignoring the last-coded region's branch while a fragment carries a later code.
    const out = regions([
      emStroke({ at: node(5), region: 'tail' }),
      emStroke({ at: node(7), region: '', ignore: true }),
    ])
    expect(Array.from(out.label).every((code) => code >= 0 && code < out.names.length)).toBe(
      true,
    )
  })

  it('reads the new scope and the ignored region back, and still no unlabelled', () => {
    const upTo = emStroke({ scope: 'upTo', region: '', ignore: true })
    expect(readRegionStrokes([writeRegionStroke(upTo)])).toEqual([upTo])
    expect(
      readRegionStrokes([writeRegionStroke(emStroke({ scope: 'upTo', region: 'unlabelled' }))]),
    ).toEqual([])
  })
})
