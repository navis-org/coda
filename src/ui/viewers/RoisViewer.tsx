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

import { useCallback, useMemo, useState } from 'react'

import { getColumn } from '../../core/values'
import { getSource } from '../../data/source'
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
import type { RoiView } from './roiProjection'
import { ROI_VIEWS, fitFrame, relaxShifts } from './roiProjection'
import { rampColor, regionColor, regionSide, sideLabel } from './roiStyle'

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

/** How many region names the automatic mode will draw before it starts thinning. */
const MAX_AUTO_LABELS = 18

/** Below this share of the frame a region is too small to carry its own name legibly. */
const MIN_LABEL_AREA = 0.004

export function RoisViewer(props: RoisViewerProps) {
  const {
    sourceId,
    datasetId,
    view,
    explode,
    colorBy,
    labels,
    hemisphere,
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

  const outlines = useRoiOutlines(sourceId, datasetId, refresh)
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

  /*
   * The groups the dataset publishes, in hierarchy order.
   *
   * Read off the *dataset*, not off the regions that happen to have loaded, so the list does not
   * shrink as the picture is filtered — a control whose options disappear when you use it is one
   * nobody can get back to.
   */
  const groups = useMemo(() => {
    const map =
      sourceId && datasetId ? getSource(sourceId)?.peekDataset(datasetId)?.roiSuper : undefined
    if (!map) return []
    const seen = new Set<string>()
    const names: string[] = []
    for (const group of Object.values(map)) {
      if (seen.has(group)) continue
      seen.add(group)
      names.push(group)
    }
    return names
  }, [sourceId, datasetId])

  const groupOf = useMemo(() => {
    const map =
      sourceId && datasetId ? getSource(sourceId)?.peekDataset(datasetId)?.roiSuper : undefined
    return map ?? {}
  }, [sourceId, datasetId])

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

  const width = Math.max(1, size.width || 480)
  const height = Math.max(1, size.height || 260)
  const frame = useMemo(
    () => fitFrame(projected, shifts, width, height, compact ? 6 : 12),
    [projected, shifts, width, height, compact],
  )

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

  const toggle = useCallback(
    (label: string) => setPinned((current) => (current === label ? undefined : label)),
    [],
  )

  const active = pinned ?? hover

  /* Auto labels: the largest by drawn area, capped, so the picture stays readable. */
  const labelled = useMemo(() => {
    if (labels === 'off') return new Set<string>()
    const areas = projected.map((region) => ({
      label: region.label,
      area: region.rings.reduce((sum, ring) => sum + ringArea(ring), 0),
    }))
    if (labels === 'all') return new Set(areas.map((a) => a.label))
    const total = areas.reduce((sum, a) => sum + a.area, 0) || 1
    return new Set(
      areas
        .filter((a) => a.area / total >= MIN_LABEL_AREA)
        .sort((a, b) => b.area - a.area)
        .slice(0, compact ? 0 : MAX_AUTO_LABELS)
        .map((a) => a.label),
    )
  }, [projected, labels, compact])

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
    return (
      <div className="viewer rois rois--empty">
        <button
          className="rois__load"
          type="button"
          onClick={outlines.load}
          disabled={regions === 0}
        >
          {regions === 0 ? 'No regions listed yet' : `Load ${regions} regions`}
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
      <div className="rois__map" ref={box}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Regions of ${datasetId ?? 'the dataset'}, ${view} view`}
        >
          {/* Painter's order: furthest first, so a near region draws over a far one. */}
          {projected
            .map((region, index) => ({ region, index }))
            .sort((a, b) => b.region.depth - a.region.depth)
            .map(({ region, index }) => {
              const source = shown[index]!
              const colour = colorOf(source)
              const isActive = active === region.label
              const dx = (shifts[index * 2] ?? 0) * (explode / 100)
              const dy = (shifts[index * 2 + 1] ?? 0) * (explode / 100)
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
                  {region.rings.map((ring, ringIndex) => (
                    <path
                      key={ringIndex}
                      d={ringPath(ring, frame, dx, dy)}
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
          {projected
            .filter((region) => labelled.has(region.label) || active === region.label)
            .map((region, index) => {
              const at = projected.indexOf(region)
              const dx = (shifts[at * 2] ?? 0) * (explode / 100)
              const dy = (shifts[at * 2 + 1] ?? 0) * (explode / 100)
              return (
                <text
                  key={`${region.label}-label-${index}`}
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
            region={shown.find((r) => r.roi === active)}
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

/** Shoelace, for ranking which regions are big enough to carry a label. */
function ringArea(ring: Float32Array): number {
  let sum = 0
  const points = ring.length / 2
  for (let i = 0; i < points; i++) {
    const j = (i + 1) % points
    sum += ring[i * 2]! * ring[j * 2 + 1]! - ring[j * 2]! * ring[i * 2 + 1]!
  }
  return Math.abs(sum) / 2
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
