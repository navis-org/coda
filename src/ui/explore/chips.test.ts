/**
 * How an annotation chip gets its colour.
 *
 * Two things are worth pinning, and neither is "does it look nice".
 *
 * The first is that the hues in `theme.css` are still the validated palette in `colors.ts`.
 * They have to be duplicated — a chip lives in a memoised row, so a colour computed in JS
 * would survive a theme switch unchanged, where a custom property re-resolves for free — and
 * a duplicated palette is a palette that drifts. This is the only thing that would notice.
 *
 * The second is that a slot belongs to a *field*, not to a position in the row, since that is
 * what makes `class` the same blue on every dataset. A test is the only place that shows the
 * difference: both designs render eight colours and only one of them is stable.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MAX_SERIES, seriesColor } from '../colors'
import type { Mode } from '../colors'
import { chipKey, chipSlots } from './rowFields'

const THEME = readFileSync(fileURLToPath(new URL('../theme.css', import.meta.url)), 'utf8')

/**
 * The `--chip-*` values declared in one theme block.
 *
 * `theme.css` states the light palette on bare `:root` and the dark one twice — once under
 * `prefers-color-scheme` and once under an explicit `data-theme`. Both dark copies are read,
 * because a toggle that disagrees with the system default is exactly the bug this catches.
 */
function chipTokens(selector: string): string[] {
  const at = THEME.indexOf(selector)
  expect(at, `no ${selector} block in theme.css`).toBeGreaterThanOrEqual(0)
  const block = THEME.slice(at, THEME.indexOf('\n}', at))
  return Array.from({ length: MAX_SERIES }, (_, i) => {
    const match = new RegExp(`--chip-${i + 1}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)
    expect(match, `--chip-${i + 1} missing from ${selector}`).not.toBeNull()
    return match![1]!.toLowerCase()
  })
}

function expectedPalette(mode: Mode): string[] {
  return Array.from({ length: MAX_SERIES }, (_, i) => seriesColor(i, mode))
}

describe('chip hues', () => {
  it('mirrors the validated categorical palette, light', () => {
    expect(chipTokens(':root {')).toEqual(expectedPalette('light'))
  })

  it('mirrors it in dark mode, under both the media query and the explicit toggle', () => {
    expect(chipTokens(":root:not([data-theme='light'])")).toEqual(expectedPalette('dark'))
    expect(chipTokens(":root[data-theme='dark']")).toEqual(expectedPalette('dark'))
  })

  it('declares one token per palette slot and no more', () => {
    // A ninth would be a hue invented outside the palette, which is the thing `colors.ts`
    // refuses to do for series and has no more licence to do here.
    expect(THEME).not.toMatch(new RegExp(`--chip-${MAX_SERIES + 1}\\b`))
  })
})

describe('chipSlots', () => {
  /** The eight male-CNS publishes, which is the widest row any of these datasets produces. */
  const maleCns = ['class', 'subclass', 'superclass', 'somaSide', 'rootSide', 'itoleeHl', 'consensusNt', 'predictedNt']

  it('gives every chip in a row a colour of its own', () => {
    // The property that actually matters on screen. Two chips sharing a hue is worse than no
    // hue at all: it says "these are the same kind of thing" about two that are not.
    const slots = chipSlots(maleCns)
    expect(slots.size).toBe(maleCns.length)
    expect(new Set(slots.values()).size).toBe(maleCns.length)
  })

  it('moves the second of two names for one fact aside rather than repeating a colour', () => {
    // `consensusNt` and `predictedNt` declare the same slot on purpose — they mean the same
    // thing — and male-CNS is the dataset that publishes both.
    expect(chipSlots(['consensusNt']).get('consensusNt')).toBe(
      chipSlots(['predictedNt']).get('predictedNt'),
    )
    const both = chipSlots(['consensusNt', 'predictedNt'])
    expect(both.get('consensusNt')).not.toBe(both.get('predictedNt'))
  })

  it('keys the colour to the field, not to where it lands in the row', () => {
    // hemibrain has no subclass, so `superclass` sits second there and third on male-CNS. Its
    // colour must not move with it, or nothing would be learnable across datasets.
    expect(chipSlots(['class', 'superclass']).get('superclass')).toBe(
      chipSlots(maleCns).get('superclass'),
    )
  })

  it('colours a field nobody anticipated, so an inspector-chosen list is still readable', () => {
    // The whole point of the `chips` param is that the list is not ours to predict. A field
    // with no declared slot takes a free one rather than rendering grey beside three others
    // that also rendered grey.
    const slots = chipSlots(['class', 'somethingNobodyHasYet', 'anotherOne'])
    expect(slots.size).toBe(3)
    expect(new Set(slots.values()).size).toBe(3)
  })

  it('stays inside the palette', () => {
    for (const slot of chipSlots([...maleCns, 'cellBodyFiber', 'entryNerve']).values()) {
      expect(slot).toBeGreaterThanOrEqual(0)
      expect(slot).toBeLessThan(MAX_SERIES)
    }
  })

  it('runs out rather than wrapping', () => {
    // A ninth chip taking slot 0 back would put two identical colours in one row, which is the
    // one thing this function exists to prevent. Undefined means the neutral chip.
    const nine = Array.from({ length: 9 }, (_, i) => `field${i}`)
    const slots = chipSlots(nine)
    expect(slots.size).toBe(MAX_SERIES)
    expect(slots.get('field8')).toBeUndefined()
  })
})

describe('chipKey', () => {
  it('labels the fields whose values say nothing on their own', () => {
    // Both are `L`/`R`. Without the key, a row shows two identical chips.
    expect(chipKey('somaSide')).toBe('soma')
    expect(chipKey('rootSide')).toBe('root')
  })

  it('leaves a self-describing value alone', () => {
    expect(chipKey('class')).toBeUndefined()
    expect(chipKey('hemilineage')).toBeUndefined()
  })
})
