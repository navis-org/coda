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
import { chipKey, chipSlots, rowFields, splitTags } from './rowFields'
import { column, tableSchema } from '../../core/types'

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
  const maleCns = [
    'class',
    'subclass',
    'superclass',
    'somaSide',
    'rootSide',
    'itoleeHl',
    'consensusNt',
    'predictedNt',
  ]

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

/**
 * Which chips a dataset gets by default, on both vocabularies.
 *
 * The list was neuPrint's alone, so a CAVE row drew **no chips at all** — the same facts are
 * published in snake_case out of an annotation table, and none of the names matched. That is
 * not only the annotation-chain case: FlyWire's *built-in* annotations are exactly
 * `cell_class`, `cell_sub_class`, `super_class`, `flow` and `cell_type`, so the shipped dataset
 * had never had one either.
 *
 * What has to hold is both halves: the CAVE spellings resolve, and neuPrint's answer is
 * untouched by having gained a family.
 */
describe('the automatic chip list', () => {
  const schema = (...names: string[]) =>
    tableSchema(...names.map((n) => column(n, 'str')), column('pre', 'i64'))

  it('gives a FlyWire dataset its built-in annotations', () => {
    // `type` is the headline, so it is never also a chip.
    const { chips, primary } = rowFields(
      schema('neuronId', 'type', 'cell_class', 'cell_sub_class', 'super_class', 'flow'),
    )
    expect(primary).toBe('type')
    expect(chips).toEqual(['cell_class', 'cell_sub_class', 'super_class', 'flow'])
  })

  it('gives an annotation chain the rest of them, in the same priority order', () => {
    // The published FlyWire annotations, as they arrive through `Table from URL → Dataset`.
    const { chips } = rowFields(
      schema(
        'neuronId',
        'type',
        'flow',
        'super_class',
        'cell_class',
        'cell_sub_class',
        'supertype',
        'ito_lee_hemilineage',
        'hartenstein_hemilineage',
        'top_nt',
        'known_nt',
        'side',
        'nerve',
        'status',
        'dimorphism',
        'synonyms',
      ),
    )
    expect(chips).toEqual([
      'cell_class',
      'cell_sub_class',
      'super_class',
      'side',
      'flow',
      'ito_lee_hemilineage',
      'top_nt',
      'nerve',
    ])
    // One name per fact: the second nomenclature is left to the `chips` param, exactly as
    // `trumanHl` is on male-CNS.
    expect(chips).not.toContain('hartenstein_hemilineage')
  })

  it('leaves a neuPrint dataset’s chips exactly as they were', () => {
    // The regression guard on the edit itself: `class`, `superclass` and `somaSide` gained a
    // family they did not have, and a family is what makes a chip *disappear*.
    const { chips } = rowFields(
      schema(
        'neuronId',
        'type',
        'instance',
        'class',
        'subclass',
        'superclass',
        'somaSide',
        'rootSide',
        'itoleeHl',
        'consensusNt',
        'predictedNt',
        'cellBodyFiber',
      ),
    )
    expect(chips).toEqual([
      'class',
      'subclass',
      'superclass',
      'somaSide',
      'rootSide',
      'itoleeHl',
      'consensusNt',
      'cellBodyFiber',
    ])
  })

  it('shows one chip where a dataset somehow published both spellings', () => {
    // What the families buy, and the reason they are families rather than separate entries:
    // two chips saying one thing spend two of eight slots and push off one that says something
    // new — how `consensusNt` went missing on male-CNS.
    const { chips } = rowFields(schema('neuronId', 'class', 'cell_class', 'side', 'somaSide'))
    expect(chips).toEqual(['class', 'somaSide'])
  })

  it('still takes a chosen list literally, both spellings included', () => {
    // The escape hatch, for an annotation base whose columns this table never anticipated.
    const { chips } = rowFields(schema('neuronId', 'supertype', 'hartenstein_hemilineage'), [
      'supertype',
      'hartenstein_hemilineage',
    ])
    expect(chips).toEqual(['supertype', 'hartenstein_hemilineage'])
  })
})

/**
 * Community tags: a column whose *values* are several free-form strings, as a CAVE
 * `neuron_information_v2` table folds into once Group By's `join` has gathered it.
 *
 * They are a different kind of claim from the chips above them — somebody's prose against a
 * neuron, not a controlled vocabulary — so what has to hold is that they stay *apart*: their own
 * field on the spec, and out of the three lists that would otherwise draw the same cell twice.
 */
describe('the additional tags column', () => {
  const schema = (...names: string[]) =>
    tableSchema(...names.map((n) => column(n, 'str')), column('pre', 'i64'))

  it('is reported apart from the chips, and drawn by neither list', () => {
    const f = rowFields(schema('neuronId', 'type', 'cell_class', 'community'), [], 'community')
    expect(f.tags).toBe('community')
    expect(f.chips).not.toContain('community')
    expect(f.secondary).not.toContain('community')
  })

  it('does not claim a column the current dataset lacks', () => {
    // The param outlives the dataset it was set on, exactly as `chips` does.
    expect(rowFields(schema('neuronId', 'type'), [], 'community').tags).toBeUndefined()
    expect(rowFields(schema('neuronId', 'type'), []).tags).toBeUndefined()
  })

  it('wins the cell when somebody named it in both controls', () => {
    // Naming one column in both is a mistake rather than a request to draw it twice, and the
    // tag row is the more specific statement.
    const f = rowFields(schema('neuronId', 'type', 'community'), ['community'], 'community')
    expect(f.chips).toEqual([])
    expect(f.tags).toBe('community')
  })

  it('does not displace a status line that is a different column', () => {
    const f = rowFields(schema('neuronId', 'type', 'status', 'community'), [], 'community')
    expect(f.secondary).toContain('status')
  })
})

describe('splitting a joined tag cell', () => {
  it('splits on the separator the join wrote, trimming and dropping blanks', () => {
    expect(splitTags('left; putative giant fibre; DA?')).toEqual([
      'left',
      'putative giant fibre',
      'DA?',
    ])
    expect(splitTags('a;  ; b')).toEqual(['a', 'b'])
  })

  it('answers nothing for an absence rather than one empty tag', () => {
    expect(splitTags(null)).toEqual([])
    expect(splitTags('')).toEqual([])
    // A number in the column is not text somebody typed; nothing to split.
    expect(splitTags(42)).toEqual([])
  })
})
