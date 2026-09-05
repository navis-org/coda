import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import type { LinkageValue, TableValue } from '../../core/values'
import { displayLabels } from '../../nodes/lib/displayLabels'
import type { Mode } from '../colors'
import { CHART_INK, MAX_SERIES, chartSurface, currentMode } from '../colors'
import { clusterColor } from '../encoding'
import { exportBaseName as makeBaseName } from '../export'
import { formatNumber, formatZoom, truncateLabel } from '../format'
import type {
  DendrogramLink,
  DendrogramOrientation,
  DendrogramWindow,
} from './dendrogramLayout'
import {
  FULL_WINDOW,
  clampWindow,
  dendrogramShape,
  isFullWindow,
  linkPath,
  observationsUnder,
  panWindow,
  pointToUnit,
  projectPoint,
  visibleLeaves,
  visibleLinks,
  windowScale,
  zoomWindow,
} from './dendrogramLayout'
import { CLICK_SLOP, tooltipPoint } from './tooltipPoint'
import { useWheelZoom } from './useWheelZoom'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { useElementSize } from './useElementSize'

export interface DendrogramViewerProps {
  linkage: LinkageValue
  orientation?: DendrogramOrientation
  showLabels?: boolean
  /**
   * A table naming the leaves, and the two columns that join it on.
   *
   * Passed as the three raw pieces rather than as a resolved lookup because the join allocates a
   * map over the whole table — 165,000 rows for a whole-brain neuron index — and `ValuePreview`
   * dispatches through a chain of early returns, so it has nowhere to put a `useMemo`. Resolved
   * once here instead, keyed on the value's own identity.
   */
  annotations?: TableValue
  matchColumn?: string
  labelColumn?: string
  selection: string[]
  onSelectionChange?: (labels: string[]) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/** Room a leaf label needs along its axis before the next one starts overlapping it. */
const LABEL_PITCH = { right: 11, down: 7 }

/** Breathing room between the card's edge and the plot, on every side. */
const PAD = 8

/** A pan in progress: where the pointer was last, in box coordinates. */
interface Pan {
  lastX: number
  lastY: number
}

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
 *
 * ## Zoom and pan, where the card is the surface
 *
 * Wheel zooms about the pointer, a drag pans, double-click or ⤢ fits — `HeatmapViewer`'s
 * gestures exactly, and off the canvas only (`compact` off), where the card is not a 150px
 * preview React Flow already zooms. The state is a `DendrogramWindow` **along the leaf axis
 * only**; see that type for why one axis rather than the heatmap's two, which was built first
 * and is wrong in a way only a browser shows.
 *
 * It is an input to the drawing rather than a transform over it, which is the whole point: the
 * labels never scale, `visibleLeaves` re-thins them for the pitch the zoom gives them, and
 * `visibleLinks` drops the brackets the window cannot reach. Measured in Chrome on a real
 * 398-leaf tree: 397 brackets and 67 names fitted, 51 brackets and 46 names at ×8.7 with
 * `labels thinned` gone from the caption.
 *
 * Two things here are pointer bookkeeping the heatmap needs none of, because this viewer's
 * whole purpose is *clicking* branches. Pan runs only while zoomed, so a fitted card's pointer
 * belongs entirely to the brackets; and a drag that becomes a pan must not also select the
 * clade it was dragged from, which is `draggedRef` and `CLICK_SLOP`.
 */
export function DendrogramViewer({
  linkage,
  orientation = 'right',
  showLabels = true,
  annotations,
  matchColumn,
  labelColumn,
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
  /** Absent means the whole tree, which is what the viewer stores as "not zoomed". */
  const [view, setView] = useState<DendrogramWindow | undefined>(undefined)
  const [pan, setPan] = useState<Pan | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const clipId = useId()
  /*
   * Whether the gesture that is ending was a drag, read by the bracket's own `onClick`.
   *
   * A **ref** rather than state, and that is the whole reason this works: `pick` is a
   * `useCallback` handed to the memoised `<DendrogramLinks>`, so anything it reads that changes
   * per render would put every bracket back through reconciliation on each pointer move — the
   * cost that component exists to avoid. A ref has no identity of its own to depend on.
   *
   * A click fires after `pointerup`, so by the time `pick` asks, this is the finished gesture.
   */
  const draggedRef = useRef(false)
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

  /*
   * What each leaf is *called*, which is not what it is.
   *
   * One pass producing both the strings and the count of leaves nothing named, because the
   * gutter width, the drawing and the caption all need one or the other and computing them
   * apart is how a caption comes to disagree with the picture above it. Absent annotations
   * resolve to the tree's own labels, so everything below reads `names` unconditionally and
   * there is no second code path for the ordinary case to rot in.
   *
   * Above the guards below, because a hook after an early return is a hook that does not run
   * every render.
   */
  const names = useMemo(() => {
    const found = displayLabels(annotations, matchColumn, labelColumn)
    let unnamed = 0
    const shown = shape.leaves.map((leaf) => {
      const name = found?.get(leaf.label)
      if (found && name === undefined) unnamed++
      // The one place "nothing named it" turns into "keep the leaf's own label", which the
      // render below reads back as `names.shown[i] !== leaf.label` to decide on a `<title>`.
      return name ?? leaf.label
    })
    return {
      shown,
      unnamed,
      by: found ? labelColumn! : '',
      // Folded in rather than reduced again in the render body: the gutter is sized over every
      // leaf, so it changes exactly when `shown` does — and a second pass here is a second
      // O(leaves) walk on the hover path, which is the one path this component is built around.
      longest: shown.reduce((m, label) => Math.max(m, label.length), 0),
    }
  }, [shape, annotations, matchColumn, labelColumn])

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
    (link: DendrogramLink, additive: boolean): void => {
      // A pan that started on a bracket ends with a click on it. Selecting the clade you were
      // only using as a handle to drag by is the failure this closes, and it is invisible in
      // jsdom, which fires no click after a synthetic pointer drag.
      if (draggedRef.current) return
      commit(observationsUnder(shape, link), additive)
    },
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

  /*
   * The plot geometry, computed **above the guards below** rather than beside the drawing it
   * feeds, because the wheel listener needs the box to turn a pointer position into a point of
   * the tree and a hook cannot sit after an early return. Cheap either way: it is four numbers
   * and one pass for `longest`, which the `names` memo has already walked.
   */
  const down = orientation === 'down'
  // The label gutter runs along the *distance* axis, so it is on the right when the leaves are
  // and at the bottom otherwise. Sized to the content and capped, as the heatmap's is.
  //
  // The *drawn* label, or a tree of root ids relabelled to `LC4` keeps a 120px gutter for names
  // eight characters long — and one relabelled the other way runs out of room and truncates.
  //
  // Sized over **every** leaf, not the visible ones: a gutter that re-measured as you panned
  // would resize the plot under the pointer, which is the heatmap's "the gutters are fixed".
  const room = down ? size.height : size.width
  const gutter =
    showLabels && room > 160 ? Math.min(120, Math.max(30, names.longest * 6 + 8)) : 6

  const box = {
    width: Math.max(0, size.width - (down ? PAD * 2 : gutter + PAD)),
    height: Math.max(0, size.height - (down ? gutter + PAD : PAD * 2)),
  }
  const labelsDrawn = showLabels && gutter > 12

  /*
   * Named `frame` and not `window`: this file calls `requestAnimationFrame` and
   * `getBoundingClientRect` off the global of that name, and a shadowed one is the kind of bug
   * that only appears once somebody adds the next line.
   *
   * **Memoised, and that is load-bearing rather than tidy.** `clampWindow` returns a fresh
   * object, and this is a prop of the memoised `<DendrogramLinks>` — so an unmemoised one fails
   * its shallow compare on *every* render, including the `setHover` that fires on every pointer
   * move over a bracket. That is 4,000 `linkPath` calls and 12,000 elements reconciled per
   * pointer move on a fitted tree, which is precisely the cost that component exists to avoid,
   * and it would also have voided `visibleLinks`' returning `shape.links` by identity.
   *
   * Clamped on the way *out* rather than only on the way in: the floor is one leaf slot, so a
   * window stored at 400 leaves is out of range the moment the tree upstream is filtered to 40.
   */
  const frame = useMemo(() => clampWindow(view ?? FULL_WINDOW, leafCount), [view, leafCount])
  const zoomed = !isFullWindow(frame)
  const zoom = windowScale(frame)
  // Off the canvas only, where the card is not a 150px preview React Flow already zooms —
  // `HeatmapViewer`'s rule, and the same one that keeps a wheel over a card panning the canvas.
  const zoomable = !compact && leafCount > 0 && leafCount <= MAX_LEAVES_DRAWN

  /*
   * What the window leaves to draw, memoised for the reason `frame` is: every `setHover` from a
   * pointer move over a bracket re-renders this component, and both of these are O(leaves)
   * otherwise — `visibleLeaves` unconditionally, and `visibleLinks` whenever anything is zoomed.
   *
   * `visibleLinks` hands back `shape.links` itself at the fit, so an unzoomed card's props are
   * identical render to render and `<DendrogramLinks>`' memo still bites.
   */
  const leafAxis = down ? box.width : box.height
  const links = useMemo(() => visibleLinks(shape, frame), [shape, frame])
  const { indices: labelled, thinned } = useMemo(
    () => visibleLeaves(shape, frame, leafAxis, LABEL_PITCH[orientation]),
    [shape, frame, leafAxis, orientation],
  )

  // A new tree gets a new frame; a resize does not, because the window is in unit space.
  useEffect(() => {
    setView(undefined)
  }, [linkage])

  /*
   * Zoom about the pointer: the point of the tree under it is the one that must not move. The
   * listener, the coalescing and the sensitivity are `useWheelZoom`'s; what is left here is the
   * two lines that are actually about a tree.
   *
   * `PAD` comes off both coordinates because the hook measures from the element's own box and
   * the plot sits inside the pad and the gutter.
   */
  useWheelZoom(ref, zoomable && box.width > 0 && box.height > 0, (factor, x, y) => {
    const anchor = pointToUnit(x - PAD, y - PAD, orientation, box, frame)
    const next = zoomWindow(frame, anchor, factor, leafCount)
    setView(isFullWindow(next) ? undefined : next)
  })

  const fit = useCallback(() => setView(undefined), [])

  /*
   * Pan, and the click it must not become.
   *
   * **Only while zoomed** — `HeatmapViewer`'s guard, and here it is load-bearing rather than
   * tidy: this viewer's whole purpose is clicking branches, and a drag handler live at the fit
   * would make every selection a one-pixel gamble. Fitted, the pointer belongs to the brackets.
   *
   * **Pointer capture is taken at the slop, not at the press.** Captured from `pointerdown`, the
   * subsequent `click` is dispatched to the capturing element rather than to the bracket under
   * it, so selection would stop working the moment anybody zoomed in. Taken once the gesture has
   * travelled far enough to stop being a click, it does exactly what it is for — a pan that runs
   * off the edge of the card keeps going — and costs nothing that was still available.
   */
  const onPointerDown = (event: React.PointerEvent): void => {
    draggedRef.current = false
    if (!zoomable || !zoomed || event.button !== 0) return
    const point = tooltipPoint(event, ref.current)
    setPan({ lastX: point.x, lastY: point.y })
  }

  const onPointerMove = (event: React.PointerEvent): void => {
    if (!pan) return
    const point = tooltipPoint(event, ref.current)
    const dx = point.x - pan.lastX
    const dy = point.y - pan.lastY
    // `draggedRef` carries the stickiness, so there is no `moved` flag on the pan state saying
    // the same thing one render later — the ref has to outlive the gesture anyway, since the
    // click that must be suppressed arrives after `endPan` has cleared the state.
    if (!draggedRef.current && Math.hypot(dx, dy) > CLICK_SLOP) {
      draggedRef.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    /*
     * Screen pixels to unit space, along whichever axis the leaves run down. That is the box's
     * height with the leaves on the right and its width with them at the bottom —
     * `projectPoint`'s mapping read backwards, which is why the orientation appears here rather
     * than being hidden inside the pan.
     *
     * The other direction does nothing, deliberately: the distance axis is never windowed, so
     * there is nothing along it to move. See `DendrogramWindow`.
     */
    const alongLeaf = down ? dx / Math.max(1, box.width) : dy / Math.max(1, box.height)
    setView(panWindow(frame, -alongLeaf * frame.atSpan, leafCount))
    setPan({ lastX: point.x, lastY: point.y })
    setHover(null)
  }

  const endPan = (): void => setPan(null)

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

  // Shared with `out.dendrogram`, which puts this hue in its `Selected` output — two copies is
  // how a branch and the neuron it stands for come to be drawn in different colours.
  const colorFor = (cluster: number): string => clusterColor(cluster, mode)

  return (
    <div className="viewer">
      <div
        ref={ref}
        // `nowheel`/`nodrag` keep React Flow's pane out of a gesture aimed at the card. Moot
        // while the gesture is off under `compact`, and the classes cost nothing — the standing
        // `HeatmapViewer` takes for the same pair.
        className="viewer__scroll nowheel nodrag"
        style={{
          overflow: 'hidden',
          position: 'relative',
          cursor: pan ? 'grabbing' : zoomed ? 'grab' : 'default',
          ...(zoomable ? { touchAction: 'none' } : {}),
          /*
           * A pan drags across leaf labels, and the browser's default for that is to *select*
           * them — a zoomed tree came back with half its names highlighted blue. Seen in
           * Chrome; the heatmap never had it because its plot is a canvas.
           *
           * Suppressed only while a pan is live, so a label stays selectable, findable and
           * readable-aloud the rest of the time — which is half of why this viewer is SVG.
           * `preventDefault` on the `pointerdown` would be the other fix and is the wrong one:
           * cancelling it suppresses the compatibility mouse events, and the click that selects
           * a branch goes with them.
           */
          ...(pan ? { userSelect: 'none' as const } : {}),
        }}
        {...(zoomable
          ? {
              onPointerDown,
              onPointerMove,
              onPointerUp: endPan,
              onPointerCancel: endPan,
              onDoubleClick: (event: React.MouseEvent) => {
                // Stopped, or the canvas underneath takes it as a zoom-to-fit of its own.
                event.stopPropagation()
                fit()
              },
            }
          : {})}
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

            <defs>
              {/*
               * Two regions, in the translated group's own coordinates — the user space a
               * `clipPath` referenced from inside it resolves against.
               *
               * The gutter is clipped **along the leaf axis only**: a name lives outside the
               * plot along the distance axis by definition, so clipping it there erases every
               * label. That is why this is not one rect, and why it is not `clipZones`'.
               */}
              <clipPath id={`${clipId}-plot`}>
                <rect width={box.width} height={box.height} />
              </clipPath>
              <clipPath id={`${clipId}-labels`}>
                {down ? (
                  <rect y={box.height} width={box.width} height={size.height} />
                ) : (
                  <rect x={box.width} width={size.width} height={box.height} />
                )}
              </clipPath>
            </defs>

            <g transform={`translate(${PAD} ${PAD})`}>
              <g clipPath={`url(#${clipId}-plot)`}>
                <DendrogramLinks
                  shape={shape}
                  links={links}
                  orientation={orientation}
                  boxWidth={box.width}
                  boxHeight={box.height}
                  frame={frame}
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
                    d={linkPath(hover.link, orientation, box, frame)}
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
              </g>

              <g clipPath={`url(#${clipId}-labels)`}>
                {labelsDrawn &&
                  labelled.map((i) => {
                    const leaf = shape.leaves[i]!
                    const { x, y } = projectPoint(
                      { at: leaf.at, height: 0 },
                      orientation,
                      box,
                      frame,
                    )
                    const isSelected = selected.has(leaf.observation)
                    const renamed = names.shown[i] !== leaf.label
                    const text = (
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
                        {truncateLabel(names.shown[i]!, gutter - 8)}
                      </text>
                    )
                    /*
                     * The identity, on a leaf drawn under another name — `a` and `b` are both
                     * `LC4` the moment cell types are on, and then nothing else on screen says
                     * which leaf is which.
                     *
                     * An SVG `<title>` rather than the `chart-tooltip` the brackets use: it is one
                     * string per drawn label and the browser shows it for free, where a hover
                     * handler on every label would put a `setHover` — and a re-render of the whole
                     * tree with it — between the pointer and three thousand of them.
                     *
                     * **Wrapped in a `<g>` rather than placed inside the `<text>`.** Both are
                     * spec'd the same way (a `<title>` is never rendered), but only one of them
                     * needs that to be true of every renderer this SVG is exported into, and
                     * jsdom cannot answer the question either way — it concatenates the descendant
                     * text, so a test asserting the drawn label sees `aLC4`. The form with no
                     * question is the one to ship.
                     *
                     * Only where the two differ: a title repeating the text under it is noise a
                     * screen reader has to read out twice.
                     */
                    if (!renamed) return text
                    return (
                      <g key={`${leaf.observation}`}>
                        <title>{leaf.label}</title>
                        {text}
                      </g>
                    )
                  })}
              </g>
            </g>
          </svg>
        )}
        {zoomable && (
          // Bottom right, `HeatmapViewer`'s placement: leaves-on-the-right — the default —
          // puts the label gutter down the top-right corner the strip usually takes.
          <div className="network-strip nodrag" style={{ top: 'auto', bottom: 6 }}>
            <button
              type="button"
              className="network-strip__btn"
              title="Show the whole tree (or double-click). Scroll to zoom, drag to pan."
              aria-label="Fit to view"
              disabled={!zoomed}
              onClick={fit}
            >
              ⤢
            </button>
          </div>
        )}

        {hover && !pan && (
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
          {/*
           * Which column the names came from, beside the method — a tree of cell types and a
           * tree of root ids are different pictures, and only the caption can say which one is
           * on screen. Named rather than a bare "annotated": `type` and `instance` produce
           * plausible pictures of one another.
           */}
          {names.by ? ` · by ${names.by}` : ''}
          {clusterCount > 0 ? ` · ${clusterCount} clusters` : ''}
          {selected.size > 0 ? ` · ${selected.size} selected` : ''}
        </span>
        {thinned && labelsDrawn && <span className="viewer__note">labels thinned</span>}
        {zoomed && (
          <span
            className="viewer__note"
            title={`Zoomed in on ${Math.round(frame.atSpan * leafCount).toLocaleString()} of ${leafCount.toLocaleString()} leaves. Scroll to zoom, drag to pan, double-click or ⤢ to fit.`}
          >
            ×{formatZoom(zoom)}
          </span>
        )}
        {names.unnamed > 0 && (
          // The other half of "an unnamed leaf keeps its own label": a tree where a third of the
          // leaves are still root ids looks like a half-broken join and is one, and the count is
          // the only thing that distinguishes it from a table that simply has holes.
          <span
            className="viewer__note"
            title="These leaves are drawn with the label the matrix arrived with, because the annotation table says nothing about them."
          >
            {names.unnamed} unnamed
          </span>
        )}
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
 *
 * `links` is the second half of that arithmetic once a window exists. A pan is a new `frame`
 * per pointer step and therefore a genuine re-render of this component — nothing memoises that
 * away — so what keeps it affordable is that a zoomed window leaves a few hundred brackets of
 * the several thousand. `visibleLinks` hands back `shape.links` itself when nothing is zoomed,
 * so the fitted card's props are identical render to render and the memo still bites there.
 */
interface DendrogramLinksProps {
  shape: ReturnType<typeof dendrogramShape>
  /** The brackets that reach the window — `visibleLinks(shape, frame)`. */
  links: DendrogramLink[]
  orientation: DendrogramOrientation
  boxWidth: number
  boxHeight: number
  frame: DendrogramWindow
  selectedLinks: Uint8Array
  mode: Mode
  interactive: boolean
  onPick: (link: DendrogramLink, additive: boolean) => void
  onHover: (link: DendrogramLink, event: React.MouseEvent) => void
  onLeave: () => void
}

const DendrogramLinks = memo(function DendrogramLinks({
  shape,
  links,
  orientation,
  boxWidth,
  boxHeight,
  frame,
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
      {links.map((link) => {
        const path = linkPath(link, orientation, box, frame)
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
