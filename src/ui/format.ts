import { AGG_OPTIONS } from '../nodes/lib/tableOps'
import type { CellValue } from '../core/values'

/** Compact form for axis ticks and tips: 1,284 / 12.9K / 4.2M. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${trim(value / 1e9)}B`
  if (abs >= 1e6) return `${trim(value / 1e6)}M`
  if (abs >= 1e4) return `${trim(value / 1e3)}K`
  if (abs >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
  if (abs === 0) return '0'
  if (abs < 0.01) return value.toExponential(1)
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

function trim(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

/**
 * The SI ladder a length is read on.
 *
 * `per` is how many of the finest unit one of these is, so a value in any of them converts by
 * multiplying. **Sorted here rather than by convention**, because the rung search below takes the
 * last match: a `cm` added in reading order would otherwise silently become the answer for every
 * length, with no type error and nothing failing for the cases already covered.
 *
 * Only lengths get a ladder, and that asymmetry is the point rather than an omission. Which unit
 * a length wants depends on its magnitude, so "2.98" alone says nothing — where `synapses` and
 * `voxels` are *counts*, and a count has no ladder: 12.9K synapses is already the form somebody
 * wants, and a voxel is not a fraction of anything.
 */
interface LengthStep {
  readonly unit: string
  readonly per: number
}

const LENGTH_STEPS: readonly LengthStep[] = [
  { unit: 'nm', per: 1 },
  { unit: 'µm', per: 1e3 },
  { unit: 'mm', per: 1e6 },
  { unit: 'm', per: 1e9 },
].sort((a, b) => a.per - b.per)

/** Decimals a scaled measurement keeps. Two is a hundredth of a rung, which is plenty to read. */
const MEASURE_DIGITS = 2

/**
 * A measurement in the unit a reader thinks in, rather than the one it is stored in.
 *
 * `formatCompact` is unit-blind, so a cable length of 2,980,158 nm read as "3M" — a number whose
 * magnitude is carried entirely by a suffix that means "million" rather than "milli". Nanometres
 * are the right *storage* unit (invariant: geometry is normalised so meshes and skeletons share
 * one scene) and the wrong *display* one for anything the size of a neuron: a fly neuron's arbor
 * is millimetres of cable, and that is the figure in every paper about it.
 *
 * **The unit travels with the number here, and does not for a count** — see `LENGTH_STEPS`. A
 * caller that shows the unit separately should keep using `formatCompact`; a caller holding a
 * unit this does not know gets `formatCompact` anyway, which is what it had before.
 *
 * The lookup is by *membership*, never `unit === 'nm'`: the ladder already names µm, mm and m, so
 * gating on the storage unit would silently drop the unit and reinstate the "3M" failure the
 * moment a column declared one of the others — an uploaded CSV of measurements, or a source
 * publishing µm.
 */
export function formatMeasure(value: number, unit: string | undefined): string {
  const from = LENGTH_STEPS.find((step) => step.unit === unit)
  if (!from || !Number.isFinite(value)) return formatCompact(value)

  const base = value * from.per
  const abs = Math.abs(base)
  // The coarsest rung the value fills, floored at the finest so a sub-nanometre length stays a
  // number rather than becoming "0 µm" one rung up.
  let at = 0
  for (let i = 0; i < LENGTH_STEPS.length; i++) if (abs >= LENGTH_STEPS[i]!.per) at = i
  /*
   * Then once more against the *rounded* figure, which is not redundant: the rung is chosen from
   * the raw value and the number is rounded afterwards, so 999,999 nm fills only µm and prints
   * there as "1,000 µm" — a thousands separator, which is the one thing the ladder exists to
   * remove. Asked of the rounded figure it reads "1 mm", and 999,994 still reads "999.99 µm".
   */
  const next = LENGTH_STEPS[at + 1]
  const rounded = Number((abs / LENGTH_STEPS[at]!.per).toFixed(MEASURE_DIGITS))
  if (next && rounded * LENGTH_STEPS[at]!.per >= next.per) at += 1

  const step = LENGTH_STEPS[at]!
  const scaled = base / step.per
  const scaledAbs = Math.abs(scaled)
  // Below the finest rung there is nowhere left to go, so keep `formatCompact`'s own tail rather
  // than rounding a real length away to "0 nm".
  if (scaledAbs !== 0 && scaledAbs < 0.01) return `${scaled.toExponential(1)} ${step.unit}`
  const digits = scaledAbs !== 0 && scaledAbs < 1 ? 3 : MEASURE_DIGITS
  return `${scaled.toLocaleString(undefined, { maximumFractionDigits: digits })} ${step.unit}`
}

/** Full precision with thousands separators, for tables and tooltips. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return value.toLocaleString()
  const abs = Math.abs(value)
  if (abs > 0 && abs < 0.001) return value.toExponential(2)
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

/**
 * A number printed as it would be typed back in: no grouping, no rounding.
 *
 * Two callers want exactly this, for one reason. An **identifier** has no magnitude, so a
 * thousands separator is a reading aid for something that is not there: body 527536 is not five
 * hundred thousand of anything, `527,536` is a string no query accepts, and under another locale
 * it is not even the same string — which makes a column copied out of the table disagree with
 * itself between two machines. And a **stat's tooltip** is the escape hatch from the compact
 * figure beside it, so rounding there answers the one question the hover exists for with a
 * different number: `formatNumber` takes a CATMAID cable length of 4003103.2328612693 nm down to
 * "4,003,103.233", which is neither exact nor pasteable.
 *
 * `String` rather than a `useGrouping: false` locale call, because that is what "verbatim" means
 * and a second spelling of it is a second thing to keep in step.
 */
export function formatExact(value: number): string {
  return Number.isFinite(value) ? String(value) : '—'
}

/** `sum_`, `mean_`, … — derived, so a sixth aggregate is covered by adding it there. */
const AGG_PREFIXES = AGG_OPTIONS.map((option) => `${option.value}_`)

/**
 * Whether a column's numbers are *names* rather than quantities.
 *
 * Why it matters is `formatExact`'s note; what it costs is that nothing in a `DType` says which
 * of the two a column holds — the same gap `BuildNetwork`'s merge rule documents ("summing added
 * `preId` up to 24093454514") and the one the upload node's `Text columns` exists for. So the
 * answer here is theirs: the *name*.
 *
 * The rule is the name's **last word**, split on separators and camelCase boundaries. That
 * covers `neuronId`, `preId`/`postId`, `partnerId`, `sourceId`/`targetId` and the `root_id` /
 * `pt_root_id` spellings an uploaded CSV arrives under, with no list of them to keep in step —
 * and it is why a plain `endsWith('id')` is not enough, since `centroid` and `valid` are words
 * that happen to end that way rather than columns of ids.
 *
 * An **aggregate of** an id column is a quantity again, and is excluded by its prefix:
 * `countDistinct_partnerId` counts partners and does want its separator. The cost is a column
 * somebody else called `max_id`, which reads as an aggregate and keeps its grouping — taken
 * deliberately, because `sum_neuronId` is a name Coda's own `groupBy` generates where `max_id`
 * can only arrive in somebody's CSV.
 *
 * Memoised, because this is asked once per *cell*: a 500-row page of ten numeric columns is
 * 5,000 calls per render, each otherwise doing a regex replace, a split and a filter — twenty
 * thousand throwaway arrays to answer a question about a handful of distinct strings. The
 * network viewer asks it per edge for one constant name, which is the same waste in one line.
 * Keyed on the name because that is the whole input; the set of names in a session is small
 * and bounded, so the map needs no eviction.
 */
const identifierColumns = new Map<string, boolean>()

export function isIdentifierColumn(name: string | undefined): boolean {
  if (!name) return false
  const cached = identifierColumns.get(name)
  if (cached !== undefined) return cached

  let answer = false
  if (!AGG_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    const words = name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
    const last = words[words.length - 1]?.toLowerCase()
    answer = last === 'id' || last === 'ids'
  }
  identifierColumns.set(name, answer)
  return answer
}

/**
 * One cell as it should read on screen, given the column it came from.
 *
 * The column name is optional because several callers hold a bare value; passing it is what
 * keeps an id out of `formatNumber`'s hands. See `isIdentifierColumn`.
 */
export function formatCell(value: CellValue, columnName?: string): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number')
    return isIdentifierColumn(columnName) ? formatExact(value) : formatNumber(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return value
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}s`
}

/**
 * How long ago something happened, to the largest whole unit: `40s`, `12m`, `5h`, `3d`.
 *
 * Deliberately not `formatDuration`, which measures how long a *run took* and is written for the
 * millisecond end — `<1ms`, `142ms`, `2.4s`. This is the other end and answers a different
 * question, so it rounds rather than refining: nobody deciding whether to re-read an annotation
 * base is served by `2.7d`, and a second decimal on a number that will be different tomorrow
 * implies a precision the answer does not have.
 *
 * Floors rather than rounds, so a thing is never reported as older than it is — `23h` stays `23h`
 * until it really is a day. Anything under a second is `0s`, which is honest and, on the surface
 * this exists for, means the fetch just happened.
 */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Clean axis ticks: 0 / 1,000 / 2,000 rather than 0 / 1,137 / 2,274. Returns at most
 * `count`+1 values covering [0, max].
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0]
  const rawStep = max / count
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const stepMultiple = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  const step = stepMultiple * magnitude
  const ticks: number[] = []
  for (let t = 0; t <= max + step * 0.5; t += step) ticks.push(Math.round(t * 1e6) / 1e6)
  return ticks
}

/**
 * How many labels to skip so they do not overlap.
 *
 * Every `step`th, never a subset chosen by importance: an axis's labels are in a meaningful
 * order, so thinning by rank would leave a run here and a gap there and read as missing data.
 * The caption says when this bit, on the Network viewer's reasoning — silent culling is what
 * makes a viewer look broken.
 *
 * Shared by the dendrogram's leaves and the heatmap's two axes, which is why it sits here beside
 * `truncateLabel` rather than in either viewer: two thinning rules that round differently would
 * drop different numbers of labels for the same room, under captions that say the same thing.
 */
export function labelStep(count: number, room: number, perLabel: number): number {
  if (count === 0 || room <= 0) return 1
  const fits = Math.max(1, Math.floor(room / perLabel))
  return Math.max(1, Math.ceil(count / fits))
}

/**
 * Width to reserve for a horizontal chart's row labels.
 *
 * Here rather than in either viewer, for the reason `labelStep` above is: the bar chart and the
 * box plot are the same picture turned to face the same way, and two gutter rules that rounded
 * differently would give them visibly different left margins on the same table. The numbers are
 * measured against the 10px labels those two charts draw, not derived.
 *
 * Pairs with `truncateLabel(label, gutter - 8)` at the call site — the constant leaves room for
 * the 5px tick gap and rounding, and a label allowed to fill the whole gutter touches the axis.
 */
export function labelGutter(labels: string[], compact: boolean): number {
  const longest = labels.reduce((m, label) => Math.max(m, label.length), 0)
  return compact
    ? Math.min(72, Math.max(28, longest * 5.6 + 6))
    : Math.min(120, Math.max(40, longest * 6 + 8))
}

/** Truncate a label to fit a pixel width, measured against an average glyph width. */
export function truncateLabel(label: string, maxWidth: number, charWidth = 6): string {
  const maxChars = Math.max(1, Math.floor(maxWidth / charWidth))
  if (label.length <= maxChars) return label
  if (maxChars <= 1) return '…'
  return `${label.slice(0, maxChars - 1)}…`
}

/**
 * How long ago, in the shortest form that still says it: "just now", "4m", "3h", "2d".
 *
 * Coarse on purpose — the library shelf uses it to answer "is this the copy I was working on?",
 * for which the ordering matters and the precision does not. Falls back to a date past a week,
 * where "9d" has stopped being a useful way to think about it.
 */
export function formatAgo(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days <= 7) return `${days}d ago`
  return new Date(epochMs).toLocaleDateString()
}

/**
 * `3 nodes`, `1 node` — the count and its noun, agreeing.
 *
 * Spelled out inline in eleven places before this, twice in adjacent lines of the same
 * template. Regular `-s` by default and an explicit plural for the rest — the escape hatch was
 * a `suffix` parameter no caller could use, since `'category' + 'ies'` is not a word, so the
 * one irregular noun in the app grew a private copy of this function that also dropped the
 * thousands separator.
 */
export function plural(n: number, noun: string, plural = `${noun}s`): string {
  return `${formatNumber(n)} ${n === 1 ? noun : plural}`
}

/**
 * A size in bytes, in the units storage is quoted in.
 *
 * Binary rungs (1024) rather than decimal, because what these numbers describe is browser
 * storage and a quota — where 1 MB means 1,048,576 and a decimal reading is quietly 5% out by
 * the gigabyte. A `GB` rung because an edge set reaches it where an upload never did.
 *
 * Moved here from `UploadBody`, which held it privately until an edge set became the second
 * thing in the app with a size worth stating. Note there is a *third* spelling in `RoisViewer`,
 * which quotes decimal MB for a download — left alone deliberately rather than folded in, since
 * changing it would move a number on an unrelated card.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
