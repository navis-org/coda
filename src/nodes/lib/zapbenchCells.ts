/**
 * ZapBench cell ids as they travel between nodes, and the vocabulary the ZapBench nodes share.
 *
 * **A row label is the list of cells it averages, joined with `+`.** `ZapBench Traces` names a
 * row at a reduced scale `40211+40212`, and `ZapBench to Neurons` reads the same string back, so
 * the grammar has one owner: `cellLabel` writes it and `cellIdsOf` reads it, side by side. Carrying
 * the members in the label is what lets a Heatmap selection reach the neurons with nothing
 * downstream knowing which scale drew it. A scale param on the second node would be a second copy
 * of a fact the first node already decided, and a wrong one the moment somebody changed one card.
 *
 * A cell id here is the release's **1-based segmentation label** — fish2's `zapbenchId` — never a
 * trace column. `traceColumnOf` is where the two meet, and the only place.
 */

import { formatBytes } from '../../core/limits'
import type { StringParam } from '../../core/node'
import type { CellValue } from '../../core/values'
import type { TraceCost, TraceProduct, TraceWindow } from '../../data/zapbench/traces'
import {
  TRACE_BYTES_WARN,
  TRACE_COLUMNS,
  TRACE_TIMESTEPS,
  WHOLE_RECORDING_ID,
  ZAPBENCH_CONDITIONS,
  traceColumnOf,
  traceUnit,
  windowLength,
} from '../../data/zapbench/traces'
import { SEPARATORS } from './idList'

/** The fish2 neuron property holding a cell id. */
export const ZAPBENCH_ID_COLUMN = 'zapbenchId'

/** A matrix row label for the cells a row holds. Takes a typed array, so a row is a subarray. */
export function cellLabel(ids: readonly number[] | Int32Array): string {
  return ids.join('+')
}

/**
 * The cell ids a table cell names: a whole number, or text of whole numbers joined by `+`.
 * `[]` for an empty cell, `undefined` for one that is not cell ids at all.
 */
export function cellIdsOf(cell: CellValue): number[] | undefined {
  if (cell === null || cell === '') return []
  if (typeof cell === 'number') return Number.isInteger(cell) ? [cell] : undefined
  if (typeof cell !== 'string') return undefined
  const ids: number[] = []
  for (const part of cell.split('+')) {
    const text = part.trim()
    if (!/^\d+$/.test(text)) return undefined
    ids.push(Number(text))
  }
  return ids
}

/**
 * A pasted list of cell ids: separated the way `Input IDs` separates a pasted id list (`idList.ts`'
 * `SEPARATORS`, so `[1203, 4410]` out of a Python session reads the same in both fields), `a-b` for
 * an inclusive range, and a ZapBench Traces row label read as its members.
 *
 * What cannot be read is handed back rather than skipped, so both stages can name it — a list that
 * silently lost `12O4` reads as a cell with no trace.
 */
export function parseCellList(raw: unknown): { ids: number[]; unreadable: string[] } {
  const ids: number[] = []
  const unreadable: string[] = []
  if (typeof raw !== 'string') return { ids, unreadable }
  for (const token of raw.split(SEPARATORS)) {
    if (token === '') continue
    const range = /^(\d+)-(\d+)$/.exec(token)
    if (range) {
      const first = Number(range[1])
      const last = Number(range[2])
      // A range wider than the release is a typo, and expanding `1-71721000` would allocate
      // before anything could say so.
      if (last < first || last - first >= TRACE_COLUMNS) unreadable.push(token)
      else for (let id = first; id <= last; id++) ids.push(id)
      continue
    }
    const members = cellIdsOf(token)
    if (members) ids.push(...members)
    else unreadable.push(token)
  }
  return { ids, unreadable }
}

/** The ids this release has no cell for. */
export function outsideRelease(ids: readonly number[]): number[] {
  return ids.filter((id) => traceColumnOf(id) === undefined)
}

function some(items: readonly (string | number)[]): string {
  const shown = items.slice(0, 5).map(String).join(', ')
  return items.length > 5 ? `${shown} and ${(items.length - 5).toLocaleString()} more` : shown
}

function unreadableCells(tokens: readonly string[]): string {
  return (
    `Not cell ids: ${some(tokens)}. List whole numbers, ranges like 100-200, or row labels ` +
    `from ZapBench Traces.`
  )
}

/** Past this an out-of-range id is not a typo but a neuron id. fish2's bodyIds are around 10^8. */
const BODY_ID_FLOOR = 1_000_000

/**
 * The refusal for ids the release has no cell for — naming a neuron id for what it is, since the
 * likeliest way to get one is a Heatmap fed by `Neurons to ZapBench Traces`, whose rows *are* neuron ids.
 */
export function cellsOutsideRelease(ids: readonly number[]): string {
  return (
    `No ZapBench cell is numbered ${some(ids)} — this release numbers its ` +
    `${TRACE_COLUMNS.toLocaleString()} cells from 1.` +
    (ids.some((id) => id >= BODY_ID_FLOOR)
      ? ' Those look like neuron ids — Selected to Neurons reads a selection of neurons.'
      : '')
  )
}

/** The `Cell IDs` param both ZapBench nodes take, and `readCellList` reads. */
export const CELL_IDS_PARAM: StringParam = {
  id: 'ids',
  kind: 'string',
  label: 'Cell IDs',
  multiline: true,
  placeholder: '1203, 4410\n5000-5100',
  default: '',
  help: 'ZapBench cell ids — fish2’s zapbenchId — separated by commas or new lines. A range like 5000-5100 includes both ends.',
}

export interface CellListRead {
  readonly ids: readonly number[]
  /** The same cells, each once, in the order first listed. */
  readonly cells: readonly number[]
  /** Everything wrong with the list, as the card says it and a Run refuses it. */
  readonly issues: readonly string[]
}

const EMPTY_LIST: CellListRead = { ids: [], cells: [], issues: [] }

/**
 * Recent lists by their text. More than one, because `validate` runs for **every** node on every
 * graph mutation: a ZapBench Traces card listing cells beside a ZapBench to Neurons with an empty field
 * evicted a single slot on every pass, re-parsing the long list each time. Insertion order is
 * the eviction order.
 */
const recentLists = new Map<string, CellListRead>()
const RECENT_LISTS = 4

/**
 * A typed `Cell IDs` param, read once for both stages and both ZapBench nodes that take one.
 *
 * Remembered because a pasted list of every cell is ~10 ms to re-parse and the stored param is
 * the same string until somebody edits it. Hence `readonly` — the arrays are shared between calls.
 */
export function readCellList(raw: unknown): CellListRead {
  if (typeof raw !== 'string' || raw === '') return EMPTY_LIST
  const held = recentLists.get(raw)
  if (held) return held
  const { ids, unreadable } = parseCellList(raw)
  const outside = outsideRelease(ids)
  const issues: string[] = []
  if (unreadable.length > 0) issues.push(unreadableCells(unreadable))
  if (outside.length > 0) issues.push(cellsOutsideRelease(outside))
  const read: CellListRead = { ids, cells: [...new Set(ids)], issues }
  recentLists.set(raw, read)
  if (recentLists.size > RECENT_LISTS) recentLists.delete(recentLists.keys().next().value!)
  return read
}

/** Options for the window picker: the whole recording, then zapbench's nine, in its order. */
export const CONDITION_OPTIONS = [
  {
    value: WHOLE_RECORDING_ID,
    label: `Whole recording (${TRACE_TIMESTEPS.toLocaleString()} steps)`,
  },
  ...ZAPBENCH_CONDITIONS.map((condition) => ({
    value: condition.name,
    label: `${condition.name} (${windowLength(condition.window).toLocaleString()} steps)`,
  })),
]

/** A trace matrix's column labels: the absolute timestep of each column. */
export function stepLabels(window: TraceWindow): string[] {
  return Array.from({ length: windowLength(window) }, (_, step) => String(window.start + step))
}

/** A trace matrix's value label: the unit, the condition when windowed, the bin when averaged. */
export function traceValueLabel(product: TraceProduct, condition: string, scale = 1): string {
  const window = condition === WHOLE_RECORDING_ID ? '' : ` — ${condition}`
  const mean = scale === 1 ? '' : `, mean of ${scale} × ${scale}`
  return `${traceUnit(product)}${window}${mean}`
}

export function noSuchCondition(name: string): string {
  return (
    `No ZapBench condition called "${name}" in this release. Available: ` +
    `${WHOLE_RECORDING_ID}, ${ZAPBENCH_CONDITIONS.map((c) => c.name).join(', ')}`
  )
}

/**
 * The sentence for a selective read past `TRACE_BYTES_WARN`, or nothing.
 *
 * Priced from the reader's `onCost` rather than here, because only the reader knows which of the
 * two layouts it will use and they differ by orders of magnitude — priced by the caller, this said
 * "about 554 MB" for a read that went on to fetch 1.1 MiB.
 *
 * Hand-phrased rather than through `warnOverThreshold`, the call `data/csv.ts` makes for the upload
 * thresholds: that helper prints `count` and `threshold` with `toLocaleString()` and no unit, which
 * announced "580,902,912 bytes to read is past the size a ZapBench read is worth mentioning
 * (67,108,864)".
 */
export function traceCostWarning(traces: number, cost: TraceCost): string | undefined {
  if (cost.bytes <= TRACE_BYTES_WARN) return undefined
  return cost.layout === 'plain'
    ? `${traces.toLocaleString()} traces land in ${cost.blocks.toLocaleString()} of the ` +
        `array’s 512-neuron blocks, so this reads about ${formatBytes(cost.bytes)}. Neurons ` +
        `sit on the contiguous axis of that copy, so the cost follows the blocks rather than ` +
        `the neuron count — narrowing Condition is what makes it smaller. Reading it anyway.`
    : `${traces.toLocaleString()} traces come to about ${formatBytes(cost.bytes)} in ` +
        `${cost.reads.toLocaleString()} reads. Narrowing Condition is what makes it smaller. ` +
        `Reading it anyway.`
}

/** The same threshold for a whole-population read, where the levers are Condition and Scale. */
export function recordingCostWarning(cost: TraceCost): string | undefined {
  if (cost.bytes <= TRACE_BYTES_WARN) return undefined
  return (
    `Every cell comes to about ${formatBytes(cost.bytes)} in ${cost.reads.toLocaleString()} ` +
    `reads. Narrowing Condition or reducing Scale is what makes it smaller. Reading it anyway.`
  )
}
