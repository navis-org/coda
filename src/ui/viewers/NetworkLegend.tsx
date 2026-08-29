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

import type { MarkerShape, ResolvedColor, ResolvedShape } from '../encoding'
import type { SizeChannel } from './LegendKeys'
import { ColorKey, ShapeKey, SizeKey } from './LegendKeys'

export type { SizeChannel } from './LegendKeys'

export interface NetworkLegendProps {
  colors: ResolvedColor
  /**
   * Name for the node colour group, where its keys need one.
   *
   * Absent by default — see the note above about not labelling both halves. The exception is a
   * derived channel: `component` keys are bare ordinals, and `1 2 3 4` with nothing saying what
   * the numbers are is the one case where the economy costs more than it saves.
   */
  colorName?: string | undefined
  /**
   * Node marks, where shape is encoding something.
   *
   * Keyed even in `compact`, unlike the magnitude ramps below: shape is identity, and an
   * identity channel without its key says nothing at all — the same rule that keeps the colour
   * key on a card. It draws no key at all when the mode is constant, which is the common case.
   */
  shapes: ResolvedShape
  /** Pin a key's mark. Omit and the shape key is inert, which is what a card shows. */
  onReshape?: ((label: string, shape: MarkerShape) => void) | undefined
  edgeColors: ResolvedColor
  nodeSize: SizeChannel
  edgeWidth: SizeChannel
  /** In a card preview, identity still gets a key; magnitude ramps stand down. */
  compact: boolean
}

export function NetworkLegend({
  colors,
  colorName,
  shapes,
  onReshape,
  edgeColors,
  nodeSize,
  edgeWidth,
  compact,
}: NetworkLegendProps) {
  const hasColor = !!colors.legend
  const hasShape = !!shapes.legend
  const hasEdgeColor = !!edgeColors.legend
  // Magnitude keys are dropped in a card: they cost two rows of a 150px preview to annotate
  // a comparison the reader can already make by eye. Identity is not optional in the same
  // way — without its key a categorical colour says nothing at all.
  const hasNodeSize = !compact && !!nodeSize.resolved.domain && !!nodeSize.spec.column
  const hasEdgeWidth = !compact && !!edgeWidth.resolved.domain && !!edgeWidth.spec.column
  if (!hasColor && !hasShape && !hasEdgeColor && !hasNodeSize && !hasEdgeWidth) return null

  return (
    <div className="legend">
      <ColorKey colors={colors} {...(colorName ? { name: colorName } : {})} />
      {shapes.legend && (
        <ShapeKey
          column={shapes.legend.column}
          entries={shapes.legend.entries}
          {...(onReshape && !compact ? { onReshape } : {})}
        />
      )}
      {hasNodeSize && <SizeKey channel={nodeSize} name="size" />}
      <ColorKey colors={edgeColors} name="links" />
      {hasEdgeWidth && <SizeKey channel={edgeWidth} name="link width" />}
    </div>
  )
}
