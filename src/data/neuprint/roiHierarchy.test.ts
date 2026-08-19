/**
 * The level above the primary regions.
 *
 * The tree is transcribed from the one neuprint-python's own documentation prints for hemibrain,
 * so what is asserted here is the real shape rather than a convenient one: primary regions
 * listed directly under the dataset root beside groups that contain them.
 */

import { describe, expect, it } from 'vitest'

import { superRoiNames, superRoisFrom } from './roiHierarchy'

/** hemibrain's, as `fetch_roi_hierarchy` prints it. Asterisks there mark the primary set. */
const HEMIBRAIN = {
  name: 'hemibrain',
  children: [
    { name: 'AL(L)' },
    { name: 'AL(R)' },
    { name: 'AOT(R)' },
    {
      name: 'CX',
      children: [
        { name: 'AB(L)' },
        { name: 'AB(R)' },
        { name: 'EB' },
        { name: 'FB' },
        { name: 'NO' },
        { name: 'PB' },
      ],
    },
    { name: 'GNG' },
    {
      name: 'INP',
      children: [{ name: 'ATL(L)' }, { name: 'ATL(R)' }, { name: 'IB' }],
    },
  ],
}

const PRIMARY = ['AL(L)', 'AL(R)', 'AB(L)', 'AB(R)', 'EB', 'FB', 'NO', 'PB', 'GNG', 'ATL(L)', 'ATL(R)', 'IB']

describe('superRoisFrom', () => {
  it('maps a primary region to the group above it', () => {
    const groups = superRoisFrom(HEMIBRAIN, PRIMARY)
    expect(groups['EB']).toBe('CX')
    expect(groups['FB']).toBe('CX')
    expect(groups['PB']).toBe('CX')
    expect(groups['IB']).toBe('INP')
  })

  it('leaves a region listed directly under the root ungrouped', () => {
    /*
     * A real answer, not a gap. hemibrain lists `AL(L)` and `GNG` beside `CX` and `INP`, so the
     * root is the only thing above them — and the root is the dataset itself, which would make
     * one group containing everything: a control that does nothing dressed as one that does.
     */
    const groups = superRoisFrom(HEMIBRAIN, PRIMARY)
    expect(groups['AL(L)']).toBeUndefined()
    expect(groups['GNG']).toBeUndefined()
    expect(Object.values(groups)).not.toContain('hemibrain')
  })

  it('ignores a non-primary leaf, which is not a region anyone draws', () => {
    // `AOT(R)` is in the tree and not in the primary set.
    expect(superRoisFrom(HEMIBRAIN, PRIMARY)['AOT(R)']).toBeUndefined()
  })

  it('does not descend into a primary region', () => {
    // Sub-primary regions nest *inside* a primary one; this is about the level above, so
    // mapping them would put them in a group they are only indirectly in.
    const nested = {
      name: 'ds',
      children: [
        { name: 'OL', children: [{ name: 'ME(R)', children: [{ name: 'ME_col_1' }] }] },
      ],
    }
    const groups = superRoisFrom(nested, ['ME(R)', 'ME_col_1'])
    expect(groups['ME(R)']).toBe('OL')
    expect(groups['ME_col_1']).toBeUndefined()
  })

  it('keeps the nearest group when they nest', () => {
    const deep = {
      name: 'ds',
      children: [{ name: 'Outer', children: [{ name: 'Inner', children: [{ name: 'X' }] }] }],
    }
    expect(superRoisFrom(deep, ['X'])['X']).toBe('Outer')
  })

  it('reads the JSON string Neo4j actually stores', () => {
    // `Meta.roiHierarchy` is a string; neuprint-python decodes it with apoc on the server side.
    const groups = superRoisFrom(JSON.stringify(HEMIBRAIN), PRIMARY)
    expect(groups['EB']).toBe('CX')
  })

  it('loses the grouping rather than the map when the tree is unusable', () => {
    // Somebody else's data, arriving as a string over a network.
    expect(superRoisFrom('{not json', PRIMARY)).toEqual({})
    expect(superRoisFrom(undefined, PRIMARY)).toEqual({})
    expect(superRoisFrom(null, PRIMARY)).toEqual({})
    expect(superRoisFrom({ children: [{ name: 'x' }] }, ['x'])).toEqual({})
  })

  it('answers nothing when no region is primary', () => {
    expect(superRoisFrom(HEMIBRAIN, [])).toEqual({})
  })
})

describe('superRoiNames', () => {
  it('lists the groups once each, in the order the hierarchy gives them', () => {
    // Tree order rather than alphabetical: the hierarchy is somebody's ordering of anatomy and
    // re-sorting discards it for nothing.
    expect(superRoiNames(superRoisFrom(HEMIBRAIN, PRIMARY))).toEqual(['CX', 'INP'])
  })

  it('is empty for a dataset whose primary regions are all top level', () => {
    const flat = { name: 'ds', children: [{ name: 'A' }, { name: 'B' }] }
    expect(superRoiNames(superRoisFrom(flat, ['A', 'B']))).toEqual([])
  })
})
