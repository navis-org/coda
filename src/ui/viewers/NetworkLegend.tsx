/**
 * The network viewer's legend strip.
 *
 * Four channels can be live at once — node colour, node size, link colour, link width — and
 * every one of them needs a key. A categorical encoding without one is colour as the sole
 * channel, which the accessibility pass rules out; a size or width ramp without one is a
 * picture of relative magnitudes with no units attached.
 *
 * Until now only the *export* drew any of this: `networkToSvg` has always appended a legend,
 * while the screen showed categorical swatches and nothing else. A sequential encoding had no
 * key at all on screen, and neither size channel had one anywhere.
 *
 * Link groups are named; node groups are not. Nodes are the default subject of a network
 * drawing, so labelling both halves spends the strip's width restating that.
 */

import type { ResolvedColor } from '../encoding'
import type { SizeChannel } from './LegendKeys'
import { ColorKey, SizeKey } from './LegendKeys'

export type { SizeChannel } from './LegendKeys'

export interface NetworkLegendProps {
  colors: ResolvedColor
  edgeColors: ResolvedColor
  nodeSize: SizeChannel
  edgeWidth: SizeChannel
  /** In a card preview, identity still gets a key; magnitude ramps stand down. */
  compact: boolean
}

export function NetworkLegend({
  colors,
  edgeColors,
  nodeSize,
  edgeWidth,
  compact,
}: NetworkLegendProps) {
  const hasColor = !!colors.legend
  const hasEdgeColor = !!edgeColors.legend
  // Magnitude keys are dropped in a card: they cost two rows of a 150px preview to annotate
  // a comparison the reader can already make by eye. Identity is not optional in the same
  // way — without its key a categorical colour says nothing at all.
  const hasNodeSize = !compact && !!nodeSize.resolved.domain && !!nodeSize.spec.column
  const hasEdgeWidth = !compact && !!edgeWidth.resolved.domain && !!edgeWidth.spec.column
  if (!hasColor && !hasEdgeColor && !hasNodeSize && !hasEdgeWidth) return null

  return (
    <div className="legend">
      <ColorKey colors={colors} />
      {hasNodeSize && <SizeKey channel={nodeSize} name="size" />}
      <ColorKey colors={edgeColors} name="links" />
      {hasEdgeWidth && <SizeKey channel={edgeWidth} name="link width" />}
    </div>
  )
}
