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
 * The layout effect is the whole of the second pass: mount hidden, measure, place, show. That is
 * also why the placement arithmetic is a pure function in a file of its own; jsdom performs no
 * layout, so this effect measures zero and only `hoverPlacement.test.ts` can hold the geometry.
 *
 * **The value is subscribed to, not handed in.** A hover outlives a run — a preview left open
 * while a scheduled pass replaces the cache would otherwise show what used to be on the wire,
 * which is the one thing a preview of a wire may not do. `runVersion` is what ties the read to
 * the scheduler, and `nodeOutput` returns the cached value by identity, so the selector
 * allocates nothing (invariant 7). Where the value has gone the panel renders nothing rather
 * than an empty box.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { plural } from '../format'
import { hoverPlacement } from '../hoverPlacement'
import type { Rect } from '../hoverPlacement'
import { portPreview } from './portPreview'
import type { PreviewRows } from './portPreview'

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
  const value = useGraphStore((s) => {
    void s.runVersion
    return s.nodeOutput(nodeId, portId)
  })
  const ref = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<{ left: number; top: number } | undefined>(undefined)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = hoverPlacement({
      anchor,
      width: el.offsetWidth,
      height: el.offsetHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      // Away from the card: an output socket sits on the card's right edge, so everything the
      // reader is comparing this against — the card's title, its params, its footer — is to the
      // left. See `hoverPlacement`.
      prefer: 'right',
      gap: GAP,
      margin: MARGIN,
    })
    setBox({ left: place.left, top: place.top })
  }, [anchor, value])

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
    <div
      ref={ref}
      className="port-preview"
      // Hidden rather than unmounted for the first frame: the panel has to be in the document to
      // be measured, and a panel that has been measured but not yet placed is at (0, 0).
      style={{
        left: box?.left ?? 0,
        top: box?.top ?? 0,
        visibility: box ? undefined : 'hidden',
      }}
      role="tooltip"
    >
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

      {preview.rows.map((rows, index) => (
        <PreviewTable key={rows.caption ?? index} rows={rows} />
      ))}

      {preview.text !== undefined && <p className="port-preview__text">{preview.text}</p>}
    </div>
  )
}

/**
 * One table's head and first rows.
 *
 * A real `<table>` here, unlike `TableSummary`'s deliberate block layout: that component turns a
 * sixty-column table ninety degrees to fit a 320px inspector, where this one is showing the first
 * few rows *as rows* — which is the question it exists to answer — and the intrinsic-width pass
 * is what lines the columns up. The panel is capped at six columns, so the pass is bounded.
 */
function PreviewTable({ rows }: { rows: PreviewRows }) {
  /*
   * One line, said out loud rather than trailing off: a panel drawing five of sixty columns and
   * not saying so has answered a question it was not asked.
   */
  const footer =
    rows.cells.length === 0
      ? 'no rows'
      : [
          rows.moreRows > 0 ? `+${plural(rows.moreRows, 'more row')}` : undefined,
          rows.moreColumns > 0 ? `+${plural(rows.moreColumns, 'more column')}` : undefined,
        ]
          .filter(Boolean)
          .join(' · ')

  return (
    <div className="port-preview__table-wrap">
      {rows.caption && <div className="port-preview__caption">{rows.caption}</div>}
      <table className="port-preview__table">
        <thead>
          <tr>
            {rows.columns.map((col, index) => (
              <th key={col.name || `c${index}`} title={col.name}>
                <span className="port-preview__col">{col.name}</span>
                {col.dtype && (
                  <span className="port-preview__dtype">
                    {col.dtype}
                    {col.unit ? ` · ${col.unit}` : ''}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.cells.map((line, row) => (
            <tr key={row}>
              {line.map((cell, col) => (
                <td key={col}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer && <div className="port-preview__more">{footer}</div>}
    </div>
  )
}
