/**
 * Fit Model's full-size view: how the fit ended, the recorded and fitted voltage one sweep at a time,
 * the parameters with their errors, and the error per iteration — the four outputs read, nothing
 * recomputed — with Apply to Compartment Model beside the line that says whether to trust it.
 *
 * One sweep at a time because a line is a (series, column) pair in the Line Chart, so every sweep at
 * once would colour each sweep's recorded and fitted traces as two more lines of the cycle rather
 * than as a pair.
 */

import { useMemo, useState } from 'react'

import type { TableValue, Value } from '../../core/values'
import { getColumn, isTableValue, selectRows } from '../../core/values'
import { TIME_COLUMN } from '../../packs/biophys/simulateOps'
import { formatSignificant } from '../../style/format'
import { useGraphStore } from '../../store/graphStore'
import { LineChartViewer } from '../viewers/LineChartViewer'
import { ViewerEmpty } from '../viewers/ViewerEmpty'
import { ApplyFitButton } from './FitFooter'

/** Significant figures a fitted value is shown to, and its error. */
const VALUE_DIGITS = 4
const ERROR_DIGITS = 2

/** A table output of this node, as the store holds it; undefined until a run. */
function useTableOutput(nodeId: string, port: string): TableValue | undefined {
  const value: Value | undefined = useGraphStore((s) => s.nodeOutput(nodeId, port))
  return isTableValue(value) ? value : undefined
}

/** The Parameters table as rows: `value ± error unit`, or held, or on its bound. */
function ParameterRows({ table }: { table: TableValue }) {
  const col = (name: string) => getColumn(table, name)
  const [name, value, error, unit, free, atBound] = [
    col('parameter'),
    col('value'),
    col('standardError'),
    col('unit'),
    col('free'),
    col('atBound'),
  ]
  return (
    <dl className="model-stats">
      {Array.from({ length: table.length }, (_, i) => {
        const v = Number(value[i])
        const e = error[i]
        const said =
          free[i] !== true
            ? 'held'
            : atBound[i] === true
              ? 'on its bound'
              : typeof e === 'number'
                ? `± ${formatSignificant(e, ERROR_DIGITS)}`
                : ''
        return (
          <div key={String(name[i])}>
            <dt>{String(name[i])}</dt>
            <dd title={said}>
              {formatSignificant(v, VALUE_DIGITS)} {String(unit[i] ?? '')}
              {said && <span className="fit-view__said"> {said}</span>}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

export function FitView({ nodeId, fitted }: { nodeId: string; fitted: Value | undefined }) {
  const traces = useTableOutput(nodeId, 'traces')
  const parameters = useTableOutput(nodeId, 'parameters')
  const iterations = useTableOutput(nodeId, 'iterations')

  // Sweeps in order of first appearance, and the rows of each, once per result.
  const sweeps = useMemo(() => {
    const bySweep = new Map<string, number[]>()
    if (!traces) return bySweep
    getColumn(traces, 'sweep').forEach((cell, row) => {
      // Any value names a sweep, a number with a fraction included; `idText` reads only ids.
      const key = cell === null ? '' : String(cell)
      const rows = bySweep.get(key)
      if (rows) rows.push(row)
      else bySweep.set(key, [row])
    })
    return bySweep
  }, [traces])
  const [picked, setPicked] = useState<string | undefined>()
  const sweep = picked !== undefined && sweeps.has(picked) ? picked : sweeps.keys().next().value
  const shownTraces = useMemo(
    () => (traces && sweep !== undefined ? selectRows(traces, sweeps.get(sweep)!) : undefined),
    [traces, sweeps, sweep],
  )

  if (!fitted || !traces || !parameters || !iterations || !shownTraces) {
    return <ViewerEmpty>Run the fit to see it.</ViewerEmpty>
  }

  return (
    <div className="split-editor">
      <div className="topo__bar">
        {/* How the fit ended is the surface's own subtitle (`describeValue`), so not repeated here. */}
        <span className="fit-view__spacer" />
        {sweeps.size > 1 && (
          <label className="topo__check nodrag">
            Sweep
            <select value={sweep} onChange={(e) => setPicked(e.target.value)}>
              {[...sweeps.keys()].map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
        )}
        <ApplyFitButton
          nodeId={nodeId}
          className="btn btn--primary"
          label="Apply to Compartment Model"
        />
      </div>

      <div className="split-editor__main">
        <div className="fit-view__plot">
          <LineChartViewer table={shownTraces} x={TIME_COLUMN} ys={['recorded', 'fitted']} />
        </div>
        <aside className="split-editor__list" aria-label="The fitted parameters">
          <h4>Parameters</h4>
          <ParameterRows table={parameters} />
          <h4>Error per iteration</h4>
          <div className="fit-view__iterations">
            <LineChartViewer table={iterations} x="iteration" ys={['rms']} compact />
          </div>
        </aside>
      </div>

      <div className="viewer__caption">
        The recorded voltage and the fitted model’s, inside the fit window, one sweep at a time.
        ± is one standard error; a parameter on its bound is the bound’s, not a measurement, and
        a held one is the model’s.
      </div>
    </div>
  )
}
