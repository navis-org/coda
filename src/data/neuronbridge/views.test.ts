/**
 * What a comparison draws, against the recorded match files. The rules are `views.ts`' header;
 * each has a case here, the mirroring ones above all — a wrong flip draws a plausible neuron on
 * the wrong side of the brain.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { NbConfig } from './client'
import type { NbImage, NbMatch } from './types'
import { readImage, readLookup, readMatches } from './types'
import { SCALE_BAR_CORNER, comparisonFor, cornerClip, lmViewsFor } from './views'

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8')) as unknown

/** The recorded config's prefixes, read the way `fetchConfig` reads them. */
function config(): NbConfig {
  const raw = fixture('config.json') as {
    stores: Record<string, { prefixes: Record<string, string> }>
  }
  return {
    version: 'v3_10_0',
    prefixes: new Map(Object.entries(raw.stores).map(([id, s]) => [id, s.prefixes])),
    emLibraries: [],
  }
}

const EM: NbImage = readLookup(fixture('by_body-1734350788.json'), 'x')[0]!
const CDS = readMatches(fixture('cdsresults-2945073143147307019.sample.json'), 'x').results
const PPPM = readMatches(fixture('pppmresults-2941778995433177634.sample.json'), 'x').results
const mirrored = CDS.find((m) => m.mirrored)!
const direct = CDS.find((m) => !m.mirrored)!

const urls = (layers: readonly { url: string }[]) => layers.map((l) => l.url.split('/').pop())

describe('CDS comparisons', () => {
  it('draws the EM search image beside the segmented hit, by default', () => {
    const view = comparisonFor(config(), EM, direct, 'cds', 'side', 'hit')
    expect(view.figures.map((f) => f.id)).toEqual(['em', 'lm'])
    expect(urls(view.figures[0]!.layers)).toEqual([direct.files.CDMInput!.split('/').pop()])
    expect(urls(view.figures[1]!.layers)).toEqual([direct.files.CDMMatch!.split('/').pop()])
    expect(view.figures[0]!.layers[0]!.flip).toBeUndefined()
  })

  it('flips the EM, never the LM, for a mirrored match — and hides the flipped scale bar', () => {
    const side = comparisonFor(config(), EM, mirrored, 'cds', 'side', 'both')
    const [em, lm] = side.figures
    expect(em!.layers[0]).toMatchObject({ flip: true, hideCorner: true })
    expect(em!.caption).toMatch(/mirrored to match/)
    expect(lm!.layers.every((l) => !l.flip)).toBe(true)

    const overlay = comparisonFor(config(), EM, mirrored, 'cds', 'overlay', 'line')
    const layers = overlay.figures[0]!.layers
    expect(layers.at(-1)).toMatchObject({
      em: true,
      flip: true,
      lighten: true,
      hideCorner: true,
    })
    expect(layers.slice(0, -1).every((l) => !l.flip)).toBe(true)
  })

  it('draws the whole sample from the LM image’s own projection', () => {
    const view = comparisonFor(config(), EM, direct, 'cds', 'lm', 'line')
    expect(view.figures.map((f) => f.id)).toEqual(['lm'])
    expect(urls(view.figures[0]!.layers)).toEqual([direct.image.files.CDM!.split('/').pop()])
  })

  it('lays the hit in colour over the whole sample in grey, the grey’s scale bar hidden', () => {
    const [lm] = comparisonFor(config(), EM, direct, 'cds', 'lm', 'both').figures
    expect(lm!.layers).toHaveLength(2)
    expect(lm!.layers[0]).toMatchObject({ grey: true, hideCorner: true })
    expect(lm!.layers[0]!.url.endsWith(`/${direct.image.files.CDM}`)).toBe(true)
    expect(lm!.layers[1]).toMatchObject({ lighten: true })
    expect(lm!.layers[1]!.url).toBe(
      `https://s3.amazonaws.com/janelia-flylight-color-depth/${direct.files.CDMMatch}`,
    )
  })

  it('overlays the EM on top of whichever LM view is chosen, with its opacity live', () => {
    for (const lmView of ['hit', 'line', 'both'] as const) {
      const view = comparisonFor(config(), EM, direct, 'cds', 'overlay', lmView)
      expect(view.figures).toHaveLength(1)
      expect(view.figures[0]!.layers.at(-1)).toMatchObject({ em: true, lighten: true })
      expect(view.emOpacity).toBe(true)
    }
  })
})

describe('PPPM comparisons', () => {
  const match = PPPM[0]!

  it('has no hit that can be laid over the line, and says so rather than drawing something else', () => {
    expect(lmViewsFor('pppm')).toEqual(['hit', 'line'])
    const view = comparisonFor(config(), EM, match, 'pppm', 'lm', 'both')
    expect(view.lmView).toBe('hit')
    expect(view.note).toMatch(/grey/)
    expect(urls(view.figures[0]!.layers)).toEqual([
      match.files.SignalMipMasked!.split('/').pop(),
    ])
  })

  it('overlays with NeuronBridge’s own renderings, which the opacity control cannot reach', () => {
    const hit = comparisonFor(config(), EM, match, 'pppm', 'overlay', 'hit')
    expect(urls(hit.figures[0]!.layers)).toEqual([
      match.files.SignalMipMaskedSkel!.split('/').pop(),
    ])
    const line = comparisonFor(config(), EM, match, 'pppm', 'overlay', 'line')
    expect(urls(line.figures[0]!.layers)).toEqual([match.files.CDMSkel!.split('/').pop()])
    expect(line.emOpacity).toBe(false)
    expect(line.figures[0]!.layers.some((l) => l.em)).toBe(false)
  })

  it('borrows the EM neuron’s own projection for side by side, flipped where mirrored', () => {
    const view = comparisonFor(config(), EM, match, 'pppm', 'side', 'line')
    expect(view.figures[0]!.id).toBe('em')
    expect(view.figures[0]!.layers[0]!.url).toMatch(
      /1734350788-JRC2018_Unisex_20x_HR-CDM\.png$/,
    )
    expect(view.figures[0]!.layers[0]!.flip).toBe(match.mirrored ? true : undefined)
    expect(urls(view.figures[1]!.layers)).toEqual([match.files.CDMBest!.split('/').pop()])
  })
})

describe('unpublished files', () => {
  it('draws an empty figure rather than a broken image', () => {
    const bare: NbMatch = { ...direct, files: { store: direct.files.store! } }
    const emOnly = readImage({ ...EM, files: { store: EM.files.store } })!
    const view = comparisonFor(config(), emOnly, bare, 'cds', 'side', 'hit')
    expect(view.figures.map((f) => f.layers.length)).toEqual([0, 0])
  })
})

describe('the scale-bar clip', () => {
  it('cuts the same pixel block from a landscape brain image and a portrait nerve cord', () => {
    expect(cornerClip(1210, 566)).toBe(
      `polygon(0 0, ${(100 - (SCALE_BAR_CORNER.width / 1210) * 100).toFixed(2)}% 0, ` +
        `${(100 - (SCALE_BAR_CORNER.width / 1210) * 100).toFixed(2)}% ` +
        `${((SCALE_BAR_CORNER.height / 566) * 100).toFixed(2)}%, 100% ` +
        `${((SCALE_BAR_CORNER.height / 566) * 100).toFixed(2)}%, 100% 100%, 0 100%)`,
    )
    expect(cornerClip(573, 1209)).toMatch(/^polygon\(0 0, 52\.88% 0, 52\.88% 6\.20%/)
    expect(cornerClip(0, 0)).toBeUndefined()
  })
})
