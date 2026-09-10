import { useMemo } from 'react'

import type { GraphNode } from '../../core/graph'
import type { InferContext, ParamValue } from '../../core/node'
import { enumValue } from '../../core/node'
import { filledParams, getNodeDef } from '../../core/registry'
import { schemaOf } from '../../core/types'
import type { Value } from '../../core/values'
import type { PartnerGrouping } from '../../nodes/lib/profileStats'
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
import {
  heatmapLogColor,
  heatmapPaletteOf,
  readColorLimits,
} from '../../nodes/lib/heatmapParams'
import { LazyNetworkViewer, LazyViewer3D } from './LazyViewers'
import type { BackgroundChoice } from './viewer3dScene'
import { NeuroglancerViewer } from './NeuroglancerViewer'
import { chosenViewerKind } from '../../nodes/output/neuroglancer'
import { widthModeOf } from '../../nodes/output/viewer3d'
import { DatasetSummaryViewer } from './DatasetSummaryViewer'
import { NetworkMetricsViewer } from './NetworkMetricsViewer'
import { roisPrimaryOnly } from '../../nodes/lib/roiViewParams'
import { readWeightProperty } from '../../nodes/lib/datasetParam'
import { RoisViewer } from './RoisViewer'
import type { RoiColorMode, RoiLabelMode } from './RoisViewer'
import type { RoiView } from './roiProjection'
import { ProfileViewer } from './ProfileViewer'
import { TopologyViewer } from './TopologyViewer'
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
 * One empty list, shared.
 *
 * A fresh `[]` per render is a fresh identity, and these reach viewer dep arrays — see the
 * `superRois` note below for the one that costs a relaxation solve per pointer move.
 */
const NO_IDS: string[] = []

/**
 * Picks a viewer for a node's output.
 *
 * Driven by the node's *type* first (an `out.heatmap` renders a heatmap, using its own
 * scale params) and falls back to the value's kind, so selecting any node in the graph
 * shows something useful in the inspector — not just the dedicated output nodes.
 *
 * Also names the node every viewer below is drawing, so `ViewerActions` can publish its picture.
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
   * The params every branch reads, each declared default filled (`withDefaults`), so a branch
   * reads `params.x` rather than writing the default out a second time beside it — the copy
   * invariant 4 names, which drifts the day a declaration changes. An enum is read off its
   * declared options (`enumValue`), for the same reason.
   */
  const def = getNodeDef(node.type)
  const params = filledParams(node)
  const choice = <T extends string>(id: string): T =>
    def ? enumValue<T>(def, params, id) : (String(params[id]) as T)

  /*
   * Up here rather than in the table branch below, because this component returns early a
   * dozen times and a hook after a conditional return is not a hook. Keyed on the stored
   * `string[]`, which changes only when somebody edits a filter — decoding inline would mint a
   * fresh array every store tick, and `TableViewer` resets its draft whenever this changes
   * identity, so it would discard what was being typed and re-filter and re-page on each one.
   */
  const filterClauses = useMemo(() => decodeClauses(params.filters), [params.filters])

  /*
   * Up here for the same reason, and keyed the same way — on the stored `string[]`, which
   * changes only when a viewer writes a selection. `idList` copies, six viewers key memos and
   * effects on the result, and a heatmap rectangle over a wide matrix is thousands of entries:
   * minted fresh per render it would defeat every one of those memos on every store tick.
   */
  const selection = useMemo(() => idList(params.selection), [params.selection])

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
        status={String(params.status)}
        attributes={ctx.columns('attributes')}
        // Absence spelled the way `absentMeans` spells it, never as the default: a stored node
        // with no key predates the control and meant the whole list. `deserializeGraph` writes
        // it in, so this is the belt to that document's braces.
        chartsMode={params.chartsMode === 'add' ? 'add' : 'replace'}
        topTypes={Number(params.topTypes)}
        measure={choice<'pre' | 'post'>('completenessMeasure')}
        onMeasure={(measure) => onParamChange?.('completenessMeasure', measure)}
        sort={choice<'label' | 'value'>('completenessSort')}
        onSort={(sort) => onParamChange?.('completenessSort', sort)}
        onReload={() => onParamChange?.('refresh', Number(params.refresh) + 1)}
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
        view={choice<RoiView>('view')}
        explode={Number(params.explode)}
        colorBy={choice<RoiColorMode>('colorBy')}
        labels={choice<RoiLabelMode>('labels')}
        hemisphere={choice<'both' | 'left' | 'right'>('hemisphere')}
        primaryOnly={roisPrimaryOnly(params)}
        // A shared constant, not a fresh `[]`: this prop reaches `shown`'s dep array, and a new
        // identity per render voids the projection *and* `relaxShifts` — 220 passes over n²/2
        // pairs — on every pointer move of a pan. `withDefaults` fills an absent key with its own
        // shared empty list, so this now guards only a value that is not a list at all.
        superRois={Array.isArray(params.superRois) ? (params.superRois as string[]) : NO_IDS}
        opacity={Number(params.opacity)}
        refresh={Number(params.refresh)}
        {...(onParamChange ? { onParamChange } : {})}
        {...shared}
      />
    )
  }

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
    if (skeletons || meshes || points || volumes)
      return (
        <LazyViewer3D
          skeletons={isSkeletonsValue(skeletons) ? skeletons : undefined}
          meshes={isMeshesValue(meshes) ? meshes : undefined}
          points={isPointsValue(points) ? points : undefined}
          volumes={isMeshesValue(volumes) ? volumes : undefined}
          skeletonColor={readColorSpec('skeleton', params, ctx.column)}
          meshColor={readColorSpec('mesh', params, ctx.column)}
          pointColor={readColorSpec('point', params, ctx.column)}
          volumeColor={readColorSpec('volume', params, ctx.column)}
          skeletonWidth={Number(params.skeletonWidth)}
          skeletonWidthMode={widthModeOf(params)}
          skeletonRadiusWidth={Number(params.skeletonRadiusWidth)}
          skeletonWorldWidth={Number(params.skeletonWorldWidth)}
          lightIntensity={Number(params.lightIntensity)}
          // Defaults to false, so a graph saved before this param existed opens with the
          // scene unpickable — which is the new default rather than a migration.
          selectByClick={params.selectByClick === true}
          // `Number` rather than a cast, and it covers the alpha graphs that stored this as a
          // boolean before it became a strength: `true` is 1 and `false` is 0, which is exactly
          // what those two meant.
          ambientOcclusion={Number(params.ambientOcclusion)}
          meshOpacity={Number(params.meshOpacity)}
          pointSize={Number(params.pointSize)}
          volumeOpacity={Number(params.volumeOpacity)}
          // The node id, so the card and the overlay share one camera instead of resetting each
          // other — the same prop the network viewer takes for its layout and camera.
          viewerId={node.id}
          background={choice<BackgroundChoice>('background')}
          refit={params.refit === true}
          // Through the reader beside `readColorSpec`, because `colorParams({ legend })` is what
          // names these params — spelling `skeletonHidden` here is a fifth place that has to agree
          // with the factory that generates it and the viewer that writes it back.
          hidden={{
            skeleton: readHiddenKeys('skeleton', params),
            mesh: readHiddenKeys('mesh', params),
            point: readHiddenKeys('point', params),
            volume: readHiddenKeys('volume', params),
          }}
          shown={{
            skeletons: params.showSkeletons !== false,
            meshes: params.showMeshes !== false,
            points: params.showPoints !== false,
            volumes: params.showVolumes !== false,
          }}
          selection={selection}
          onSelectionChange={onSelectionChange}
          {...(onParamChange ? { onParamChange } : {})}
          {...shared}
        />
      )
  }

  /*
   * Above the `!value` guard, on `out.viewer3d`'s terms: the card is drawn from the *input*
   * network, so it has something to show the moment the node upstream has run rather than one
   * scheduler step later. Reading the input is also what makes the card free — `networkMetrics`
   * is memoised on the network object, and the input is the object `evaluate` was handed, so
   * the card and the run share one triangle count. Drawing the node's own `out` network would
   * be a different object and therefore a second one.
   *
   * Gated on the input actually being a network, so a graph that has never run says "No result
   * yet" instead of rendering an empty tile grid.
   */
  if (node.type === 'net.metrics' && isNetworkValue(inputValues?.in)) {
    return (
      <NetworkMetricsViewer
        network={inputValues.in}
        plotX={ctx.column('plotX')}
        plotY={ctx.column('plotY')}
        histColumn={String(params.histColumn)}
        bins={Number(params.bins)}
        histVertical={params.histVertical === true}
        logScale={params.logScale === true}
        /*
         * The param ids stay in the dispatcher, where every other node's are — the card knows
         * it is changing an axis, not which key that is stored under.
         *
         * Spread rather than four `onParamChange?.(…)` arrows, because an arrow that swallows
         * the call is still a function: the card would see a writer on every surface and draw
         * live-looking controls that do nothing on the one surface that cannot store them.
         */
        {...(onParamChange
          ? {
              onPlotX: (next: string) => onParamChange('plotX', next),
              onPlotY: (next: string) => onParamChange('plotY', next),
              onHistColumn: (next: string) => onParamChange('histColumn', next),
              onBins: (next: number) => onParamChange('bins', next),
              onHistVertical: (next: boolean) => onParamChange('histVertical', next),
            }
          : {})}
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
        layout={choice<LayoutName>('layout')}
        iterations={Number(params.iterations)}
        xColumn={ctx.column('xColumn')}
        yColumn={ctx.column('yColumn')}
        orientation={choice<'tb' | 'lr'>('layoutOrientation')}
        layerColumn={ctx.column('layerColumn')}
        groupColumn={ctx.column('groupColumn')}
        seed={choice<'spectral' | 'circle'>('seed')}
        barnesHut={choice<'on' | 'off' | 'auto'>('barnesHut')}
        weightInfluence={Number(params.weightInfluence)}
        // `separate` is the default and the reason the layout is here; anything else is the
        // explicit "all at once" comparison. See `prefusePositions`.
        partition={params.partition !== 'together'}
        springLength={Number(params.springLength)}
        // Keyed to the graph node, so a layout settled in the overlay is still there when it
        // is reopened — and is shared with the card and the inspector.
        viewerId={node.id}
        nodeColor={readColorSpec('node', params, ctx.column)}
        nodeSize={readSizeSpec('node', params, ctx.column, { min: 4, max: 18 })}
        nodeShape={readShapeSpec('node', params, ctx.column)}
        {...(onParamChange ? { onParamChange } : {})}
        nodeBorderWidth={Number(params.nodeBorderWidth)}
        edgeColor={readColorSpec('edge', params, ctx.column)}
        edgeSize={readSizeSpec('edge', params, ctx.column, { min: 0.5, max: 6 })}
        edgeOpacity={Number(params.edgeOpacity)}
        showLabels={params.showLabels !== false}
        labelColumn={ctx.column('labelColumn')}
        arrows={params.arrows !== false}
        edgeLabels={params.edgeLabels === true}
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
        // Resolved through `ctx.column` like every other picker, so the profile's subject and
        // the inspector's control cannot disagree about which column is set.
        groupBy={ctx.column('groupBy')}
        page={Number(params.page)}
        onPage={(next) => onParamChange?.('page', next)}
        pinned={selection}
        onPin={(ids) => onParamChange?.('selection', ids)}
        minWeight={Number(params.minWeight)}
        countBy={readWeightProperty(params.countBy)}
        topN={Number(params.topN)}
        chips={ctx.columns('chips')}
        {...shared}
      />
    )
  }

  if (node.type === 'out.topology') {
    // Drawn from the *input*, like Profile and the 3D viewer: this node's own `out` port is a
    // pass-through, so keying the card on it would show the same table twice over.
    const neurons = inputValues?.neurons
    const dataset = inputValues?.dataset
    return (
      <TopologyViewer
        neurons={isTableValue(neurons) ? neurons : undefined}
        sourceId={isDatasetValue(dataset) ? dataset.sourceId : undefined}
        datasetId={isDatasetValue(dataset) ? dataset.datasetId : undefined}
        annotations={isDatasetValue(dataset) ? dataset.annotations : undefined}
        edges={isDatasetValue(dataset) ? dataset.edges : undefined}
        page={Number(params.page)}
        onPage={(next) => onParamChange?.('page', next)}
        pinned={selection}
        onPin={(ids) => onParamChange?.('selection', ids)}
        colorBy={choice('colorBy')}
        onColorBy={(value) => onParamChange?.('colorBy', value)}
        showMesh={params.showMesh !== false}
        showSkeleton={params.showSkeleton !== false}
        showSynapses={params.showSynapses !== false}
        onLayer={(id, on) => onParamChange?.(id, on)}
        partners={idList(params.partners)}
        onPartners={(next) => onParamChange?.('partners', next)}
        grouping={choice<PartnerGrouping>('grouping')}
        onGrouping={(value) => onParamChange?.('grouping', value)}
        direction={choice('direction')}
        onDirection={(value) => onParamChange?.('direction', value)}
        partnerQuery={String(params.partnerQuery)}
        onPartnerQuery={(value) => onParamChange?.('partnerQuery', value)}
        tab={choice('tab')}
        onTab={(value) => onParamChange?.('tab', value)}
        railOpen={params.railOpen !== false}
        onRailOpen={(open) => onParamChange?.('railOpen', open)}
        // The one control here that is data rather than presentation: it adds columns to the
        // Morphometrics port, so writing it marks the graph stale.
        split={params.split === true}
        onSplit={(on) => onParamChange?.('split', on)}
        flowThresh={Number(params.flowThresh)}
        splitVal={Number(params.splitVal)}
        onSplitParam={(id, value) => onParamChange?.(id, value)}
        heal={params.heal === true}
        onHeal={(on) => onParamChange?.('heal', on)}
        pointSize={Number(params.pointSize)}
        skeletonWidth={Number(params.skeletonWidth)}
        skeletonOpacity={Number(params.skeletonOpacity)}
        dimOpacity={Number(params.dimOpacity)}
        meshOpacity={Number(params.meshOpacity)}
        skeletonColor={String(params.skeletonColor)}
        onSkeletonColor={(hex) => onParamChange?.('skeletonColor', hex)}
        onVisual={(id, value) => onParamChange?.(id, value)}
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
        color={readColorSpec('segment', params, ctx.column)}
        scale={Number(params.uiScale)}
        viewerType={chosenViewerKind(params)}
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
    // The value on the second port, not the type: a wire says a table is coming, and only a run
    // says what is in it. Unwired, muted or not yet run are one state here and all three draw
    // the tree's own labels — the reading `out.viewer3d` and `out.rois` take of the same field.
    const annotations = inputValues?.annotations
    // Through `ctx.column`, never `ctx.params` — invariant 5, and what keeps the picture from
    // naming a column the emitted notebook would not.
    const matchColumn = ctx.column('matchColumn')
    const labelColumn = ctx.column('labelColumn')
    return (
      <DendrogramViewer
        linkage={value}
        orientation={choice<'down' | 'right'>('orientation')}
        showLabels={params.showLabels !== false}
        {...(isTableValue(annotations) ? { annotations } : {})}
        {...(matchColumn ? { matchColumn } : {})}
        {...(labelColumn ? { labelColumn } : {})}
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
        scale={choice<'diverging' | 'sequential'>('scale')}
        palette={heatmapPaletteOf(params)}
        limits={readColorLimits(params)}
        logColor={heatmapLogColor(params)}
        showValues={params.showValues === true}
        // The param verbatim: both axes live in one `ids` param, so a rectangle is one commit
        // and an undo takes back the whole of it. `chartSelection.ts` owns the grammar.
        selection={selection}
        {...(onSelectionChange ? { onSelectionChange } : {})}
        {...shared}
      />
    )
  }

  if (node.type === 'out.scatter' && isTableValue(value)) {
    const x = ctx.column('x')
    const y = ctx.column('y')
    // "Not known yet" and "nothing to pick" are different states and want different words —
    // see `NoColumns`, which is where that distinction now lives for every chart here.
    if (!x || !y)
      return <NoColumns known={!!schemaOf(ctx.inputs.in)} what="two numeric columns" />
    const label = ctx.column('labelBy')
    const id = ctx.column('idColumn')
    return (
      <ScatterViewer
        table={value}
        xColumn={x}
        yColumn={y}
        xScale={params.xLog === true ? 'log' : 'linear'}
        yScale={params.yLog === true ? 'log' : 'linear'}
        aspect={choice<'equal' | 'fit'>('aspect')}
        color={readColorSpec('point', params, ctx.column)}
        size={readSizeSpec('point', params, ctx.column, { min: 3, max: 12 })}
        shape={readShapeSpec('point', params, ctx.column)}
        {...(onParamChange ? { onParamChange } : {})}
        {...(label ? { labelColumn: label } : {})}
        {...(id ? { idColumn: id } : {})}
        opacity={Number(params.opacity)}
        maxPoints={Number(params.maxPoints)}
        trend={choice<'linear' | 'none'>('trend')}
        trendPerGroup={params.trendPerGroup !== false}
        selection={selection}
        {...(onSelectionChange ? { onSelectionChange } : {})}
        {...shared}
      />
    )
  }

  if (node.type === 'out.barChart' && isTableValue(value)) {
    const category = ctx.column('category')
    const valueColumn = ctx.column('value')
    const series = params.useSeries === true ? ctx.column('series') : undefined
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
        sortBars={params.sortBars !== false}
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
        binMode={choice<'fixed' | 'auto'>('binMode')}
        bins={Number(params.bins)}
        log={params.logX === true}
        normalize={choice<Normalize>('normalize')}
        cumulative={params.cumulative === true}
        selection={selection}
        {...(onSelectionChange ? { onSelectionChange } : {})}
        {...shared}
      />
    )
  }

  if (node.type === 'out.pie' && isTableValue(value)) {
    const category = ctx.column('category')
    if (!category)
      return <NoColumns known={!!schemaOf(ctx.inputs.in)} what="a category column" />
    const valueColumn = ctx.column('value')
    return (
      <PieViewer
        table={value}
        categoryColumn={category}
        {...(valueColumn && valueColumn !== category ? { valueColumn } : {})}
        shape={choice<'pie' | 'donut'>('shape')}
        sortSlices={params.sortSlices !== false}
        maxSlices={Number(params.maxSlices)}
        sliceLabels={choice<'percent' | 'value' | 'none'>('sliceLabels')}
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
        style={choice<DistributionStyle>('style')}
        orientation={choice<'columns' | 'rows'>('orientation')}
        points={choice<'none' | 'outliers'>('points')}
        whiskers={choice<WhiskerRule>('whiskers')}
        log={params.logAxis === true}
        sortByMedian={params.sortGroups !== false}
        maxGroups={Number(params.maxGroups)}
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
    const pageSize = Number(params.pageSize)
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
            showFilters: params.showFilters === true,
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
      <div className="viewer__empty">
        {summarised ? describeValue(value) : String(value.value)}
      </div>
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
