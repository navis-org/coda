/**
 * What one row of the Explore list shows.
 *
 * A data-driven spec rather than a hand-written row component, because the fields worth showing
 * differ per dataset and per taste: hemibrain has `cellBodyFiber`, MANC has `hemilineage`,
 * male-CNS has `superclass` and a neurotransmitter prediction, and none of them is knowable
 * when the component is written. Reordering the lists below changes every row; the component
 * never mentions a column name.
 *
 * Fields are looked up by name against the live schema, so a dataset lacking one simply shows
 * fewer chips instead of an empty slot — the same "address columns by name" contract the rest
 * of Coda's nodes use.
 */

import type { TableSchema } from '../../core/types'
import { isNumericDType } from '../../core/types'
import { MAX_SERIES } from '../colors'

/**
 * Candidate columns in priority order. First match wins for `primary`; the rest fill up to
 * their caps. Names not present in a dataset are skipped.
 */
const PRIMARY = ['type', 'instance']
const SECONDARY = ['instance', 'status', 'statusLabel']

/**
 * Chip candidates, in priority order, each with the palette slot that colours it.
 *
 * Two things are decided here. **Order** is what shows by default: only `MAX_CHIPS` of these
 * render, so a field further down never appears on a dataset that has the ones above it. The
 * side fields sit fourth and fifth on purpose — they are two characters wide and they are what
 * someone browsing a bilateral dataset is looking for, so paying six characters of width to
 * surface them beats a fourth taxonomic rank. Anyone who disagrees can say so: the Explore
 * node's `chips` param replaces this list entirely.
 *
 * **Slot** is the categorical palette index the chip is tinted with, keyed to the *field*
 * rather than to where the chip lands in the row, so `class` is the same blue on every dataset
 * and every row. Fields that mean the same thing under two names share a slot deliberately —
 * `hemilineage`/`itoleeHl`, `consensusNt`/`predictedNt` — and `chipSlots` moves the second one
 * aside on the dataset that publishes both.
 *
 * The colour is a scanning aid, not the identity: chips sit side by side in any combination,
 * and eight hues do not clear the all-pairs colourblind gate (validated — worst pair ΔE 1.6
 * deutan on the dark surface, and 7.1 for normal vision, against a target of 8 and a floor of
 * 15). What identifies a chip is its text, its `title`, and for the two-letter side fields an
 * inline key. Same doctrine as the socket colours in `theme.css`: colour plus a visible label,
 * never colour alone.
 */
interface ChipSpec {
  name: string
  /** Preferred categorical palette slot, 0-based. See `chipSlots` for what "preferred" means. */
  slot: number
  /**
   * Fields that are the same fact under different names, of which the automatic list takes
   * the first one present.
   *
   * Hemilineage is published as `hemilineage` by MANC and as `itoleeHl`/`trumanHl` by
   * male-CNS; `consensusNt` is the curated call and `predictedNt` the model's. A dataset
   * carrying both spends two of eight slots saying one thing, and what it pushes off the end
   * is a field that says something new. Only the automatic list dedupes — a list chosen in
   * the inspector is taken literally, including asking for both.
   */
  family?: string
  /**
   * Shown before the value, quietly, when the value alone says nothing.
   *
   * `somaSide` and `rootSide` are both `L`/`R`, so two identically-lettered chips side by
   * side would be a puzzle that only a tooltip could solve.
   */
  key?: string
}

const CHIPS: ChipSpec[] = [
  { name: 'class', slot: 0 },
  { name: 'subclass', slot: 1 },
  { name: 'superclass', slot: 2 },
  { name: 'somaSide', slot: 3, key: 'soma' },
  { name: 'rootSide', slot: 4, key: 'root' },
  // Hemilineage under three names: MANC calls it `hemilineage`, male-CNS publishes both the
  // Ito-Lee and the Truman nomenclature. `trumanHl` is not listed at all — one of the two
  // male-CNS names has to lead, and the param is there for anyone who wants the other.
  { name: 'itoleeHl', slot: 5, family: 'hemilineage' },
  { name: 'hemilineage', slot: 5, family: 'hemilineage' },
  { name: 'consensusNt', slot: 6, family: 'neurotransmitter' },
  { name: 'predictedNt', slot: 6, family: 'neurotransmitter' },
  { name: 'cellBodyFiber', slot: 7 },
  { name: 'entryNerve', slot: 7 },
  { name: 'flywireType', slot: 2 },
]

const CHIP_BY_NAME = new Map(CHIPS.map((chip) => [chip.name, chip]))

const STATS = ['pre', 'post', 'synweight', 'upstream', 'downstream', 'size', 'cableLength']

/**
 * Eight, which is the size of the palette — so the automatic list can never want a colour that
 * does not exist. It is a cap on the *default* only: a list someone chose in the inspector is
 * shown in full, because trimming what was asked for is how a control stops being believed.
 */
const MAX_CHIPS = 8
const MAX_STATS = 3

export interface RowFields {
  /** Headline label — the neuron's name. Undefined for a table with no string columns. */
  primary: string | undefined
  /** One quieter line under the headline. */
  secondary: string[]
  /** Categorical annotations, rendered as chips. */
  chips: string[]
  /** Numeric columns, rendered as a right-aligned figure list. */
  stats: string[]
}

/**
 * @param chosen Fields the user picked in the inspector. Empty means "decide for me", which is
 * what every dataset starts as and what the priority list above is for.
 */
export function rowFields(schema: TableSchema | undefined, chosen: readonly string[] = []): RowFields {
  const byName = new Map((schema?.columns ?? []).map((c) => [c.name, c]))
  const has = (name: string) => byName.has(name)

  const primary = PRIMARY.find(has) ?? firstString(schema)
  // A chosen field is still filtered against the schema: the param outlives the dataset it was
  // set on, and a graph repointed at hemibrain should lose `superclass` rather than show a
  // column of blanks. Uncapped, unlike the automatic list — see `MAX_CHIPS`.
  const chips = chosen.length ? chosen.filter(has) : automaticChips(has, primary)

  return {
    primary,
    // Never repeat the headline on the line beneath it.
    secondary: SECONDARY.filter((name) => has(name) && name !== primary).slice(0, 2),
    chips,
    stats: STATS.filter((name) => {
      const column = byName.get(name)
      return column !== undefined && isNumericDType(column.dtype)
    }).slice(0, MAX_STATS),
  }
}

/**
 * The default list: candidates this dataset has, one per family, capped at the palette.
 *
 * The family pass is what stops a dataset that names one fact twice from pushing a different
 * fact off the end — which is exactly how `consensusNt` went missing on male-CNS once
 * `itoleeHl` joined `hemilineage` in the list.
 */
function automaticChips(has: (name: string) => boolean, primary: string | undefined): string[] {
  const families = new Set<string>()
  const out: string[] = []
  for (const chip of CHIPS) {
    if (out.length >= MAX_CHIPS) break
    if (!has(chip.name) || chip.name === primary) continue
    if (chip.family) {
      if (families.has(chip.family)) continue
      families.add(chip.family)
    }
    out.push(chip.name)
  }
  return out
}

function firstString(schema: TableSchema | undefined): string | undefined {
  return schema?.columns.find((c) => c.dtype === 'str')?.name
}

/**
 * Palette slot per field, for one row's worth of chips.
 *
 * Resolved for the list as a whole rather than field by field, because the property that
 * matters on screen is that no two chips in the same row share a colour. Each field takes its
 * declared slot when that slot is still free, and the next free one otherwise.
 *
 * The table is arranged so the second branch is rare — the fields that co-occur on hemibrain,
 * MANC and male-CNS have distinct slots — so in practice a field keeps its colour across
 * datasets. It fires for two things: a dataset publishing both names for one fact
 * (`consensusNt` and `predictedNt`), and a list someone assembled in the inspector out of
 * fields this table never anticipated. Both would otherwise render as repeats or as grey.
 *
 * Past the eighth chip there is nothing left to hand out, and the entry is left undefined: the
 * neutral ink every chip had before is a better answer than a hue that means something else
 * three chips to the left.
 */
/**
 * Keyed on the field list, which is memoised per widget — so every row of a page, and the
 * Profile tiles beside it, share one resolution instead of rebuilding the same Map 25 times
 * on each keystroke. Pure in its argument, and weak so a retired spec is collected with it.
 */
const slotCache = new WeakMap<readonly string[], Map<string, number>>()

export function chipSlots(fields: readonly string[]): Map<string, number> {
  const cached = slotCache.get(fields)
  if (cached) return cached
  const resolved = resolveSlots(fields)
  slotCache.set(fields, resolved)
  return resolved
}

function resolveSlots(fields: readonly string[]): Map<string, number> {
  const taken = new Set<number>()
  const out = new Map<string, number>()

  const claim = (field: string, slot: number | undefined): boolean => {
    if (slot === undefined || taken.has(slot)) return false
    taken.add(slot)
    out.set(field, slot)
    return true
  }

  // Declared slots first, so a field that has one is not displaced by an earlier field that
  // had to improvise.
  for (const field of fields) claim(field, CHIP_BY_NAME.get(field)?.slot)
  for (const field of fields) {
    if (out.has(field)) continue
    for (let slot = 0; slot < MAX_SERIES; slot++) if (claim(field, slot)) break
  }
  return out
}

/** The quiet prefix a chip carries when its value alone is not self-describing. */
export function chipKey(field: string): string | undefined {
  return CHIP_BY_NAME.get(field)?.key
}

/** Unit suffix for a stat, when the schema declares one. */
export function statUnit(schema: TableSchema | undefined, name: string): string | undefined {
  return schema?.columns.find((c) => c.name === name)?.unit
}
