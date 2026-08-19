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

export function formatCell(value: CellValue): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return formatNumber(value)
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
