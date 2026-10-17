/**
 * `Load Recording`'s table, schema beside value (invariant 3): a recording's sweeps as one long
 * table — `t` (ms), `sweep`, then a column per picked channel and command — narrowed to the
 * sweeps and the window asked for and averaged down by the factor asked for.
 *
 * Long rather than a column per sweep because a protocol's sweep count is the file's, not the
 * user's: a 200-sweep file would be 400 columns, and a Line Chart draws one line per sweep from
 * `sweep` as it is. Combine Traces spreads sweeps into columns where a comparison needs them.
 */

import type { ParamValues } from '../../core/node'
import { CELL_BYTES, crashFloorIssue } from '../../core/limits'
import { namedFew } from '../../core/prose'
import type { TableSchema } from '../../core/types'
import { column, tableSchema, uniqueName } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import type { Recording, RecordingSummary } from '../../data/ephys/recording'
import { SEPARATORS } from '../../nodes/lib/idList'
import { TIME_COLUMN } from './simulateOps'
import { agree, formatNumber, plural } from '../../style/format'

const RECORDING_SWEEP = 'sweep'

/** One column the recording can give: a recorded channel or a rebuilt command. */
interface RecordingColumn {
  /** The column's name: the file's own, told apart from `t`, `sweep` and each other. */
  readonly name: string
  readonly unit: string
  readonly source: 'channel' | 'command'
  /** Which channel or command, in the file's order. */
  readonly index: number
}

/** Every column the recording can give, channels first, in the file's order. */
export function recordingColumns(summary: RecordingSummary): RecordingColumn[] {
  const taken = new Set([TIME_COLUMN, RECORDING_SWEEP])
  const named = (name: string, fallback: string) =>
    uniqueName(taken, name || fallback, (n) => ` (${n})`)
  return [
    ...summary.channels.map((c, index) => ({
      name: named(c.name, `channel ${index + 1}`),
      unit: c.unit,
      source: 'channel' as const,
      index,
    })),
    ...summary.commands.map((c, index) => ({
      name: named(c.name, `command ${index + 1}`),
      unit: c.unit,
      source: 'command' as const,
      index,
    })),
  ]
}

/** What the node's controls ask for, read once. */
export interface RecordingPick {
  /** Column names; empty is every column. */
  readonly columns: readonly string[]
  /** `1-3, 7`, sweeps counted from 1; empty is every sweep. */
  readonly sweeps: string
  /** A window within each sweep, ms; undefined is the whole sweep. */
  readonly window: { readonly start: number; readonly end: number } | undefined
  /** Whether a window's start becomes t = 0. */
  readonly rezero: boolean
  /** Average each this many samples into one. */
  readonly every: number
}

/** Whether the card crops: the window params' `visibleIf`, and what the pick reads. */
export const cropped = (p: ParamValues) => p.crop === true

export function readRecordingPick(p: ParamValues): RecordingPick {
  const crop = cropped(p)
  return {
    columns: p.channels as string[],
    sweeps: String(p.sweeps),
    window: crop ? { start: Number(p.windowStart), end: Number(p.windowEnd) } : undefined,
    rezero: crop && p.rezero === true,
    every: Math.max(1, Math.floor(Number(p.downsample))),
  }
}

/**
 * The columns a pick keeps, in the file's order; a picked name the file lacks is skipped. The one
 * statement of the choice, for the schema and the table alike (invariant 3).
 */
function pickedColumns(all: RecordingColumn[], pick: RecordingPick): RecordingColumn[] {
  if (pick.columns.length === 0) return all
  const wanted = new Set(pick.columns)
  return all.filter((c) => wanted.has(c.name))
}

export function recordingSchema(summary: RecordingSummary, pick: RecordingPick): TableSchema {
  return schemaOf(pickedColumns(recordingColumns(summary), pick))
}

/** `t`, `sweep`, then the kept columns: the one statement of the table's shape. */
function schemaOf(columns: readonly RecordingColumn[]): TableSchema {
  return tableSchema(
    column(TIME_COLUMN, 'f64', 'ms'),
    column(RECORDING_SWEEP, 'i64'),
    ...columns.map((c) => column(c.name, 'f64', c.unit || undefined)),
  )
}

/**
 * `1-3, 7` as sweep indices from 0, sorted and once each; what names no sweep of `count` is
 * returned to be said. Empty text is every sweep.
 */
export function parseSweeps(text: string, count: number): { sweeps: number[]; bad: string[] } {
  const all = Array.from({ length: count }, (_, i) => i)
  if (!text.trim()) return { sweeps: all, bad: [] }
  const keep = new Set<number>()
  const bad: string[] = []
  // A range is closed up first — `1 - 3` is one range, not 1, a dash and 3 — then split on the
  // id lists' separators, so a pasted `[1, 3]` reads as it does everywhere else.
  const ranged = text.replace(/\s*[-–]\s*/g, '-')
  for (const token of ranged.split(SEPARATORS).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token)
    const [from, to] = range
      ? [Number(range[1]), Number(range[2])]
      : [Number(token), Number(token)]
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1 ||
      to > count ||
      from > to
    ) {
      bad.push(token)
      continue
    }
    for (let s = from; s <= to; s++) keep.add(s - 1)
  }
  return { sweeps: [...keep].sort((a, b) => a - b), bad }
}

/** Problems with a pick that are worth a line on the card before a run, against the summary. */
export function recordingPickIssues(summary: RecordingSummary, pick: RecordingPick): string[] {
  const plan = planTable(summary, pick)
  const issues: string[] = []
  const known = new Set(plan.all.map((c) => c.name))
  const gone = pick.columns.filter((name) => !known.has(name))
  if (gone.length > 0) {
    issues.push(
      `${plural(gone.length, 'picked channel')} ${agree(gone.length, 'is', 'are')} not in this recording: ${namedFew(gone)}.`,
    )
  }
  if (plan.bad.length > 0) {
    issues.push(
      `Sweeps: ${namedFew(plan.bad)} ${agree(plan.bad.length, 'names', 'name')} no sweep of the ${formatNumber(summary.sweeps)} in this recording.`,
    )
  } else if (plan.sweeps.length === 0) issues.push('Sweeps names no sweep.')
  const length = summary.sweepSamples * plan.dt
  if (pick.window && !(pick.window.end > pick.window.start)) {
    issues.push('The window ends before it starts.')
  } else if (pick.window && (pick.window.start >= length || pick.window.end <= 0)) {
    issues.push(`The window is outside the sweep, which is ${formatNumber(length)} ms long.`)
  }
  const size = sizeIssue(plan)
  if (size) issues.push(size)
  return issues
}

/**
 * A pick read against the summary once, for the card's issues and the table alike: which columns
 * and sweeps, which samples, how many rows.
 */
interface TablePlan {
  /** Every column the recording can give, and the ones kept. */
  readonly all: readonly RecordingColumn[]
  readonly columns: readonly RecordingColumn[]
  readonly sweeps: readonly number[]
  /** What Sweeps names that no sweep is. */
  readonly bad: readonly string[]
  /** ms between samples. */
  readonly dt: number
  /** Samples `from` up to `to` of each sweep, `start ≤ t < end` by one half-sample rule. */
  readonly from: number
  readonly to: number
  readonly perSweep: number
  readonly rows: number
}

function planTable(summary: RecordingSummary, pick: RecordingPick): TablePlan {
  const dt = 1000 / summary.rate
  const from = pick.window ? Math.max(0, Math.ceil(pick.window.start / dt - 1e-9)) : 0
  const to = pick.window
    ? Math.min(summary.sweepSamples, Math.ceil(pick.window.end / dt - 1e-9))
    : summary.sweepSamples
  const perSweep = Math.ceil(Math.max(0, to - from) / pick.every)
  const { sweeps, bad } = parseSweeps(pick.sweeps, summary.sweeps)
  const all = recordingColumns(summary)
  const columns = pickedColumns(all, pick)
  return { all, columns, sweeps, bad, dt, from, to, perSweep, rows: perSweep * sweeps.length }
}

/**
 * The crash floor's sentence for a pick, or undefined: known from the summary and the controls, so
 * the card says it before a run and the run refuses in the same words.
 */
function sizeIssue(plan: TablePlan): string | undefined {
  const width = plan.columns.length + 2
  return crashFloorIssue(
    `${formatNumber(plan.rows)} rows × ${formatNumber(width)} columns`,
    plan.rows * width * CELL_BYTES,
    'Pick fewer sweeps or channels, crop a shorter window, or raise Downsample.',
  )
}

export function recordingTable(rec: Recording, pick: RecordingPick): TableValue {
  const plan = planTable(rec.summary, pick)
  const { columns, sweeps, dt, from, to, perSweep, rows } = plan
  if (sweeps.length === 0) throw new Error('Sweeps names no sweep of this recording.')
  const size = sizeIssue(plan)
  if (size) throw new Error(size)
  const { every } = pick
  const shift = pick.rezero ? from * dt : 0
  const t = new Array<number>(rows)
  const sweep = new Array<number>(rows)
  const values = columns.map(() => new Array<CellValue>(rows))
  sweeps.forEach((s, n) => {
    const at = n * perSweep
    for (let b = 0; b < perSweep; b++) {
      const first = b * every
      const last = Math.min(to - from, first + every)
      // A block's time is its middle, so averaging never shifts a trace.
      t[at + b] = (from + first + (last - first - 1) / 2) * dt - shift
      sweep[at + b] = s + 1
    }
    // Column by column, only the window's samples, indexed from its start.
    columns.forEach((c, k) => {
      const data =
        c.source === 'channel'
          ? rec.channel(c.index, s, from, to)
          : rec.command(c.index, s, from, to)
      const out = values[k]!
      for (let b = 0; b < perSweep; b++) {
        const first = b * every
        const last = Math.min(data.length, first + every)
        let sum = 0
        for (let i = first; i < last; i++) sum += data[i]!
        const mean = sum / (last - first)
        out[at + b] = Number.isFinite(mean) ? mean : null
      }
    })
  })
  const data: Record<string, CellValue[]> = { [TIME_COLUMN]: t, [RECORDING_SWEEP]: sweep }
  columns.forEach((c, k) => (data[c.name] = values[k]!))
  return makeTable(schemaOf(columns), data)
}
