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

const EMPTY: ReadonlySet<string> = new Set()

/** Named in tooltips, so the gesture reads as the one this platform actually uses. */
const MODIFIER =
  typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform ?? '')
    ? 'Option'
    : 'Alt'

/**
 * What a key can do, when the viewer around it wants one that does things.
 *
 * Every field is optional and each one is a separate affordance, because which of them make
 * sense is a property of the *channel* rather than of the legend. A synapse cloud can be
 * hidden and recoloured but not selected — its rows are synapses, and the selection this app
 * carries is of neurons — so the points key renders its label as text where the skeleton key
 * renders a button. An affordance that would lie is left out rather than disabled.
 *
 * Omit the whole object and `ColorKey` renders exactly what it always did: swatches and words,
 * no buttons, no focus stops.
 */
export interface LegendControls {
  /** Keys currently hidden from the scene. */
  hidden?: ReadonlySet<string>
  /** Alt/⌘-click asks to isolate rather than to hide. */
  onToggleHidden?: (label: string, solo: boolean) => void
  /** Keys every one of whose rows is selected, for the pressed state. */
  selected?: ReadonlySet<string>
  onSelect?: (label: string) => void
  onRecolor?: (label: string, hex: string) => void
  /**
   * Switch the whole channel off, one step coarser than the per-key eye.
   *
   * Given here rather than drawn beside the key so that a channel is *named once*. The strip
   * already prints "skeletons" as the group's title where more than one channel is on screen,
   * and a separate row of switches put the same four words in the strip twice — the switch and
   * the title are the same label doing two jobs, so they are one control.
   */
  onToggleChannel?: () => void
  /** Whether that channel is currently off, for the switch's own state. */
  channelHidden?: boolean
}

/**
 * A channel's name, as the control that turns the channel off.
 *
 * Exported because it is needed in two places and must look identical in both: as the title of
 * a `ColorKey` that has keys under it, and on its own for a channel that has none. The second
 * case is not an edge case — a constant colour produces no legend at all, which is what
 * neuropil shells ship with, so it is the only switch those ever get.
 */
/**
 * The "N selected ⨯" button that clears a viewer's selection, in the caption row.
 *
 * Four viewers had grown their own copy — histogram, distribution, pie, and then the 3D view —
 * identical down to the class, the `title` and the glyph, which is the point at which a fifth
 * would have quietly picked a different one. `ExploreBody` already did: `explore__link` and `✕`.
 *
 * `label` rather than a count, because what is selected differs — bins, slices, neurons — and
 * the chart viewers already have `plural` for it. Rendering nothing for an empty selection is
 * part of the contract: the caption row is a flex row of optional spans, and an empty button
 * would still take its gap.
 */
export function ClearSelection({ label, onClear }: { label: string; onClear: () => void }) {
  if (!label) return null
  return (
    <button
      type="button"
      className="legend__label nodrag"
      title="Clear the selection"
      aria-label="Clear selection"
      onClick={onClear}
    >
      {label} ⨯
    </button>
  )
}

export function ChannelToggle({
  name,
  hidden,
  onToggle,
}: {
  name: string
  hidden: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="legend__channel nodrag"
      aria-pressed={!hidden}
      title={hidden ? `Draw the ${name} again` : `Hide the ${name} entirely`}
      onClick={onToggle}
    >
      <span className="legend__eye" aria-hidden>
        {hidden ? '○' : '●'}
      </span>
      {name}
    </button>
  )
}

export function ColorKey({
  colors,
  name,
  controls,
}: {
  colors: ResolvedColor
  name?: string
  controls?: LegendControls
}) {
  const legend = colors.legend
  if (!legend) return null

  /** The group's name, as a switch where the viewer offers one. */
  const title =
    name === undefined ? null : controls?.onToggleChannel ? (
      <ChannelToggle
        name={name}
        hidden={controls.channelHidden === true}
        onToggle={controls.onToggleChannel}
      />
    ) : (
      <span className="legend__title">{name}</span>
    )

  if (legend.kind === 'categorical') {
    const hidden = controls?.hidden ?? EMPTY
    return (
      <span className="legend__group">
        {title}
        {legend.entries.map((entry) => {
          const isHidden = hidden.has(entry.label)
          const isSelected = controls?.selected?.has(entry.label) ?? false
          return (
            <span
              key={entry.label}
              className="legend__item"
              data-hidden={isHidden || undefined}
              data-selected={isSelected || undefined}
            >
              {controls?.onRecolor ? (
                /*
                 * A native colour input, sized down to exactly the swatch it replaces.
                 *
                 * The alternative was a popover with a palette in it, which is a component to
                 * build, position and dismiss, and which would offer the eight slots this key
                 * is already showing. What somebody overriding a slot wants is the colour that
                 * is *not* in the palette — their lab's convention, a figure's existing key —
                 * and the OS picker is the one control that already has it.
                 */
                <input
                  type="color"
                  className="legend__swatch legend__swatch--input nodrag"
                  value={entry.color}
                  title={`Colour for ${entry.label}`}
                  aria-label={`Colour for ${entry.label}`}
                  onChange={(event) => controls.onRecolor?.(entry.label, event.target.value)}
                />
              ) : (
                <span className="legend__swatch" style={{ background: entry.color }} />
              )}

              {controls?.onSelect ? (
                <button
                  type="button"
                  className="legend__label nodrag"
                  title={`Select every ${entry.label} in the scene`}
                  aria-pressed={isSelected}
                  onClick={() => controls.onSelect?.(entry.label)}
                >
                  {entry.label}
                </button>
              ) : (
                entry.label
              )}

              {controls?.onToggleHidden && (
                <button
                  type="button"
                  className="legend__eye nodrag"
                  // Two gestures on one control, and the title has to teach the second one:
                  // nothing on screen suggests that a modifier is meaningful here.
                  title={
                    isHidden
                      ? `Show ${entry.label} (${MODIFIER}-click to show only it)`
                      : `Hide ${entry.label} (${MODIFIER}-click to show only it)`
                  }
                  aria-label={isHidden ? `Show ${entry.label}` : `Hide ${entry.label}`}
                  aria-pressed={isHidden}
                  onClick={(event) =>
                    controls.onToggleHidden?.(entry.label, event.altKey || event.metaKey)
                  }
                >
                  {isHidden ? '○' : '●'}
                </button>
              )}
            </span>
          )
        })}
        {/*
         * The keys this strip does not have room for.
         *
         * Only `hash` ever sets it: `categorical` accounts for its remainder with the `Other`
         * entry, so there is nothing left over to admit to. Twelve keys over twenty-one neurons
         * with no note would read as a scene of twelve.
         */}
        {(legend.unlisted ?? 0) > 0 && (
          <span
            className="legend__item legend__more"
            title={`${legend.unlisted} more values, each drawn in a colour of its own`}
          >
            +{legend.unlisted} more
          </span>
        )}
      </span>
    )
  }

  return (
    <span className="legend__group">
      {/* A ramp has no keys, so the column name still has to be said — after the switch when
          there is one, rather than folded into it. */}
      {title}
      <span className="legend__title">{legend.column}</span>
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
