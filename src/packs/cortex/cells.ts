/**
 * The gallery's cells: a dataset's neuron index with where each soma sits in the cortex, and the
 * sample of them the wall draws.
 *
 * Headless, so the node's `evaluate`, its `inferOutputs` and the card all read one definition —
 * invariant 3's pair side by side: `cellsSchema` and `cellsTable`, agreed on by a test.
 */

import type { NeuronId } from '../../core/ids'
import { fmix32 } from '../../core/hash'
import { ID_COLUMN_NAME } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { column } from '../../core/types'
import type { ColumnData, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { readLimit } from '../../nodes/lib/heatmapParams'
import { foldColumns, sampleRowIndices } from '../../nodes/lib/tableOps'
import type { CorticalFrame } from './frames'
import { placeAll } from './frames'

/** Micrometres below the pia, of the soma. Null where the source has no single soma for it. */
export const DEPTH_COLUMN = 'soma_depth'
/** The layer that depth falls in (`layerOf`). Null with the depth, or beyond the frame. */
export const LAYER_COLUMN = 'layer'

/** The index's columns with the two the frame adds folded in — `foldColumns`' rules. */
export function cellsSchema(neurons: TableSchema): TableSchema {
  return foldColumns(neurons, [column(DEPTH_COLUMN, 'f64'), column(LAYER_COLUMN, 'str')])
}

/** The value half: every index row, with its soma's depth and layer, or nulls. */
export function cellsTable(
  index: TableValue,
  somata: ReadonlyMap<NeuronId, readonly [number, number, number]>,
  frame: CorticalFrame,
): TableValue {
  const ids = index.data[ID_COLUMN_NAME] ?? []
  // Each soma looked up once; `NaN` is the one with none, which places as null.
  const at = Array.from({ length: index.length }, (_, i) => somata.get(String(ids[i])))
  const { depth, layer } = placeAll(
    frame,
    index.length,
    (i) => at[i]?.[0] ?? NaN,
    (i) => at[i]?.[1] ?? NaN,
  )
  const data: Record<string, ColumnData> = {
    ...index.data,
    [DEPTH_COLUMN]: depth,
    [LAYER_COLUMN]: layer,
  }
  return makeTable(cellsSchema(index.schema), data, index.kind)
}

/**
 * How much of a cell must have been proofread for the wall to offer it.
 *
 * The labels on an unproofread axon are an automatic split, so `dendrite` and above are the
 * defaults that make an axon/dendrite colouring mean something. Which columns say so is the
 * frame's declaration (`CorticalFrame.proofreading`), never a name this module knows.
 */
export type Proofread = 'any' | 'dendrite' | 'both' | 'axonComplete'

export const PROOFREAD_OPTIONS = [
  { value: 'both', label: 'Axon and dendrite proofread' },
  { value: 'axonComplete', label: 'Axon complete' },
  { value: 'dendrite', label: 'Dendrite proofread' },
  { value: 'any', label: 'Any' },
]

const truthy = (value: unknown) => value === true || value === 't' || value === 'true'

/**
 * Why a proofreading level cannot be applied to these cells, or undefined when it can: the frame
 * declares no flags, or the table it names for them came back without them. The gallery reads
 * that table itself (`cellTypes.ts`), so the second is the publisher's change rather than a
 * wiring to fix — the sentence names the table and says what the wall does instead. An empty
 * wall would read as a dataset with no neurons.
 */
export function proofreadingMissing(
  cells: TableValue,
  frame: CorticalFrame,
  level: Proofread,
): string | undefined {
  if (level === 'any') return undefined
  const flags = frame.proofreading
  if (!flags) return 'Showing every cell: this dataset publishes no proofreading status.'
  // Only the columns this level reads: asking for a dendrite does not need the axon's strategy.
  const wanted = [
    flags.dendrite,
    ...(level === 'dendrite' ? [] : [flags.axon]),
    ...(level === 'axonComplete' && flags.strategy ? [flags.strategy.column] : []),
  ]
  const absent = wanted.filter((name) => !(name in cells.data))
  return absent.length > 0
    ? `Showing every cell, proofread or not: ${flags.table} no longer has ` +
        `${absent.join(' or ')}, which the Proofread filter reads.`
    : undefined
}

function proofreadEnough(
  data: Readonly<Record<string, ColumnData>>,
  row: number,
  level: Proofread,
  flags: NonNullable<CorticalFrame['proofreading']>,
) {
  const dendrite = truthy(data[flags.dendrite]?.[row])
  if (level === 'dendrite') return dendrite
  const axon = truthy(data[flags.axon]?.[row])
  if (level === 'both') return dendrite && axon
  const strategy = flags.strategy
  return (
    dendrite &&
    axon &&
    (strategy ? strategy.complete.test(String(data[strategy.column]?.[row] ?? '')) : true)
  )
}

export interface WallOptions {
  /** The column cells are grouped and striped by — `type` unless somebody picks another. */
  groupBy: string
  /** Groups to show; empty shows every group. */
  types: readonly string[]
  proofread: Proofread
  /** Cells per group; 0 is every cell. */
  perType: number
  seed: number
  /** How the groups follow one another — see `WALL_ORDERS`. Within a group, shallowest first. */
  order: WallOrder
}

/**
 * How the wall's groups are ordered. By depth, the default, reads down the cortex the way the
 * layers do; the others are for finding a group by name, seeing the big ones first, or breaking
 * the depth order's suggestion that neighbouring groups are related.
 */
export type WallOrder = 'depth' | 'name' | 'count' | 'shuffled'

export const WALL_ORDERS = [
  { value: 'depth', label: 'By depth' },
  { value: 'name', label: 'By name' },
  { value: 'count', label: 'Largest first' },
  { value: 'shuffled', label: 'Shuffled' },
]

/** One group's cells on the wall, as row indices into the cell table, shallowest first. */
export interface WallGroup {
  type: string
  rows: number[]
  /** How many passed the filters, before the sample. */
  total: number
}

/** The label a cell with no value in the grouping column is grouped under. */
export const UNTYPED = 'untyped'

/** A cell's group label: its value, or `UNTYPED`. The one spelling, for the wall and the chips. */
export function groupLabel(value: unknown): string {
  return value === null || value === undefined || value === '' ? UNTYPED : String(value)
}

/**
 * The wall: the cells that pass the filters, grouped, a seeded sample of each.
 *
 * Only cells with a depth are offered — a cell the frame cannot place has nowhere on a depth axis
 * to be drawn. Groups follow `options.order`, ties broken by name; within a group, shallowest
 * first. A proofreading level the table cannot answer
 * (`proofreadingMissing`) is not applied.
 */
export function wallGroups(
  cells: TableValue,
  frame: CorticalFrame,
  options: WallOptions,
): WallGroup[] {
  const depth = cells.data[DEPTH_COLUMN] ?? []
  const group = cells.data[options.groupBy] ?? []
  const wanted = new Set(options.types)
  const flags =
    proofreadingMissing(cells, frame, options.proofread) === undefined
      ? frame.proofreading
      : undefined
  const byGroup = new Map<string, number[]>()
  for (let row = 0; row < cells.length; row++) {
    if (typeof depth[row] !== 'number') continue
    if (
      flags &&
      options.proofread !== 'any' &&
      !proofreadEnough(cells.data, row, options.proofread, flags)
    )
      continue
    const label = groupLabel(group[row])
    if (wanted.size > 0 && !wanted.has(label)) continue
    const list = byGroup.get(label) ?? []
    list.push(row)
    byGroup.set(label, list)
  }

  // One sort key per group, worked out once: the median depth, the size, or the group's own seed.
  const keyOf = (label: string, rows: readonly number[]): number =>
    options.order === 'count'
      ? -rows.length
      : options.order === 'shuffled'
        ? seedFor(options.seed, label)
        : options.order === 'name'
          ? 0
          : (depth[rows[rows.length >> 1]!] as number)
  const groups: { group: WallGroup; key: number }[] = []
  for (const [label, rows] of byGroup) {
    // Sorted once, in place — the list is this function's own — for the median and the sample.
    rows.sort((a, b) => (depth[a] as number) - (depth[b] as number))
    // The Sample node's own draw, so the one generator a seed pins is the one used; its
    // indices come back ascending, so the sample stays shallowest first.
    const sampled =
      options.perType > 0
        ? sampleRowIndices(rows.length, {
            mode: 'random',
            count: options.perType,
            seed: seedFor(options.seed, label),
            step: 1,
          }).map((i) => rows[i]!)
        : rows
    groups.push({
      group: { type: label, rows: sampled, total: rows.length },
      key: keyOf(label, rows),
    })
  }
  return groups
    .sort((a, b) => a.key - b.key || a.group.type.localeCompare(b.group.type))
    .map(({ group }) => group)
}

/**
 * Compare mode's two groups, by label: an empty or vanished name takes the first group, and the
 * second the next one that is not the first — so a fresh card compares something rather than
 * nothing. Fewer than two groups gives what there is.
 */
export function compareGroups(groups: readonly WallGroup[], a: string, b: string): WallGroup[] {
  const left = groups.find((g) => g.type === a) ?? groups[0]
  const right = groups.find((g) => g.type === b && g !== left) ?? groups.find((g) => g !== left)
  return [left, right].filter((g): g is WallGroup => g !== undefined)
}

/**
 * A seed per group, so changing one group's filter, or adding a group, redraws no other group's
 * sample.
 */
function seedFor(seed: number, label: string): number {
  let hash = seed | 0
  for (let i = 0; i < label.length; i++) hash = (Math.imul(hash, 31) + label.charCodeAt(i)) | 0
  // Mixed at the end: unmixed, the seed adds the same term to every label of one length, so a
  // shuffle comparing two labels' seeds came out the same for every seed.
  return fmix32(hash)
}

/**
 * How wide the wall's columns are: each cell's own extent (`fit`), or one width for every cell
 * (`even`), the arbour clipped at its edges — `um` for that width, automatic when absent.
 */
export type ColumnWidths = { mode: 'fit' } | { mode: 'even'; um?: number }

/**
 * `Column width` and `Width (µm)`, read — one reader for the card and `validate`, on the
 * heatmap's `readLimit` so "empty means automatic" and what counts as a number have one answer.
 * A width that is not a positive number is ignored, automatic standing in, and `problem` says so.
 */
export function readColumnWidths(params: Readonly<Record<string, unknown>>): {
  widths: ColumnWidths
  problem?: string
} {
  if (params.columnMode !== 'even') return { widths: { mode: 'fit' } }
  const { value, problem } = readLimit(params.columnUm)
  if (problem)
    return { widths: { mode: 'even' }, problem: `Width: ${problem}, so it is automatic.` }
  if (value === undefined) return { widths: { mode: 'even' } }
  if (value <= 0) {
    return {
      widths: { mode: 'even' },
      problem: `Width: ${value} µm is not a width, so it is automatic.`,
    }
  }
  return { widths: { mode: 'even', um: value } }
}
