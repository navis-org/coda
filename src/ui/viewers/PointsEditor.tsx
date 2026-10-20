/**
 * Skeleton to Points' expanded view under `placed by hand`: a neuron's dendrogram to click points
 * onto, the neuron in 3D beside it to see where they are, and the list of what is placed.
 *
 * The Split Axon/Dendrite editor's pairing of layers — `arborLayout`, the shared stage
 * (`useArborStage`), `pickPiece`/`arborPointAt` — with a 3D arbour beside it that is for looking
 * only: picking is on the dendrogram, which has no depth to pick through. A click stores the point
 * on the edge where it landed, not the nearest node (`ManualPoint`), as a position in the
 * skeleton's frame, so a re-fetch that renumbers the nodes leaves it where it was; the list beside
 * it names each point (`name`). The node is `cheap` and re-runs at once; the marks here are drawn
 * from the stored points themselves, so a click shows before the run comes back.
 */

import { memo, useMemo, useState } from 'react'

import { ID_COLUMN_NAME, idText } from '../../core/ids'
import { SNAP_NM } from '../../nodes/lib/anchors'
import { constantColor } from '../../nodes/lib/encodingParams'
import type { ParamValue } from '../../core/node'
import { column, tableSchema } from '../../core/types'
import type { PointsValue, SkeletonGeometry, SkeletonsValue } from '../../core/values'
import { boundsOf, getRow, makeTable } from '../../core/values'
import { DAYLIGHT_PASSES, SUBWAY_DEFAULTS } from '../../nodes/lib/arborLayout'
import type { Arbor, Placement } from '../../nodes/lib/arborOps'
import {
  distanceAt,
  keyTree,
  landmarkDistances,
  orientPlacement,
} from '../../nodes/lib/arborOps'
import { elementAt } from '../../nodes/lib/iterables'
import type { ManualPoint } from '../../nodes/lib/skeletonPoints'
import {
  MANUAL_PARAM,
  manualPointAt,
  projectManual,
  readManualPoints,
  writeManualPoint,
} from '../../nodes/lib/skeletonPoints'
import { splitArbor } from '../../nodes/lib/splitCorrections'
import { NM_PER_UM } from '../../data/units'
import { CHART_INK, chartSurface, seriesColor } from '../../style/colors'
import { plural } from '../../style/format'
import { currentMode } from '../useThemeMode'
import { arborPointAt, pickPiece, synapseMarks } from './arborPlot'
import type { TickGroup } from './arborScene'
import { buildScene } from './arborScene'
import { LazyViewer3D } from './LazyViewers'
import { Pager } from './Pager'
import { TopoName, neuronLabel } from './topoChrome'
import { tooltipPoint } from './tooltipPoint'
import { useArborLayout } from './useArborLayout'
import { useArborStage, usePaintedScene } from './useArborStage'
import { ViewerEmpty } from './ViewerEmpty'
import { TextField } from '../params/ParamField'

export interface PointsEditorProps {
  /** The node's `Skeletons` input: the neurons points are placed on. */
  skeletons: SkeletonsValue
  /** The stored `points` param, as it is. */
  points: unknown
  /** The node's key in its workflow, for the 3D view's kept renderer. */
  viewerKey: string
  onParamChange?: ((paramId: string, value: ParamValue) => void) | undefined
}

const LINE_WIDTH = 1.5

/**
 * Where on the arbour each of a neuron's stored points lands — the node's own rule
 * (`projectManual`), so the list and the output agree on which points are stale — and its path
 * distance from the root, µm, null for a stale one.
 */
function landing(skeleton: SkeletonGeometry, arbor: Arbor, mine: readonly ManualPoint[]) {
  const placement: Placement = orientPlacement(arbor, projectManual(skeleton, mine))
  const fromRoot = Array.from(placement.node, (node, i) =>
    node < 0
      ? null
      : distanceAt(arbor, arbor.geodesic, { node, t: placement.t[i]! }) / NM_PER_UM,
  )
  return { placement, fromRoot }
}

export function PointsEditor({
  skeletons,
  points,
  viewerKey,
  onParamChange,
}: PointsEditorProps) {
  const mode = currentMode()
  const [page, setPage] = useState(0)
  const index = Math.min(page, Math.max(0, skeletons.items.length - 1))
  const skeleton = skeletons.items[index]
  const row = getRow(skeletons.attributes, index)
  const neuronName = neuronLabel(row, skeleton?.id)

  const stored = useMemo(() => readManualPoints(points), [points])
  const mine = useMemo(
    () => stored.filter((point) => point.neuron === skeleton?.id),
    [stored, skeleton],
  )

  /* --- the arbour, laid out unrooted as the split editor's is ----------------------------- */

  const arbor = useMemo(() => (skeleton ? splitArbor(skeleton) : undefined), [skeleton])
  const tree = useMemo(() => (arbor ? keyTree(arbor) : undefined), [arbor])
  const landmarkD = useMemo(
    () => (tree && arbor ? landmarkDistances(tree, arbor.geodesic) : undefined),
    [tree, arbor],
  )
  const { shape } = useArborLayout('equalAngle', tree, landmarkD, {
    order: 'balanced',
    subway: SUBWAY_DEFAULTS,
    daylight: DAYLIGHT_PASSES,
  })

  /* --- the points --------------------------------------------------------------------------- */

  const landed = useMemo(
    () => (skeleton && arbor ? landing(skeleton, arbor, mine) : undefined),
    [skeleton, arbor, mine],
  )
  const marks = useMemo(
    () =>
      tree && landmarkD && arbor && landed
        ? synapseMarks(tree, landmarkD, arbor, arbor.geodesic, landed.placement, () => 'post')
        : undefined,
    [tree, landmarkD, arbor, landed],
  )
  const ink = CHART_INK[mode]
  const accent = seriesColor(0, mode)
  const ticks = useMemo(
    (): TickGroup[] =>
      marks
        ? [
            {
              color: accent,
              alpha: 1,
              rows: Int32Array.from(marks.piece.keys()).filter((s) => marks.piece[s]! >= 0),
            },
          ]
        : [],
    [marks, accent],
  )

  /* --- the stage ---------------------------------------------------------------------------- */

  const stage = useArborStage(shape, skeleton?.id)
  const { stageRef, canvasRef, transform, pieces, panning, handlers } = stage
  const scene = useMemo(() => {
    if (!shape || !transform || !pieces || !tree) return undefined
    return buildScene({
      width: transform.width,
      height: transform.height,
      background: chartSurface(mode),
      title: `${neuronName}, points placed by hand`,
      ink: { line: ink.secondary, text: ink.primary, accent },
      shape,
      transform,
      pieces,
      settled: true,
      tree,
      lineWidth: LINE_WIDTH,
      ticks,
      synapseSize: 9,
      ...(marks ? { marks } : {}),
    })
  }, [shape, transform, pieces, tree, marks, ticks, mode, neuronName, ink, accent])
  usePaintedScene(canvasRef, scene)

  /* --- the 3D view: this neuron and its points, to look at ---------------------------------- */

  const one = useMemo(() => elementAt(skeletons, index), [skeletons, index])
  const cloud = useMemo((): PointsValue | undefined => {
    if (mine.length === 0) return undefined
    const positions = new Float32Array(mine.flatMap(({ at }) => at))
    return {
      kind: 'points',
      positions,
      attributes: makeTable(tableSchema(column(ID_COLUMN_NAME, 'str')), {
        [ID_COLUMN_NAME]: mine.map((point) => point.neuron),
      }),
      bounds: boundsOf([positions]),
      ...(skeletons.units ? { units: skeletons.units } : {}),
      ...(skeletons.space ? { space: skeletons.space } : {}),
    }
  }, [mine, skeletons.units, skeletons.space])

  /* --- placing ------------------------------------------------------------------------------ */

  const write = (next: readonly ManualPoint[]) =>
    onParamChange?.(MANUAL_PARAM, next.map(writeManualPoint))

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onParamChange || !skeleton || !pieces || !tree || !arbor || !landmarkD) return
    const point = tooltipPoint(event, event.currentTarget)
    const hit = pickPiece(pieces, point.x, point.y)
    if (!hit) return
    const on = arborPointAt(arbor, tree, landmarkD, arbor.geodesic, hit.piece, hit.along)
    const at = manualPointAt(skeleton.positions, arbor.parent, on)
    write([...stored, { neuron: skeleton.id, at }])
  }

  if (!skeleton) return <ViewerEmpty>No skeletons to place points on.</ViewerEmpty>

  const id = idText(row?.[ID_COLUMN_NAME]) ?? skeleton.id
  return (
    <div className="points-editor">
      <div className="topo__bar">
        <Pager
          index={index}
          total={skeletons.items.length}
          onStep={(delta) => setPage(index + delta)}
          unit="neuron"
        />
        <TopoName name={neuronName} neuronId={id} />
        <span className="topo__count">{plural(mine.length, 'point')}</span>
      </div>

      <div className="points-editor__main">
        <div
          ref={stageRef}
          className="arbor__plot nodrag"
          data-panning={panning || undefined}
          data-zoomed={stage.zoomed || undefined}
          {...handlers}
          onClick={onClick}
          onDoubleClick={stage.resetView}
        >
          <canvas
            ref={canvasRef}
            className="arbor__canvas"
            aria-label={`${neuronName}: click to place a point`}
          />
        </div>

        <div className="points-editor__scene">
          <PointsScene
            skeletons={one}
            points={cloud}
            frameKey={skeleton.id}
            line={ink.secondary}
            accent={accent}
            viewerId={`${viewerKey}:points`}
          />
        </div>

        <aside className="split-editor__list" aria-label="Points on this neuron">
          <h4>Points</h4>
          {mine.length === 0 ? (
            <p className="split-editor__hint">
              Click a branch on the dendrogram to place a point there.
            </p>
          ) : (
            <>
              <ol>
                {mine.map((point, i) => {
                  const distance = landed?.fromRoot[i]
                  return (
                    <li key={i} className="points-editor__point">
                      {onParamChange && (
                        <TextField
                          label={`Name of point ${i + 1}`}
                          value={point.name ?? ''}
                          placeholder={`point ${i + 1}`}
                          title="Its `name` column: a trace label in Simulate Model, or a partner in a Compartment Model, where points sharing a name fire together"
                          // Committed on Enter or blur, not per keystroke: each commit re-runs the node.
                          debounce={false}
                          onChange={(name) => {
                            // A blur commits whatever is there; an unchanged name is no edit.
                            if (name.trim() === (point.name ?? '')) return
                            write(stored.map((x) => (x === point ? { ...x, name } : x)))
                          }}
                        />
                      )}
                      <span
                        className="points-editor__distance"
                        title={
                          distance == null
                            ? `More than ${SNAP_NM / NM_PER_UM} µm from this neuron’s cable, so it is not placed.`
                            : 'Path distance from the root'
                        }
                      >
                        {distance == null ? 'not on the cable' : `${distance.toFixed(1)} µm`}
                      </span>
                      {onParamChange && (
                        <button
                          type="button"
                          className="btn btn--ghost rename-body__remove nodrag"
                          aria-label={`Remove point ${i + 1}`}
                          title="Remove this point"
                          onClick={() => write(stored.filter((x) => x !== point))}
                        >
                          ✕
                        </button>
                      )}
                    </li>
                  )
                })}
              </ol>
              {onParamChange && (
                <button
                  type="button"
                  className="btn btn--ghost nodrag"
                  onClick={() => write(stored.filter((x) => x.neuron !== skeleton.id))}
                >
                  Clear this neuron
                </button>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

const NO_SELECTION: string[] = []
const NOTHING_HIDDEN = { skeleton: [], mesh: [], point: [], volume: [] }
const SHOWN = { skeletons: true, meshes: false, points: true, volumes: false }

/**
 * The 3D half, apart and memoised: the dendrogram's pan and zoom re-render the editor on every
 * frame of a drag, and none of that changes what is drawn here.
 */
const PointsScene = memo(function PointsScene({
  skeletons,
  points,
  frameKey,
  line,
  accent,
  viewerId,
}: {
  skeletons: SkeletonsValue
  points: PointsValue | undefined
  frameKey: string
  line: string
  accent: string
  viewerId: string
}) {
  const colors = useMemo(
    () => ({ line: constantColor(line), accent: constantColor(accent) }),
    [line, accent],
  )
  return (
    <LazyViewer3D
      skeletons={skeletons}
      frameKey={frameKey}
      {...(points ? { points } : {})}
      skeletonColor={colors.line}
      meshColor={colors.line}
      pointColor={colors.accent}
      // No volumes are shown; the prop is required.
      volumeColor={colors.line}
      skeletonWidth={1.5}
      skeletonWidthMode="uniform"
      skeletonRadiusWidth={3}
      skeletonWorldWidth={1}
      lightIntensity={1}
      meshOpacity={1}
      pointSize={8}
      pointSizeAttenuation={false}
      volumeOpacity={0.12}
      background="theme"
      selection={NO_SELECTION}
      selectByClick={false}
      ambientOcclusion={0}
      hidden={NOTHING_HIDDEN}
      shown={SHOWN}
      compact={false}
      viewerId={viewerId}
    />
  )
})
