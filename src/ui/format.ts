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

/** Full precision with thousands separators, for tables and tooltips. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return value.toLocaleString()
  const abs = Math.abs(value)
  if (abs > 0 && abs < 0.001) return value.toExponential(2)
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

/**
 * An identifier printed as it would be typed back in: no grouping, no rounding.
 *
 * `String` rather than a `useGrouping: false` locale call because that is exactly what the
 * cell's own `title` already shows — a hover that disagrees with the cell under it is the
 * failure this is here to fix, not a second spelling of it.
 */
function formatId(value: number): string {
  return Number.isFinite(value) ? String(value) : '—'
}

/** `sum_`, `mean_`, … — derived, so a sixth aggregate is covered by adding it there. */
const AGG_PREFIXES = AGG_OPTIONS.map((option) => `${option.value}_`)

/**
 * Whether a column's numbers are *names* rather than quantities.
 *
 * A thousands separator is a reading aid for magnitude, and an identifier has no magnitude:
 * body 527536 is not five hundred thousand of anything, so `527,536` is a string nobody can
 * paste back into a query — and under another locale it is not even the same string, which
 * makes a copied column disagree with itself between two machines.
 *
 * Nothing in a `DType` says which of the two a column holds. That is the same gap
 * `BuildNetwork`'s merge rule documents ("summing added `preId` up to 24093454514") and the
 * one the upload node's `Text columns` exists for, so the answer here is theirs: the *name*.
 *
 * The rule is the name's **last word**, split on separators and camelCase boundaries. That
 * covers `bodyId`, `preId`/`postId`, `partnerId`, `sourceId`/`targetId` and the `root_id` /
 * `pt_root_id` spellings an uploaded CSV arrives under, with no list of them to keep in step —
 * and it is why a plain `endsWith('id')` is not enough, since `centroid` and `valid` are words
 * that happen to end that way rather than columns of ids.
 *
 * An **aggregate of** an id column is a quantity again, and is excluded by its prefix:
 * `countDistinct_partnerId` counts partners and does want its separator. The cost is a column
 * somebody else called `max_id`, which reads as an aggregate and keeps its grouping — taken
 * deliberately, because `sum_bodyId` is a name Coda's own `groupBy` generates where `max_id`
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
    return isIdentifierColumn(columnName) ? formatId(value) : formatNumber(value)
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
 * template. Regular `-s` only: every noun this is asked for is one, and a table of
 * irregulars would be answering a question nobody has.
 */
export function plural(n: number, noun: string, suffix = 's'): string {
  return `${formatNumber(n)} ${noun}${n === 1 ? '' : suffix}`
}
