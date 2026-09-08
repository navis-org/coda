/**
 * The map of a connectome's neuropils.
 *
 * Outlines rather than filled silhouettes, because sixty overlapping regions painted solid lose
 * the back half of the brain to the front half — a stroke carries identity and a faint fill
 * carries extent, so a region behind another still reads. It is also why the picture is genuine
 * vector, which `ui/export.ts` already knows what to do with.
 *
 * Everything geometric is in `roiProjection.ts` and everything about getting the geometry is in
 * `roiOutlines.ts`. What is left here is a drawing and its chrome — which is the shape
 * `ScatterViewer` and `NetworkViewer` both take, and for the reason they record: jsdom has no
 * canvas and no layout, so anything that stays in a component is covered by nothing at all.
 *
 * ## Three states, and the first one is a button
 *
 * A dataset's region meshes are 29–62 MB. That is four to nine times Explore's whole-dataset
 * neuron index, so it cannot be a side effect of dropping a card on a canvas; the card opens on
 * an explicit Load. What lands is a few tens of kilobytes of polyline, cached — so the second
 * open, and every open after it, has no button and no wait.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { getColumn } from '../../core/values'
import { getSource, regionList } from '../../data/source'
import { CHART_INK, currentMode, sequentialColor, seriesColor } from '../colors'
import type { SequentialHue } from '../colors'
import type { Mode } from '../colors'
import { formatCompact, formatNumber } from '../format'
import { Facts, Loadable, Tile } from './Tiles'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { useElementSize } from './useElementSize'
import { useRoiCompleteness } from './useRoiCompleteness'
import { useRoiOutlines } from './useRoiOutlines'
import type { RoiOutlineRegion, RoiOutlineSet } from './roiOutlines'
import { ROI_CONFIRM_REGIONS } from './roiOutlines'
import type { RoiView, RoiWindow } from './roiProjection'
import {
  ROI_VIEWS,
  autoLabelled,
  explodedShifts,
  fitFrame,
  regionGeometry,
  panRoiWindow,
  relaxShifts,
  windowFrame,
  zoomRoiWindow,
} from './roiProjection'
import { rampColor, regionColor, regionSide, sideLabel } from './roiStyle'
import { usePanGesture } from './usePanGesture'
import { useWheelZoom } from './useWheelZoom'

/** One empty set, so the two label modes that draw nothing share an identity. */
const NO_LABELS: ReadonlySet<string> = new Set()

export type RoiColorMode = 'postCompleteness' | 'preCompleteness' | 'region' | 'side' | 'flat'
export type RoiLabelMode = 'auto' | 'all' | 'off'

export interface RoisViewerProps {
  sourceId: string | undefined
  datasetId: string | undefined
  view: RoiView
  explode: number
  colorBy: RoiColorMode
  labels: RoiLabelMode
  hemisphere: 'both' | 'left' | 'right'
  /**
   * The node's `Primary regions only`.
   *
   * Not a filter over what is drawn but a choice of *which list is downloaded* — the published
   * region list nests, so the two are 63 against 230 on hemibrain and 144 against 5,619 on
   * male-CNS. Which is why it reaches the loader rather than the projection: filtering here
   * would spend the larger download to show the smaller picture.
   */
  primaryOnly: boolean
  /** Which region groups to draw. Empty means all of them. */
  superRois: readonly string[]
  opacity: number
  refresh: number
  onParamChange?: (paramId: string, value: string | number | string[]) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

export function RoisViewer(props: RoisViewerProps) {
  const {
    sourceId,
    datasetId,
    view,
    explode,
    colorBy,
    labels,
    hemisphere,
    primaryOnly,
    superRois,
    opacity,
    refresh,
    onParamChange,
    compact = false,
    baseName = 'regions',
    onExpand,
    onError,
  } = props

  const mode = currentMode()
  const [box, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<string | undefined>(undefined)
  const [pinned, setPinned] = useState<string | undefined>(undefined)
  /*
   * Which region set a confirm is standing open for — the setting it was asked about, not a bare
   * "a confirm is open".
   *
   * The question is about a particular download, so it has to expire when the download it names
   * changes: ticking `Primary regions only` back on and off again would otherwise land straight
   * on a confirm that was answered for the previous set. Storing the setting rather than a flag
   * is what makes that expiry fall out of the comparison instead of needing an effect — and it
   * is the boolean itself, rather than a fourth spelling of primary-versus-all.
   *
   * Component state and not the shared entry, because the download is shared and the *question*
   * is not: a press on one card must not put a dialog on another.
   */
  const [confirmingFor, setConfirmingFor] = useState<boolean | undefined>(undefined)

  /*
   * The zoom. `undefined` is the fit — one spelling of "not zoomed", so the ⤢ button's disabled
   * state and the caption cannot disagree about it. The drag itself is `usePanGesture`'s.
   */
  /*
   * Named `viewWindow`: `view` is the anatomical plane, one prop up, and `window` is the global
   * this file calls `getBoundingClientRect` through. `DendrogramViewer` records the second half
   * of that hazard — a shadowed `window` is the kind of bug that surfaces once somebody adds the
   * next line.
   */
  const [viewWindow, setViewWindow] = useState<RoiWindow | undefined>(undefined)

  const outlines = useRoiOutlines(sourceId, datasetId, refresh, primaryOnly)
  const completeness = useRoiCompleteness(sourceId, datasetId)

  const set = outlines.state.status === 'ready' ? outlines.state.set : undefined

  /** Traced fraction per region, by name, from the published table rather than the geometry. */
  const traced = useMemo(() => {
    const byRoi = new Map<string, { pre: number | null; post: number | null }>()
    if (completeness.status !== 'ready') return byRoi
    const table = completeness.table
    const rois = getColumn(table, 'roi')
    const pre = getColumn(table, 'preCompleteness')
    const post = getColumn(table, 'postCompleteness')
    for (let row = 0; row < table.length; row++) {
      byRoi.set(String(rois[row]), {
        pre: typeof pre[row] === 'number' ? (pre[row] as number) : null,
        post: typeof post[row] === 'number' ? (post[row] as number) : null,
      })
    }
    return byRoi
  }, [completeness])

  /** One peek, read by the groups control, the group filter and the confirm's sentence. */
  const info = useMemo(
    () => (sourceId && datasetId ? getSource(sourceId)?.peekDataset(datasetId) : undefined),
    [sourceId, datasetId],
  )

  /*
   * The groups the dataset publishes, in hierarchy order.
   *
   * Read off the *dataset*, not off the regions that happen to have loaded, so the list does not
   * shrink as the picture is filtered — a control whose options disappear when you use it is one
   * nobody can get back to.
   */
  const groups = useMemo(() => {
    const map = info?.roiSuper
    if (!map) return []
    const seen = new Set<string>()
    const names: string[] = []
    for (const group of Object.values(map)) {
      if (seen.has(group)) continue
      seen.add(group)
      names.push(group)
    }
    return names
  }, [info])

  const groupOf = useMemo(() => info?.roiSuper ?? {}, [info])

  /** For the confirm's sentence: what the ticked box would have asked for instead. */
  const primaryCount = regionList(info, true).length

  /*
   * The regions this view actually draws.
   *
   * Filtered before projection is read rather than after, so the frame is fitted to what is on
   * screen: showing one hemisphere and then framing both leaves the picture in a corner.
   */
  const shown = useMemo(() => {
    if (!set) return []
    const wanted = new Set(superRois)
    return set.regions.filter((region) => {
      if (hemisphere !== 'both') {
        const side = regionSide(region.roi)
        // A region with no side in its name is midline and belongs to either half.
        if (side !== undefined && side !== hemisphere) return false
      }
      // Empty means every group, the `chips` idiom — and an ungrouped region is never hidden by
      // a group filter, because no box could ever be ticked to bring it back.
      if (wanted.size === 0) return true
      const group = groupOf[region.roi]
      return group === undefined || wanted.has(group)
    })
  }, [set, hemisphere, superRois, groupOf])

  /*
   * Solved once per (set, view, filter) and scaled by the slider, so dragging the explode costs
   * no solve. It depends on the projection and on nothing the user is currently doing.
   */
  const projected = useMemo(
    () =>
      shown.map((region, index) => ({
        index,
        label: region.roi,
        rings: region.views[view].rings,
        centre: region.views[view].centre,
        depth: region.views[view].depth,
        radius: region.views[view].radius,
      })),
    [shown, view],
  )

  const shifts = useMemo(() => relaxShifts(projected, view), [projected, view])

  /*
   * Painter's order — furthest first, so a near region draws over a far one.
   *
   * Memoised rather than rebuilt in the JSX: the order depends only on the projection, and this
   * component re-renders on every hover, pan step and wheel step. Inline it allocated a wrapper
   * per region and re-sorted the whole list each time.
   */
  const painted = useMemo(() => [...projected].sort((a, b) => b.depth - a.depth), [projected])

  /*
   * The two sweeps over raw ring geometry, hoisted to where the geometry actually changes.
   *
   * Neither depends on the slider or on the window: a shift translates a region, which moves its
   * box and leaves its area alone. Left inline they ran per slider step and per *pointer move*
   * respectively, which is tens of thousands of point visits a frame on a whole published region
   * list. See `regionBounds`.
   */
  const { bounds, areas } = useMemo(() => regionGeometry(projected), [projected])

  /*
   * Where the regions actually are, at this setting of the slider.
   *
   * The frame, the rings, the names and the thinning all read this one array. Each of them
   * scaling `shifts` for itself is what let the frame be fitted to an arrangement nothing was
   * drawing — the whole of the bug this replaced.
   */
  const drawn = useMemo(() => explodedShifts(shifts, explode / 100), [shifts, explode])

  const width = Math.max(1, size.width || 480)
  const height = Math.max(1, size.height || 260)

  /*
   * Two frames, and the split is the whole design.
   *
   * `fitted` is the scene in the box at the slider's current setting — the automatic zoom, which
   * is simply a fit of what is actually drawn. `frame` is that restated at the manual window's
   * magnification and centre, and it is the only one anything draws through, so a zoom reaches
   * the rings, the labels and the SVG export by one route. The two compose: the window is in
   * projection units, so exploding under a manual zoom keeps looking at the same place.
   */
  const fitted = useMemo(
    () => fitFrame(bounds, drawn, width, height, compact ? 6 : 12),
    [bounds, drawn, width, height, compact],
  )
  const frame = useMemo(
    () => windowFrame(fitted, viewWindow, width, height),
    [fitted, viewWindow, width, height],
  )
  /*
   * Derived from the stored window, not from `frame !== fitted`.
   *
   * The two agree — a window is only ever stored above magnification 1 — but the identity form
   * made `windowFrame`'s by-reference return a contract across a module boundary, so any later
   * edit that rebuilt the frame object would silently leave the ⤢ button enabled forever and the
   * caption reading "zoomed 1.0×". The fast path stays; it just stops being load-bearing.
   */
  const zoomed = viewWindow !== undefined

  /*
   * Off the canvas only, the rule `HeatmapViewer` and `DendrogramViewer` both take: on a card a
   * wheel belongs to React Flow, and a viewer that swallowed it would leave the canvas unable to
   * zoom wherever a map happened to be under the pointer.
   */
  const zoomable = !compact && projected.length > 0

  // A new plane is a new coordinate space — x/y against x/z — so a centre carried over from the
  // last one names nothing. A resize does not reset, because the window is in projection units.
  useEffect(() => {
    setViewWindow(undefined)
  }, [view, set])

  const fit = useCallback(() => setViewWindow(undefined), [])

  useWheelZoom(box, zoomable && size.width > 0 && size.height > 0, (factor, x, y) => {
    const next = zoomRoiWindow(fitted, viewWindow, x, y, factor, width, height)
    setViewWindow(next.zoom <= 1 ? undefined : next)
  })

  /*
   * Pan. Everything about the gesture is `usePanGesture`'s — the slop, the capture timing, the
   * `dragged` ref — and what is left here is the one line that is about a map: pixels into a
   * window over the projection. `enabled` is "zoomable *and* zoomed", because at the fit the
   * pointer belongs to the regions, which are what this card is clicked on.
   */
  const { panning, handlers } = usePanGesture(zoomable && zoomed, (dx: number, dy: number) => {
    setViewWindow(panRoiWindow(fitted, viewWindow, dx, dy, width, height))
    // Or the rail flickers through every region the drag crosses.
    setHover(undefined)
  })

  /*
   * Presynaptic reads red, postsynaptic blue.
   *
   * The two are the same picture over different numbers, so with one hue a glance cannot say
   * which measure it is looking at — and on hemibrain they differ by more than fifty points,
   * which is exactly the sort of gap somebody could take from the wrong one. The ramp's label
   * says it too; this is the half that does not need reading.
   */
  const rampHue: SequentialHue = colorBy === 'preCompleteness' ? 'red' : 'blue'

  const colorOf = useCallback(
    (region: RoiOutlineRegion): string => {
      if (colorBy === 'flat') return chartInk(mode)
      if (colorBy === 'region') return regionColor(region.roi, mode)
      if (colorBy === 'side') {
        const side = regionSide(region.roi)
        return seriesColor(side === 'left' ? 0 : side === 'right' ? 1 : 2, mode)
      }
      const value = traced.get(region.roi)
      const fraction = colorBy === 'preCompleteness' ? value?.pre : value?.post
      // Null is not zero: a region nothing was recorded for must not paint as fully untraced.
      if (fraction === null || fraction === undefined) return chartInk(mode)
      return rampColor(fraction, mode, rampHue)
    },
    [colorBy, traced, mode, rampHue],
  )

  // The click a pan ends with is `usePanGesture`'s to swallow, in the capture phase above this,
  // so pinning does not have to know a drag happened.
  /*
   * The two things a hover must not rebuild.
   *
   * This component re-renders on every pointer enter and leave, on every pan step and on every
   * wheel step — and in the JSX both of these came out byte-identical each time. `ringPath` is
   * two `toFixed` calls and a concat *per vertex*, which is tens of thousands of transient
   * strings at 63 regions and a great deal more on a whole published list; `colorOf` under
   * `region` is a regex, a per-character hash and an HSL conversion per region.
   *
   * Split rather than one memo, because they answer to different things: a colour depends on
   * neither the frame nor the explode, so it survives a pan and a zoom as well as a hover.
   */
  const colours = useMemo(() => shown.map((region) => colorOf(region)), [shown, colorOf])

  const paths = useMemo(
    () =>
      painted.map((region) =>
        region.rings.map((ring) =>
          ringPath(ring, frame, drawn[region.index * 2] ?? 0, drawn[region.index * 2 + 1] ?? 0),
        ),
      ),
    [painted, frame, drawn],
  )

  const toggle = useCallback(
    (label: string) => setPinned((current) => (current === label ? undefined : label)),
    [],
  )

  const active = pinned ?? hover

  /** The rail's subject, by name. A `find` here is a linear scan on every pointer move. */
  const byRoi = useMemo(() => new Map(shown.map((region) => [region.roi, region])), [shown])

  /*
   * Auto labels: the largest by drawn area, capped, and only the ones on screen.
   *
   * The rule is `autoLabelled`'s, headless — jsdom performs no layout, so anything about which
   * names fit that stays in this component is covered by nothing. `all` is still all: a name
   * outside the box simply does not render, and thinning a list the user asked for in full would
   * be answering a different question.
   */
  const everyLabel = useMemo(
    () => new Set(projected.map((region) => region.label)),
    [projected],
  )

  /*
   * Two of the three answers do not read the window at all, so they are memoised apart from it.
   * Inside one memo keyed on `frame` they were recomputed on every pointer move of a pan — an
   * n-entry `Set` per frame under `labels: 'all'`, for a value that cannot have changed.
   */
  const ranked = useMemo(
    () =>
      new Set(
        autoLabelled(projected, areas, drawn, frame, width, height).map(
          (index) => projected[index]!.label,
        ),
      ),
    [projected, areas, drawn, frame, width, height],
  )

  const labelled =
    labels === 'off' || compact ? NO_LABELS : labels === 'all' ? everyLabel : ranked

  const thinned = labels === 'auto' && !compact && labelled.size < projected.length

  /*
   * A key for the sequential modes, and only for those.
   *
   * `region` gets none by design — 63 to 152 hues that mean "not that one" have nothing to list —
   * and `side` and `flat` are self-evident from three colours and one. A ramp without its ends
   * labelled is decoration; these are the numbers the fill is standing for.
   */
  const rampStops = useMemo(
    () => Array.from({ length: 7 }, (_, i) => sequentialColor(i / 6, mode, rampHue)),
    [mode, rampHue],
  )
  const showRamp = colorBy === 'postCompleteness' || colorBy === 'preCompleteness'

  const exportSource: ExportSource = useMemo(
    () => ({
      svg: () => box.current?.querySelector('svg') ?? null,
      csv: () => outlineCsv(set),
    }),
    [box, set],
  )

  // --- states before there is anything to draw -----------------------------

  if (outlines.state.status === 'none') {
    return (
      <div className="viewer rois">
        <p className="tile__pending">
          {datasetId ? 'This source publishes no region meshes.' : 'Connect a Dataset.'}
        </p>
      </div>
    )
  }

  if (outlines.state.status === 'idle') {
    const regions = outlines.state.regions

    /*
     * A second press for a set the first one's sentence does not describe.
     *
     * `Load 144 regions` and `Load 5,619 regions` are the same button, and the wait behind them
     * is not the same wait: it is one request per region at a concurrency of four, so the second
     * is well over a thousand sequential rounds against a shared production server. The threshold
     * clears every primary set and hemibrain's whole published list, so unticking the box on a
     * dataset whose list barely nests still costs one press. See `ROI_CONFIRM_REGIONS`.
     *
     * Held against the *scope* rather than as a bare boolean, so ticking the box back and forth
     * cannot leave a confirm standing for a set nobody is looking at any more.
     */
    if (regions > ROI_CONFIRM_REGIONS && confirmingFor === primaryOnly) {
      // Both numbers, because "5,619 against 144" is what makes somebody press Cancel — and no
      // clause at all where the source never said which of its regions tile the volume.
      const tileClause =
        primaryCount > 0 ? ` — ${formatNumber(primaryCount)} of them tile the volume` : ''
      return (
        <div className="viewer rois rois--empty">
          <p className="rois__note">
            <strong>{formatNumber(regions)} regions.</strong> That is the whole published list,
            sub-regions included{tileClause}. One request per region, so this is a far longer
            download than the primary set&rsquo;s, and nothing is stored until it finishes.
          </p>
          <div className="rois__confirm">
            <button
              className="rois__load"
              type="button"
              onClick={() => {
                setConfirmingFor(undefined)
                outlines.load()
              }}
            >
              Download anyway
            </button>
            <button
              className="rois__load"
              type="button"
              onClick={() => setConfirmingFor(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="viewer rois rois--empty">
        <button
          className="rois__load"
          type="button"
          onClick={() => {
            if (regions > ROI_CONFIRM_REGIONS) setConfirmingFor(primaryOnly)
            else outlines.load()
          }}
          disabled={regions === 0}
        >
          {regions === 0 ? 'No regions listed yet' : `Load ${formatNumber(regions)} regions`}
        </button>
        <p className="rois__note">
          Region meshes are large — typically tens of megabytes for a dataset. Downloaded once,
          then kept as outlines, so this is asked only the first time.
        </p>
      </div>
    )
  }

  if (outlines.state.status === 'loading') {
    const pct = Math.round(outlines.state.progress * 100)
    return (
      <div className="viewer rois rois--empty">
        <p className="rois__note">
          Downloading region meshes… {pct}%
          {outlines.state.note ? ` · ${outlines.state.note}` : ''}
        </p>
        <div className="rois__progress">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  }

  if (outlines.state.status === 'error') {
    return (
      <div className="viewer rois rois--empty">
        <p className="rois__note">{outlines.state.message}</p>
        <button className="rois__load" type="button" onClick={outlines.reload}>
          Try again
        </button>
      </div>
    )
  }

  // --- the map -------------------------------------------------------------

  return (
    <div className="viewer rois">
      <div
        className="rois__map"
        ref={box}
        style={{
          cursor: panning ? 'grabbing' : zoomed ? 'grab' : 'default',
          ...(zoomable ? { touchAction: 'none' as const } : {}),
          /*
           * A pan drags across region names, and the browser's default for that is to *select*
           * them — `DendrogramViewer` found the same thing in Chrome, and this viewer's labels
           * are SVG text for the same reasons its are. Only while a pan is live, so a name stays
           * selectable and readable-aloud the rest of the time.
           */
          ...(panning ? { userSelect: 'none' as const } : {}),
        }}
        {...(zoomable
          ? {
              ...handlers,
              onDoubleClick: (event: React.MouseEvent) => {
                // Stopped, or the canvas underneath takes it as a zoom-to-fit of its own.
                event.stopPropagation()
                fit()
              },
            }
          : {})}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Regions of ${datasetId ?? 'the dataset'}, ${view} view`}
        >
          {/* Painter's order: furthest first, so a near region draws over a far one. */}
          {painted.map((region, at) => {
            const colour = colours[region.index]!
            const isActive = active === region.label
            const dim = active !== undefined && !isActive
            return (
              <g
                key={region.label}
                className="roi"
                opacity={dim ? 0.35 : 1}
                /*
                 * Named and focusable, so a region is reachable without a pointer — the fill
                 * is the only thing identifying it otherwise, and colour is never the sole
                 * channel here. It also gives the label something to pass its clicks to:
                 * `.roi__label` is `pointer-events: none` so a name never blocks the shape
                 * under it.
                 */
                role="button"
                tabIndex={0}
                aria-label={region.label}
                aria-pressed={pinned === region.label}
                onPointerEnter={() => setHover(region.label)}
                onPointerLeave={() => setHover(undefined)}
                onFocus={() => setHover(region.label)}
                onBlur={() => setHover(undefined)}
                onClick={() => toggle(region.label)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  toggle(region.label)
                }}
              >
                {paths[at]!.map((d, ringIndex) => (
                  <path
                    key={ringIndex}
                    d={d}
                    fill={colour}
                    fillOpacity={isActive ? Math.min(0.5, opacity * 2.2) : opacity}
                    stroke={colour}
                    strokeWidth={isActive ? 2.2 : 1.1}
                    strokeLinejoin="round"
                  />
                ))}
              </g>
            )
          })}
          {/*
           * `region.index` rather than `projected.indexOf(region)`, which is what this was: the
           * position is on the object by construction (`projected` is a `map` over `shown`), and
           * the scan was O(labels x regions) inside a render that now happens on every pan step —
           * a true O(n²) under `labels: 'all'`, where every region is labelled.
           */}
          {projected
            .filter((region) => labelled.has(region.label) || active === region.label)
            .map((region) => {
              const dx = drawn[region.index * 2] ?? 0
              const dy = drawn[region.index * 2 + 1] ?? 0
              return (
                <text
                  key={`${region.label}-label`}
                  className="roi__label"
                  x={(region.centre[0] + dx) * frame.scale + frame.offsetX}
                  y={(region.centre[1] + dy) * frame.scale + frame.offsetY}
                >
                  {region.label}
                </text>
              )
            })}
        </svg>
        {showRamp && (
          <div className="rois__legend">
            <span className="rois__legend-title">
              {colorBy === 'preCompleteness' ? 'presynaptic' : 'postsynaptic'} traced
            </span>
            <span className="colorbar">
              0%
              <span
                className="colorbar__ramp"
                style={{ background: `linear-gradient(to right, ${rampStops.join(', ')})` }}
              />
              100%
            </span>
          </div>
        )}
        {zoomable && (
          /*
           * Bottom right, `HeatmapViewer`'s placement and for this card the same reason it has:
           * the top-right corner is where `.rois__legend` draws the completeness ramp.
           */
          <div className="network-strip network-strip--bottom nodrag">
            <button
              type="button"
              className="network-strip__btn"
              title="Show the whole brain (or double-click). Scroll to zoom, drag to pan."
              aria-label="Fit to view"
              disabled={!zoomed}
              onClick={fit}
            >
              ⤢
            </button>
          </div>
        )}
        {!compact && (
          <ViewerActions
            baseName={baseName}
            source={exportSource}
            {...(onExpand ? { onExpand } : {})}
            {...(onError ? { onError } : {})}
          />
        )}
      </div>

      {!compact && (
        <aside className="rois__rail">
          <RegionRail
            set={set!}
            region={active === undefined ? undefined : byRoi.get(active)}
            traced={traced}
            completenessKnown={completeness.status === 'ready'}
            mode={mode}
          />
        </aside>
      )}

      <div className="rois__ctl">
        <div className="seg" role="group" aria-label="View">
          {ROI_VIEWS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => onParamChange?.('view', option)}
            >
              {option[0]!.toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
        <label className="rois__slider">
          Explode
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={explode}
            aria-label="Explode"
            onChange={(event) => onParamChange?.('explode', Number(event.target.value))}
          />
        </label>
        <label className="rois__slider">
          Colour
          <select
            aria-label="Colour"
            value={colorBy}
            onChange={(event) => onParamChange?.('colorBy', event.target.value)}
          >
            <option value="postCompleteness">Completeness (post)</option>
            <option value="preCompleteness">Completeness (pre)</option>
            <option value="region">Region</option>
            <option value="side">Side</option>
            <option value="flat">Flat</option>
          </select>
        </label>
        {groups.length > 0 && (
          <details className="rois__groups">
            <summary>
              Groups
              {superRois.length > 0 && <span className="rois__count">{superRois.length}</span>}
            </summary>
            <div className="rois__menu">
              {groups.map((group) => {
                const on = superRois.length === 0 || superRois.includes(group)
                return (
                  <label key={group}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        /*
                         * Empty means *all*, so the first untick has to expand it to the full
                         * list minus one rather than start from nothing — otherwise unticking
                         * one group would hide every other, which reads as the control being
                         * inverted. And unticking back down to nothing returns to empty, so
                         * "everything" has one stored form rather than two.
                         */
                        const current = superRois.length === 0 ? groups : superRois
                        const next = on
                          ? current.filter((name) => name !== group)
                          : [...current, group]
                        onParamChange?.('superRois', next.length === groups.length ? [] : next)
                      }}
                    />
                    {group}
                  </label>
                )
              })}
            </div>
          </details>
        )}
        <span className="rois__spacer" />
        <div className="seg" role="group" aria-label="Labels">
          {(['auto', 'all', 'off'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={labels === option}
              onClick={() => onParamChange?.('labels', option)}
            >
              {option[0]!.toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="rois__cap">
        <span>
          {projected.length} of {(set?.regions.length ?? 0) + (set?.missing.length ?? 0)}{' '}
          regions
        </span>
        <span className="sep">·</span>
        <span>{view}</span>
        {set && set.missing.length > 0 && (
          <>
            <span className="sep">·</span>
            <span className="warn">{set.missing.length} publish no mesh</span>
          </>
        )}
        {explode > 0 && (
          <>
            <span className="sep">·</span>
            <span className="warn">exploded {explode}%</span>
          </>
        )}
        {zoomed && (
          <>
            <span className="sep">·</span>
            {/* Said out loud, on the caption's own terms: the picture is of part of a brain. */}
            <span className="warn">zoomed {(viewWindow?.zoom ?? 1).toFixed(1)}×</span>
          </>
        )}
        {thinned && (
          <>
            <span className="sep">·</span>
            <span className="warn">labels thinned</span>
          </>
        )}
        {colorBy !== 'flat' && colorBy !== 'side' && completeness.status !== 'ready' && (
          <>
            <span className="sep">·</span>
            <span className="warn">completeness not loaded</span>
          </>
        )}
      </div>
    </div>
  )
}

/** The rail: dataset facts with nothing picked, one region's when something is. */
function RegionRail({
  set,
  region,
  traced,
  completenessKnown,
  mode,
}: {
  set: RoiOutlineSet
  region: RoiOutlineRegion | undefined
  traced: Map<string, { pre: number | null; post: number | null }>
  completenessKnown: boolean
  mode: Mode
}) {
  if (!region) {
    return (
      <>
        <Tile label="Regions">
          <Facts
            rows={[
              ['drawn', formatNumber(set.regions.length)],
              ['no mesh', set.missing.length > 0 ? formatNumber(set.missing.length) : null],
              ['downloaded', set.bytes > 0 ? `${(set.bytes / 1e6).toFixed(1)} MB` : null],
            ]}
          />
        </Tile>
        <Tile label="Reading this">
          <p className="tile__pending">Hover a region for its figures. Click to pin it.</p>
        </Tile>
      </>
    )
  }

  const fractions = traced.get(region.roi)
  return (
    <>
      <Tile label="Region">
        <h4 className="rois__name">{region.roi}</h4>
        <Facts
          rows={[
            ['side', sideLabel(region.roi)],
            ['primary', region.primary ? 'yes' : 'no'],
          ]}
        />
      </Tile>

      <Tile label="Completeness" qualifier="traced">
        <Loadable state={completenessKnown ? 'ready' : 'loading'} empty={!fractions}>
          <Facts
            rows={[
              ['presynaptic', share(fractions?.pre)],
              ['postsynaptic', share(fractions?.post)],
            ]}
          />
        </Loadable>
      </Tile>

      {/*
       * Marked approximate, and the qualifier is not decoration. neuPrint publishes these
       * meshes "for visualization only… not suitable for quantitative analysis", and Coda
       * decimates them further before measuring — so this is an estimate off a display surface.
       * It is carried because nothing else in the app can say anything about a region's size.
       */}
      <Tile label="Size" qualifier="≈ from display mesh">
        <Facts
          rows={[
            ['volume', `${formatCompact(region.volume / 1e9)} µm³`],
            ['surface', `${formatCompact(region.surfaceArea / 1e6)} µm²`],
          ]}
        />
      </Tile>
      <span hidden>{mode}</span>
    </>
  )
}

function share(fraction: number | null | undefined): string | null {
  if (fraction === null || fraction === undefined) return null
  return `${(fraction * 100).toFixed(0)}%`
}

/** A closed path from x,y interleaved points, transformed into the frame. */
function ringPath(
  ring: Float32Array,
  frame: { scale: number; offsetX: number; offsetY: number },
  dx: number,
  dy: number,
): string {
  if (ring.length < 6) return ''
  let d = ''
  for (let i = 0; i < ring.length; i += 2) {
    const x = (ring[i]! + dx) * frame.scale + frame.offsetX
    const y = (ring[i + 1]! + dy) * frame.scale + frame.offsetY
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
  }
  return `${d}Z`
}

/**
 * The achromatic ink, for a region with nothing to say.
 *
 * `muted` rather than `grid`: this is carrying data — "no completeness recorded here" — and
 * `grid` is 1.27:1 against the dark surface, i.e. invisible by design and reserved for chrome.
 */
function chartInk(mode: Mode): string {
  return CHART_INK[mode].muted
}

/**
 * What the CSV export writes: one row per region, the facts rather than the geometry.
 *
 * Chunked as parts because that is the contract — `ui/export.ts` builds a Blob out of them
 * rather than one string, so a large table never allocates itself twice.
 */
function outlineCsv(set: RoiOutlineSet | undefined): string[] {
  const parts = ['roi,primary,volume_nm3,surface_nm2\n']
  if (!set) return parts
  for (const region of set.regions) {
    parts.push(
      `${JSON.stringify(region.roi)},${region.primary},${region.volume},${region.surfaceArea}\n`,
    )
  }
  return parts
}
