/**
 * Colouring a region.
 *
 * The interesting one is `regionColor`, which deliberately breaks the palette's "never cycle a
 * hue" rule — and is allowed to, because it is not a categorical *encoding*. Sixty to a hundred
 * and fifty regions cannot have a legend, so the hue means only "this shape is not that shape",
 * which is the job neuroglancer's segment colours do. What it must still get right is that a
 * left/right pair reads as one structure and that a region keeps its colour forever.
 */

import { describe, expect, it } from 'vitest'

import { rampColor, regionColor, sideLabel } from './roiStyle'

const HEX = /^#[0-9a-f]{6}$/

describe('regionColor', () => {
  it('gives a left/right pair the same colour, because they are one structure', () => {
    expect(regionColor('ME(L)', 'dark')).toBe(regionColor('ME(R)', 'dark'))
    expect(regionColor("a'L(L)", 'light')).toBe(regionColor("a'L(R)", 'light'))
  })

  it('gives different structures different colours', () => {
    expect(regionColor('ME(R)', 'dark')).not.toBe(regionColor('LO(R)', 'dark'))
    // A sub-region is its own structure, not a shade of its parent.
    expect(regionColor('ME(R)_col_12', 'dark')).not.toBe(regionColor('ME(R)', 'dark'))
  })

  it('is stable, so a region keeps its colour across reloads and filters', () => {
    expect(regionColor('CA(R)', 'dark')).toBe(regionColor('CA(R)', 'dark'))
  })

  it('emits literal hex, which is what makes vector export free', () => {
    // A colour arriving in another notation works until somebody opens the exported file
    // somewhere else.
    for (const roi of ['ME(R)', 'FB', 'GNG', "b'L(L)"]) {
      expect(regionColor(roi, 'dark')).toMatch(HEX)
      expect(regionColor(roi, 'light')).toMatch(HEX)
    }
  })

  it('spreads hues rather than clustering them', () => {
    /*
     * Hash times the golden angle, not `hash % 360`. The plain modulo leaves consecutively
     * named regions looking alike often enough to notice, which on a map of neuropils reads as
     * two structures being related when they are not.
     */
    const hues = ['ME', 'LO', 'LOP', 'CA', 'PED', 'AL', 'LH', 'SLP', 'SMP', 'FB', 'EB', 'PB'].map(
      (roi) => regionColor(`${roi}(R)`, 'dark'),
    )
    expect(new Set(hues).size).toBe(hues.length)
  })

  it('answers a different colour per theme, since one surface is not the other', () => {
    expect(regionColor('ME(R)', 'dark')).not.toBe(regionColor('ME(R)', 'light'))
  })
})

describe('sideLabel', () => {
  it('names the side, and midline as its own answer', () => {
    expect(sideLabel('ME(R)')).toBe('right')
    expect(sideLabel('ME(L)')).toBe('left')
    // Not "unknown": FB, EB, PB and GNG genuinely span the midline.
    expect(sideLabel('FB')).toBe('midline')
  })
})

describe('rampColor', () => {
  it('clamps rather than trusting a published ratio', () => {
    // `preCompleteness` is a ratio the server computed; a region with more traced synapses than
    // total ones would index past the end of the ramp and come back undefined.
    expect(rampColor(1.4, 'dark')).toBe(rampColor(1, 'dark'))
    expect(rampColor(-0.2, 'dark')).toBe(rampColor(0, 'dark'))
  })

  it('answers a different hue for the two measures', () => {
    /*
     * Presynaptic and postsynaptic completeness are the same picture over different numbers, so
     * with one hue a glance cannot say which is on screen — and on hemibrain they differ by more
     * than fifty points, which is exactly the gap somebody could read off the wrong one.
     */
    for (const mode of ['light', 'dark'] as const) {
      expect(rampColor(0.7, mode, 'red')).not.toBe(rampColor(0.7, mode, 'blue'))
    }
  })

  it('keeps the mode flip in both hues, or a dark ramp reads as a negative', () => {
    // On a light surface a low value takes the lightest step and recedes into the page; on a
    // dark one it takes the darkest. The flip has to survive the hue argument.
    for (const hue of ['blue', 'red'] as const) {
      expect(rampColor(0, 'light', hue)).not.toBe(rampColor(0, 'dark', hue))
      expect(rampColor(0, 'light', hue)).toBe(rampColor(1, 'dark', hue))
    }
  })

  it('runs monotonically in lightness, which is what carries the value without hue', () => {
    // The reading a colourblind viewer gets, and the reason a sequential ramp is one hue.
    const luminance = (hex: string) => {
      const channel = (at: number) => {
        const v = parseInt(hex.slice(at, at + 2), 16) / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
    }
    for (const hue of ['blue', 'red'] as const) {
      const steps = Array.from({ length: 9 }, (_, i) => luminance(rampColor(i / 8, 'light', hue)))
      for (let i = 0; i + 1 < steps.length; i++) {
        expect(steps[i]!).toBeGreaterThan(steps[i + 1]!)
      }
    }
  })
})
