/**
 * The Cortex gallery's card: the filters, and the wall — each sampled cell drawn at its depth with
 * the layers behind it, a stripe in its group's colour above it, and a click to select it.
 *
 * Three modes, one layout (`layoutWall`): line-up runs every group on, rows gives each group rows
 * of its own under its name, compare sets two groups side by side on one depth scale. On the canvas
 * the card is a short strip of the wall; opened full size, the whole of it. Everything here is a
 * `presentational` param (`packs/cortex/gallery.ts`) — browsing re-runs nothing — except picking,
 * which writes `selection`, what the outputs carry.
 */

import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'

import type { NeuronId } from '../../core/ids'
import { ID_COLUMN_NAME, idText } from '../../core/ids'
import { visibleParams } from '../../core/node'
import { getNodeDef } from '../../core/registry'
import type { TableValue } from '../../core/values'
import {
  DEPTH_COLUMN,
  LAYER_COLUMN,
  compareGroups,
  groupLabel,
  proofreadingMissing,
  readColumnWidths,
  wallGroups,
} from '../../packs/cortex/cells'
import type { ColumnWidths, Proofread, WallGroup, WallOrder } from '../../packs/cortex/cells'
import type { CorticalFrame } from '../../packs/cortex/frames'
import type { Mode } from '../colors'
import { axonDendriteInk } from '../compartmentInk'
import type { ResolvedColor } from '../encoding'
import { resolveColor } from '../encoding'
import { formatNumber, plural } from '../format'
import type { NodeBodyProps } from '../nodes/nodeBodies'
import { ParamField, SelectField } from '../params/ParamField'
import { useDatasetInput } from '../useDatasetInput'
import { useThemeMode } from '../useThemeMode'
import { prepareCanvas } from '../viewers/canvas2d'
import { ClearSelection, ColorKey } from '../viewers/LegendKeys'
import { ViewerActions } from '../viewers/ViewerActions'
import { useCanvasScale } from '../viewers/canvasScale'
import { exportBaseName } from '../export'
import { useGraphStore } from '../../store/graphStore'
import { useElementSize } from '../viewers/useElementSize'
import type { CellGeometry, RowScale, WallMode, WallSection } from './wall'
import {
  cellGeometry,
  columnWidths,
  drawBands,
  drawCell,
  layoutWall,
  rowMetrics,
  rowScale,
  wallColumns,
} from './wall'
import type { WallSkeletons } from './useGallery'
import { useGalleryCells, useWallSkeletons } from './useGallery'
import type { LegendGroup, WallFigure } from './wallSvg'
import { wallToSvg } from './wallSvg'

/** Row height: a short strip on the card; full size, the `height` param's choice. */
const ROW_HEIGHT = { compact: 130, short: 190, medium: 300, tall: 440 } as const
/** The ruler at the start of each row, where the layers are named. */
const RULER = 34
const GAP = 2
/** Between compare mode's two halves. */
const COLUMN_GAP = 16

type Height = 'short' | 'medium' | 'tall'

interface WallCell {
  id: NeuronId
  /** One colour per stripe: the group's, then the second stripe's where there is one. */
  colors: string[]
  title: string
}

export function GalleryBody({ node, ctx, inputValues, compact, setParam }: NodeBodyProps) {
  const mode = useThemeMode()
  const dataset = useDatasetInput(ctx, inputValues)
  const state = useGalleryCells(dataset, String(ctx.params.cellTypes))
  const cells = state.status === 'ready' ? state.cells : undefined
  const frame = state.status === 'ready' ? state.frame : undefined

  // Off `ctx.params`, which carries the declared defaults — never a second copy of them here.
  const wallMode = ctx.params.mode as WallMode
  const types = ctx.params.types as string[]
  const proofread = ctx.params.proofread as Proofread
  const perType = Number(ctx.params.perType)
  const seed = Number(ctx.params.seed)
  const order = ctx.params.order as WallOrder
  const height = compact ? ROW_HEIGHT.compact : ROW_HEIGHT[ctx.params.height as Height]
  const compareA = String(ctx.params.compareA)
  const compareB = String(ctx.params.compareB)
  const selection = ctx.params.selection as string[]
  const picked = useMemo(() => new Set(selection), [selection])
  // Resolved through the context (invariant 5); an unresolved picker groups or stripes nothing.
  const groupBy = ctx.column('groupBy') ?? ''
  const stripeBy = ctx.column('stripe')

  // Compare mode draws two groups whatever the chips say, so it asks for every group. Keyed on
  // whether it is comparing, not on the mode: line-up and rows draw the same groups.
  const comparing = wallMode === 'compare'
  const groups = useMemo(
    () =>
      cells && frame
        ? wallGroups(cells, frame, {
            groupBy,
            types: comparing ? [] : types,
            proofread,
            perType,
            seed,
            order,
          })
        : [],
    [cells, frame, groupBy, types, proofread, perType, seed, order, comparing],
  )
  const compared = useMemo(
    () => (comparing ? compareGroups(groups, compareA, compareB) : undefined),
    [comparing, groups, compareA, compareB],
  )
  const drawn = compared ?? groups
  const graphName = useGraphStore((s) => s.graph.meta?.name)
  // The wall's SVG, built on demand from what it last laid out — see `Wall`'s `exportRef`.
  const exportRef = useRef<WallExport | null>(null)
  // Column widths, read once (`readColumnWidths`, which `validate` also reads); kept stable by what
  // they are rather than by the params object, which is new every render.
  const readWidths = readColumnWidths(ctx.params).widths
  const evenUm = readWidths.mode === 'even' ? readWidths.um : undefined
  const columnSpec = useMemo<ColumnWidths>(
    () =>
      readWidths.mode === 'even'
        ? { mode: 'even', ...(evenUm !== undefined ? { um: evenUm } : {}) }
        : { mode: 'fit' },
    [readWidths.mode, evenUm],
  )

  /*
   * Colours by `resolveColor`'s categorical rule — the one every Scatter, Network and 3D view
   * applies to the same column — over the **whole** table, so a filter never recolours what stays.
   */
  const colors = useStripeColors(cells, groupBy, mode)
  const colors2 = useStripeColors(cells, stripeBy, mode)
  const chips = useMemo(() => {
    const column = cells?.data[groupBy] ?? []
    const found = new Map<string, { count: number; color: string }>()
    for (let row = 0; row < column.length; row++) {
      const label = groupLabel(column[row])
      const entry = found.get(label)
      if (entry) entry.count++
      else found.set(label, { count: 1, color: colors?.at(row) ?? '' })
    }
    return [...found].sort((a, b) => a[0].localeCompare(b[0]))
  }, [cells, groupBy, colors])

  // The cells drawn, in order, and the section each group's cells form.
  const { shown, sections } = useMemo(() => {
    const out: WallCell[] = []
    const sections: WallSection[] = []
    if (!cells) return { shown: out, sections }
    const ids = cells.data[ID_COLUMN_NAME] ?? []
    const depth = cells.data[DEPTH_COLUMN] ?? []
    const layer = cells.data[LAYER_COLUMN] ?? []
    for (const group of drawn) {
      const members: number[] = []
      for (const row of group.rows) {
        const d = depth[row]
        const facts = [
          group.type,
          ...(typeof d === 'number' ? [`${Math.round(d)} µm`] : []),
          ...(layer[row] ? [String(layer[row])] : []),
          ...(stripeBy ? [`${stripeBy} ${groupLabel(cells.data[stripeBy]?.[row])}`] : []),
        ]
        const id = idText(ids[row]) ?? ''
        members.push(out.length)
        out.push({
          id,
          colors: [colors?.at(row) ?? '', ...(colors2 ? [colors2.at(row)] : [])],
          title: `${id}\n${facts.join(' · ')}`,
        })
      }
      sections.push({ members, label: `${group.type} · ${formatNumber(group.total)}` })
    }
    return { shown: out, sections }
  }, [cells, drawn, colors, colors2, stripeBy])
  const columns = useMemo(() => wallColumns(wallMode, sections), [wallMode, sections])
  const wanted = useMemo(() => shown.map((cell) => cell.id), [shown])
  const skeletons = useWallSkeletons(dataset, wanted)

  const toggleType = useCallback(
    (label: string) =>
      setParam(
        'types',
        types.includes(label) ? types.filter((t) => t !== label) : [...types, label],
      ),
    [types, setParam],
  )
  const togglePick = useCallback(
    (id: NeuronId) =>
      setParam(
        'selection',
        picked.has(id) ? selection.filter((s) => s !== id) : [...selection, id],
      ),
    [picked, selection, setParam],
  )

  if (state.status === 'none') {
    return <p className="gallery__note">Connect a Dataset to see its cells.</p>
  }
  if (state.status === 'noFrame') {
    return (
      <p className="gallery__note">
        No cortical frame is declared for this dataset, so there is no depth to draw a cell at.
      </p>
    )
  }
  if (state.status === 'error') {
    return <p className="gallery__note gallery__note--error">{state.message}</p>
  }
  if (state.status === 'loading') {
    return (
      <p className="gallery__note">
        {dataset.awaitingRun
          ? 'Run the dataset’s annotation chain to load its cell types.'
          : `Loading ${state.note ?? 'cells'}…`}
      </p>
    )
  }

  const total = drawn.reduce((sum, group) => sum + group.total, 0)
  const unapplied = proofreadingMissing(state.cells, state.frame, proofread)
  const groupOptions = groups.map((g) => ({ value: g.type, label: g.type }))
  /*
   * The node's own params, drawn by `ParamField` as every other card body draws them, so a label,
   * an option list or a bound is declared once, in `gallery.ts`. Order stands down in compare by
   * its `visibleIf`; height is a full-size control, the card's strip having one height.
   */
  const def = getNodeDef(node.type)
  const visible = def ? visibleParams(def, node.params) : []
  const field = (id: string, control?: (label: string) => ReactNode) => {
    const param = visible.find((p) => p.id === id)
    if (!param) return null
    return (
      <label key={id} className="gallery__control">
        {param.label}
        {control?.(param.label) ?? (
          <ParamField
            param={param}
            value={node.params[id]}
            ctx={ctx}
            onChange={(value) => setParam(id, value)}
          />
        )}
      </label>
    )
  }
  return (
    <div className="gallery nodrag nowheel">
      <div className="gallery__controls">
        {field('cellTypes')}
        {field('groupBy')}
        {field('mode')}
        {/* Their options are the table's groups, which an enum param cannot reach. */}
        {(['compareA', 'compareB'] as const).map((id, side) =>
          field(id, (label) => (
            <SelectField
              label={label}
              value={compared?.[side]?.type ?? ''}
              options={groupOptions}
              onChange={(v) => setParam(id, v)}
            />
          )),
        )}
        {field('proofread')}
        {field('stripe')}
        {field('order')}
        {field('columnMode')}
        {field('columnUm')}
        {!compact && field('height')}
        {field('perType')}
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setParam('seed', seed + 1)}
        >
          Shuffle
        </button>
        <span className="gallery__count">
          {formatNumber(shown.length)} of {plural(total, 'cell')}
          {/* The picks are the outputs, so clearing them is an edit — one undo step back. */}
          {picked.size > 0 && ' · '}
          <ClearSelection
            label={picked.size > 0 ? `${formatNumber(picked.size)} selected` : ''}
            onClear={() => setParam('selection', [])}
          />
        </span>
        <ViewerActions
          baseName={exportBaseName(graphName, node.title ?? def?.label ?? 'cortex-gallery')}
          source={{
            svg: () =>
              exportRef.current?.({
                title: `${node.title ?? def?.label ?? 'Cortex Gallery'} — ${dataset.datasetId ?? ''}`,
                legend: figureLegend(mode, groupBy, drawn, colors, stripeBy, colors2),
                ...(anyCycled(colors, colors2) ? { note: 'colours repeat' } : {}),
              }) ?? null,
          }}
          compact
        />
      </div>
      {wallMode !== 'compare' && (
        <div className="gallery__types" role="group" aria-label="Groups">
          {chips.map(([label, { count, color }]) => (
            <button
              key={label}
              type="button"
              className="chip-filter"
              aria-pressed={types.length === 0 || types.includes(label)}
              onClick={() => toggleType(label)}
            >
              <span className="legend__swatch" style={{ background: color }} />
              {label}
              <span className="chip-filter__count">{formatNumber(count)}</span>
            </button>
          ))}
        </div>
      )}
      <Legend
        mode={mode}
        cycled={anyCycled(colors, colors2)}
        colors2={colors2}
        stripeBy={stripeBy}
      />
      {unapplied && <p className="gallery__note">{unapplied}</p>}
      {skeletons.error && (
        <p className="gallery__note gallery__note--error">
          Some cells could not be drawn: {skeletons.error}
        </p>
      )}
      <Wall
        frame={state.frame}
        cells={shown}
        columns={columns}
        labelled={wallMode !== 'lineup'}
        skeletons={skeletons.held}
        version={skeletons.version}
        picked={picked}
        onPick={togglePick}
        height={height}
        mode={mode}
        exportRef={exportRef}
        columnSpec={columnSpec}
      />
    </div>
  )
}

/** The axon and dendrite key, the one both legends open with — on screen and in a figure. */
function inkEntries(mode: Mode): { label: string; color: string }[] {
  const { axon, dendrite } = axonDendriteInk(mode)
  return [
    { label: 'dendrite', color: dendrite },
    { label: 'axon', color: axon },
  ]
}

/** The wall's SVG, given what the figure says about itself — built only on export. */
type WallExport = (figure: WallFigure) => SVGSVGElement | null

/** Whether either stripe's colours come round again — said in the legend, on screen and in a figure. */
function anyCycled(...colors: (ResolvedColor | undefined)[]): boolean {
  return colors.some((c) => c?.legend?.kind === 'categorical' && c.legend.cycled === true)
}

/**
 * The exported figure's legend: axon and dendrite, then the groups drawn under the grouping
 * column's name — the chips' job on screen, which a figure has no chips for — then the second
 * stripe's key, with what it had no room for.
 */
function figureLegend(
  mode: Mode,
  groupBy: string,
  drawn: readonly WallGroup[],
  colors: ResolvedColor | undefined,
  stripeBy: string | undefined,
  colors2: ResolvedColor | undefined,
): LegendGroup[] {
  const groups: LegendGroup[] = [{ entries: inkEntries(mode) }]
  if (groupBy && colors) {
    groups.push({
      title: groupBy,
      entries: drawn.map((group) => ({
        label: group.type,
        color: group.rows[0] === undefined ? '' : colors.at(group.rows[0]),
      })),
    })
  }
  const second = colors2?.legend
  if (stripeBy && second?.kind === 'categorical') {
    groups.push({
      title: stripeBy,
      entries: second.entries,
      ...(second.unlisted ? { more: second.unlisted } : {}),
    })
  }
  return groups
}

/** A column's categorical colours over the whole table, or undefined without a column. */
function useStripeColors(
  cells: TableValue | undefined,
  column: string | undefined,
  mode: Mode,
): ResolvedColor | undefined {
  return useMemo(
    () =>
      cells && column
        ? resolveColor(cells, { mode: 'categorical', column, constant: '' }, mode)
        : undefined,
    [cells, column, mode],
  )
}

/** The axon/dendrite key, and the second stripe's, and whether colours repeat. */
function Legend({
  mode,
  cycled,
  colors2,
  stripeBy,
}: {
  mode: Mode
  cycled: boolean
  colors2: ResolvedColor | undefined
  stripeBy: string | undefined
}) {
  return (
    <div className="legend gallery__legend">
      {inkEntries(mode).map((entry) => (
        <span key={entry.label} className="legend__item">
          <span className="legend__swatch" style={{ background: entry.color }} /> {entry.label}
        </span>
      ))}
      {/* The group stripe's key is the chips; the second stripe's is the shared one, which says
          `+N more` past the keys it has room for. */}
      {colors2 && <ColorKey colors={colors2} name={stripeBy} />}
      {/* More values than colours, so two share one: said, since two equal stripes look like one
          value rather than like a palette running out (`ResolvedColor.cycled`'s doctrine). */}
      {cycled && <span className="legend__item">colours repeat</span>}
    </div>
  )
}

function Wall({
  frame,
  cells,
  columns,
  labelled,
  skeletons,
  version,
  picked,
  onPick,
  height,
  mode,
  exportRef,
  columnSpec,
}: {
  frame: CorticalFrame
  cells: readonly WallCell[]
  columns: readonly (readonly WallSection[])[]
  labelled: boolean
  skeletons: WallSkeletons['held']
  version: number
  picked: ReadonlySet<NeuronId>
  onPick: (id: NeuronId) => void
  height: number
  mode: Mode
  /** Where the wall leaves a builder for its SVG, which the export calls on demand. */
  exportRef: { current: WallExport | null }
  /** Fit each cell, or one width for all — `Column width` and `Width (µm)`. */
  columnSpec: ColumnWidths
}) {
  const [box, size] = useElementSize<HTMLDivElement>()
  const scale = useMemo(() => rowScale(frame, height), [frame, height])
  // Every cell carries the same number of stripes, so the first says how tall the head is.
  const metrics = rowMetrics(height, labelled, cells[0]?.colors.length ?? 1)
  const { labelHeight, head, stride } = metrics

  const geometries = useMemo(
    () =>
      cells.map((cell) => {
        const skeleton = skeletons.get(cell.id)
        return skeleton ? cellGeometry(skeleton, frame) : undefined
      }),
    // `version` is what says `skeletons` — mutated in place — has something new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cells, skeletons, version, frame],
  )
  /*
   * Two widths per cell. `drawn` is its own extent — its canvas, whatever the mode; `widths` is
   * its column, which is the same in fit mode and one width for all in even mode, the button
   * clipping the canvas. So an automatic even width stepping as the wall fills is a layout change
   * and redraws no arbour; sized to the column, every landed cell redrew at each step.
   */
  const drawn = useMemo(
    () => columnWidths(geometries, scale.pxPerUm, { mode: 'fit' }),
    [geometries, scale],
  )
  const widths = useMemo(
    () =>
      columnSpec.mode === 'fit' ? drawn : columnWidths(geometries, scale.pxPerUm, columnSpec),
    [drawn, geometries, scale, columnSpec],
  )
  const layout = useMemo(
    () =>
      size.width > 0
        ? layoutWall(widths, size.width, columns, {
            ruler: RULER,
            gap: GAP,
            columnGap: COLUMN_GAP,
          })
        : undefined,
    [widths, size.width, columns],
  )
  const rows = layout?.rows ?? 0
  // Assigned during render, like `pick` below: the export asks for the wall as last laid out, and
  // brings what the figure says about itself only when somebody asks for one.
  exportRef.current = (figure) =>
    layout
      ? wallToSvg({
          frame,
          layout,
          stripes: cells.map((cell) => cell.colors),
          geometries,
          drawn,
          scale,
          metrics,
          width: size.width,
          mode,
          ...figure,
        })
      : null

  // One handler for every cell, off its `data-id`: a closure per cell would re-render them all.
  const pick = useRef(onPick)
  pick.current = onPick
  const onClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const id = event.currentTarget.dataset.id
    if (id) pick.current(id)
  }, [])

  /*
   * The wall scrolls inside the card and inside the full-size view alike, rather than the card
   * cutting at a row count: a card resized taller shows more rows, and the full-size view shows
   * every row there is. The measured element is the inner wall, whose width is the scroller's
   * less its gutter — reserved (`scrollbar-gutter`) so a scrollbar arriving never narrows the
   * rows it made necessary.
   */
  return (
    <div className="gallery__scroll">
      <div className="gallery__wall" ref={box} style={{ height: rows * stride }}>
        {layout?.labels.map((label) => (
          <span
            key={`label-${label.x}-${label.row}`}
            className="gallery__label"
            style={{ left: label.x, top: label.row * stride }}
          >
            {label.text}
          </span>
        ))}
        {/*
         * One canvas of layer bands per row, the ruler's labels at its left, behind the cells —
         * whose canvases draw only their arbour. A cell's justified width is then a style: a row
         * reflowing as a neighbour lands moves and widens buttons and redraws nothing.
         */}
        {layout?.rulers.map((ruler) => (
          <BandCanvas
            key={`band-${ruler.x}-${ruler.row}`}
            frame={frame}
            scale={scale}
            width={ruler.width}
            height={height}
            mode={mode}
            style={{ left: ruler.x, top: ruler.row * stride + head }}
          />
        ))}
        {layout &&
          cells.map((cell, i) => {
            const place = layout.cells[i]
            if (!place) return null
            return (
              <CellButton
                key={cell.id}
                cell={cell}
                x={place.x}
                y={place.row * stride + labelHeight}
                width={place.width}
                drawn={drawn[i]!}
                height={height}
                picked={picked.has(cell.id)}
                geometry={geometries[i]}
                missing={skeletons.get(cell.id) === null}
                scale={scale}
                mode={mode}
                onClick={onClick}
              />
            )
          })}
      </div>
    </div>
  )
}

/** One cell: its stripes and its drawing, placed. Memoised: a move is a style, not a redraw. */
const CellButton = memo(function CellButton({
  cell,
  x,
  y,
  width,
  drawn,
  height,
  picked,
  geometry,
  missing,
  scale,
  mode,
  onClick,
}: {
  cell: WallCell
  x: number
  y: number
  /** The button's width, which is the cell's own plus its share of a full row. */
  width: number
  /** The arbour's own width: what its canvas is, centred in the button. */
  drawn: number
  height: number
  picked: boolean
  geometry: CellGeometry | undefined
  missing: boolean
  scale: RowScale
  mode: Mode
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      type="button"
      className="gallery__cell"
      data-id={cell.id}
      aria-pressed={picked}
      title={cell.title}
      style={{ left: x, top: y, width }}
      onClick={onClick}
    >
      {cell.colors.map((color, i) => (
        <span key={i} className="gallery__stripe" style={{ background: color }} />
      ))}
      <CellCanvas
        geometry={geometry}
        scale={scale}
        width={drawn}
        height={height}
        mode={mode}
        state={geometry ? 'drawn' : missing ? 'missing' : 'loading'}
      />
    </button>
  )
})

/** A row's layer bands across its column, the layers named at its left. */
function BandCanvas({
  frame,
  scale,
  width,
  height,
  mode,
  style,
}: {
  frame: CorticalFrame
  scale: RowScale
  width: number
  height: number
  mode: Mode
  style: CSSProperties
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const pixels = useCanvasScale()
  useEffect(() => {
    const context = canvas.current && prepareCanvas(canvas.current, width, height, pixels)
    if (!context) return
    // Cleared: the bands fill every other layer only, so a redraw at the same size — a theme
    // switch — would otherwise land on the last one's.
    context.clearRect(0, 0, width, height)
    drawBands(context, frame, scale, width, height, mode)
  }, [frame, scale, width, height, mode, pixels])
  return <canvas className="gallery__band" ref={canvas} style={style} aria-hidden="true" />
}

/** One arbour on a transparent canvas of its own width, over its row's bands. */
function CellCanvas({
  geometry,
  scale,
  width,
  height,
  mode,
  state,
}: {
  geometry: CellGeometry | undefined
  scale: RowScale
  width: number
  height: number
  mode: Mode
  state: 'drawn' | 'missing' | 'loading'
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const pixels = useCanvasScale()
  useEffect(() => {
    const context = canvas.current && prepareCanvas(canvas.current, width, height, pixels)
    if (!context) return
    // Cleared: the canvas is transparent over its row's bands, so nothing else covers the last draw.
    context.clearRect(0, 0, width, height)
    if (geometry) drawCell(context, geometry, scale, width, mode)
  }, [geometry, scale, width, height, mode, pixels])
  return (
    <canvas className="gallery__canvas" ref={canvas} data-state={state} aria-hidden="true" />
  )
}
