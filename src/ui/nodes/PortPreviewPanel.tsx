/**
 * The panel a hover over an output socket puts on screen.
 *
 * Portalled to the body (or to the fullscreen root) and positioned in viewport coordinates, so
 * it is drawn at screen scale on a canvas that is free to be at any zoom — the one thing a
 * preview must not inherit is React Flow's transform, since a panel of 9px type at 0.4× is a
 * panel nobody can read.
 *
 * **It measures itself and then places itself.** A port preview's height is its content — two
 * facts or two tables — so there is no size to hand `hoverPlacement` before the thing exists.
 * `usePlacedPanel` is that second pass, shared with Explore's mark preview.
 *
 * **The value is subscribed to, not handed in.** A hover outlives a run — a preview left open
 * while a scheduled pass replaces the cache would otherwise show what used to be on the wire,
 * which is the one thing a preview of a wire may not do. The selector re-runs on every scheduler
 * tick, and `nodeOutput` returns the cached value by identity, so it allocates nothing
 * (invariant 7). Where the value has gone the panel renders nothing rather
 * than an empty box.
 */

import { useMemo } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { plural } from '../format'
import type { Rect } from '../hoverPlacement'
import { usePlacedPanel } from '../useHoverPanel'
import { portPreview } from './portPreview'
import type { PreviewTable } from './portPreview'

/** Gap between the socket and the panel. */
const GAP = 12

/** How close to the viewport edge the panel may sit. */
const MARGIN = 8

export interface PortPreviewPanelProps {
  nodeId: string
  portId: string
  /** What the port is called, so the panel says which of several outputs this is. */
  label: string
  /** The socket's rect, measured when the hover opened. */
  anchor: Rect
}

export function PortPreviewPanel({ nodeId, portId, label, anchor }: PortPreviewPanelProps) {
  const value = useGraphStore((s) => s.nodeOutput(nodeId, portId))
  const { ref, style } = usePlacedPanel(
    anchor,
    // Away from the card: an output socket sits on the card's right edge, so everything the
    // reader is comparing this against — the card's title, its params, its footer — is to the
    // left. See `hoverPlacement`.
    { prefer: 'right', gap: GAP, margin: MARGIN },
    value,
  )

  /*
   * Memoised on the value's identity, which the scheduler cache gives for free.
   *
   * Not premature: the panel renders at least twice per hover (hidden to be measured, then
   * placed) and again on every re-render of the card it hangs off, and the build is not bounded
   * by the 6×5 cap for every kind — `describeValue` walks every item of a geometry collection,
   * and a linkage counts its clusters into a Set. A hover held on a viewer's output during a
   * streaming fetch would re-walk every skeleton four times a second for a headline that has
   * not moved.
   */
  const preview = useMemo(() => (value ? portPreview(value) : undefined), [value])
  if (!preview) return null

  return (
    <div ref={ref} className="hover-panel port-preview" style={style} role="tooltip">
      <div className="port-preview__head">
        <span className="port-preview__port">{label}</span>
        <span className="port-preview__headline">{preview.headline}</span>
      </div>

      {preview.facts.length > 0 && (
        <dl className="port-preview__facts">
          {preview.facts.map((fact) => (
            <div className="port-preview__fact" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {preview.tables.map((table, index) => (
        <FieldTable key={table.caption ?? index} table={table} />
      ))}

      {preview.text !== undefined && <p className="port-preview__text">{preview.text}</p>}
    </div>
  )
}

/**
 * A value's fields down the panel, with its first row across.
 *
 * A real `<table>`, unlike `TableSummary`'s deliberate block layout: that component draws one
 * value per column name, where this has a head to keep in line with three body cells. Bounded at
 * both ends — `MAX_FIELDS` rows, `TABLE_BUDGET_PX` across — so the intrinsic-width pass is too.
 *
 * **The head names all three, and that is not decoration.** Pivoted, a panel of `neuronId str
 * 1047576697` is three unlabelled things in a row, and the first column of a table drawn as rows
 * invites exactly the wrong reading of anything underneath it. `column · type · first row` says
 * what each is, and the field noun doubles as the footer's, so the count beneath cannot contradict
 * the heading above it.
 */
function FieldTable({ table }: { table: PreviewTable }) {
  const typed = table.fields.some((field) => field.type !== undefined)
  /*
   * Fields only. What is *not* here is a count of the rows not drawn: the headline says how many
   * the value has and the head says which one is shown, so a third statement added nothing — and
   * under a list of fields it read as counting them.
   */
  const footer =
    table.fields.length === 0
      ? `no ${table.fieldNoun}s`
      : table.moreFields > 0
        ? `+${plural(table.moreFields, `more ${table.fieldNoun}`)}`
        : ''

  return (
    <div className="port-preview__table-wrap">
      {table.caption && <div className="port-preview__caption">{table.caption}</div>}
      <table className="port-preview__table">
        <thead>
          <tr>
            <th>{table.fieldNoun}</th>
            {typed && <th>type</th>}
            {table.headers.map((head, index) => (
              <th key={index} title={head}>
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.fields.map((field) => (
            <tr key={field.name}>
              <td className="port-preview__field" title={field.name}>
                {field.name}
              </td>
              {typed && <td className="port-preview__dtype">{field.type}</td>}
              {field.values.map((value, index) => (
                <td key={index}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer && <div className="port-preview__more">{footer}</div>}
    </div>
  )
}
