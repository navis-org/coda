/**
 * Simulate's partner table, as data: one row per partner of the wired model, whether it fires,
 * and — after a run with the per-partner summary — what it did alone. Pure, so the table's rules
 * are tested without a DOM.
 *
 * **What is stored is who is silenced**, never who fires (`simulate.ts`' `silenced`): a partner the
 * model gains on a rebuild fires, which is what a model with its synapses wired in is for. So
 * ticking removes ids from the list and unticking adds them, and the list keeps the order the
 * user built it in.
 */

import { idText } from '../../core/ids'
import { findColumn } from '../../core/types'
import type { CellModelValue, CellValue, SynapseSign, TableValue } from '../../core/values'
import { getColumn, partnerSign } from '../../core/values'
import { parseLabelFilter } from '../../nodes/lib/matrixShape'
import { compareCells } from '../../nodes/lib/tableOps'
import {
  PARTNER_ID_COLUMN,
  SUMMARY_COLUMNS,
  firingIndices,
} from '../../packs/biophys/simulateOps'
import type { ColumnSort } from '../viewers/sortCycle'

export interface PartnerRow {
  readonly id: string
  readonly type: string | null
  readonly synapses: number
  /** Which socket its synapses came on: `mixed` for a partner on both. */
  readonly sign: SynapseSign | 'mixed'
  /** Not silenced: the tick. */
  readonly ticked: boolean
  /** Fires in the next run: ticked, and among the top N where `Fire` asks for them. */
  readonly fires: boolean
  /** The last run's summary, null before one or for a partner that did not run alone. */
  readonly somaPeak: number | null
  readonly localPeak: number | null
  readonly attenuation: number | null
  readonly somaSpike: boolean | null
}

export type PartnerSortKey = keyof PartnerRow

/** What the table reads of a model: its partner list. */
export type ModelPartners = CellModelValue['partners']

/**
 * The rows, one per partner in the model's order. The summary is joined by partner id, since the
 * last run may have been of a model built before the latest edit; a partner it does not name gets
 * empty cells, as one that did not run alone does.
 */
export function partnerRows(
  partners: ModelPartners,
  silenced: readonly string[],
  summary: TableValue | undefined,
  top?: number,
): PartnerRow[] {
  const off = new Set(silenced)
  const firing = new Set(firingIndices(partners, silenced, top))
  // The summary's rows by partner id; none from a run without the summary.
  const ran = new Map<string, number>()
  const has =
    summary !== undefined && findColumn(summary.schema, SUMMARY_COLUMNS[0]) !== undefined
  if (has) {
    getColumn(summary, PARTNER_ID_COLUMN).forEach((cell, row) =>
      ran.set(idText(cell) ?? '', row),
    )
  }
  /** A summary column by name, its cell for partner `id`; null where the partner did not run. */
  const reader = (name: (typeof SUMMARY_COLUMNS)[number]) => {
    const column = has ? getColumn(summary, name) : undefined
    return (id: string) => {
      const row = ran.get(id)
      return column && row !== undefined ? (column[row] ?? null) : null
    }
  }
  const [somaPeak, localPeak, attenuation, somaSpike] = SUMMARY_COLUMNS.map(reader)
  const num = (value: CellValue) => (value === null ? null : Number(value))
  return partners.id.map((id, p) => {
    const spike = somaSpike!(id)
    return {
      id,
      type: partners.type[p] ?? null,
      synapses: partners.synapses[p]!,
      sign: partnerSign(partners, p),
      ticked: !off.has(id),
      fires: firing.has(p),
      somaPeak: num(somaPeak!(id)),
      localPeak: num(localPeak!(id)),
      attenuation: num(attenuation!(id)),
      somaSpike: spike === null ? null : spike === true,
    }
  })
}

/**
 * The rows a filter keeps — Neuron Topology's and the Heatmap's grammar (`parseLabelFilter`):
 * a substring, `/regex/`, `!` or `-` to negate — asked of the id and the type. A negated filter
 * keeps a row only when *neither* matches, or `!LC4` would keep every LC4 by its id.
 */
export function filterPartners(
  rows: readonly PartnerRow[],
  query: string,
): { rows: readonly PartnerRow[]; error?: string } {
  const { filter, error } = parseLabelFilter(query)
  if (!filter) return error ? { rows, error } : { rows }
  return {
    rows: rows.filter((row) =>
      filter.testAny(row.type === null ? [row.id] : [row.id, row.type]),
    ),
  }
}

/** Sorted by one column; empty cells last whichever way, so a sort shows what was measured first. */
export function sortPartners(
  rows: readonly PartnerRow[],
  sort: ColumnSort<PartnerSortKey> | undefined,
): readonly PartnerRow[] {
  if (!sort) return rows
  const sign = sort.descending ? -1 : 1
  return [...rows].sort((a, b) => {
    const x = a[sort.column]
    const y = b[sort.column]
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
    return sign * compareCells(x, y, typeof x !== 'string')
  })
}

/**
 * The silenced list after ticking (`fire`) or unticking some partners: ticking removes their ids,
 * unticking appends the ones not already there. Everything else stays where it was.
 */
export function withFiring(
  silenced: readonly string[],
  ids: readonly string[],
  fire: boolean,
): string[] {
  if (fire) {
    const on = new Set(ids)
    return silenced.filter((id) => !on.has(id))
  }
  const off = new Set(silenced)
  return [...silenced, ...ids.filter((id) => !off.has(id))]
}
