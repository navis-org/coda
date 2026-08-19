/**
 * Thumbnail geometry and row composition.
 *
 * Both are pure, which is the point: there is no WebGL in jsdom and no browser automation in
 * this repo, so anything that lives only inside a canvas-drawing component has no coverage at
 * all. The projection and the field selection are where the bugs would be, so they are out here
 * where they can be checked.
 *
 * What is *not* checked anywhere: how a rendered thumbnail actually looks. That was verified by
 * rasterising real hemibrain, MANC and male-CNS neurons and printing the mask as ASCII — an LC4
 * showed its lobula arbor, thin neurite and terminal tuft, and male-CNS body 10001 showed the
 * giant fibre's descending axon — but that check needed a token and a network, so it cannot live
 * in the suite.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { rowFields, statUnit } from './rowFields'
import {
  coverageFraction,
  emptySilhouette,
  hexToRgb,
  rasteriseSilhouette,
  silhouetteToRgba,
} from './thumbnail'

/** A unit square at a single depth: two triangles filling most of the tile. */
const SQUARE_POSITIONS = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0])
const SQUARE_INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])

function at(silhouette: { size: number; coverage: Uint8Array }, x: number, y: number): number {
  return silhouette.coverage[y * silhouette.size + x] ?? 0
}

describe('rasteriseSilhouette', () => {
  it('fills the interior of a shape', () => {
    const result = rasteriseSilhouette(SQUARE_POSITIONS, SQUARE_INDICES, 32)
    expect(at(result, 16, 16)).toBeGreaterThan(0)
    expect(coverageFraction(result)).toBeGreaterThan(0.6)
  })

  it('keeps the shape inside the tile, with padding', () => {
    const result = rasteriseSilhouette(SQUARE_POSITIONS, SQUARE_INDICES, 32)
    // Corners stay clear: a thumbnail flush against its edge reads as clipped.
    expect(at(result, 0, 0)).toBe(0)
    expect(at(result, 31, 31)).toBe(0)
  })

  it('preserves aspect ratio rather than stretching to fill', () => {
    // A shape twice as wide as tall must stay twice as wide as tall.
    const wide = new Float32Array([0, 0, 0, 20, 0, 0, 20, 5, 0, 0, 5, 0])
    const result = rasteriseSilhouette(wide, SQUARE_INDICES, 40)
    let minX = 40
    let maxX = 0
    let minY = 40
    let maxY = 0
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        if (at(result, x, y) === 0) continue
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
    const ratio = (maxX - minX + 1) / (maxY - minY + 1)
    expect(ratio).toBeGreaterThan(3.2)
    expect(ratio).toBeLessThan(4.8)
  })

  it('shades by depth, so a flat projection still reads as a 3D object', () => {
    // Two separated triangles at different depths; the nearer one must be brighter.
    const positions = new Float32Array([
      0, 0, 0, 4, 0, 0, 0, 4, 0, // near
      6, 6, 100, 10, 6, 100, 6, 10, 100, // far
    ])
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5])
    const result = rasteriseSilhouette(positions, indices, 48)

    let near = 0
    let far = 0
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 48; x++) {
        const value = at(result, x, y)
        if (value === 0) continue
        // The near triangle occupies the top-left of the projected bounds.
        if (x < 24 && y < 24) near = Math.max(near, value)
        else far = Math.max(far, value)
      }
    }
    expect(near).toBeGreaterThan(far)
    expect(far).toBeGreaterThan(0)
  })

  it('returns an empty mask rather than throwing on degenerate input', () => {
    expect(coverageFraction(rasteriseSilhouette(new Float32Array(0), new Uint32Array(0), 16))).toBe(0)
    // Every vertex identical: no span to scale by, and a division would produce NaN indices.
    const collapsed = new Float32Array([5, 5, 5, 5, 5, 5, 5, 5, 5])
    expect(coverageFraction(rasteriseSilhouette(collapsed, new Uint32Array([0, 1, 2]), 16))).toBe(0)
  })

  it('ignores indices that point outside the vertex list', () => {
    // A truncated fragment should degrade to a partial drawing, not a crash.
    expect(() =>
      rasteriseSilhouette(SQUARE_POSITIONS, new Uint32Array([0, 1, 99]), 16),
    ).not.toThrow()
  })
})

describe('silhouetteToRgba', () => {
  it('paints one colour at the mask’s alpha', () => {
    const silhouette = emptySilhouette(2)
    silhouette.coverage[0] = 255
    silhouette.coverage[3] = 128
    const rgba = silhouetteToRgba(silhouette, { r: 10, g: 20, b: 30 })
    expect([...rgba.slice(0, 4)]).toEqual([10, 20, 30, 255])
    // Untouched pixels stay fully transparent, so the tile's background shows through.
    expect([...rgba.slice(4, 8)]).toEqual([0, 0, 0, 0])
    expect(rgba[15]).toBe(128)
  })

  it('stores no colour in the mask itself, so a cached tile survives a theme switch', () => {
    const silhouette = emptySilhouette(2)
    silhouette.coverage[0] = 200
    const light = silhouetteToRgba(silhouette, { r: 0, g: 0, b: 0 })
    const dark = silhouetteToRgba(silhouette, { r: 255, g: 255, b: 255 })
    expect(light[0]).toBe(0)
    expect(dark[0]).toBe(255)
    expect(light[3]).toBe(dark[3])
  })
})

describe('hexToRgb', () => {
  it('reads a six-digit hex, with or without the hash', () => {
    expect(hexToRgb('#1baf7a')).toEqual({ r: 27, g: 175, b: 122 })
    expect(hexToRgb('1baf7a')).toEqual({ r: 27, g: 175, b: 122 })
  })

  it('falls back to grey rather than throwing on a colour it cannot read', () => {
    // The palette is literal hex today, but a CSS variable slipping in must not kill a row.
    expect(hexToRgb('var(--text-muted)')).toEqual({ r: 128, g: 128, b: 128 })
  })
})

// ---------------------------------------------------------------------------

describe('rowFields', () => {
  /** Shaped after male-CNS, which has more chip-eligible columns than a row can hold. */
  const maleCns = tableSchema(
    column('bodyId', 'i64'),
    column('type', 'str'),
    column('instance', 'str'),
    ...['class', 'subclass', 'superclass', 'somaSide', 'rootSide', 'itoleeHl', 'trumanHl', 'hemilineage', 'consensusNt', 'predictedNt', 'flywireType'].map(
      (n) => column(n, 'str'),
    ),
    ...['pre', 'post', 'synweight', 'upstream', 'downstream'].map((n) => column(n, 'i64')),
  )

  const hemibrain = tableSchema(
    column('bodyId', 'i64'),
    column('type', 'str'),
    column('instance', 'str'),
    column('status', 'str'),
    column('size', 'i64', 'voxels'),
    column('pre', 'i64', 'synapses'),
    column('post', 'i64', 'synapses'),
    column('cellBodyFiber', 'str'),
  )

  it('leads with the neuron’s name', () => {
    expect(rowFields(hemibrain).primary).toBe('type')
  })

  it('never repeats the headline on the line beneath it', () => {
    const noType = tableSchema(column('bodyId', 'i64'), column('instance', 'str'))
    const fields = rowFields(noType)
    expect(fields.primary).toBe('instance')
    expect(fields.secondary).not.toContain('instance')
  })

  it('picks up dataset-specific annotations without being told about them', () => {
    // The whole reason this is a spec: hemibrain has cellBodyFiber, MANC has hemilineage,
    // male-CNS has superclass, and the row component knows none of those names.
    expect(rowFields(hemibrain).chips).toContain('cellBodyFiber')
    const manc = tableSchema(
      column('bodyId', 'i64'),
      column('type', 'str'),
      column('hemilineage', 'str'),
    )
    expect(rowFields(manc).chips).toEqual(['hemilineage'])
  })

  it('caps the automatic chip list at the size of the palette', () => {
    const wide = tableSchema(
      column('bodyId', 'i64'),
      column('type', 'str'),
      ...['class', 'subclass', 'superclass', 'somaSide', 'rootSide', 'itoleeHl', 'consensusNt', 'cellBodyFiber', 'flywireType'].map(
        (n) => column(n, 'str'),
      ),
    )
    expect(rowFields(wide).chips).toHaveLength(8)
    expect(rowFields(maleCns).stats).toHaveLength(3)
  })

  it('spends one slot per fact, not one per name for it', () => {
    // The bug this rule exists for: male-CNS publishes the hemilineage twice and the
    // neurotransmitter twice, and the four of them together pushed `consensusNt` — a field
    // that says something none of the others do — off the end of the list.
    const chips = rowFields(maleCns).chips
    expect(chips).toContain('itoleeHl')
    expect(chips).not.toContain('hemilineage')
    expect(chips).toContain('consensusNt')
    expect(chips).not.toContain('predictedNt')
  })

  it('falls back to the other name for a fact when the first is absent', () => {
    const manc = tableSchema(
      column('bodyId', 'i64'),
      column('type', 'str'),
      column('hemilineage', 'str'),
      column('predictedNt', 'str'),
    )
    expect(rowFields(manc).chips).toEqual(['hemilineage', 'predictedNt'])
  })

  it('shows both side markers on a dataset that has them', () => {
    // The reason the cap is six rather than four: on male-CNS the taxonomic ranks alone fill
    // four slots, so `somaSide` and `rootSide` — the fields someone browsing a bilateral
    // dataset is actually looking for — never used to reach the row.
    const fields = rowFields(maleCns)
    expect(fields.chips).toContain('somaSide')
    expect(fields.chips).toContain('rootSide')
  })

  it('keeps the side markers ahead of the fields that would crowd them out', () => {
    expect(rowFields(maleCns).chips).toEqual([
      'class',
      'subclass',
      'superclass',
      'somaSide',
      'rootSide',
      'itoleeHl',
      'consensusNt',
      'flywireType',
    ])
  })

  it('takes the hemilineage under whichever name the dataset publishes it', () => {
    // `trumanHl` is not a candidate at all — one of male-CNS's two nomenclatures has to lead,
    // and the `chips` param is how someone asks for the other.
    expect(rowFields(maleCns).chips).not.toContain('trumanHl')
    const manc = tableSchema(column('bodyId', 'i64'), column('type', 'str'), column('hemilineage', 'str'))
    expect(rowFields(manc).chips).toEqual(['hemilineage'])
  })

  it('shows exactly the fields chosen in the inspector, in that order', () => {
    // Not merged with the automatic list and not reordered by it: a list someone typed is an
    // instruction, and a control that silently adds to what you asked for stops being one.
    expect(rowFields(maleCns, ['trumanHl', 'class'])).toMatchObject({
      chips: ['trumanHl', 'class'],
    })
  })

  it('is not capped when the fields were chosen by hand', () => {
    const every = maleCns.columns.filter((c) => c.dtype === 'str').map((c) => c.name)
    expect(every.length).toBeGreaterThan(8)
    expect(rowFields(maleCns, every).chips).toHaveLength(every.length)
  })

  it('drops a chosen field the dataset does not have', () => {
    // The param outlives the dataset it was set on. Repointed at hemibrain, `superclass`
    // should disappear rather than render a column of blanks.
    const hemibrainish = tableSchema(column('bodyId', 'i64'), column('cellBodyFiber', 'str'))
    expect(rowFields(hemibrainish, ['superclass', 'cellBodyFiber']).chips).toEqual([
      'cellBodyFiber',
    ])
  })

  it('treats a numerically-named column as a stat only when it is numeric', () => {
    // A source that types `pre` as a string must not land in the figure column, where it
    // would be formatted as a number and render as an em dash.
    const odd = tableSchema(column('bodyId', 'i64'), column('pre', 'str'))
    expect(rowFields(odd).stats).toEqual([])
  })

  it('survives a schema it knows nothing about', () => {
    const alien = tableSchema(column('bodyId', 'i64'), column('weird', 'str'))
    const fields = rowFields(alien)
    expect(fields.primary).toBe('weird')
    expect(fields.chips).toEqual([])
  })

  it('reports no fields at all for an absent schema', () => {
    expect(rowFields(undefined)).toEqual({
      primary: undefined,
      secondary: [],
      chips: [],
      stats: [],
    })
  })

  it('reads a stat’s unit off the schema', () => {
    expect(statUnit(hemibrain, 'post')).toBe('synapses')
    expect(statUnit(hemibrain, 'type')).toBeUndefined()
  })
})
