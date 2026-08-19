import type { GraphNode } from '../../core/graph'
import type { InferContext, ParamValue } from '../../core/node'
import { schemaOf } from '../../core/types'
import type { Value } from '../../core/values'
import {
  asString,
  describeValue,
  isDatasetValue,
  isLayoutValue,
  isMatrixValue,
  isMeshesValue,
  isNetworkValue,
  isPointsValue,
  isSkeletonsValue,
  isTableValue,
} from '../../core/values'
import { readColorSpec, readSizeSpec } from '../../nodes/lib/encodingParams'
import { BarChartViewer } from './BarChartViewer'
import { HeatmapViewer } from './HeatmapViewer'
import { LazyNetworkViewer, LazyViewer3D } from './LazyViewers'
import { NeuroglancerViewer } from './NeuroglancerViewer'
import { DatasetSummaryViewer } from './DatasetSummaryViewer'
import { RoisViewer } from './RoisViewer'
import type { RoiColorMode, RoiLabelMode } from './RoisViewer'
import type { RoiView } from './roiProjection'
import { ProfileViewer } from './ProfileViewer'
import { ExportNodeContext } from './exportRegistry'
import { ScatterViewer } from './ScatterViewer'
import type { LayoutName } from './networkLayout'
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
}: ValuePreviewProps) {
  // Forwarded to every viewer; kept in one place so a new viewer can't forget export.
  const shared = {
    compact,
    ...(baseName ? { baseName } : {}),
    ...(onExpand ? { onExpand } : {}),
    ...(onError ? { onError } : {}),
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
        superRois={Array.isArray(node.params.superRois) ? (node.params.superRois as string[]) : []}
        opacity={Number(node.params.opacity ?? 0.12)}
        refresh={Number(node.params.refresh ?? 0)}
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

  const selection = (Array.isArray(node.params.selection) ? node.params.selection : []).map(
    String,
  )

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
        layout={String(node.params.layout ?? 'forceatlas2') as LayoutName}
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
        // Keyed to the graph node, so a layout settled in the overlay is still there when it
        // is reopened — and is shared with the card and the inspector.
        viewerId={node.id}
        nodeColor={readColorSpec('node', node.params, ctx.column)}
        nodeSize={readSizeSpec('node', node.params, ctx.column, { min: 4, max: 18 })}
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

  if (node.type === 'out.viewer3d') {
    // The 3D node's own output is the *selection*; the scene comes from its inputs.
    const skeletons = inputValues?.skeletons
    const meshes = inputValues?.meshes
    const points = inputValues?.points
    return (
      <LazyViewer3D
        skeletons={isSkeletonsValue(skeletons) ? skeletons : undefined}
        meshes={isMeshesValue(meshes) ? meshes : undefined}
        points={isPointsValue(points) ? points : undefined}
        skeletonColor={readColorSpec('skeleton', node.params, ctx.column)}
        meshColor={readColorSpec('mesh', node.params, ctx.column)}
        pointColor={readColorSpec('point', node.params, ctx.column)}
        skeletonWidth={Number(node.params.skeletonWidth ?? 1)}
        meshOpacity={Number(node.params.meshOpacity ?? 0.25)}
        pointSize={Number(node.params.pointSize ?? 60)}
        background={String(node.params.background ?? 'theme') as 'theme' | 'dark' | 'light'}
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
    return (
      <NeuroglancerViewer
        url={asString(value)}
        neurons={isTableValue(neurons) ? neurons : undefined}
        color={readColorSpec('segment', node.params, ctx.column)}
        scale={Number(node.params.uiScale ?? 0.75)}
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
    if (!x || !y) {
      // "Not known yet" and "nothing to pick" are different states and want different words.
      // A Pivot publishes its wide schema only once it has run — and not again until it does
      // after a reload — so telling someone to pick a column they cannot see is worse than
      // telling them the columns have not arrived.
      const known = schemaOf(ctx.inputs.in)
      return (
        <div className="viewer">
          <div className="viewer__empty">
            {known
              ? 'Pick two numeric columns to plot.'
              : 'Columns not known yet — run the graph.'}
          </div>
        </div>
      )
    }
    const shape = ctx.column('shapeBy')
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
        {...(shape ? { shapeColumn: shape } : {})}
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
      // Same distinction the scatter branch draws: a Pivot publishes its wide schema only
      // once it has run, so before that there is nothing to pick rather than a bad pick.
      return (
        <div className="viewer">
          <div className="viewer__empty">
            {schemaOf(ctx.inputs.in)
              ? 'Pick a category and a numeric value column to plot.'
              : 'Columns not known yet — run the graph.'}
          </div>
        </div>
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

  if (isMatrixValue(value)) {
    return <HeatmapViewer matrix={value} {...shared} />
  }

  if (isTableValue(value)) {
    // out.table declares its page size; other nodes fall back to a sensible default.
    const pageSize = Number(node.params.pageSize)
    return (
      <TableViewer
        table={value}
        pageSize={Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 100}
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

  // Scalars print themselves; a layout has nothing to draw on its own — it is an arrangement
  // for someone else's nodes — so it falls back to the same summary the footer shows.
  return (
    <div className="viewer">
      <div className="viewer__empty">
        {value.kind === 'layout' ? describeValue(value) : String(value.value)}
      </div>
    </div>
  )
}

/*
 * Params arrive as `ParamValue`, so every enum has to be narrowed back to its union somewhere.
 * Here rather than in the viewer: a component that accepted a bare string would have to decide
 * what an unrecognised one means, and the honest answer — the definition's default — is a fact
 * about the node rather than about the drawing.
 */
function roiView(value: unknown): RoiView {
  return value === 'dorsal' || value === 'lateral' ? value : 'frontal'
}

function roiColorMode(value: unknown): RoiColorMode {
  return value === 'preCompleteness' || value === 'region' || value === 'side' || value === 'flat'
    ? value
    : 'postCompleteness'
}

function roiLabelMode(value: unknown): RoiLabelMode {
  return value === 'all' || value === 'off' ? value : 'auto'
}

function roiHemisphere(value: unknown): 'both' | 'left' | 'right' {
  return value === 'left' || value === 'right' ? value : 'both'
}
