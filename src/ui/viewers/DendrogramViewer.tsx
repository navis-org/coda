import { memo, useCallback, useMemo, useRef, useState } from 'react'

import type { LinkageValue } from '../../core/values'
import type { Mode } from '../colors'
import { CHART_INK, MAX_SERIES, chartSurface, currentMode } from '../colors'
import { clusterColor } from '../encoding'
import { exportBaseName as makeBaseName } from '../export'
import { formatNumber, truncateLabel, labelStep } from '../format'
import type { DendrogramLink, DendrogramOrientation } from './dendrogramLayout'
import { dendrogramShape, linkPath, observationsUnder, projectPoint } from './dendrogramLayout'
import { tooltipPoint } from './tooltipPoint'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { useElementSize } from './useElementSize'

export interface DendrogramViewerProps {
  linkage: LinkageValue
  orientation?: DendrogramOrientation
  showLabels?: boolean
  selection: string[]
  onSelectionChange?: (labels: string[]) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/** Room a leaf label needs along its axis before the next one starts overlapping it. */
const LABEL_PITCH = { right: 11, down: 7 }

/**
 * Above `LEAVES_WARN` the brackets are hairlines and there is nothing to click; above
 * `MAX_LEAVES_DRAWN` there is no SVG worth building at all.
 *
 * `_WARN` rather than something more descriptive so that `grep _WARN` finds the whole tier —
 * see docs/limits.md, which invites exactly that sweep.
 *
 * Two numbers, because "you will not enjoy reading this" and "this cannot be drawn" are
 * different statements and the first was standing in for the second. A tree of ten thousand
 * leaves is 20,000 path elements: heavy, laid out once — see `DendrogramLinks`, which is what
 * makes "once" true — and a perfectly good picture of *structure* even when no individual label
 * can be read. Cut Tree is the node for the other question.
 *
 * `MAX_LEAVES_DRAWN` is **not reachable today**: every linkage comes through
 * `checkLinkageInput`, whose own floor is lower, so nothing in the app can build a tree this
 * big. It is kept rather than deleted because the alternative is a viewer whose only bound is a
 * constant three modules upstream — the arrangement `MAX_HEATMAP_CELLS` was in until it turned
 * out that connectivity matrices reach that viewer without passing through a pivot at all.
 */
const LEAVES_WARN = 3000
const MAX_LEAVES_DRAWN = 20_000

/**
 * A merge tree, drawn.
 *
 * **SVG rather than canvas**, which is the opposite of the call `ScatterViewer` makes and for
 * the opposite reason: a scatter is fed by an embedding of a whole dataset, where this is
 * bounded by `MAX_LINKAGE_OBSERVATIONS` and by what a reader can take in — a few hundred
 * brackets, not a hundred thousand marks. What that buys is the whole export path for free
 * (`ViewerActions` clones the live `<svg>`), real hit testing on every branch without a
 * quadtree, and labels the browser lays out.
 *
 * **Colours cycle past the eighth cluster, and the caption says so.** Everywhere else here a
 * ninth category takes the achromatic Other colour, because in a legend a repeated hue claims
 * two series are the same thing. A dendrogram is the case that rule does not fit: clusters sit
 * in leaf order along one axis, so two sharing a hue are visibly far apart and the number in
 * the table is the identity — where greying everything past eight would leave a twenty-cluster
 * cut with no picture at all. Admitted rather than hidden, on the `labels thinned` idiom.
 */
export function DendrogramViewer({
  linkage,
  orientation = 'right',
  showLabels = true,
  selection,
  onSelectionChange,
  compact = false,
  baseName,
  onExpand,
  onError,
}: DendrogramViewerProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<{ link: DendrogramLink; x: number; y: number } | null>(
    null,
  )
  const svgRef = useRef<SVGSVGElement>(null)
  const mode = currentMode()
  const ink = CHART_INK[mode]
  const surface = chartSurface(mode)

  // By value, not by identity: `linkage` is a fresh object on every store tick, and the shape
  // is an O(n) pass plus three typed arrays. Same reasoning as `useStable`, one step cheaper —
  // the arrays inside a linkage are stable, so they are the honest key.
  const shape = useMemo(() => dendrogramShape(linkage), [linkage])

  const selected = useMemo(() => new Set(selection.map(Number)), [selection])

  /*
   * Which branches are *wholly* selected, in one bottom-up pass over the merges rather than by
   * asking each link about its own leaves.
   *
   * Done per link, that cost the sum of the subtree sizes — about 22,000 element copies for a
   * balanced tree of 2,000 leaves and two million for a chain, which single and average linkage
   * produce routinely. Here it mirrors the `cluster[node] === cluster[node]` pass the layout
   * already makes: a merge is selected when both its children are.
   */
  const selectedLinks = useMemo(() => {
    const n = shape.leaves.length
    const merges = linkage.merges.length / 4
    const whole = new Uint8Array(n + merges)
    // Nothing selected means nothing emphasised, rather than every branch qualifying vacuously.
    if (selected.size === 0) return whole
    for (const leaf of shape.leaves)
      whole[leaf.observation] = selected.has(leaf.observation) ? 1 : 0
    for (let i = 0; i < merges; i++) {
      const a = linkage.merges[i * 4]!
      const b = linkage.merges[i * 4 + 1]!
      whole[n + i] = whole[a]! && whole[b]! ? 1 : 0
    }
    return whole
  }, [shape, linkage.merges, selected])

  // Keyed on the typed array's identity, which is stable — and above the guards below, because
  // a hook after an early return is a hook that does not run every render.
  const clusterCount = useMemo(
    () => (linkage.clusters ? new Set(linkage.clusters).size : 0),
    [linkage.clusters],
  )

  const exportSource: ExportSource = useMemo(() => ({ svg: () => svgRef.current }), [])

  /*
   * Both handed to the memoised `<DendrogramLinks>` below, so both have to be stable — a fresh
   * closure per render would defeat the memo and put every bracket back through reconciliation
   * on each pointer move, which is the whole cost being avoided.
   *
   * `setHover` is a `useState` setter and stable by construction; `ref` is a ref object, so
   * reading `ref.current` inside needs no dependency.
   */
  const commit = useCallback(
    (observations: number[], additive: boolean): void => {
      if (!onSelectionChange) return
      const emit = (set: Iterable<number>): void => onSelectionChange([...set].map(String))
      if (!additive) {
        // A branch already wholly selected clears, so a second click on the same bracket undoes
        // the first — otherwise the only way out of a selection is to find empty canvas.
        const same =
          observations.length === selected.size && observations.every((o) => selected.has(o))
        emit(same ? [] : observations)
        return
      }
      const next = new Set(selected)
      const allIn = observations.every((o) => next.has(o))
      for (const o of observations) {
        if (allIn) next.delete(o)
        else next.add(o)
      }
      emit(next)
    },
    [onSelectionChange, selected],
  )

  // Only the click needs the leaves under a branch, so the walk that finds them happens once
  // per click rather than once per render.
  const pick = useCallback(
    (link: DendrogramLink, additive: boolean): void =>
      commit(observationsUnder(shape, link), additive),
    [commit, shape],
  )

  const hoverAt = useCallback(
    (link: DendrogramLink, event: React.MouseEvent): void => {
      // Container coordinates, not the viewport's: the card sits inside a transformed pane.
      // See `tooltipPoint`.
      setHover({ link, ...tooltipPoint(event, ref.current) })
    },
    [ref],
  )

  const clearHover = useCallback(() => setHover(null), [])

  const leafCount = shape.leaves.length
  if (leafCount === 0) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Tree is empty</div>
      </div>
    )
  }
  if (leafCount > MAX_LEAVES_DRAWN) {
    return (
      <div className="viewer">
        <div className="viewer__empty">
          {leafCount.toLocaleString()} leaves is {(leafCount * 2).toLocaleString()} SVG paths,
          more than one card can hold.
          <br />
          Group or filter upstream, or take the clustering as a table through Cut Tree.
        </div>
      </div>
    )
  }

  const down = orientation === 'down'
  // The label gutter runs along the *distance* axis, so it is on the right when the leaves are
  // and at the bottom otherwise. Sized to the content and capped, as the heatmap's is.
  const longest = shape.leaves.reduce((m, leaf) => Math.max(m, leaf.label.length), 0)
  const room = down ? size.height : size.width
  const gutter = showLabels && room > 160 ? Math.min(120, Math.max(30, longest * 6 + 8)) : 6

  const pad = 8
  const box = {
    width: Math.max(0, size.width - (down ? pad * 2 : gutter + pad)),
    height: Math.max(0, size.height - (down ? gutter + pad : pad * 2)),
  }
  const originX = pad
  const originY = pad

  // Every `step`th label, never a chosen subset: the leaf order is meaningful, so a gap here
  // and a run there would read as missing data rather than as thinning.
  const step = labelStep(leafCount, down ? box.width : box.height, LABEL_PITCH[orientation])
  const thinned = step > 1
  const labelsDrawn = showLabels && gutter > 12

  // Shared with `out.dendrogram`, which puts this hue in its `Selected` output — two copies is
  // how a branch and the neuron it stands for come to be drawn in different colours.
  const colorFor = (cluster: number): string => clusterColor(cluster, mode)

  return (
    <div className="viewer">
      <div
        ref={ref}
        className="viewer__scroll"
        style={{ overflow: 'hidden', position: 'relative' }}
      >
        {size.width > 40 && size.height > 40 && (
          <svg
            ref={svgRef}
            className="chart"
            width={size.width}
            height={size.height}
            role="img"
            onClick={(event) => {
              // Only a click that reached the background, i.e. missed every bracket.
              if (event.target === event.currentTarget) onSelectionChange?.([])
            }}
          >
            <title>
              {`Dendrogram of ${leafCount} leaves${linkage.method ? `, ${linkage.method} linkage` : ''}`}
            </title>
            <rect width={size.width} height={size.height} fill={surface} />

            <g transform={`translate(${originX} ${originY})`}>
              <DendrogramLinks
                shape={shape}
                orientation={orientation}
                boxWidth={box.width}
                boxHeight={box.height}
                selectedLinks={selectedLinks}
                mode={mode}
                interactive={onSelectionChange !== undefined}
                onPick={pick}
                onHover={hoverAt}
                onLeave={clearHover}
              />

              {/*
               * The hover emphasis as one extra path rather than a `strokeWidth` inside the
               * map above: hovering writes to state, so a stroke that read `hover` would put
               * every bracket's props back through reconciliation on each pointer move.
               */}
              {hover && (
                <path
                  d={linkPath(hover.link, orientation, box)}
                  fill="none"
                  stroke={
                    selectedLinks[shape.leaves.length + hover.link.merge] === 1
                      ? ink.primary
                      : colorFor(hover.link.cluster)
                  }
                  strokeWidth={2.2}
                  strokeLinejoin="round"
                  pointerEvents="none"
                />
              )}

              {labelsDrawn &&
                shape.leaves.map((leaf, i) => {
                  if (i % step !== 0) return null
                  const { x, y } = projectPoint({ at: leaf.at, height: 0 }, orientation, box)
                  const isSelected = selected.has(leaf.observation)
                  return (
                    <text
                      key={`${leaf.observation}`}
                      x={down ? x : x + 5}
                      y={down ? y + 5 : y}
                      fill={isSelected ? ink.primary : ink.secondary}
                      fontSize={10}
                      textAnchor={down ? 'end' : 'start'}
                      dominantBaseline="central"
                      transform={down ? `rotate(-90 ${x} ${y + 5})` : undefined}
                      style={{ cursor: onSelectionChange ? 'pointer' : 'default' }}
                      onClick={(event) => {
                        event.stopPropagation()
                        commit([leaf.observation], event.metaKey || event.ctrlKey)
                      }}
                    >
                      {truncateLabel(leaf.label, gutter - 8)}
                    </text>
                  )
                })}
            </g>
          </svg>
        )}
        {hover && (
          <div
            className="chart-tooltip"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
            role="status"
          >
            <strong>{hover.link.last - hover.link.first + 1} leaves</strong>
            {/*
             * Two rows rather than one. The label is an *expression* — "1 − NBLAST score" —
             * where every other tooltip here appends a unit, so the heatmap's `{value}
             * {label}` shape reads as "0.239 1 − NBLAST score" and the two numbers run
             * together.
             */}
            <div className="chart-tooltip__row">
              joined at {formatNumber(hover.link.distance)}
            </div>
            {linkage.distanceLabel && (
              <div className="chart-tooltip__row">{linkage.distanceLabel}</div>
            )}
          </div>
        )}
      </div>
      <div className="viewer__caption">
        <span>
          {leafCount} leaves
          {linkage.method ? ` · ${linkage.method}` : ''}
          {clusterCount > 0 ? ` · ${clusterCount} clusters` : ''}
          {selected.size > 0 ? ` · ${selected.size} selected` : ''}
        </span>
        {thinned && labelsDrawn && <span className="viewer__note">labels thinned</span>}
        {leafCount > LEAVES_WARN && (
          // Drawn, and worth saying that what is on screen is structure rather than leaves:
          // the brackets are hairlines at this size and there is nothing to click.
          <span
            className="viewer__note"
            title="More leaves than this drawing can separate: the shape is readable, individual leaves are not. Cut Tree hands the same clustering back as a table."
          >
            structure only
          </span>
        )}
        {clusterCount > MAX_SERIES && <span className="viewer__note">colours repeat</span>}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'dendrogram')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}

/**
 * The brackets, memoised away from the tooltip.
 *
 * The tree is `2n` `<path>` elements and nothing about any of them changes on a hover — only
 * the tooltip and the one emphasis path above do. The file already knew half of this: the
 * emphasis is drawn as an extra path rather than as a `strokeWidth` that reads `hover`,
 * precisely so a pointer move does not change every bracket's *props*. What that did not avoid
 * is the re-render itself, because `setHover` re-runs the component and React reconciles the
 * whole map again.
 *
 * Measured in jsdom, which has no layout or paint and is therefore a floor: at 19,000 leaves —
 * 38,000 paths — a first render is ~700 ms and *each pointer move* was another 230–320 ms. That
 * was tolerable while the viewer refused above 3,000 leaves; it is not now that it draws up to
 * the linkage floor.
 *
 * Every prop is a primitive or a memoised value, which is what makes `memo` bite: `shape` and
 * `selectedLinks` come from `useMemo`, the box is passed as two numbers rather than as an
 * object literal, and all three callbacks are `useCallback`s in the parent.
 */
interface DendrogramLinksProps {
  shape: ReturnType<typeof dendrogramShape>
  orientation: DendrogramOrientation
  boxWidth: number
  boxHeight: number
  selectedLinks: Uint8Array
  mode: Mode
  interactive: boolean
  onPick: (link: DendrogramLink, additive: boolean) => void
  onHover: (link: DendrogramLink, event: React.MouseEvent) => void
  onLeave: () => void
}

const DendrogramLinks = memo(function DendrogramLinks({
  shape,
  orientation,
  boxWidth,
  boxHeight,
  selectedLinks,
  mode,
  interactive,
  onPick,
  onHover,
  onLeave,
}: DendrogramLinksProps) {
  const box = { width: boxWidth, height: boxHeight }
  const ink = CHART_INK[mode]
  return (
    <>
      {shape.links.map((link) => {
        const path = linkPath(link, orientation, box)
        const isSelected = selectedLinks[shape.leaves.length + link.merge] === 1
        return (
          <g key={link.merge}>
            {/* A fat transparent copy, so a hairline bracket is still clickable — the same
                trick `BaseEdge`'s interactionWidth plays on a wire. */}
            <path
              d={path}
              fill="none"
              stroke="transparent"
              strokeWidth={10}
              style={{ cursor: interactive ? 'pointer' : 'default' }}
              onClick={(event) => {
                event.stopPropagation()
                onPick(link, event.metaKey || event.ctrlKey)
              }}
              onMouseMove={(event) => onHover(link, event)}
              onMouseLeave={onLeave}
            />
            <path
              d={path}
              fill="none"
              stroke={isSelected ? ink.primary : clusterColor(link.cluster, mode)}
              strokeWidth={isSelected ? 2.2 : 1.2}
              strokeLinejoin="round"
              pointerEvents="none"
            />
          </g>
        )
      })}
    </>
  )
})
