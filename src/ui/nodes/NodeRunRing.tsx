/**
 * The outline that shows a node is running, and how far along it is.
 *
 * A stroked rounded rect traced around the node's perimeter, with `pathLength="1"` so the
 * dash array is a plain fraction — no measuring the node, no ResizeObserver, and correct at
 * any height. The rect's geometry comes from CSS (`width: calc(100% - 2px)`), which SVG 2
 * allows, so it tracks a node that grows a preview or expands its params.
 *
 * Two things are being communicated and they need separate channels:
 *
 *  - **that it is running** — the ring pulses. A static ring cannot be told apart from a
 *    node that stalled.
 *  - **how far** — the ring's length. Determinate work draws an arc from the top-left
 *    corner clockwise; indeterminate work sends a short arc travelling around instead,
 *    because a full ring at 100% would read as finished.
 *
 * A conic-gradient border was the obvious alternative and is wrong here: it sweeps by angle
 * about the centre, so on a node twice as wide as it is tall the arc races along the short
 * edges and crawls along the long ones. Perimeter distance is what reads as progress.
 */

export interface NodeRunRingProps {
  /** 0..1 when the node reports progress; undefined while it is working but silent. */
  progress?: number | undefined
  /**
   * The corner radius of the thing being ringed, in px. Defaults to a card's `--radius`.
   *
   * A knob rather than a rule keyed on the host, because the ring is a *sibling* of what it
   * rings: nothing the host sets on itself reaches it. The collapsed group box wears a frame's
   * 14px corner, and the alternative — a stylesheet rule selecting on React Flow's generated
   * `.react-flow__node-groupBox` — is a CSS selector depending on a TypeScript string constant,
   * which a rename breaks in silence (the ring keeps drawing, concentric with nothing).
   */
  radius?: number | undefined
}

const round = (value: number) => Math.round(value * 10_000) / 10_000

export function NodeRunRing({ progress, radius }: NodeRunRingProps) {
  const determinate = typeof progress === 'number' && Number.isFinite(progress)
  // Clamped, and floored just above zero: a zero-length dash draws nothing, so a node that
  // has only just started would show no ring at all.
  const fraction = determinate ? Math.min(1, Math.max(0.02, progress)) : 0.18
  // Rounded because `1 - 0.18` is 0.8200000000000001, and sixteen digits of float noise in
  // the markup buys nothing — four decimals is a hundredth of a percent of the perimeter.
  const gap = round(1 - fraction)

  return (
    <svg
      className="coda-node__ring"
      // Read by the rect's `rx`, which falls back to `--radius` when nothing sets it.
      {...(radius === undefined
        ? {}
        : { style: { '--ring-radius': `${radius}px` } as React.CSSProperties })}
      data-mode={determinate ? 'progress' : 'indeterminate'}
      aria-hidden="true"
      focusable="false"
    >
      <rect pathLength={1} strokeDasharray={`${round(fraction)} ${gap}`} />
    </svg>
  )
}
