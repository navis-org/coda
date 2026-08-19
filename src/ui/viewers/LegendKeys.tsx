/**
 * The individual keys a legend strip is built from.
 *
 * Extracted from `NetworkLegend` when the scatter plot needed the same three: a categorical
 * encoding without its key is colour as the sole channel, which the accessibility pass rules
 * out, and that is as true of a point cloud as of a node-link drawing. Two viewers drawing
 * their own swatches is how two viewers end up disagreeing about what the palette's `Other`
 * bucket looks like.
 *
 * Every key here is a fragment — the strip that holds them (`.legend`) belongs to the viewer,
 * because what stands down in a card preview is a per-viewer judgement.
 */

import type { SizeSpec } from '../../nodes/lib/encodingParams'
import type { ResolvedColor, ResolvedSize } from '../encoding'
import { formatCompact } from '../format'
import { markPath } from './scatterDraw'
import type { MarkerShape } from './scatterPlot'

export interface SizeChannel {
  spec: SizeSpec
  resolved: ResolvedSize
}

/** Largest disc a size key will draw, so a big range cannot set the strip's height. */
const MAX_DISC = 9

export function ColorKey({ colors, name }: { colors: ResolvedColor; name?: string }) {
  const legend = colors.legend
  if (!legend) return null

  if (legend.kind === 'categorical') {
    return (
      <span className="legend__group">
        {name && <span className="legend__title">{name}</span>}
        {legend.entries.map((entry) => (
          <span key={entry.label} className="legend__item">
            <span className="legend__swatch" style={{ background: entry.color }} />
            {entry.label}
          </span>
        ))}
      </span>
    )
  }

  return (
    <span className="legend__group">
      <span className="legend__title">{name ? `${name} ${legend.column}` : legend.column}</span>
      <span className="colorbar">
        {formatCompact(legend.domain[0])}
        <span
          className="colorbar__ramp"
          style={{ background: `linear-gradient(to right, ${legend.stops.join(', ')})` }}
        />
        {formatCompact(legend.domain[1])}
      </span>
    </span>
  )
}

/**
 * Two discs at the ends of the range, with the values they stand for.
 *
 * Area-scaled, matching `resolveSize` — so the drawn pair is the same comparison the picture
 * is making, rather than a pair of radii that would overstate the difference.
 */
export function SizeKey({ channel, name }: { channel: SizeChannel; name: string }) {
  const { spec, resolved } = channel
  if (!resolved.domain || !spec.column) return null
  const small = Math.min(MAX_DISC, Math.max(2, spec.min))
  const large = Math.min(MAX_DISC, Math.max(small + 1, spec.max))

  return (
    <span className="legend__group">
      <span className="legend__title">{`${name} ${spec.column}`}</span>
      <span className="legend__item">
        <span className="legend__disc" style={{ width: small, height: small }} />
        {formatCompact(resolved.domain[0])}
      </span>
      <span className="legend__item">
        <span className="legend__disc" style={{ width: large, height: large }} />
        {formatCompact(resolved.domain[1])}
      </span>
    </span>
  )
}

/**
 * The marks a shape encoding hands out, drawn as the marks themselves.
 *
 * Tiny inline SVGs off `markPath` rather than glyph characters: a legend that approximated
 * its own marks would be the one place on screen where what is drawn and what it says are
 * allowed to differ, and the shapes are already a fallback channel for exactly the readers a
 * colour key cannot serve.
 */
export function ShapeKey({
  column,
  entries,
}: {
  column: string
  entries: Array<{ label: string; shape: MarkerShape }>
}) {
  return (
    <span className="legend__group">
      <span className="legend__title">{column}</span>
      {entries.map((entry) => (
        <span key={entry.label} className="legend__item">
          <svg className="legend__mark" width={10} height={10} viewBox="0 0 10 10" aria-hidden>
            <path d={markPath(entry.shape, 5, 5, 4)} fill="currentColor" />
          </svg>
          {entry.label}
        </span>
      ))}
    </span>
  )
}
