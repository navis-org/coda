/**
 * Simulate's full-size view: the wired model's partners, a tick for each that fires, and — after a
 * run with the per-partner summary — what each one did alone, sortable.
 *
 * Drawn from the node's *input* (the model's partner list) so it is there before any run, which is
 * when choosing who fires matters; the summary columns come from the node's own `Partners` output
 * and appear once a run has made them. The rules are `partnerRows.ts`'; this is the table.
 *
 * Only on full-size surfaces: the card keeps its param rows, where `Silenced partners` already
 * reads as a count.
 */

import { useMemo, useState } from 'react'
import { isTableValue } from '../../core/values'
import type { ParamValue } from '../../core/node'
import { useGraphStore } from '../../store/graphStore'
import { formatCell, formatNumber, plural } from '../../style/format'
import type { ColumnSort } from '../viewers/sortCycle'
import { nextSort, sortAria, sortGlyph } from '../viewers/sortCycle'
import { ViewerEmpty } from '../viewers/ViewerEmpty'
import { SIGN_COLUMN, SILENCED_PARAM } from '../../packs/biophys/simulateOps'
import type { ModelPartners, PartnerSortKey } from './partnerRows'
import { filterPartners, partnerRows, sortPartners, withFiring } from './partnerRows'

export interface SimulatePartnersProps {
  nodeId: string
  /** The wired model's partners; absent until the Compartment Model has run. */
  partners: ModelPartners | undefined
  silenced: readonly string[]
  /** `Fire`'s top N, where it asks for one: the partners outside it are ticked and do not fire. */
  top?: number | undefined
  onParamChange?: ((paramId: string, value: ParamValue) => void) | undefined
}

interface Column {
  readonly key: PartnerSortKey
  readonly label: string
  readonly title?: string
  readonly numeric?: boolean
}

const COLUMNS: readonly Column[] = [
  { key: 'id', label: 'Partner' },
  { key: 'type', label: 'Type' },
  { key: 'synapses', label: 'Synapses', numeric: true },
]

/** Shown once the model has any inhibitory synapse: which socket each partner came on. */
const SIGN: Column = {
  key: SIGN_COLUMN,
  label: 'Sign',
  title: 'Which socket its synapses came on: excitatory, inhibitory, or mixed for both',
}

/** The summary's columns, shown once a run has filled any of them. */
const SUMMARY_COLUMNS: readonly Column[] = [
  {
    key: 'somaPeak',
    label: 'Soma ΔV (mV)',
    title: 'Peak change at the soma, this partner alone: negative where it hyperpolarises',
    numeric: true,
  },
  {
    key: 'localPeak',
    label: 'Local ΔV (mV)',
    title: 'Peak change at its own synapses: negative where it hyperpolarises',
    numeric: true,
  },
  {
    key: 'attenuation',
    label: 'Soma / local',
    title: 'The share of the local change that reaches the soma',
    numeric: true,
  },
  { key: 'somaSpike', label: 'Spike', title: 'Whether the soma crossed the spike threshold' },
]

/** A cell as every table writes one (`formatCell`), the spike column read as yes/no. */
function cellText(value: string | number | boolean | null): string {
  return typeof value === 'boolean' ? (value ? 'yes' : 'no') : formatCell(value)
}

export function SimulatePartners({
  nodeId,
  partners,
  silenced,
  top,
  onParamChange,
}: SimulatePartnersProps) {
  // The node's own last summary, by reference — a selector that returns the cached value.
  const summary = useGraphStore((s) => s.nodeOutput(nodeId, 'partners'))
  // Both views of the list, not of the run: session-only, so neither is a param. A stored filter
  // would also reach the full-size sidebar, which draws every presentational param of a tabbed node.
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ColumnSort<PartnerSortKey> | undefined>(undefined)

  const rows = useMemo(
    () =>
      partners
        ? partnerRows(partners, silenced, isTableValue(summary) ? summary : undefined, top)
        : [],
    [partners, silenced, summary, top],
  )
  const filtered = useMemo(() => filterPartners(rows, query), [rows, query])
  const shown = useMemo(() => sortPartners(filtered.rows, sort), [filtered.rows, sort])
  const counts = useMemo(
    () => ({
      firing: rows.filter((row) => row.fires).length,
      synapses: rows.reduce((sum, row) => sum + row.synapses, 0),
      summarised: rows.some((row) => row.somaPeak !== null),
    }),
    [rows],
  )
  const filteredIds = useMemo(() => filtered.rows.map((row) => row.id), [filtered.rows])

  if (!partners) {
    return (
      <ViewerEmpty>Wire a Compartment Model to choose which of its partners fire.</ViewerEmpty>
    )
  }
  if (partners.id.length === 0) {
    return (
      <ViewerEmpty>
        This model has no synapses, so it has no partners to fire. Wire Synapses into its
        Compartment Model.
      </ViewerEmpty>
    )
  }

  const signed = rows.some((row) => row.sign !== 'excitatory')
  const base = signed ? [...COLUMNS, SIGN] : COLUMNS
  const columns = counts.summarised ? [...base, ...SUMMARY_COLUMNS] : base
  const narrowed = filtered.rows.length < rows.length
  const write = (ids: readonly string[], fire: boolean) =>
    onParamChange?.(SILENCED_PARAM, withFiring(silenced, ids, fire))

  return (
    <div className="sim-partners">
      <div className="sim-partners__bar">
        <span className="sim-partners__count">
          {formatNumber(counts.firing)} of {plural(rows.length, 'partner')} fire
          {top !== undefined && ` (Fire: the top ${formatNumber(top)} by synapses)`} ·{' '}
          {plural(counts.synapses, 'synapse')}
        </span>
        <input
          className="topo__search sim-partners__search nodrag"
          type="search"
          placeholder="Filter partners…"
          aria-label="Filter partners"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {[true, false].map((fire) => {
          const verb = fire ? 'Tick' : 'Untick'
          return (
            <button
              key={verb}
              type="button"
              className="explore__link nodrag"
              disabled={filteredIds.length === 0}
              onClick={() => write(filteredIds, fire)}
            >
              {narrowed ? `${verb} ${formatNumber(filteredIds.length)} shown` : `${verb} all`}
            </button>
          )
        })}
      </div>
      {filtered.error && <div className="topo__note--warn">{filtered.error}</div>}
      <div className="sim-partners__scroll nowheel">
        <table className="data-table">
          <thead>
            <tr>
              <th className="sim-partners__tick">Fires</th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  title={col.title}
                  aria-sort={sortAria(sort, col.key)}
                  data-sorted={sort?.column === col.key || undefined}
                >
                  <button
                    type="button"
                    className="data-table__name nodrag"
                    onClick={() => setSort((current) => nextSort(current, col.key))}
                  >
                    {col.label}
                    <span className="data-table__sort" aria-hidden="true">
                      {sortGlyph(sort, col.key)}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.id} data-silenced={!row.fires || undefined}>
                <td className="sim-partners__tick">
                  <input
                    type="checkbox"
                    className="nodrag"
                    aria-label={`${row.id} fires`}
                    checked={row.ticked}
                    onChange={(event) => write([row.id], event.target.checked)}
                  />
                </td>
                {columns.map((col) => (
                  <td key={col.key} data-numeric={col.numeric || undefined}>
                    {cellText(row[col.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <div className="sim-partners__none">No partner matches “{query}”.</div>
        )}
      </div>
    </div>
  )
}
