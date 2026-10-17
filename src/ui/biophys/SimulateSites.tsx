/**
 * Simulate's Sites tab: every record site a run has — the soma, `Record at`'s points, Playback's
 * traces — and a tick for each the current is injected at (`Inject at`).
 *
 * Here rather than in the inspector because the sites are named by the data: a `Record at` point
 * is called by its label column's value, which a param's options never see. The list is
 * `runRecordSites`', the run's own, so a ticked name is the compartment the run injects at.
 *
 * Ticking a site while injection is off turns it on, at that site — one commit, so one undo.
 * Unticking the last turns it off. Shape and timing stay in the Clamp tab.
 */

import { useMemo } from 'react'

import type { ParamValue, ParamValues } from '../../core/node'
import type { CellModelValue, Value } from '../../core/values'
import { readManualPoints } from '../../nodes/lib/skeletonPoints'
import {
  CLAMP_SITES_PARAM,
  TRACES_PARAM,
  describeClamp,
  runInputs,
  runRecordSites,
} from '../../packs/biophys/simulateOps'
import { formatNumber, plural } from '../../style/format'
import { ViewerEmpty } from '../viewers/ViewerEmpty'

export interface SimulateSitesProps {
  model: CellModelValue | undefined
  params: ParamValues
  record: Value | undefined
  column: (paramId: string) => string | undefined
  /** Several params in one commit: ticking while off turns injection on and picks the site. */
  onParamsChange?: ((values: Readonly<Record<string, ParamValue>>) => void) | undefined
}

export interface SiteRow {
  readonly label: string
  /** Where the site comes from, or undefined for a ticked name no site is called any more. */
  readonly from: 'soma' | 'Record at' | 'Playback trace' | undefined
  readonly ticked: boolean
}

/**
 * The tab's rows: the run's sites in its order, then any ticked name no site has now — kept and
 * ticked, so it can be unticked rather than lingering unseen in the param.
 */
export function siteRows(
  sites: { readonly labels: readonly string[]; readonly recorded: number },
  ticked: readonly string[],
): SiteRow[] {
  const on = new Set(ticked)
  const rows: SiteRow[] = sites.labels.map((label, i) => ({
    label,
    from: i === 0 ? 'soma' : i < sites.recorded ? 'Record at' : 'Playback trace',
    ticked: on.has(label),
  }))
  const known = new Set(sites.labels)
  for (const name of on) {
    if (!known.has(name)) rows.push({ label: name, from: undefined, ticked: true })
  }
  return rows
}

export function SimulateSites({
  model,
  params,
  record,
  column,
  onParamsChange,
}: SimulateSitesProps) {
  // Exactly what places a site: the stored traces, the snap distance, the label column.
  const labelColumn = column('recordLabel')
  const traces = params[TRACES_PARAM]
  const recordSnap = params.recordSnap
  const sites = useMemo(() => {
    if (!model) return undefined
    const inputs = runInputs(record, undefined, (id) =>
      id === 'recordLabel' ? labelColumn : undefined,
    )
    const placing = { snap: Number(recordSnap), stored: readManualPoints(traces) }
    return runRecordSites(model, inputs.record, placing, [])
  }, [model, record, traces, recordSnap, labelColumn])

  if (!model || !sites) {
    return (
      <ViewerEmpty>Wire a Compartment Model to choose where current is injected.</ViewerEmpty>
    )
  }

  const on = params.clamp === true
  const picked = on ? (params[CLAMP_SITES_PARAM] as string[]) : []
  const rows = siteRows(sites, picked)
  const write = (values: Record<string, ParamValue>) => onParamsChange?.(values)
  const tick = (label: string, ticked: boolean) => {
    const next = ticked ? [...picked, label] : picked.filter((name) => name !== label)
    if (!on) write({ clamp: true, [CLAMP_SITES_PARAM]: [label] })
    else if (next.length === 0) write({ clamp: false })
    else write({ [CLAMP_SITES_PARAM]: next })
  }
  const live = rows.filter((row) => row.ticked && row.from).length
  const editable = onParamsChange !== undefined

  return (
    <div className="sim-partners">
      <div className="sim-partners__bar">
        <span className="sim-partners__count">
          {on
            ? `Injecting ${describeClamp(params)} at ${plural(live, 'site')} of ${formatNumber(rows.filter((row) => row.from).length)}. Shape and timing are in the Clamp tab.`
            : 'Current injection is off. Tick a site to inject at it; shape and timing are in the Clamp tab.'}
        </span>
      </div>
      <div className="sim-partners__scroll nowheel">
        <table className="data-table">
          <thead>
            <tr>
              <th className="sim-partners__tick">Inject</th>
              <th>Site</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} data-silenced={!row.ticked || undefined}>
                <td className="sim-partners__tick">
                  <input
                    type="checkbox"
                    className="nodrag"
                    aria-label={`Inject at ${row.label}`}
                    checked={row.ticked}
                    disabled={!editable}
                    onChange={(event) => tick(row.label, event.target.checked)}
                  />
                </td>
                <td>{row.label}</td>
                <td
                  title={row.from ? undefined : 'No record site is called this now: untick it.'}
                >
                  {row.from ?? 'no such site now'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
