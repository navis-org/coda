/**
 * The Dataset Summary widget: what is in a connectome, in tiles.
 *
 * Explore answers "which neuron?", Profile answers "what is this cell?", and this answers the
 * question that comes before both — "what is in here at all?". Modelled on Codex's Stats page,
 * with region completeness added, which is the one thing here that no other surface in Coda can
 * show and arguably the most useful: a connectivity result out of a region that is 39% traced
 * means something quite different from one out of a region that is 91%.
 *
 * It follows Profile's two rules unchanged, because they are what make a dashboard over
 * datasets-that-disagree-about-everything possible at all:
 *
 *  - **A tile renders only when its data exists.** hemibrain has no `superclass`, MANC has no
 *    `flow`, mushroombody publishes no ROI summary whatsoever, and a table with none of them is
 *    a legitimate dataset rather than an error. Nothing here names a column that must exist.
 *  - **Looking is free.** Every param the card writes is presentational and the node returns
 *    nothing, so there is no provenance to disturb — which is what lets the reload button and
 *    the chart picker sit on the card at all.
 *
 * **Region connectivity is not here**, though it was. A 63×63 matrix at the size a tile gets is
 * a field of coloured squares nobody can read a label off, and shrinking a picture until it is
 * only texture is not a summary of anything. `neuron.roiConnectivity` draws the same data at
 * whatever size it is given, into the Heatmap this once embedded — so the capability is not lost,
 * it is one node away and better served. The source method and its cache stay untouched.
 */

import { useMemo, useState } from 'react'

import type { TableValue } from '../../core/values'
import { getColumn, selectRows } from '../../core/values'
import {
  completenessTotals,
  datasetTotals,
  statsFor,
  summaryAttributes,
} from '../../nodes/lib/datasetStats'
import type { AttributeCounts, SummaryChartsMode } from '../../nodes/lib/datasetStats'
import { getSource } from '../../data/source'
import { MAX_SERIES, currentMode, seriesColor } from '../colors'
import type { Mode } from '../colors'
import { formatCompact, formatNumber, formatShare } from '../format'
import { useNeuronIndex } from '../useNeuronIndex'
import { Bars, Columns, Donut, Loadable, Pager, Tile } from './Tiles'
import type { ColumnBar } from './Tiles'
import { tableToCsvParts } from '../export'
import { useElementSize } from './useElementSize'
import { useRoiCompleteness } from './useRoiCompleteness'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'

export interface DatasetSummaryViewerProps {
  sourceId: string | undefined
  datasetId: string | undefined
  /** Empty means every neuron the dataset publishes — see the node's `status` param. */
  status: string
  /** Chosen chart columns. Empty means "decide for me". */
  attributes: readonly string[]
  /** Whether those replace the automatic charts or are drawn beside them. */
  chartsMode: SummaryChartsMode
  topTypes: number
  /** Which half of a synapse the completeness chart reports. */
  measure: CompletenessMeasure
  onMeasure: (measure: CompletenessMeasure) => void
  /** Whether the completeness chart ranks its regions or names them in order. */
  sort: CompletenessSort
  onSort: (sort: CompletenessSort) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
  /** Bumps the node's `refresh` nonce. Re-downloads the index for every widget on it. */
  onReload?: () => void
}

/** Bars per page in a ranked chart. Past this the pager takes over. */
const MAX_BARS = 8

/**
 * The most values an attribute may have and still be drawn as a ring.
 *
 * Five, because a ring is a part-of-whole claim that stops being legible when the slices get
 * thin — and because that is where the useful cases sit: `flow` has three values, `side` four,
 * `somaSide` three. A sixth slice is usually a long tail beginning, which is a bar chart's job.
 */
const MAX_DONUT_SLICES = 5

/**
 * The narrowest a completeness column may be before the chart pages instead of shrinking.
 *
 * Set by the *value* label rather than by the bar: `100%` in the 8.5px mono face is about 24px,
 * and a column narrower than its own number either clips it or drops it. The bar itself would
 * read fine at half this.
 *
 * How many columns fit is therefore a question about the box, not a constant — a full-width tile
 * in the overlay takes fifty-odd, the same tile on a 560px card takes twenty, and both fill the
 * width they are given. A fixed page size did neither: ten columns used half of the overlay and
 * still paged seven times through hemibrain's 63.
 */
const MIN_COLUMN_PX = 26

/** Before the first measurement. Replaced on the next frame; only ever shown for one. */
const FALLBACK_REGIONS_PER_PAGE = 12

export type CompletenessSort = 'value' | 'label'

/** Paging key for the completeness tile, which is not keyed by a column name. */
const REGION_KEY = '\u0000regions'

export type CompletenessMeasure = 'pre' | 'post'

export function DatasetSummaryViewer({
  sourceId,
  datasetId,
  status,
  attributes,
  chartsMode,
  topTypes,
  measure,
  onMeasure,
  sort,
  onSort,
  compact = false,
  baseName,
  onExpand,
  onError,
  onReload,
}: DatasetSummaryViewerProps) {
  const mode = currentMode()
  const { state: index } = useNeuronIndex(sourceId, datasetId)
  const completeness = useRoiCompleteness(sourceId, datasetId)

  const info = sourceId && datasetId ? getSource(sourceId)?.peekDataset(datasetId) : undefined

  /*
   * The status filter, memoised on the table and the status.
   *
   * Not merely a render optimisation: `statsFor` memoises per `TableValue` identity, so a fresh
   * filtered table every render would defeat the cache entirely and re-count eight columns over
   * 165,122 rows on every unrelated store tick. Same reasoning as `useStable` for the encoding
   * specs, arrived at from the other direction.
   */
  const table = useMemo(() => {
    if (index.status !== 'ready') return undefined
    if (!status) return index.table
    const column = index.table.data['status']
    if (!column) return index.table
    const keep: number[] = []
    for (let row = 0; row < index.table.length; row++) {
      if (column[row] === status) keep.push(row)
    }
    return selectRows(index.table, keep)
  }, [index, status])

  const totals = useMemo(() => (table ? datasetTotals(table) : undefined), [table])
  const regionTotals = useMemo(
    () =>
      completeness.status === 'ready' ? completenessTotals(completeness.table) : undefined,
    [completeness],
  )

  const charts = useMemo(
    () => (table ? summaryAttributes(table.schema, attributes, chartsMode) : []),
    [table, attributes, chartsMode],
  )

  /*
   * Which page each chart is on, by column name.
   *
   * Component state, not node params, and deliberately so. Profile's pager writes a param
   * because it feeds a `Current` port and has to survive a reload; nothing here feeds anything,
   * so which slice of a bar chart is on screen is not a fact about the document. A param would
   * also have to be one *per column name*, which is a schema this node cannot know at
   * definition time.
   */
  const [pages, setPages] = useState<Record<string, number>>({})

  const indexState = loadState(index.status)

  /*
   * The caption names its population every time.
   *
   * A dataset-wide count with no stated population is the number that ends up quoted, and the
   * index carries *every* `:Neuron` rather than the Traced subset every other query node here
   * defaults to. Same idiom as `labels thinned` and `showing 50,000 of 165,122`.
   */
  const caption = [
    totals ? `${formatNumber(totals.neurons)} neurons` : undefined,
    status ? status : 'all statuses',
    totals?.distinctTypes ? `${formatNumber(totals.distinctTypes)} cell types` : undefined,
    regionTotals?.filtered ? `${regionTotals.regions} primary regions` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

  /*
   * CSV only, and it is the completeness table.
   *
   * There is no single `<svg>` to hand over — the card is a grid of tiles, several of which
   * draw their own — so a vector export here would have to invent a composite nothing else
   * renders. What somebody actually wants out of this card is the numbers, and the region
   * table is the one set of them that exists nowhere else in the graph.
   */
  const exportSource: ExportSource = {
    csv: () => (completeness.status === 'ready' ? tableToCsvParts(completeness.table) : ['\n']),
  }

  return (
    <div className="viewer summary">
      <div className="tiles nowheel">
        <Tile label="Dataset">
          <Loadable state={datasetId ? 'ready' : 'none'}>
            <dl className="tile__facts">
              <Fact label="id" value={datasetId} />
              <Fact label="species" value={info?.species} />
              <Fact label="version" value={info?.version} />
              {/*
               * Primary first, and the total only when it differs.
               *
               * This said `regions 5,619` on male-CNS while the chart below it was over 144
               * and the caption said "144 primary regions" — two numbers on one card both
               * called regions, thirty-nine times apart, with nothing saying which was which.
               * The published list nests: 5,619 counts every sub-region, 144 tile the volume,
               * and only the second is the one anything may sum. Naming both, in that order,
               * is what makes the chart's count stop looking like a filter that failed.
               */}
              <Fact label="regions" value={regionCount(info)} />
            </dl>
          </Loadable>
        </Tile>

        <Tile label="Neurons" qualifier={status || 'all statuses'}>
          <Loadable state={indexState}>
            <dl className="tile__facts">
              <Fact label="total" value={totals ? formatNumber(totals.neurons) : undefined} />
              <Fact
                label="typed"
                value={totals?.typed ? formatNumber(totals.typed) : undefined}
              />
              <Fact
                label="cell types"
                value={totals?.distinctTypes ? formatNumber(totals.distinctTypes) : undefined}
              />
            </dl>
          </Loadable>
        </Tile>

        {/* Only when the regions actually summed to something. A dataset publishing no ROI
            summary — mushroombody does exactly that — draws no tile rather than four zeros. */}
        {regionTotals && regionTotals.regions > 0 && (
          <Tile label="Synapses" qualifier="traced / total">
            <dl className="tile__facts">
              <Fact
                label="pre"
                value={`${formatCompact(regionTotals.pre)} / ${formatCompact(regionTotals.totalPre)}`}
              />
              <Fact
                label="post"
                value={`${formatCompact(regionTotals.post)} / ${formatCompact(regionTotals.totalPost)}`}
              />
              <Fact label="traced" value={completenessPair(regionTotals)} />
            </dl>
          </Tile>
        )}

        {charts.map((name, i) => (
          <AttributeTile
            key={name}
            table={table}
            column={name}
            /*
             * A colour per chart, cycling the categorical palette by position.
             * Every bar on the card being one blue made eight charts read as one chart in
             * eight parts. A repeat across *tiles* is harmless — the palette's all-pairs gate
             * is about series sitting side by side inside one chart, which these never do.
             */
            color={seriesColor(i % MAX_SERIES, mode)}
            mode={mode}
            page={pages[name] ?? 0}
            onPage={(page) => setPages((p) => ({ ...p, [name]: page }))}
          />
        ))}

        {topTypes > 0 && (
          <RankedTile
            label="Top cell types"
            counts={table?.data['type'] ? statsFor(table, 'type') : undefined}
            state={indexState}
            perPage={topTypes}
            color={seriesColor(0, mode)}
            page={pages['type'] ?? 0}
            onPage={(page) => setPages((p) => ({ ...p, type: page }))}
          />
        )}

        <CompletenessTile
          state={loadState(completeness.status)}
          table={completeness.status === 'ready' ? completeness.table : undefined}
          measure={measure}
          onMeasure={onMeasure}
          sort={sort}
          onSort={onSort}
          color={seriesColor(2, mode)}
          page={pages[REGION_KEY] ?? 0}
          onPage={(page) => setPages((p) => ({ ...p, [REGION_KEY]: page }))}
        />
      </div>

      <div className="viewer__caption">
        <span>{caption || 'No dataset'}</span>
        {onReload && (
          <button
            type="button"
            className="summary__reload"
            title="Re-download this dataset's neuron index"
            aria-label="Reload dataset index"
            onClick={onReload}
          >
            ⟳
          </button>
        )}
        <ViewerActions
          baseName={baseName ?? 'dataset-summary'}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

/**
 * One attribute, as a ring or as bars depending on how many values it has.
 *
 * The switch is the point. A ring is a *part-of-whole* claim and stops being legible somewhere
 * around five slices; a ranked bar chart is a *comparison* and keeps working at fifty. `flow`
 * has three values and `side` four — those are wholes, and drawing them as three bars wastes the
 * one thing a reader wants, which is the split. `class` has ten on male-CNS and two hundred on a
 * table somebody built themselves, which no ring can hold. Codex splits its own panels the same
 * way, and this is the rule behind that split rather than a list of which field is which.
 */
function AttributeTile({
  table,
  column,
  color,
  mode,
  page,
  onPage,
}: {
  table: TableValue | undefined
  column: string
  color: string
  mode: Mode
  page: number
  onPage: (page: number) => void
}) {
  const counts = table?.data[column] ? statsFor(table, column) : undefined
  const asRing = counts !== undefined && counts.values.length <= MAX_DONUT_SLICES

  if (asRing) {
    return (
      <Tile label={column}>
        <Donut
          total={formatCompact(counts.total)}
          slices={counts.values.map((value, i) => ({
            key: value.value ?? '—',
            value: value.count,
            share: value.share,
            // Per *slice* here, not per chart: inside one ring the slices are adjacent, which
            // is exactly the case the palette's all-pairs gate was validated for.
            color: seriesColor(i, mode),
            title: `${value.value ?? 'no value'} — ${formatNumber(value.count)} neurons`,
          }))}
        />
      </Tile>
    )
  }

  return (
    <RankedTile
      label={column}
      counts={counts}
      state={table ? 'ready' : 'loading'}
      perPage={MAX_BARS}
      color={color}
      page={page}
      onPage={onPage}
    />
  )
}

/**
 * A ranked list as bars, one page at a time.
 *
 * Paging replaced the `Other` residual rather than joining it, and that is a change of claim
 * rather than of layout: a residual says "there are 206 more and you cannot see them", where a
 * pager says "there are 206 more, here they are". Nothing is hidden, so nothing has to be
 * admitted — the heading carries `9–16 of 214` and the arrows do the rest.
 */
function RankedTile({
  label,
  counts,
  state,
  perPage,
  color,
  page,
  onPage,
}: {
  label: string
  counts: AttributeCounts | undefined
  state: 'none' | 'loading' | 'ready' | 'error'
  perPage: number
  color: string
  page: number
  onPage: (page: number) => void
}) {
  const size = Math.max(1, perPage)
  const total = counts?.values.length ?? 0
  const pages = Math.max(1, Math.ceil(total / size))
  // Clamped rather than trusted: `perPage` is a param somebody can lower while page 9 is open.
  const current = Math.min(Math.max(0, page), pages - 1)
  const shown = counts?.values.slice(current * size, current * size + size) ?? []

  // Scaled against the whole ranked list, not the page — otherwise page two redraws its
  // largest bar full width and reads as though it matched page one's.
  const max = Math.max(...(counts?.values ?? []).map((v) => v.count), 1)

  return (
    <Tile
      label={label}
      qualifier={rangeQualifier(current, size, total)}
      action={<Pager page={current} pages={pages} onPage={onPage} label={label} />}
    >
      <Loadable state={state} empty={total === 0}>
        <Bars
          color={color}
          rows={shown.map((value) => ({
            key: value.value ?? '—',
            title: `${value.value ?? 'no value'} — ${formatNumber(value.count)} neurons, ${formatShare(value.share)}`,
            fraction: value.count / max,
            value: formatCompact(value.count),
            detail: formatShare(value.share),
          }))}
        />
      </Loadable>
    </Tile>
  )
}

/**
 * Region completeness, as columns on a fixed 0–100% axis.
 *
 * **Primary regions only, and the filter is not optional here.** The published list nests, so
 * `LO(R)` and its parent `OL(R)` are both rows; drawn side by side they read as two regions
 * whose bars can be compared, when one contains the other. Summed they are worse still — over
 * hemibrain's 229 rows the presynaptic total comes to 20,988,880 against a true 9,428,400, a
 * 2.2× overcount that matches `Meta.totalPreCount` only once the 63 primary rows are the ones
 * kept. The ROI Completeness *node* offers the nested rows because somebody comparing
 * sub-regions of one antennal lobe wants exactly them; a dataset-level chart never does.
 *
 * A region whose `primary` is unknown is dropped here too — unlike the node, which keeps it.
 * Showing a region costs nothing; putting one of unknown standing into a ranked comparison
 * against regions that tile the volume is a claim nobody can check.
 */
function CompletenessTile({
  state,
  table,
  measure,
  onMeasure,
  sort,
  onSort,
  color,
  page,
  onPage,
}: {
  state: 'none' | 'loading' | 'ready' | 'error'
  table: TableValue | undefined
  measure: CompletenessMeasure
  onMeasure: (measure: CompletenessMeasure) => void
  sort: CompletenessSort
  onSort: (sort: CompletenessSort) => void
  color: string
  page: number
  onPage: (page: number) => void
}) {
  /*
   * How many columns fit is a question about the box.
   *
   * Measured rather than assumed, the same reason `useElementSize` exists for the other charts:
   * this tile is full width in the overlay and a fraction of a 560px card, and a page size that
   * suited one wasted most of the other. Zero on the first render — the observer has not fired —
   * so the fallback shows for a frame and is replaced.
   */
  const [plotRef, plotSize] = useElementSize<HTMLDivElement>()
  const perPage =
    plotSize.width > 0
      ? Math.max(1, Math.floor(plotSize.width / MIN_COLUMN_PX))
      : FALLBACK_REGIONS_PER_PAGE

  const chart = table
    ? completenessColumns(table, measure, sort)
    : { bars: [] as ColumnBar[], mean: null }
  const rows = chart.bars
  /*
   * Why it is empty, when it is.
   *
   * Three different things read as "no chart" and only one of them is a fact about the
   * dataset: it publishes no regions, or it publishes regions with nothing recorded for *this*
   * measure, or the other measure would work and this one is simply the wrong question. A bare
   * "None" says the first whichever is true.
   */
  const other = table
    ? completenessColumns(table, measure === 'pre' ? 'post' : 'pre', sort).bars
    : []
  const emptyLabel =
    rows.length > 0
      ? undefined
      : table && table.length === 0
        ? 'This dataset publishes no region summary'
        : other.length > 0
          ? `Nothing recorded ${measure === 'pre' ? 'presynaptically' : 'postsynaptically'} — try ${measure === 'pre' ? 'postsynaptic' : 'presynaptic'}`
          : 'No regions with synapses recorded'

  const pages = Math.max(1, Math.ceil(rows.length / perPage))
  // Clamped rather than trusted: the page count falls as the card is widened.
  const current = Math.min(Math.max(0, page), pages - 1)
  const shown = rows.slice(current * perPage, current * perPage + perPage)

  return (
    <Tile
      label="Region completeness"
      qualifier={rangeQualifier(current, perPage, rows.length)}
      wide
      action={
        <>
          {/*
           * On the tile rather than only in the inspector: which half of a synapse is traced
           * is the question this chart exists to answer, and the two answers differ by fifty
           * points on hemibrain — 91% presynaptic against 37% postsynaptic. A control that
           * changes the reading that much belongs where the reading is.
           */}
          <select
            className="tile__measure"
            value={measure}
            aria-label="Completeness measure"
            onChange={(e) => onMeasure(e.target.value as CompletenessMeasure)}
          >
            <option value="post">postsynaptic</option>
            <option value="pre">presynaptic</option>
          </select>
          {/*
           * Ranked or named. Ranked answers "where can I trust this?"; named answers "how
           * complete is *this* region?", which is the question somebody has when they already
           * know the region — and on a paged chart of sixty-three it is the difference between
           * hunting and looking it up.
           */}
          <select
            className="tile__measure"
            value={sort}
            aria-label="Region order"
            onChange={(e) => onSort(e.target.value as CompletenessSort)}
          >
            <option value="value">by value</option>
            <option value="label">by name</option>
          </select>
          <Pager page={current} pages={pages} onPage={onPage} label="regions" />
        </>
      }
    >
      {/*
       * The measured box wraps `Loadable`, never the other way round.
       *
       * `useElementSize` observes once, on mount, and bails when the ref is empty — so a box
       * rendered *inside* the loading branch is null exactly when the observer is set up and
       * is never seen again. The chart then keeps the fallback page size for the rest of the
       * session, which looks like a chart that simply chose a small number: on male-CNS it sat
       * at twelve columns in a box that fits eighteen. Mounting the wrapper unconditionally is
       * what makes the measurement happen at all.
       */}
      <div ref={plotRef} className="tile__columns-measure">
        <Loadable state={state} empty={rows.length === 0} emptyLabel={emptyLabel}>
          <Columns
            bars={shown}
            color={color}
            {...(chart.mean === null
              ? {}
              : {
                  reference: {
                    fraction: chart.mean,
                    label: `mean ${formatShare(chart.mean)}`,
                    title: `Weighted mean across all ${formatNumber(rows.length)} regions — total traced over total present, so a large region counts for more than a small one`,
                  },
                })}
          />
        </Loadable>
      </div>
    </Tile>
  )
}

/**
 * `144 primary of 5,619`, or just the count where every region tiles the volume.
 *
 * MANC publishes 59 regions and all 59 are primary, so `59 primary of 59` is noise; hemibrain
 * publishes 230 against 63. Undefined rather than `0` when the listing has not landed — a
 * dataset with no regions and a dataset nobody has asked about yet are different things.
 */
function regionCount(
  info: { rois: string[]; primaryRois?: string[] } | undefined,
): string | undefined {
  if (!info?.rois.length) return undefined
  const primary = info.primaryRois?.length
  if (!primary) return formatNumber(info.rois.length)
  if (primary === info.rois.length) return formatNumber(primary)
  return `${formatNumber(primary)} primary of ${formatNumber(info.rois.length)}`
}

function Fact({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null
  return (
    <div className="tile__fact">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Primary regions, by completeness or by name.
 *
 * Ranked by fraction rather than by size when sorting by value, because the question is "where
 * can I trust this?" rather than "where is the volume?". A null fraction is a region with
 * nothing recorded, not a region at 0%, and is left out rather than drawn at the floor.
 *
 * The name sort uses `localeCompare` with `numeric`, so `ME_R_col_2` precedes `ME_R_col_10`
 * rather than following it — male-CNS names thousands of regions that way, and a plain string
 * sort puts them in an order that looks like a bug.
 */
interface CompletenessChart {
  bars: ColumnBar[]
  /**
   * The **weighted** mean over every region drawn, or null when there is nothing to divide.
   *
   * Weighted — total traced over total present — and not the average of the per-region
   * fractions, which is a different number and the wrong one. Hemibrain's regions run from 41%
   * to 83% postsynaptically; averaging those fractions gives every region an equal vote, so a
   * tiny well-traced neuropil counts as much as `ME(R)`, which holds a fifth of the volume's
   * synapses. The weighted figure is the one that answers "what fraction of this connectome's
   * postsynaptic sites belong to a reconstructed neuron", and the one that agrees with the
   * Synapses tile above it.
   *
   * Over every primary region, never over the page: a reference line that moved as you paged
   * would be comparing each page against itself.
   */
  mean: number | null
}

function completenessColumns(
  table: TableValue,
  measure: CompletenessMeasure,
  sort: CompletenessSort = 'value',
): CompletenessChart {
  const roi = getColumn(table, 'roi')
  const fraction = getColumn(table, measure === 'pre' ? 'preCompleteness' : 'postCompleteness')
  const traced = getColumn(table, measure === 'pre' ? 'pre' : 'post')
  const total = getColumn(table, measure === 'pre' ? 'totalPre' : 'totalPost')
  const primary = table.data['primary']

  const bars: ColumnBar[] = []
  let tracedTotal = 0
  let presentTotal = 0
  for (let row = 0; row < table.length; row++) {
    /*
     * Only a region known to nest is dropped. `null` means the source could not say — the
     * primary list had not arrived — and an absent column means nobody was asked at all.
     * Testing `!== true` covered both as though they were `false`, which turns an answer
     * nobody has yet into the claim that a dataset has no regions. That is the same
     * unknown-is-not-empty rule `columnSchemaFor` and `validateColumnParams` follow, and it
     * is worth stating here because the failure is total: every row fails one strict test at
     * once, so the chart does not degrade, it disappears.
     */
    if (primary?.[row] === false) continue
    /*
     * Null checked *before* the conversion, never after.
     *
     * `Number(null)` is 0 and `Number.isFinite(0)` is true, so testing the converted value lets
     * a region with nothing recorded through as a confident 0% column — a measurement drawn for
     * something nobody measured. Same trap `numeric()` in `ui/encoding.ts` exists for, and the
     * same answer.
     */
    const cell = fraction[row]
    if (cell === null || cell === undefined) continue
    const value = Number(cell)
    if (!Number.isFinite(value)) continue
    // Accumulated from the same rows the bars come from, so the line cannot describe a
    // different set from the chart under it.
    const rowTraced = Number(traced[row])
    const rowTotal = Number(total[row])
    if (Number.isFinite(rowTraced) && Number.isFinite(rowTotal)) {
      tracedTotal += rowTraced
      presentTotal += rowTotal
    }

    bars.push({
      key: String(roi[row]),
      title: `${String(roi[row])} — ${formatNumber(rowTraced)} of ${formatNumber(rowTotal)} ${measure === 'pre' ? 'presynaptic sites' : 'postsynaptic sites'} traced`,
      fraction: value,
      value: formatShare(value),
    })
  }
  bars.sort(
    sort === 'label'
      ? (a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })
      : // Ties break on the name, so an equal pair cannot swap places between renders.
        (a, b) =>
          b.fraction - a.fraction || a.key.localeCompare(b.key, undefined, { numeric: true }),
  )
  return { bars, mean: presentTotal > 0 ? tracedTotal / presentTotal : null }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function completenessPair(totals: {
  preCompleteness: number | null
  postCompleteness: number | null
}): string | undefined {
  const { preCompleteness, postCompleteness } = totals
  if (preCompleteness === null && postCompleteness === null) return undefined
  return `${preCompleteness === null ? '—' : formatShare(preCompleteness)} pre · ${
    postCompleteness === null ? '—' : formatShare(postCompleteness)
  } post`
}

/** `9–16 of 214`, or just the count when it all fits and there is nothing to page through. */
function rangeQualifier(page: number, perPage: number, total: number): string | undefined {
  if (total === 0) return undefined
  if (total <= perPage) return formatNumber(total)
  const from = page * perPage + 1
  const to = Math.min(total, from + perPage - 1)
  return `${from}–${to} of ${formatNumber(total)}`
}

/** The index hook's state names happen to be the tile's; kept explicit so a rename cannot slip. */
function loadState(status: string): 'none' | 'loading' | 'ready' | 'error' {
  if (status === 'ready') return 'ready'
  if (status === 'error') return 'error'
  if (status === 'loading') return 'loading'
  return 'none'
}
