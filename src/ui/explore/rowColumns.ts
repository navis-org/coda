/**
 * The expanded list's columns: which fields each one reads, and how it draws them.
 *
 * **One list, where there used to be three mechanisms.** The header was aligned annotations
 * (chosen by `splitByFill`), a track of marks (chosen by `plotSpec`'s hard-coded pairs) and the
 * figures (a fixed list capped at three), each with its own rule and none of them editable where
 * they were drawn. On `neuprint-fish2` that left `axonIn`, `axonOut`, `dendriteIn` and
 * `dendriteOut` with no way onto the row except as left-aligned text, since the figure list is
 * fixed and fish2 spends its three on `pre`, `post` and `synweight`.
 *
 * So a column is now **fields plus a renderer**, and the three old mechanisms survive as the
 * *automatic* list — what `automaticColumns` builds when nobody has edited the header, and what
 * the first edit starts from. The pre/post balance bar was already a two-field stacked bar and the
 * size tick a one-field rank; nothing about them was special except that nobody could make another.
 * The same list also places fields among the row's **chips**, which is what replaced the
 * inspector's `Fields` picker: it chose the chips while the header chose the columns, and so could
 * never show the whole row.
 *
 * Headless, for `rowPlots.ts`' reason: jsdom lays nothing out, so the rules have to be testable
 * without a component. That is why the edits live here too (`placeAsColumn`, `hideField`,
 * `moveColumn` …) rather than as closures in `ExploreBody`.
 */

import type { TableSchema } from '../../core/types'
import { findColumn, isNumericDType } from '../../core/types'
import { ID_COLUMN_NAME } from '../../core/ids'
import { MAX_SERIES } from '../colors'
import type { RowFields } from './rowFields'
import { statUnit } from './rowFields'
import type { PlotSpec } from './rowPlots'
import { MARK_W } from './rowPlots'

/**
 * How a column draws.
 *
 * `regions` and `confidence` are the two built-ins nobody can assemble by hand: the first reads a
 * query rather than a field, and the second is a value qualified by a label, which the
 * one-field-one-mark renderers have no way to say. They can be moved, renamed and removed, not
 * re-pointed — their `fields` are inputs, never fields the column *shows* (`isBuiltin`).
 */
export type Renderer =
  | 'text'
  | 'number'
  | 'bar'
  | 'logBar'
  | 'rank'
  | 'stacked'
  | 'bars'
  | 'donut'
  | 'regions'
  | 'confidence'

export interface ColumnSpec {
  render: Renderer
  fields: readonly string[]
  /**
   * What the header calls it, where somebody renamed it. Absent means `automaticLabel`, which is
   * also what an empty or unchanged name is stored as — so a rename that was undone by hand does
   * not leave a column pinned to a label that merely happens to match today's derived one.
   */
  label?: string
  /**
   * Human-readable formatting — `15.4K`, `2.98 mm` — where the column prints figures: a one-number
   * column, or merged numbers as text. **Off means the stored number itself**, `15417`, by
   * `formatExact`'s rule (the one the hover always used), in the column's stored unit — scaling a
   * cable length into millimetres being the half of the readable form that rounds.
   *
   * Off is also the default for any column somebody *adds*: a field chosen by hand is usually
   * chosen to be read or copied as a value. The automatic figures carry it on, which is how they
   * always drew, so the first edit to a header does not change how its figures look.
   */
  readable?: boolean
}

/**
 * What differs by renderer, in one table.
 *
 * It was a dozen switches across four files — label, header style, which spread a mark reads,
 * whether its fields are ones it shows — and only the labels were checked for completeness, so a
 * new renderer compiled and quietly took the wrong tooltip. A missing row here is a compile error.
 */
const RENDERERS: Record<
  Renderer,
  { label: string; mark?: true; builtin?: true; reads?: 'sorted' | 'max' }
> = {
  text: { label: 'Text' },
  number: { label: 'Number' },
  bar: { label: 'Bar', mark: true, reads: 'max' },
  logBar: { label: 'Bar, log scale', mark: true, reads: 'max' },
  rank: { label: 'Rank in dataset', mark: true, reads: 'sorted' },
  stacked: { label: 'Stacked bar', mark: true },
  bars: { label: 'Bars', mark: true },
  donut: { label: 'Donut', mark: true },
  regions: { label: 'Region donut', mark: true, builtin: true },
  confidence: { label: 'Confidence bar', mark: true, builtin: true },
}

/** What the column editor calls a renderer. */
export function rendererLabel(render: Renderer): string {
  return RENDERERS[render].label
}

/** Whether a column draws a mark rather than text — which decides its header cell's style. */
export function isMark(column: ColumnSpec): boolean {
  return RENDERERS[column.render].mark === true
}

/** Whether a column is a built-in, whose `fields` are inputs rather than fields it shows. */
export function isBuiltin(column: ColumnSpec): boolean {
  return RENDERERS[column.render].builtin === true
}

/**
 * The one field a column shows on its own — undefined for a merged column or a built-in. What
 * hiding, making a chip, and the column editor's "Show as chip instead" all ask.
 */
export function soleFieldOf(column: ColumnSpec): string | undefined {
  return !isBuiltin(column) && column.fields.length === 1 ? column.fields[0] : undefined
}

/**
 * The fields whose spread the columns read, by the spread: sorted samples for a rank, the whole
 * column's maximum for a bar. Sorted and deduplicated, so a caller can key a memo on them — each
 * measured field is a pass over every row, and a rename or a moved column must not buy another.
 */
export function spreadsRead(columns: readonly ColumnSpec[]): {
  ranked: string[]
  barred: string[]
} {
  const ranked = new Set<string>()
  const barred = new Set<string>()
  for (const column of columns) {
    const reads = RENDERERS[column.render].reads
    if (reads === 'sorted') ranked.add(column.fields[0]!)
    if (reads === 'max') barred.add(column.fields[0]!)
  }
  return { ranked: [...ranked].sort(), barred: [...barred].sort() }
}

/**
 * The most fields one merged column may hold: the palette.
 *
 * A stacked bar and a ring both *fold* past the eighth slot onto `Other` (`seriesColor`), which is
 * right for a region's long tail and wrong here, where every part was chosen by name — a ninth
 * part would be grey and indistinguishable from a tenth.
 */
export const MAX_PARTS = MAX_SERIES

/** The renderers the editor offers, best first — one number, and several. */
const ONE_NUMBER: readonly Renderer[] = ['number', 'bar', 'logBar', 'rank']
const PARTS: readonly Renderer[] = ['stacked', 'bars', 'donut', 'text']

/**
 * The renderers that can draw these fields, best first; empty where nothing can.
 *
 * One text field is text. One number is a figure or a mark. Two to `MAX_PARTS` numbers are a
 * split — stacked, side by side or a ring — or plain text, `12 / 340`. A text field merged with
 * anything is refused rather than given a meaning: a share of a sum needs every part to be a count,
 * and the merged text is a line of *figures*, each in its own unit.
 */
export function renderersFor(
  fields: readonly string[],
  schema: TableSchema | undefined,
): readonly Renderer[] {
  if (fields.length === 0 || !schema) return []
  const dtypes = fields.map((name) => findColumn(schema, name)?.dtype)
  if (dtypes.some((dtype) => dtype === undefined)) return []
  const numeric = dtypes.every((dtype) => isNumericDType(dtype!))
  if (fields.length === 1) return numeric ? ONE_NUMBER : ['text']
  return numeric && fields.length <= MAX_PARTS ? PARTS : []
}

/**
 * The ticked fields after ticking or unticking one, under `renderersFor`'s rules: a text field
 * stands alone, a number replaces a text field, and past `MAX_PARTS` a further number is refused.
 * Beside `renderersFor` so the editor cannot tick what nothing can draw, nor be stricter than it —
 * two definitions of "which fields may merge" drift in whichever direction was edited last.
 */
export function toggleField(
  picked: readonly string[],
  name: string,
  numeric: ReadonlySet<string>,
): string[] {
  if (picked.includes(name)) return picked.filter((n) => n !== name)
  if (!numeric.has(name)) return [name]
  const numbers = picked.filter((n) => numeric.has(n))
  return numbers.length >= MAX_PARTS ? [...picked] : [...numbers, name]
}

/**
 * Whether this column can be drawn against this dataset.
 *
 * Asked of every stored column, because the list outlives the dataset it was built on: a graph
 * repointed from fish2 at hemibrain should not draw `axonIn` as a column of blanks. A merged column
 * fits **whole** or not at all — drawing the parts that remain would be a split of something else
 * under the same header. The tag column never fits: it draws as its own row, so a column or a chip
 * of it would say one thing twice.
 */
function fits(
  column: ColumnSpec,
  schema: TableSchema,
  spec: PlotSpec | undefined,
  tagColumn: string,
): boolean {
  if (tagColumn && column.fields.includes(tagColumn)) return false
  if (column.render === 'regions') return column.fields.length === 0 && spec?.regions === true
  if (column.render === 'confidence') {
    const [label = '', value = ''] = column.fields
    return (
      column.fields.length === 2 && !!findColumn(schema, label) && !!findColumn(schema, value)
    )
  }
  return renderersFor(column.fields, schema).includes(column.render)
}

/**
 * The list nobody chose: today's three mechanisms, in the order the row always drew them.
 *
 * Aligned annotations, then marks, then figures — which is what every graph saved before the
 * header was editable still shows, and what the first edit starts from.
 */
export function automaticColumns(fields: RowFields, spec: PlotSpec | undefined): ColumnSpec[] {
  const out: ColumnSpec[] = fields.columns.map((name) => ({ render: 'text', fields: [name] }))
  if (spec?.balance)
    out.push({ render: 'stacked', fields: [spec.balance.pre, spec.balance.post] })
  if (spec?.percentile) out.push({ render: 'rank', fields: [spec.percentile] })
  if (spec?.regions) out.push({ render: 'regions', fields: [] })
  if (spec?.confidence) {
    out.push({ render: 'confidence', fields: [spec.confidence.label, spec.confidence.value] })
  }
  // Readable, as the figures always drew — see `ColumnSpec.readable`.
  for (const name of fields.stats)
    out.push({ render: 'number', fields: [name], readable: true })
  return out
}

/** The list as drawn: the header's columns, and the fields shown as chips. */
export interface Layout {
  columns: ColumnSpec[]
  chips: string[]
}

/**
 * The list nobody chose, whole — the automatic columns and the automatic chips. What the first
 * edit starts from, so it writes exactly what was drawn and nothing on screen moves.
 */
export function automaticLayout(fields: RowFields, spec: PlotSpec | undefined): Layout {
  return { columns: automaticColumns(fields, spec), chips: fields.chips }
}

/**
 * The stored list against this dataset: what it can draw, and what it cannot.
 *
 * `layout` is undefined for the automatic list, and that covers two cases on purpose. Nothing
 * stored is the automatic list by definition; a stored list naming nothing this dataset has is a
 * list about another dataset, and an empty row on a repointed graph reads as a broken widget where
 * the automatic list is at least a list about *this* one.
 *
 * `unseen` is every readable entry this dataset cannot draw, **kept verbatim** and written back
 * by every edit (`encodeLayout`) — `fits` decides what is drawn, never what is kept. It did both at
 * first, so any edit made while a graph pointed at hemibrain, even a rename, erased the fish2
 * columns it was built with. That is the multi-column picker's rule, "keep an unseen list
 * untouched", arrived at a second time.
 */
export function resolveLayout(
  stored: readonly string[],
  schema: TableSchema | undefined,
  spec: PlotSpec | undefined,
  tagColumn = '',
): { layout: Layout | undefined; unseen: string[] } {
  if (!schema || stored.length === 0) return { layout: undefined, unseen: [] }
  const columns: ColumnSpec[] = []
  const chips: string[] = []
  const unseen: string[] = []
  for (const raw of stored) {
    const entry = decodeEntry(raw)
    if (!entry) continue
    if ('chip' in entry) {
      const drawable = entry.chip !== tagColumn && !!findColumn(schema, entry.chip)
      if (drawable) chips.push(entry.chip)
      else unseen.push(raw)
    } else if (fits(entry.column, schema, spec, tagColumn)) {
      columns.push(entry.column)
    } else {
      unseen.push(raw)
    }
  }
  return {
    layout: columns.length + chips.length > 0 ? { columns, chips } : undefined,
    unseen,
  }
}

/**
 * Whether a list holds nothing — the one edit result that may not be written, `[]` being the
 * automatic list. Asked of the *result* by every control that could produce it, so a click that
 * would be refused is a disabled control rather than a silent one: hiding `pre` from a list of
 * just a `pre` figure and a `pre` rank empties it, and a rule counting entries beforehand said yes.
 */
export function isEmptyLayout(layout: Layout): boolean {
  return layout.columns.length + layout.chips.length === 0
}

/**
 * A whole list as the param stores it: the columns in header order, the chips in row order, then
 * whatever this dataset cannot draw, verbatim — see `resolveLayout`.
 *
 * **Undefined rather than an empty list**, and the caller writes nothing: `[]` is the automatic
 * list, so writing it would bring every default field back as a side effect of hiding the last
 * one. Enforced here, where the list is written, rather than only by the controls that happen to
 * offer removal today.
 */
export function encodeLayout(
  layout: Layout,
  unseen: readonly string[] = [],
): string[] | undefined {
  if (isEmptyLayout(layout)) return undefined
  return [...layout.columns.map(encodeColumn), ...layout.chips.map(encodeChip), ...unseen]
}

/** The tooltip on every control that refuses an edit because it would empty the list. */
export const LAST_FIELD_HINT = 'The only field shown — add another first'

/** Where a field is shown: a column of its own, part of a merged one, a chip, or nowhere. */
export type Place = 'column' | 'merged' | 'chip' | 'none'

/**
 * Where a field is shown now — what the `+` menu presses.
 *
 * **A column of its own wins over a merged one.** The automatic list draws `pre` twice, in the
 * `pre/post` bar and as a figure, and answering "merged" for the first locked both halves of its
 * pair — the figure could then be neither hidden nor made a chip from the menu. Found in a browser.
 */
export function placeOf(layout: Layout, name: string): Place {
  const holding = layout.columns.filter((c) => !isBuiltin(c) && c.fields.includes(name))
  if (holding.some((c) => c.fields.length === 1)) return 'column'
  if (holding.length > 0) return 'merged'
  return layout.chips.includes(name) ? 'chip' : 'none'
}

/** Out of the list altogether — which, under the rule, is out of the row. */
export function hideField(layout: Layout, name: string): Layout {
  return {
    columns: layout.columns.filter((c) => soleFieldOf(c) !== name),
    chips: layout.chips.filter((chip) => chip !== name),
  }
}

/** A field at the end of the header — text for text, a figure for a number — and nowhere else. */
export function placeAsColumn(layout: Layout, name: string, numeric: boolean): Layout {
  const rest = hideField(layout, name)
  return {
    columns: [...rest.columns, { render: numeric ? 'number' : 'text', fields: [name] }],
    chips: rest.chips,
  }
}

/** A field at the end of the chips, and out of any column it stood in on its own. */
export function placeAsChip(layout: Layout, name: string): Layout {
  const rest = hideField(layout, name)
  return { columns: rest.columns, chips: [...rest.chips, name] }
}

/** A column put in place — appended where `index` is null, replacing the one there otherwise. */
export function setColumn(layout: Layout, index: number | null, column: ColumnSpec): Layout {
  const columns = [...layout.columns]
  if (index === null) columns.push(column)
  else columns[index] = column
  return { columns, chips: layout.chips }
}

/** A column moved one step — or the list unchanged, where the step would leave the header. */
export function moveColumn(layout: Layout, index: number, delta: -1 | 1): Layout {
  const to = index + delta
  const within = (at: number) => at >= 0 && at < layout.columns.length
  if (!within(index) || !within(to)) return layout
  const columns = [...layout.columns]
  const [moved] = columns.splice(index, 1)
  columns.splice(to, 0, moved!)
  return { columns, chips: layout.chips }
}

/** The list without one column. */
export function removeColumn(layout: Layout, index: number): Layout {
  return { columns: layout.columns.filter((_, at) => at !== index), chips: layout.chips }
}

/**
 * The row spec as drawn, and **the rule the list lives under: once it has been edited, a field is
 * shown if and only if the list holds it — as a column or as a chip.** The fill rule decides only
 * until somebody has decided instead.
 *
 * It took three shapes to get here. First the header held columns and the inspector's `Fields`
 * chose chips, so a well-filled field added through `Fields` after the header was edited was
 * classed a column by the fill rule, was not in the stored list, and drew in neither place. Then
 * "a column iff the header holds it, every other shown field a chip", which fixed that but left
 * `Fields` holding half the row and made hiding a default field impossible from the row itself.
 * One list for both is the version where nothing can disagree.
 *
 * A card has no columns, so it draws the list's text columns as chips ahead of the list's own;
 * its figures stay the automatic ones, a card being a summary rather than the table.
 */
export function rowSpecFor(
  fields: RowFields,
  listed: Layout | undefined,
  compact: boolean,
): RowFields {
  if (!listed) return fields
  if (!compact) return { ...fields, chips: listed.chips }
  const aligned = listed.columns
    .filter((c) => c.render === 'text')
    .map(soleFieldOf)
    .filter((name): name is string => name !== undefined)
  return { ...fields, chips: [...new Set([...aligned, ...listed.chips])] }
}

/**
 * One column as one entry of an `ids` param:
 * `{"render":"stacked","fields":["axonIn","dendriteIn"],"label":"inputs"}`.
 *
 * JSON for `paramPairs.ts`' reason: a field name is not a safe thing to delimit (fish2 publishes
 * `AF10_Tectum(L)`), and this sits in a `.coda.json` somebody may read. An object rather than the
 * `[render, ...fields]` array it started as, because a name is optional and an array has no slot
 * for an optional value that could not be mistaken for one more field.
 */
export function encodeColumn(column: ColumnSpec): string {
  const stored = normalizeColumn(column)
  return JSON.stringify({
    render: stored.render,
    fields: stored.fields,
    ...(stored.label ? { label: stored.label } : {}),
    ...(stored.readable ? { readable: true } : {}),
  })
}

/**
 * A column as it is stored: a name equal to the automatic one dropped — or the column stays pinned
 * to a label that only happened to match — and `readable` kept only where the column prints
 * figures. Applied by `encodeColumn`, so no writer, the editor included, can store another shape.
 */
function normalizeColumn(column: ColumnSpec): ColumnSpec {
  const label = column.label?.trim()
  return {
    render: column.render,
    fields: column.fields,
    ...(label && label !== automaticLabel(column) ? { label } : {}),
    ...(column.readable && printsFigures(column) ? { readable: true } : {}),
  }
}

/**
 * One field placed among the chips: `{"chip":"dimorphism"}`.
 *
 * Its own shape rather than a `chip` renderer, which is what it was first: a chip has no track, so
 * as a renderer it needed a label nothing offered, a branch in `fits`, and a width and a mark
 * style that were right only because nothing ever asked for them.
 */
export function encodeChip(name: string): string {
  return JSON.stringify({ chip: name })
}

/** One stored entry: a column, or a field placed among the chips. */
export type Entry = { column: ColumnSpec } | { chip: string }

/** Read one entry back, or undefined for anything unreadable — dropped, never thrown. */
export function decodeEntry(raw: unknown): Entry | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if ('chip' in record)
      return typeof record.chip === 'string' ? { chip: record.chip } : undefined
    const { render, fields, label, readable } = record
    if (typeof render !== 'string' || !(render in RENDERERS)) return undefined
    if (!Array.isArray(fields) || !fields.every((f) => typeof f === 'string')) return undefined
    if (label !== undefined && typeof label !== 'string') return undefined
    if (readable !== undefined && typeof readable !== 'boolean') return undefined
    return {
      column: {
        render: render as Renderer,
        fields,
        ...(label ? { label } : {}),
        ...(readable ? { readable: true } : {}),
      },
    }
  } catch {
    return undefined
  }
}

/** What the header calls a column: its name where somebody gave it one. */
export function columnLabel(column: ColumnSpec): string {
  return column.label || automaticLabel(column)
}

/**
 * What the header calls a column nobody named.
 *
 * A mark's label is not its field's name alone, since the figure beside it may carry the same
 * one: `size` over a tick and `size` over a number is one word labelling two different things a
 * few tracks apart. Exhaustive with no `default`, so a new renderer is a compile error here.
 */
export function automaticLabel(column: ColumnSpec): string {
  const first = column.fields[0] ?? ''
  switch (column.render) {
    case 'number':
    case 'bar':
      return first
    case 'rank':
      return `${first} rank`
    case 'logBar':
      return `${first} (log)`
    case 'text':
    case 'stacked':
    case 'bars':
    case 'donut':
      return column.fields.join('/')
    case 'regions':
      return 'regions'
    case 'confidence':
      return 'nt conf.'
  }
}

/**
 * What a header cell says on hover: the column's fields in full, and what its mark is read
 * against — a label clipped to 54px names a column, and this is where it says what it means. A
 * renamed header still says what it reads, since the name no longer does.
 */
export function columnTitle(column: ColumnSpec, schema: TableSchema | undefined): string {
  const described = describeColumn(column, schema)
  return column.label ? `${column.label}: ${described}` : described
}

function describeColumn(column: ColumnSpec, schema: TableSchema | undefined): string {
  const first = column.fields[0] ?? ''
  switch (column.render) {
    case 'number': {
      const unit = statUnit(schema, first)
      return unit ? `${first} (${unit})` : first
    }
    case 'text':
      return column.fields.join(' / ')
    case 'bar':
      return `${first} — against the largest in this dataset`
    case 'logBar':
      return `${first} — on a log scale against the largest in this dataset`
    case 'rank':
      return `${first} — where each neuron sits among this dataset's`
    case 'stacked':
    case 'bars':
    case 'donut':
      return `${column.fields.join(' + ')} — each part's share of their sum`
    case 'regions':
      return "Where each neuron's synapses are, by primary region"
    case 'confidence':
      return `${first} — how confident the prediction is`
  }
}

/** Whether a column prints figures, so `readable` means something for it. */
export function printsFigures(column: ColumnSpec): boolean {
  return column.render === 'number' || (column.render === 'text' && column.fields.length > 1)
}

/**
 * A column's grid track.
 *
 * **Fixed, every one** — `rowTemplate`'s rule, which it took three browser-only failures to learn:
 * an `auto` track sizes to its own row, so the header drifts off the values it names.
 */
export function columnWidth(column: ColumnSpec): string {
  if (column.render === 'text') return '8rem'
  // An exact figure is as long as its digits: `2980158.182` in 11px mono is ~73px, past 4.5rem.
  if (column.render === 'number') return column.readable ? '4.5rem' : '6.5rem'
  return `${MARK_W}px`
}

/**
 * The fields the popovers may offer: everything the row could draw, minus the id itself and the
 * tag column — which draws as its own row, and is kept out here and in `fits` for one reason.
 */
export function offerableFields(schema: TableSchema | undefined, tagColumn = ''): string[] {
  return (schema?.columns ?? [])
    .filter(
      (c) =>
        c.name !== ID_COLUMN_NAME &&
        c.name !== tagColumn &&
        (c.dtype === 'str' || isNumericDType(c.dtype)),
    )
    .map((c) => c.name)
}
