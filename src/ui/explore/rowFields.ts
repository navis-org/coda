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
import type { CellValue } from '../../core/values'
import { isNumericDType } from '../../core/types'
import { JOIN_SEPARATOR } from '../../core/values'
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

/*
 * Both vocabularies, paired by family.
 *
 * neuPrint publishes these facts in camelCase as properties on the neuron; a CAVE datastack
 * publishes them in snake_case out of an annotation table, and FlyWire's published annotations
 * do the same. They are *the same facts*, so each pair shares a family and a slot — which is
 * what makes `class` the same blue whichever backend a row came from, and what stops a dataset
 * naming one thing twice spending two of eight slots on it.
 *
 * Until this, the list was neuPrint's alone and a FlyWire row drew **no chips at all** — not
 * only through an annotation chain but on the shipped dataset, whose built-in annotations are
 * exactly `cell_class`, `cell_sub_class`, `super_class`, `flow` and `cell_type`.
 *
 * The two spellings of a fact are adjacent so the priority order reads the same on either
 * backend; `automaticChips` walks this list in order and takes the first member of each family
 * the dataset actually has.
 */
const CHIPS: ChipSpec[] = [
  { name: 'class', slot: 0, family: 'class' },
  { name: 'cell_class', slot: 0, family: 'class' },
  { name: 'subclass', slot: 1, family: 'subclass' },
  { name: 'cell_sub_class', slot: 1, family: 'subclass' },
  { name: 'superclass', slot: 2, family: 'superclass' },
  { name: 'super_class', slot: 2, family: 'superclass' },
  // `somaSide` and `rootSide` are *different* facts — where the soma sits against where the
  // neurite enters — so they are deliberately not one family. CAVE's `side` is the soma one,
  // and it needs no `key`: it spells the value out, where the neuPrint pair are both `L`/`R`.
  { name: 'somaSide', slot: 3, family: 'side', key: 'soma' },
  { name: 'side', slot: 3, family: 'side' },
  { name: 'rootSide', slot: 4, key: 'root' },
  // Intrinsic / afferent / efferent: the coarsest division there is, and one neuPrint has no
  // column for at all. Slot 4 is free on every dataset that publishes it, `rootSide` being the
  // other occupant and male-CNS's alone.
  { name: 'flow', slot: 4 },
  // Hemilineage under four names now: MANC calls it `hemilineage`, male-CNS publishes both the
  // Ito-Lee and the Truman nomenclature, and FlyWire's annotations spell the first
  // `ito_lee_hemilineage`. `trumanHl` and `hartenstein_hemilineage` are not listed at all — one
  // of each pair has to lead, and the param is there for anyone who wants the other.
  { name: 'itoleeHl', slot: 5, family: 'hemilineage' },
  { name: 'hemilineage', slot: 5, family: 'hemilineage' },
  { name: 'ito_lee_hemilineage', slot: 5, family: 'hemilineage' },
  { name: 'consensusNt', slot: 6, family: 'neurotransmitter' },
  { name: 'predictedNt', slot: 6, family: 'neurotransmitter' },
  { name: 'top_nt', slot: 6, family: 'neurotransmitter' },
  // A cell-body fibre is not a nerve, so only the latter two are one family.
  { name: 'cellBodyFiber', slot: 7 },
  { name: 'entryNerve', slot: 7, family: 'nerve' },
  { name: 'nerve', slot: 7, family: 'nerve' },
  // Where a neuron *leaves*, which is not where it entered — the same reason `somaSide` and
  // `rootSide` are two entries rather than one family. MANC and male-CNS publish both.
  { name: 'exitNerve', slot: 6 },
  { name: 'flywireType', slot: 2 },
  /*
   * The annotation-rich tail, added when the expanded view gained columns.
   *
   * These sit below everything above them on purpose: `MAX_CHIPS` still caps the automatic list,
   * so on a dataset carrying the whole set these are what the *columns* take once the well-filled
   * ones above are placed, and what falls off the end on a dataset that also has the rest.
   * Ordered by how often somebody browsing is looking for them rather than by how complete they
   * are — `splitByFill` already answers completeness, and letting it reorder as well would put
   * whichever field happens to be filled first at the front of a hierarchy.
   *
   * `supertype` is above `type`'s siblings because it is the rank *above* the primary label, so
   * on a row whose headline is already `type` it is the one that adds something. `dimorphism`,
   * `synonyms` and `fruDsx` are sparse by nature — filled only where they mean anything — so the
   * fill rule will hand all three to the chip tail on male-CNS, which is where a field that
   * applies to a minority belongs.
   */
  { name: 'supertype', slot: 1, family: 'supertype' },
  { name: 'dimorphism', slot: 3 },
  { name: 'fruDsx', slot: 5 },
  { name: 'synonyms', slot: 7 },
  { name: 'subcluster', slot: 2 },
]

const CHIP_BY_NAME = new Map(CHIPS.map((chip) => [chip.name, chip]))

/*
 * `nodes` sits beside `size` because it is the same question on a backend that has no voxel
 * count: a CATMAID skeleton's node count is what says how much of a neuron was traced. Without
 * it a CATMAID row had exactly one stat, since it publishes none of the other six.
 */
const STATS = [
  'pre',
  'post',
  'synweight',
  'upstream',
  'downstream',
  'size',
  'nodes',
  'cableLength',
]

/**
 * Eight, which is the size of the palette — so the automatic list can never want a colour that
 * does not exist. It is a cap on the *default* only: a list someone chose in the inspector is
 * shown in full, because trimming what was asked for is how a control stops being believed.
 */
const MAX_CHIPS = 8
const MAX_STATS = 3

/**
 * How many annotations the expanded row aligns into columns before the rest become chips.
 *
 * Bounded by width rather than by taste: the row keeps a checkbox, a 76px tile, a name block, the
 * inline plots and the right-aligned figures, which leaves room for about this many readable
 * columns at the 1500px the overlay panel caps at. Past it the columns are too narrow to hold a
 * `superclass` value and the alignment stops paying for itself.
 */
const MAX_COLUMNS = 5

/**
 * How many annotations the *expanded* row's automatic list may hold.
 *
 * `MAX_CHIPS` is a limit on **colour** — its own note says eight is the size of the palette — and
 * the aligned columns are plain text with no slot at all. So the expanded view can afford the
 * chip budget *plus* the columns that never spend one, which is what brings a well-annotated
 * dataset's tail into view at all: on a male-CNS-shaped schema the first eight candidates are
 * used up by `class` through `cellBodyFiber`, and `dimorphism`, `fruDsx` and `exitNerve` fell off
 * the end however sparse or interesting they were.
 *
 * The card keeps `MAX_CHIPS`, and that is not an oversight: it is the narrow surface, every one of
 * its annotations *is* a coloured chip, and thirteen of them is not a row anybody can read. Either
 * way the `chips` param overrides the lot.
 */
const MAX_AUTO_COLUMNS_AND_CHIPS = MAX_COLUMNS + MAX_CHIPS

/**
 * How full a field has to be, across the dataset, to be worth a column.
 *
 * **This is the whole column-versus-chip rule, and it is measured rather than curated.** A field
 * most neurons have is worth aligning — the eye runs down it and compares, which is the one thing
 * the expanded view's width buys and the one thing chips cannot do, since a chip that is absent
 * shifts every chip after it. A field only a few neurons have is the opposite: as a column it is
 * a stripe of blanks eating width that a filled column wanted, and as a chip it simply appears
 * where it applies.
 *
 * The two failure modes are worth naming because they are the argument. `class` on male-CNS is
 * filled on nearly everything, and as a chip it is in a different horizontal position on every
 * row. `dimorphism` is filled only on the types where it means anything, and as a column it would
 * be blank almost everywhere — but a blank *within* a column still says "not annotated", which is
 * why the threshold is a half rather than a nine-tenths: a field two neurons in three carry is
 * still worth comparing, and the third's blank is information.
 */
const FILL_MIN = 0.5

/**
 * How many rows the fill rate is measured over.
 *
 * Strided across the whole table rather than the first N, because a neuron table arrives in
 * whatever order the backend returned it and the head of one is not a sample of it — male-CNS
 * comes back ordered by body id, which correlates with when a neuron was traced and therefore
 * with how well it is annotated. 2,000 strided rows settle a half-versus-not question to well
 * inside the margin that matters, against 165,122 cells per candidate for the exact answer.
 */
const FILL_SAMPLE = 2000

/** Whether a hand-picked field list stands in for the automatic one or is added to it. */
export type FieldsMode = 'add' | 'replace'

export interface RowFields {
  /** Headline label — the neuron's name. Undefined for a table with no string columns. */
  primary: string | undefined
  /** One quieter line under the headline. */
  secondary: string[]
  /**
   * Annotations worth aligning, drawn as columns at the same position on every row.
   *
   * Empty for the card, which has no width to align in — `rowFields` is handed a table only by
   * the expanded view. See `FILL_MIN` for what earns a column.
   */
  columns: string[]
  /** The tail: annotations present but too sparse to align, rendered as chips. */
  chips: string[]
  /** Numeric columns, rendered as a right-aligned figure list. */
  stats: string[]
  /**
   * A column whose *values* are several free-form tags, joined with `JOIN_SEPARATOR`.
   *
   * Drawn apart from `chips` and deliberately unlike them: community annotations are somebody's
   * prose rather than a controlled vocabulary, so they get no palette slot, no key and no claim
   * to be one of a known set. Undefined unless somebody named a column.
   */
  tags: string | undefined
}

/**
 * The tags in one cell, in order, with the absences dropped.
 *
 * Splits on the separator `join` wrote, which is the one contract between the two — and it is
 * plain text rather than a control character, so a tag that itself contains `"; "` comes apart
 * into two. Cosmetic, admitted, and the whole cell is one hover away.
 */
export function splitTags(cell: CellValue): string[] {
  if (typeof cell !== 'string' || cell === '') return []
  return cell
    .split(JOIN_SEPARATOR)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

/**
 * @param chosen Fields the user picked in the inspector. Empty means "decide for me", which is
 * what every dataset starts as and what the priority list above is for.
 * @param mode Whether `chosen` stands in for the automatic list or is added to it. `'replace'` is
 * the default here rather than the node's, and deliberately: it is what the control meant before
 * the mode existed, so every caller holding only a schema — and every stored graph, through
 * `absentMeans` — keeps the behaviour it had.
 */
export function rowFields(
  schema: TableSchema | undefined,
  chosen: readonly string[] = [],
  tagColumn = '',
  /**
   * The expanded view's table, for splitting the annotations into aligned columns and a tail.
   *
   * Absent — which is the card, and every caller that only has a schema — keeps every annotation
   * as a chip, exactly as before. The split needs *values*, not a schema: how full a field is is
   * the only thing that says whether aligning it pays. See `FILL_MIN`.
   */
  aligned?: { data: Record<string, readonly CellValue[] | undefined>; length: number },
  mode: FieldsMode = 'replace',
): RowFields {
  const byName = new Map((schema?.columns ?? []).map((c) => [c.name, c]))
  const has = (name: string) => byName.has(name)
  // Filtered against the schema like everything else here: the param outlives the dataset it
  // was set on, and a graph repointed elsewhere should lose the row rather than draw blanks.
  const tags = tagColumn && has(tagColumn) ? tagColumn : undefined

  const primary = PRIMARY.find(has) ?? firstString(schema)
  // A chosen field is still filtered against the schema: the param outlives the dataset it was
  // set on, and a graph repointed at hemibrain should lose `superclass` rather than show a
  // column of blanks. Uncapped, unlike the automatic list — see `MAX_CHIPS`.
  const cap = aligned ? MAX_AUTO_COLUMNS_AND_CHIPS : MAX_CHIPS
  const picked = chosen.filter(has)
  /*
   * A chosen field comes **first**, and is never trimmed.
   *
   * First because an explicit choice outranks a default: it is what guarantees the field is
   * visible at all rather than sitting past the cap, and what gives it a shot at a column instead
   * of the chip tail. Never trimmed because that is already this control's rule — trimming what
   * was asked for is how a control stops being believed. `splitByFill` still decides its *shape*,
   * so asking for a field nine neurons in ten lack still gets a chip rather than a column of
   * blanks; position buys prominence, not an exemption from the fill rule.
   */
  const annotations =
    picked.length === 0
      ? automaticChips(has, primary, cap)
      : mode === 'replace'
        ? picked
        : [...picked, ...automaticChips(has, primary, cap, picked)]
  const withoutTags = annotations.filter((name) => name !== tags)
  const split = aligned
    ? splitByFill(withoutTags, aligned)
    : { columns: [], chips: withoutTags }

  return {
    primary,
    // Never repeat the headline on the line beneath it — nor the tags row, which draws the same
    // cell in its own shape a line below.
    secondary: SECONDARY.filter((name) => has(name) && name !== primary && name !== tags).slice(
      0,
      2,
    ),
    columns: split.columns,
    chips: split.chips,
    stats: STATS.filter((name) => {
      const column = byName.get(name)
      return column !== undefined && isNumericDType(column.dtype)
    }).slice(0, MAX_STATS),
    tags,
  }
}

/**
 * Split annotations into the ones worth aligning and the tail.
 *
 * Priority order is kept — the candidates arrive already ranked by `automaticChips`, or chosen by
 * hand — and the fill rate is a *filter* on that order rather than a re-ranking. Ranking by fill
 * would put whichever field happens to be most complete first, which is not the order anybody
 * reads a neuron in: `type` before `class` before `superclass` is a hierarchy, and sorting it by
 * completeness scrambles it.
 *
 * Measured over the whole dataset and not over the current hits, or the columns would reshuffle
 * as somebody types — a layout that moves while you search is worse than a layout that is
 * slightly wrong.
 */
export function splitByFill(
  names: readonly string[],
  table: { data: Record<string, readonly CellValue[] | undefined>; length: number },
): { columns: string[]; chips: string[] } {
  const columns: string[] = []
  const chips: string[] = []
  for (const name of names) {
    if (columns.length < MAX_COLUMNS && fillRate(table.data[name], table.length) >= FILL_MIN) {
      columns.push(name)
    } else {
      chips.push(name)
    }
  }
  return { columns, chips }
}

/**
 * What fraction of a column has something in it.
 *
 * Strided rather than sampling the head — see `FILL_SAMPLE`. A blank string counts as empty: a
 * neuPrint property that is present but unset arrives as `''`, and a column of empty strings is
 * a column of blanks whatever the schema says about it.
 */
function fillRate(column: readonly CellValue[] | undefined, length: number): number {
  if (!column || length === 0) return 0
  const stride = Math.max(1, Math.floor(length / FILL_SAMPLE))
  let seen = 0
  let filled = 0
  for (let row = 0; row < length; row += stride) {
    seen++
    const value = column[row]
    if (value !== null && value !== undefined && value !== '') filled++
  }
  return seen === 0 ? 0 : filled / seen
}

/**
 * The default list: candidates this dataset has, one per family, capped at the palette.
 *
 * The family pass is what stops a dataset that names one fact twice from pushing a different
 * fact off the end — which is exactly how `consensusNt` went missing on male-CNS once
 * `itoleeHl` joined `hemilineage` in the list.
 */
function automaticChips(
  has: (name: string) => boolean,
  primary: string | undefined,
  limit: number,
  /**
   * Fields already chosen by hand, which this list must not duplicate — nor answer twice.
   *
   * Their *families* are claimed as well as their names, so somebody who asked for `predictedNt`
   * does not also get `consensusNt` appended: two chips saying one thing is exactly what the
   * family rule exists to prevent, and it would be odd for choosing a field to be the thing that
   * reintroduces it.
   */
  alreadyPicked: readonly string[] = [],
): string[] {
  const families = new Set<string>()
  for (const name of alreadyPicked) {
    const family = CHIP_BY_NAME.get(name)?.family
    if (family) families.add(family)
  }
  const out: string[] = []
  for (const chip of CHIPS) {
    if (out.length >= limit) break
    if (!has(chip.name) || chip.name === primary) continue
    if (alreadyPicked.includes(chip.name)) continue
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
