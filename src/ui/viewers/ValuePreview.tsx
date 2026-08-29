import { useMemo } from 'react'

import type { GraphNode } from '../../core/graph'
import type { InferContext, ParamValue } from '../../core/node'
import { schemaOf } from '../../core/types'
import type { Value } from '../../core/values'
import {
  asString,
  describeValue,
  isDatasetValue,
  isLayoutValue,
  isLinkageValue,
  isMatrixValue,
  isMeshesValue,
  isNetworkValue,
  isPointsValue,
  isSkeletonsValue,
  isTableValue,
} from '../../core/values'
import {
  readColorSpec,
  readHiddenKeys,
  readShapeSpec,
  readSizeSpec,
} from '../../nodes/lib/encodingParams'
import { BarChartViewer } from './BarChartViewer'
import { DistributionViewer } from './DistributionViewer'
import type { DistributionStyle } from './DistributionViewer'
import { HistogramViewer } from './HistogramViewer'
import { PieViewer } from './PieViewer'
import { HeatmapViewer } from './HeatmapViewer'
import { LazyNetworkViewer, LazyViewer3D } from './LazyViewers'
import type { BackgroundChoice, SkeletonWidthMode } from './viewer3dScene'
import { NeuroglancerViewer } from './NeuroglancerViewer'
import { chosenViewerKind } from '../../nodes/output/neuroglancer'
import { DatasetSummaryViewer } from './DatasetSummaryViewer'
import { RoisViewer } from './RoisViewer'
import type { RoiColorMode, RoiLabelMode } from './RoisViewer'
import type { RoiView } from './roiProjection'
import { ProfileViewer } from './ProfileViewer'
import { ExportNodeContext } from './exportRegistry'
import { ScatterViewer } from './ScatterViewer'
import { DendrogramViewer } from './DendrogramViewer'
import type { WhiskerRule } from './boxStats'
import type { Normalize } from './histogramBins'
import type { LayoutName } from './networkLayout'
import type { FilterClause } from '../../nodes/lib/tableFilter'
import { decodeClauses, encodeClauses } from '../../nodes/lib/tableFilter'
import { describeTable } from '../../nodes/lib/describeOps'
import { TableSummary } from './TableSummary'
import { TableViewer } from './TableViewer'

export interface ValuePreviewProps {
  node: GraphNode
  value: Value | undefined
  /** Resolves the node's column params against the live schema. */
  ctx: InferContext
  compact?: boolean
  /** Filename stem for downloads. Omitted in tiny previews that don't offer export. */
  baseName?: string
  /** Provided when the viewer can be enlarged — i.e. not already in the overlay. */
  onExpand?: () => void
  onError?: (message: string) => void
  /**
   * Writes a param back onto the node. Present only where a viewer has something to say —
   * this is the one path by which a viewer feeds the graph.
   *
   * General rather than selection-specific because a viewer's writes are not all selections:
   * Profile's pager writes `page`, which is presentational, alongside the pin, which is not.
   * `onSelectionChange` below is the narrow convenience on top of it, kept because three
   * viewers only ever write a selection and reading `onSelectionChange` at those call sites
   * says more than `onParamChange('selection', …)` does.
   */
  onParamChange?: (paramId: string, value: ParamValue) => void
  onSelectionChange?: (ids: string[]) => void
  /** Realised values on the node's input ports, for viewers that draw several at once. */
  inputValues?: Record<string, Value | undefined>
  /**
   * Draw a tabular value as a text readout rather than as a table.
   *
   * For a surface with no room for one — the inspector, at 320 × 300. A 60-column annotation
   * table there is a horizontally scrolling grid showing about three columns at a time, where
   * `TableSummary` turns the same information ninety degrees and fits it. Reading the table
   * itself is the Table node's job, and the overlay's.
   *
   * Only the *fallback* table branch honours it: a node with a viewer of its own — a scatter, a
   * heatmap, a profile — keeps it, because those already draw something sized to their box.
   */
  summary?: boolean
}

/**
 * Picks a viewer for a node's output.
 *
 * Driven by the node's *type* first (an `out.heatmap` renders a heatmap, using its own
 * scale params) and falls back to the value's kind, so selecting any node in the graph
 * shows something useful in the inspector — not just the dedicated output nodes.
 */
/**
 * Name the node every viewer below is drawing, so `ViewerActions` can publish its picture.
 *
 * A wrapper rather than a provider at each `return`: this component dispatches through fourteen
 * of them, and one missed would leave exactly one viewer whose chart the Download node cannot
 * reach — with nothing failing anywhere to say which.
 */
export function ValuePreview(props: ValuePreviewProps) {
  return (
    <ExportNodeContext.Provider value={props.node.id}>
      <ValuePreviewInner {...props} />
    </ExportNodeContext.Provider>
  )
}

function ValuePreviewInner({
  node,
  value,
  ctx,
  compact = false,
  baseName,
  onExpand,
  onError,
  onParamChange,
  onSelectionChange,
  inputValues,
  summary,
}: ValuePreviewProps) {
  // Forwarded to every viewer; kept in one place so a new viewer can't forget export.
  const shared = {
    compact,
    ...(baseName ? { baseName } : {}),
    ...(onExpand ? { onExpand } : {}),
    ...(onError ? { onError } : {}),
  }

  /*
   * Up here rather than in the table branch below, because this component returns early a
   * dozen times and a hook after a conditional return is not a hook. Keyed on the stored
   * `string[]`, which changes only when somebody edits a filter — decoding inline would mint a
   * fresh array every store tick, and `TableViewer` resets its draft whenever this changes
   * identity, so it would discard what was being typed and re-filter and re-page on each one.
   */
  const filterClauses = useMemo(() => decodeClauses(node.params.filters), [node.params.filters])

  /*
   * A summary means "no second renderer", not just "no grid".
   *
   * `summary` was introduced for the table — a 60-column grid in a 320px panel is three
   * columns behind a sideways scrollbar, where `TableSummary` turns it ninety degrees and
   * fits. The note beside the prop says a viewer with a drawing of its own keeps it, "because
   * those already draw something sized to their box". True of an SVG or a canvas, and false of
   * these two in the way that matters: a WebGL viewer is a *renderer*, and drawing one twice
   * is two graphics contexts, two copies of the geometry on the GPU and two redraws on every
   * invalidation. Measured on a 21-neuron scene with the card, the inspector and the overlay
   * up: 3 contexts, 170 kB uploaded into each, and one background change costing 154 draw
   * calls across the three.
   *
   * So the panel names what it would have drawn and offers the way to see it properly. Which
   * is close to what it was worth in a 320 × 300 box beside the card already showing it.
   */
  if (summary && node.type in HAS_OWN_CONTEXT) {
    return <DrawnElsewhere type={node.type} {...(onExpand ? { onExpand } : {})} />
  }

  /*
   * Above the `!value` guard, and that placement is the whole reason this node renders at all.
   *
   * Every other viewer here has an output port, so after a run it has a value and the guard is
   * a "nothing yet" state it passes through once. This one has **no outputs**, so its value is
   * undefined forever — below the guard its branch is unreachable and the card shows "No result
   * yet" permanently, which is exactly what it did until a real browser was pointed at it. The
   * jsdom test renders the viewer directly and cannot see this; `valuePreview` covers it now.
   */
  if (node.type === 'out.datasetSummary') {
    // Drawn entirely from its *input*, like Profile and the neuroglancer frame — but unlike
    // them it has nothing of its own it could ever be keyed on.
    const dataset = inputValues?.dataset
    return (
      <DatasetSummaryViewer
        sourceId={isDatasetValue(dataset) ? dataset.sourceId : undefined}
        datasetId={isDatasetValue(dataset) ? dataset.datasetId : undefined}
        status={String(node.params.status ?? '')}
        attributes={ctx.columns('attributes')}
        topTypes={Number(node.params.topTypes ?? 10)}
        measure={node.params.completenessMeasure === 'pre' ? 'pre' : 'post'}
        onMeasure={(measure) => onParamChange?.('completenessMeasure', measure)}
        sort={node.params.completenessSort === 'label' ? 'label' : 'value'}
        onSort={(sort) => onParamChange?.('completenessSort', sort)}
        onReload={() => onParamChange?.('refresh', Number(node.params.refresh ?? 0) + 1)}
        {...shared}
      />
    )
  }

  /*
   * Above the `!value` guard too, and for the same reason: no outputs means no value, ever.
   * `out.datasetSummary` shipped below it once and showed "No result yet" permanently, with a
   * green suite, because every test rendered the viewer directly and so never reached here.
   */
  if (node.type === 'out.rois') {
    const dataset = inputValues?.dataset
    return (
      <RoisViewer
        sourceId={isDatasetValue(dataset) ? dataset.sourceId : undefined}
        datasetId={isDatasetValue(dataset) ? dataset.datasetId : undefined}
        view={roiView(node.params.view)}
        explode={Number(node.params.explode ?? 0)}
        colorBy={roiColorMode(node.params.colorBy)}
        labels={roiLabelMode(node.params.labels)}
        hemisphere={roiHemisphere(node.params.hemisphere)}
        superRois={
          Array.isArray(node.params.superRois) ? (node.params.superRois as string[]) : []
        }
        opacity={Number(node.params.opacity ?? 0.12)}
        refresh={Number(node.params.refresh ?? 0)}
        {...(onParamChange ? { onParamChange } : {})}
        {...shared}
      />
    )
  }

  const selection = idList(node.params.selection)

  /*
   * Above the `!value` guard, on `out.rois`' terms and for a sharper reason.
   *
   * This node's own output is the *selection* — empty until it runs — while the scene is on its
   * inputs. Below the guard, a 3D View could only draw after its own evaluation, which is one
   * whole scheduler step after the geometry it draws arrived. That is invisible on a finished
   * run and fatal to a streamed one: `ctx.publish` grows the value on the upstream port while
   * the fetch node is still running, and this card is the thing that has to notice.
   *
   * Gated on an input actually being present rather than rendering unconditionally, so a graph
   * that has never run still says "No result yet" instead of standing up a WebGL context to
   * draw nothing.
   */
  if (node.type === 'out.viewer3d') {
    const skeletons = inputValues?.skeletons
    const meshes = inputValues?.meshes
    const points = inputValues?.points
    const volumes = inputValues?.volumes
    if (skeletons || meshes || points || volumes) return (
      <LazyViewer3D
        skeletons={isSkeletonsValue(skeletons) ? skeletons : undefined}
        meshes={isMeshesValue(meshes) ? meshes : undefined}
        points={isPointsValue(points) ? points : undefined}
        volumes={isMeshesValue(volumes) ? volumes : undefined}
        skeletonColor={readColorSpec('skeleton', node.params, ctx.column)}
        meshColor={readColorSpec('mesh', node.params, ctx.column)}
        pointColor={readColorSpec('point', node.params, ctx.column)}
        volumeColor={readColorSpec('volume', node.params, ctx.column)}
        skeletonWidth={Number(node.params.skeletonWidth ?? 1)}
        skeletonWidthMode={skeletonWidthMode(node.params.skeletonWidthMode)}
        skeletonRadiusWidth={Number(node.params.skeletonRadiusWidth ?? 4)}
        skeletonWorldWidth={Number(node.params.skeletonWorldWidth ?? 1)}
        lightIntensity={Number(node.params.lightIntensity ?? 1)}
        // Defaults to false, so a graph saved before this param existed opens with the
        // scene unpickable — which is the new default rather than a migration.
        selectByClick={node.params.selectByClick === true}
        // `Number` rather than a cast, and it covers the alpha graphs that stored this as a
        // boolean before it became a strength: `true` is 1 and `false` is 0, which is exactly
        // what those two meant.
        ambientOcclusion={Number(node.params.ambientOcclusion ?? 1)}
        // Every fallback here has to equal the node's declared default: a graph saved before a
        // param existed has no key for it, and this is the value it then gets.
        meshOpacity={Number(node.params.meshOpacity ?? 1)}
        pointSize={Number(node.params.pointSize ?? 60)}
        volumeOpacity={Number(node.params.volumeOpacity ?? 0.12)}
        // The node id, so the card and the overlay share one camera instead of resetting each
        // other — the same prop the network viewer takes for its layout and camera.
        viewerId={node.id}
        background={String(node.params.background ?? 'theme') as BackgroundChoice}
        refit={node.params.refit === true}
        // Read defensively rather than cast: these three are written by the legend, so a graph
        // saved before it existed has no key for them at all.
        // Through the reader beside `readColorSpec`, because `colorParams({ legend })` is what
        // names these params — spelling `skeletonHidden` here is a fifth place that has to agree
        // with the factory that generates it and the viewer that writes it back.
        hidden={{
          skeleton: readHiddenKeys('skeleton', node.params),
          mesh: readHiddenKeys('mesh', node.params),
          point: readHiddenKeys('point', node.params),
          volume: readHiddenKeys('volume', node.params),
        }}
        // `!== false`, so a graph saved before these existed draws everything — which is what
        // it did. Reading them as `=== true` would open every old file with an empty scene.
        shown={{
          skeletons: node.params.showSkeletons !== false,
          meshes: node.params.showMeshes !== false,
          points: node.params.showPoints !== false,
          volumes: node.params.showVolumes !== false,
        }}
        selection={selection}
        onSelectionChange={onSelectionChange}
        {...(onParamChange ? { onParamChange } : {})}
        {...shared}
      />
    )
  }

  if (!value) {
    return (
      <div className="viewer">
        <div className="viewer__empty">No result yet — run the graph to see output.</div>
      </div>
    )
  }

  if (node.type === 'out.network' && isNetworkValue(value)) {
    // The node filters its own output, so the caption compares what it drew against what
    // arrived to say how much was removed.
    const source = inputValues?.in
    // Positions from the Layout socket win over the Layout param — see the port's comment on
    // the node definition. Read off the input rather than the node's own output because a
    // layout is somebody else's result passing through, exactly like the 3D viewer's geometry.
    const given = inputValues?.layout
    return (
      <LazyNetworkViewer
        network={value}
        {...(isLayoutValue(given) ? { given: given.positions } : {})}
        {...(isNetworkValue(source)
          ? { sourceCounts: { nodes: source.nodes.length, links: source.edges.length } }
          : {})}
        layout={String(node.params.layout ?? 'prefuse') as LayoutName}
        iterations={Number(node.params.iterations ?? 220)}
        xColumn={ctx.column('xColumn')}
        yColumn={ctx.column('yColumn')}
        orientation={node.params.layoutOrientation === 'tb' ? 'tb' : 'lr'}
        layerColumn={ctx.column('layerColumn')}
        groupColumn={ctx.column('groupColumn')}
        seed={node.params.seed === 'spectral' ? 'spectral' : 'circle'}
        barnesHut={
          node.params.barnesHut === 'on' || node.params.barnesHut === 'off'
            ? node.params.barnesHut
            : 'auto'
        }
        weightInfluence={Number(node.params.weightInfluence ?? 1)}
        // `separate` is the default and the reason the layout is here; anything else is the
        // explicit "all at once" comparison. See `prefusePositions`.
        partition={node.params.partition !== 'together'}
        springLength={Number(node.params.springLength ?? 50)}
        // Keyed to the graph node, so a layout settled in the overlay is still there when it
        // is reopened — and is shared with the card and the inspector.
        viewerId={node.id}
        nodeColor={readColorSpec('node', node.params, ctx.column)}
        nodeSize={readSizeSpec('node', node.params, ctx.column, { min: 4, max: 18 })}
        nodeShape={readShapeSpec('node', node.params, ctx.column)}
        {...(onParamChange ? { onParamChange } : {})}
        nodeBorderWidth={Number(node.params.nodeBorderWidth ?? 1)}
        edgeColor={readColorSpec('edge', node.params, ctx.column)}
        edgeSize={readSizeSpec('edge', node.params, ctx.column, { min: 0.5, max: 6 })}
        edgeOpacity={Number(node.params.edgeOpacity ?? 1)}
        showLabels={node.params.showLabels !== false}
        labelColumn={ctx.column('labelColumn')}
        arrows={node.params.arrows !== false}
        edgeLabels={node.params.edgeLabels === true}
        edgeLabelColumn={ctx.column('edgeLabelColumn')}
        selection={selection}
        onSelectionChange={onSelectionChange}
        {...shared}
      />
    )
  }

  if (node.type === 'out.profile') {
    // Drawn from the *input*, like the 3D and neuroglancer viewers: the node's own output is
    // a pass-through, so keying the profile on it would show the same table twice over.
    const neurons = inputValues?.neurons
    const dataset = inputValues?.dataset
    return (
      <ProfileViewer
        neurons={isTableValue(neurons) ? neurons : undefined}
        sourceId={isDatasetValue(dataset) ? dataset.sourceId : undefined}
        datasetId={isDatasetValue(dataset) ? dataset.datasetId : undefined}
        // The chain, not just the id: this card names a partner's *type* in words, so without
        // it the tiles would disagree with the ports an inch away.
        annotations={isDatasetValue(dataset) ? dataset.annotations : undefined}
        edges={isDatasetValue(dataset) ? dataset.edges : undefined}
        page={Number(node.params.page ?? 0)}
        onPage={(next) => onParamChange?.('page', next)}
        pinned={selection}
        onPin={(ids) => onParamChange?.('selection', ids)}
        minWeight={Number(node.params.minWeight ?? 1)}
        topN={Number(node.params.topN ?? 10)}
        chips={ctx.columns('chips')}
        {...shared}
      />
    )
  }

  if (node.type === 'out.neuroglancer') {
    // The scene, the segments and the colours are all in the URL the node emitted; the
    // neuron table comes along only so the legend can be drawn beside the frame.
    const neurons = inputValues?.neurons
    /*
     * Which layers of the scene are the app's own, for the splice — see the prop's own note. Both
     * halves come off this node's inputs, which is the only place they exist: the URL cannot carry
     * them, and a published state's preset selections make them unguessable from the scene.
     */
    const dataset = inputValues?.dataset
    const extra = inputValues?.layers
    return (
      <NeuroglancerViewer
        url={asString(value)}
        neurons={isTableValue(neurons) ? neurons : undefined}
        color={readColorSpec('segment', node.params, ctx.column)}
        scale={Number(node.params.uiScale ?? 0.75)}
        viewerType={chosenViewerKind(node.params)}
        datasetId={dataset?.kind === 'dataset' ? dataset.datasetId : undefined}
        extraLayers={extra?.kind === 'layers' ? extra.items.length : 0}
        // The node id, so the card and the overlay are one continuous viewer session rather than
        // two — the same prop, for the same reason, as the 3D viewer's camera and the network
        // viewer's layout. Here it carries the entire neuroglancer state, camera included.
        viewerId={node.id}
        {...shared}
      />
    )
  }

  if (node.type === 'out.dendrogram' && isLinkageValue(value)) {
    return (
      <DendrogramViewer
        linkage={value}
        orientation={node.params.orientation === 'down' ? 'down' : 'right'}
        showLabels={node.params.showLabels !== false}
        selection={selection}
        {...(onSelectionChange ? { onSelectionChange } : {})}
        {...shared}
      />
    )
  }

  if (node.type === 'out.heatmap' && isMatrixValue(value)) {
    return (
      <HeatmapViewer
        matrix={value}
        scale={node.params.scale === 'diverging' ? 'diverging' : 'sequential'}
        showValues={node.params.showValues === true}
        {...shared}
      />
    )
  }

  if (node.type === 'out.scatter' && isTableValue(value)) {
    const x = ctx.column('x')
    const y = ctx.column('y')
    // "Not known yet" and "nothing to pick" are different states and want different words —
    // see `NoColumns`, which is where that distinction now lives for every chart here.
    if (!x || !y) return <NoColumns known={!!schemaOf(ctx.inputs.in)} what="two numeric columns" />
    const label = ctx.column('labelBy')
    const id = ctx.column('idColumn')
    return (
      <ScatterViewer
        table={value}
        xColumn={x}
        yColumn={y}
        xScale={node.params.xLog === true ? 'log' : 'linear'}
        yScale={node.params.yLog === true ? 'log' : 'linear'}
        aspect={node.params.aspect === 'equal' ? 'equal' : 'fit'}
        color={readColorSpec('point', node.params, ctx.column)}
        size={readSizeSpec('point', node.params, ctx.column, { min: 3, max: 12 })}
        shape={readShapeSpec('point', node.params, ctx.column)}
        {...(onParamChange ? { onParamChange } : {})}
        {...(label ? { labelColumn: label } : {})}
        {...(id ? { idColumn: id } : {})}
        opacity={Number(node.params.opacity ?? 0.8)}
        maxPoints={Number(node.params.maxPoints ?? 50000)}
        trend={node.params.trend === 'linear' ? 'linear' : 'none'}
        trendPerGroup={node.params.trendPerGroup !== false}
        selection={selection}
        {...(onSelectionChange ? { onSelectionChange } : {})}
        {...shared}
      />
    )
  }

  if (node.type === 'out.barChart' && isTableValue(value)) {
    const category = ctx.column('category')
    const valueColumn = ctx.column('value')
    const series = node.params.useSeries === true ? ctx.column('series') : undefined
    if (!category || !valueColumn) {
      return (
        <NoColumns
          known={!!schemaOf(ctx.inputs.in)}
          what="a category and a numeric value column"
        />
      )
    }
    return (
      <BarChartViewer
        table={value}
        categoryColumn={category}
        valueColumn={valueColumn}
        {...(series && series !== category ? { seriesColumn: series } : {})}
        sortBars={node.params.sortBars !== false}
        {...shared}
      />
    )
  }

  /*
   * The three charts that bin, slice and summarise, in one block because they answer the same
   * two questions the same way: which column, and what to say when it has not resolved yet.
   *
   * "Not known yet" and "nothing to pick" are different states and get different words — a
   * `core.pivot` publishes its wide schema only once it has run, and again not at all after a
   * reload, so telling somebody to pick a column they cannot see is worse than telling them the
   * columns have not arrived. Same distinction the scatter and bar branches draw above.
   */
  if (node.type === 'out.histogram' && isTableValue(value)) {
    const valueColumn = ctx.column('value')
    if (!valueColumn) {
      return <NoColumns known={!!schemaOf(ctx.inputs.in)} what="a numeric column" />
    }
    const series = ctx.column('series')
    return (
      <HistogramViewer
        table={value}
        valueColumn={valueColumn}
        {...(series && series !== valueColumn ? { seriesColumn: series } : {})}
        binMode={node.params.binMode === 'fixed' ? 'fixed' : 'auto'}
        bins={Number(node.params.bins ?? 30)}
        log={node.params.logX === true}
        normalize={readNormalize(node.params.normalize)}
        cumulative={node.params.cumulative === true}
        selection={selection}
        {...(onSelectionChange ? { onSelectionChange } : {})}
        {...shared}
      />
    )
  }

  if (node.type === 'out.pie' && isTableValue(value)) {
    const category = ctx.column('category')
    if (!category) return <NoColumns known={!!schemaOf(ctx.inputs.in)} what="a category column" />
    const valueColumn = ctx.column('value')
    return (
      <PieViewer
        table={value}
        categoryColumn={category}
        {...(valueColumn && valueColumn !== category ? { valueColumn } : {})}
        shape={node.params.shape === 'pie' ? 'pie' : 'donut'}
        sortSlices={node.params.sortSlices !== false}
        maxSlices={Number(node.params.maxSlices ?? 8)}
        sliceLabels={readSliceLabels(node.params.sliceLabels)}
        selection={selection}
        {...(onSelectionChange ? { onSelectionChange } : {})}
        {...shared}
      />
    )
  }

  if (node.type === 'out.distribution' && isTableValue(value)) {
    const valueColumn = ctx.column('value')
    if (!valueColumn) {
      return <NoColumns known={!!schemaOf(ctx.inputs.in)} what="a numeric column" />
    }
    const group = ctx.column('group')
    return (
      <DistributionViewer
        table={value}
        valueColumn={valueColumn}
        {...(group && group !== valueColumn ? { groupColumn: group } : {})}
        style={readBoxStyle(node.params.style)}
        orientation={node.params.orientation === 'columns' ? 'columns' : 'rows'}
        points={node.params.points === 'none' ? 'none' : 'outliers'}
        whiskers={readWhiskers(node.params.whiskers)}
        log={node.params.logAxis === true}
        sortByMedian={node.params.sortGroups !== false}
        maxGroups={Number(node.params.maxGroups ?? 24)}
        selection={selection}
        {...(onSelectionChange ? { onSelectionChange } : {})}
        {...shared}
      />
    )
  }

  if (isMatrixValue(value)) {
    return <HeatmapViewer matrix={value} {...shared} />
  }

  if (isTableValue(value)) {
    // out.table declares its page size; other nodes fall back to a sensible default.
    const pageSize = Number(node.params.pageSize)
    /*
     * The filter controls are `out.table`'s alone, because it is the only node with a port to
     * put the result on. This same component draws the preview for *every* table in the app —
     * a Filter node's own output, a Group By's, an upload's — and handing those a control that
     * writes `filters` would be a control writing a param the node does not declare.
     *
     * Both halves travel together for the same reason: `TableViewer` reads the pair as one
     * decision, so there is no state in which the row can be edited and not stored.
     */
    const filtering =
      node.type === 'out.table'
        ? {
            // Decoded through a memo keyed on the stored `string[]`, which only changes when
            // somebody edits a filter. Decoding inline would mint a fresh array on every store
            // tick, and the viewer resets its draft whenever this changes identity — throwing
            // away what was being typed, and re-running the filter and the page on every tick.
            filters: filterClauses,
            onFiltersChange: (next: FilterClause[]) =>
              onParamChange?.('filters', encodeClauses(next)),
            showFilters: node.params.showFilters === true,
            onShowFiltersChange: (show: boolean) => onParamChange?.('showFilters', show),
          }
        : {}
    if (summary) return <TableSummary table={value} />
    /*
     * Describe Table draws its *second* port, not the value on its first.
     *
     * Its pass-through is the input unchanged, so drawing `value` would make it a second Table
     * node with a different name. The summary is what the node is for — and it is rebuilt here
     * rather than plumbed through because `ValuePreview` is handed one output value, the
     * primary port's, which for a tap is deliberately the one that carries the input on.
     *
     * That is not a second pass over the data: `describeTable` is memoised on the table object,
     * and this is the very object `evaluate` was given. It also hands back the same result on
     * every render, which is what keeps the viewer's page from resetting under it.
     */
    const drawn = node.type === 'out.describe' ? describeTable(value) : value
    return (
      <TableViewer
        table={drawn}
        pageSize={Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 100}
        {...filtering}
        {...shared}
      />
    )
  }

  if (value.kind === 'dataset') {
    return (
      <div className="viewer">
        <div className="viewer__empty">
          <strong>{value.label}</strong>
          <br />
          {value.sourceId} · {value.datasetId}
        </div>
      </div>
    )
  }

  if (
    isNetworkValue(value) ||
    isSkeletonsValue(value) ||
    isMeshesValue(value) ||
    isPointsValue(value)
  ) {
    // Rendered by the dedicated viewers below; this is the fallback when one is wired
    // somewhere that has no viewer node attached.
    return (
      <div className="viewer">
        <div className="viewer__empty">{describeValue(value)}</div>
      </div>
    )
  }

  /*
   * Scalars print themselves. A layout, a linkage, a transform and a layer set have nothing to
   * draw on their own — an arrangement for someone else's nodes, a tree wired to no Dendrogram, a
   * mapping with nothing passing through it, a layer with no scene to sit in — so all four fall
   * back to the summary the footer shows.
   */
  const summarised =
    value.kind === 'layout' ||
    value.kind === 'linkage' ||
    value.kind === 'transform' ||
    value.kind === 'layers'
  return (
    <div className="viewer">
      <div className="viewer__empty">{summarised ? describeValue(value) : String(value.value)}</div>
    </div>
  )
}

/**
 * Viewers that cost a graphics context, so a second copy of one is not free the way a second
 * `<svg>` is.
 *
 * A list rather than a flag on the definition, and a short one on purpose: what it is really
 * naming is "renders through WebGL", which is a property of the viewer component rather than
 * of the node, and nothing on a `NodeDefinition` knows it. `LazyViewers.tsx` is the other
 * place that knows, for the same reason and about the same two.
 *
 * The value is the noun the stand-down message uses. One table rather than a `Set` beside a
 * `Record`: two lists of the same two node types are two lists that can disagree, and the way
 * they disagree is a panel that stands down and then calls the thing "This viewer".
 */
const HAS_OWN_CONTEXT: Record<string, string> = {
  'out.viewer3d': 'This 3D scene',
  'out.network': 'This network',
}

/** What the inspector shows in place of a second renderer. */
function DrawnElsewhere({ type, onExpand }: { type: string; onExpand?: () => void }) {
  return (
    <div className="viewer">
      <div className="viewer__empty viewer__empty--stacked">
        <span title="A WebGL viewer takes a graphics context and its own copy of the geometry on the GPU, so it is drawn in one place at a time.">
          {HAS_OWN_CONTEXT[type] ?? 'This viewer'} is drawn on its card.
        </span>
        {onExpand && (
          <button type="button" className="btn btn--ghost" onClick={onExpand}>
            Open full size
          </button>
        )}
      </div>
    </div>
  )
}

/*
 * A param read as a list of strings, for the several that are one.
 *
 * Absent is empty, and so is a value of the wrong shape. Loading does not fill missing params
 * with defaults, so a graph saved before a list param existed has no key for it — which has to
 * read as "none of them", not as a reason to throw inside a render.
 */
function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

/**
 * Params arrive as `ParamValue`, so every enum has to be narrowed back to its union somewhere.
 * Here rather than in the viewer: a component that accepted a bare string would have to decide
 * what an unrecognised one means, and the honest answer — the definition's default — is a fact
 * about the node rather than about the drawing.
 */
function roiView(value: unknown): RoiView {
  return value === 'dorsal' || value === 'lateral' ? value : 'frontal'
}

function roiColorMode(value: unknown): RoiColorMode {
  return value === 'preCompleteness' ||
    value === 'region' ||
    value === 'side' ||
    value === 'flat'
    ? value
    : 'postCompleteness'
}

function roiLabelMode(value: unknown): RoiLabelMode {
  return value === 'all' || value === 'off' ? value : 'auto'
}

function skeletonWidthMode(value: unknown): SkeletonWidthMode {
  return value === 'radius' || value === 'world' ? value : 'uniform'
}

function roiHemisphere(value: unknown): 'both' | 'left' | 'right' {
  return value === 'left' || value === 'right' ? value : 'both'
}

function readNormalize(value: unknown): Normalize {
  return value === 'percent' || value === 'density' ? value : 'count'
}

function readSliceLabels(value: unknown): 'percent' | 'value' | 'none' {
  return value === 'value' || value === 'none' ? value : 'percent'
}

function readBoxStyle(value: unknown): DistributionStyle {
  return value === 'violin' || value === 'both' || value === 'swarm' || value === 'swarmBox'
    ? value
    : 'box'
}

function readWhiskers(value: unknown): WhiskerRule {
  return value === 'minmax' || value === 'p5p95' ? value : 'tukey'
}

/**
 * The empty state a chart shows when its column has not resolved.
 *
 * One component rather than five copies, because the *distinction* it draws is the part worth
 * getting right and is easy to lose: a schema that has not arrived is not a table with nothing
 * in it. A `core.pivot` upstream publishes its wide columns only once it has run — and again
 * not at all after a reload — so "pick a column" there names something nobody can see yet.
 *
 * The scatter and the bar chart wrote it inline first, with the distinction spelled out in a
 * comment on each; they go through here now, so the sentence exists once.
 */
function NoColumns({ known, what }: { known: boolean; what: string }) {
  return (
    <div className="viewer">
      <div className="viewer__empty">
        {known ? `Pick ${what} to plot.` : 'Columns not known yet — run the graph.'}
      </div>
    </div>
  )
}
