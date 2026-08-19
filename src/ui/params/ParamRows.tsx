/**
 * Rows of a grouped styling panel.
 *
 * The arrangement is decided by `groupParams`; this only draws it. A composite row is one
 * visual property — `Colour  [by category ▾]  [type ▾]` — with any modifiers on a second
 * line beneath, which is what keeps a panel of thirty params readable as a dozen properties.
 *
 * Every field is `variant="inspector"`, which suppresses a checkbox's own label: the row
 * already carries the property's name, and printing "Labels" beside a row labelled "Label"
 * reads as two controls rather than one.
 */

import type { InferContext, ParamValue, ParamValues } from '../../core/node'
import { ParamField } from './ParamField'
import type { ParamRow } from './paramGroups'
import { facetLabel } from './paramGroups'

export interface ParamRowsProps {
  rows: ParamRow[]
  params: ParamValues
  ctx: InferContext
  onChange: (paramId: string, value: ParamValue) => void
}

export function ParamRows({ rows, params, ctx, onChange }: ParamRowsProps) {
  const field = (id: string, param: Parameters<typeof ParamField>[0]['param']) => (
    <ParamField
      param={param}
      value={params[id]}
      ctx={ctx}
      onChange={(next) => onChange(id, next)}
      variant="inspector"
    />
  )

  return (
    <div className="style-rows">
      {rows.map((row) =>
        row.kind === 'single' ? (
          <div className="style-row" key={row.param.id}>
            <span className="style-row__label" title={row.param.help ?? row.param.label}>
              {row.param.label}
            </span>
            <div className="style-row__controls">{field(row.param.id, row.param)}</div>
          </div>
        ) : (
          <div className="style-row" key={row.key}>
            <span className="style-row__label" title={row.primary?.help ?? row.label}>
              {row.label}
            </span>
            <div className="style-row__controls">
              {row.primary && field(row.primary.id, row.primary)}
              {row.value && field(row.value.id, row.value)}
            </div>
            {row.extras.length > 0 && (
              <div className="style-row__extras">
                {row.extras.map((extra) => (
                  <label className="style-facet" key={extra.id}>
                    <span className="style-facet__label">{facetLabel(extra)}</span>
                    {field(extra.id, extra)}
                  </label>
                ))}
              </div>
            )}
          </div>
        ),
      )}
    </div>
  )
}
