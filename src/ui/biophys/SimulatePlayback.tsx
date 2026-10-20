/**
 * Simulate's Playback tab: the last run's voltage moving over the neuron — its dendrogram and the
 * neuron in 3D, coloured frame by frame — with the soma's trace beneath and a cursor at the frame
 * shown. Clicking a branch adds that compartment's trace.
 *
 * The movie is made when the tab opens (`useMovie`), not kept with the result; its rules — the
 * colours, the time readout — are `movie.ts`', and where a trace lands and what it is called is the
 * run's own (`planRun`'s `traces`, handed over by `useMovie`). The dendrogram is the Points
 * editor's (`useArborStage`, `splitArbor`, `equalAngle`) and so is the memoised 3D half, which only
 * the frame's colours reach on a tick.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ParamValue } from '../../core/node'
import { ID_COLUMN_NAME } from '../../core/ids'
import { column, tableSchema } from '../../core/types'
import type { CellModelValue, PointsValue, SkeletonsValue } from '../../core/values'
import { boundsOf, getColumn, makeTable } from '../../core/values'
import { DAYLIGHT_PASSES, SUBWAY_DEFAULTS } from '../../nodes/lib/arborLayout'
import { hasRadii } from '../../nodes/lib/skeletonRadii'
import { keyTree, landmarkDistances, orientPlacement } from '../../nodes/lib/arborOps'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { constantColor } from '../../nodes/lib/encodingParams'
import type { ManualPoint } from '../../nodes/lib/skeletonPoints'
import {
  manualPointAt,
  readManualPoints,
  writeManualPoint,
} from '../../nodes/lib/skeletonPoints'
import { splitArbor } from '../../nodes/lib/splitCorrections'
import type { Movie } from '../../packs/biophys/simulateJob'
import { MOVIE_BUDGET_BYTES } from '../../packs/biophys/simulateJob'
import type { MovieTrace, RunPlan } from '../../packs/biophys/simulateOps'
import {
  injectedTrace,
  modelSkeletons,
  SHOW_TRACES_PARAM,
  TIME_COLUMN,
  SIGN_COLUMN,
  SOMA_COLUMN,
  traceCompartment,
  TRACES_PARAM,
} from '../../packs/biophys/simulateOps'
import type { Mode } from '../../style/colors'
import { CHART_INK, chartSurface, cycleColor } from '../../style/colors'
import { formatBytes, formatNumber, plural } from '../../style/format'
import { isTypingTarget } from '../appShortcuts'
import { currentMode } from '../useThemeMode'
import {
  arborPointAt,
  pickPiece,
  radiusWidths,
  subSegments,
  synapseMarks,
} from '../viewers/arborPlot'
import type { TickGroup } from '../viewers/arborScene'
import { branchParts, buildScene, partStrokes, sceneToSvg } from '../viewers/arborScene'
import { uiFontFamily } from '../viewers/canvas2d'
import { LazyViewer3D } from '../viewers/LazyViewers'
import type { ChartStrip } from '../viewers/LineChartViewer'
import { LineChartViewer } from '../viewers/LineChartViewer'
import { tooltipPoint } from '../viewers/tooltipPoint'
import { useArborLayout } from '../viewers/useArborLayout'
import type { SkeletonWidthMode } from '../viewers/viewer3dScene'
import { useArborStage, usePaintedScene } from '../viewers/useArborStage'
import type { ExportSource } from '../viewers/ViewerActions'
import { ViewerActions } from '../viewers/ViewerActions'
import { ViewerEmpty } from '../viewers/ViewerEmpty'
import type { Firing, MovieScale } from './movie'
import {
  firedSites,
  baselineOf,
  frameColors,
  inputArrivals,
  movieStats,
  risesAboveRest,
  sitePositions,
  movieRamp,
  nextTraceName,
  timeFormat,
  traceTable,
} from './movie'
import type { MovieRequest, Stimulus } from './useMovie'
import { useMovie } from './useMovie'

export interface SimulatePlaybackProps extends MovieRequest {
  /** The node's key in its workflow, for the 3D view's kept renderer. */
  viewerKey: string
  baseName?: string | undefined
  onError?: ((message: string) => void) | undefined
  /** Writes the stored traces (`TRACES_PARAM`) back onto the node. */
  onParamChange?: ((paramId: string, value: ParamValue) => void) | undefined
}

export function SimulatePlayback(props: SimulatePlaybackProps) {
  const state = useMovie(props)
  if (state.status === 'waiting' || state.status === 'refused') {
    return <ViewerEmpty>{state.reason}</ViewerEmpty>
  }
  if (state.status === 'running') {
    return (
      <ViewerEmpty>
        <span className="playback__making">
          Making the movie{state.note ? ` (${state.note})` : ''}…
          <progress max={1} value={state.fraction} />
        </span>
      </ViewerEmpty>
    )
  }
  // `model` is there whenever a movie is: the hook waits without one.
  return (
    <Player
      {...props}
      model={props.model!}
      movie={state.movie}
      firing={state.firing}
      placedTraces={state.traces}
      stimulus={state.stimulus}
      sweep={state.sweep}
    />
  )
}

/** Playback speeds, as a multiple of the whole run in `RUN_SECONDS`. */
const SPEEDS = [0.25, 0.5, 1, 2, 4] as const
/** How long the whole run takes to play at 1×, whatever its length. */
const RUN_SECONDS = 8
const LINE_WIDTH = 1.5
/**
 * Under `Radius`, the 3D view's width for the 95th-percentile radius, px. Twice the dendrogram's
 * (`radiusWidths` puts it at 2 × LINE_WIDTH): a 3D line is foreshortened and lit, and at the same
 * width read barely thicker than the uniform 2 px it replaces.
 */
const RADIUS_WIDTH_3D = 4 * LINE_WIDTH

/** Added trace `k`'s colour: its line's in the Line Chart, which draws the soma first. */
function traceColor(k: number, mode: Mode): string {
  return cycleColor(k + 1, mode)
}

function Player({
  model,
  movie,
  firing,
  params,
  placedTraces: { placed, off },
  stimulus,
  sweep,
  viewerKey,
  baseName,
  onError,
  onParamChange,
}: SimulatePlaybackProps & {
  model: CellModelValue
  movie: Movie
  firing: Firing
  placedTraces: RunPlan['traces']
  stimulus: Stimulus | undefined
  sweep: string | undefined
}) {
  const mode = currentMode()
  const ink = CHART_INK[mode]
  const frames = movie.length
  const last = frames - 1

  /* --- the clock ---------------------------------------------------------------------------- */

  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<number>(1)
  // The position between frames, so a slow speed still advances: a frame is drawn when it changes.
  const position = useRef(0)
  useEffect(() => {
    if (!playing) return
    let last_ = performance.now()
    let handle = requestAnimationFrame(function tick(now) {
      const elapsed = (now - last_) / 1000
      last_ = now
      position.current += (elapsed * speed * frames) / RUN_SECONDS
      if (position.current >= last) {
        position.current = last
        setFrame(last)
        setPlaying(false)
        return
      }
      setFrame(Math.floor(position.current))
      handle = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(handle)
  }, [playing, speed, frames, last])

  const seek = useCallback(
    (f: number) => {
      const to = Math.min(last, Math.max(0, f))
      position.current = to
      setFrame(to)
    },
    [last],
  )
  const togglePlay = () => {
    // Play from the start again once the end is reached.
    if (!playing && frame >= last) seek(0)
    setPlaying(!playing)
  }

  /* --- the colours -------------------------------------------------------------------------- */

  // The extent is the movie's alone: a theme change re-ramps without rescanning every frame.
  const { extent, rise } = movieStats(movie)
  const [scale, setScale] = useState<MovieScale>('sequential')
  // Rest is where the run started — the settled state, frame 0 at the soma — not E leak, which an
  // active model does not rest at: centred there, a quiet cell would be drawn as deflected.
  const rest = movie.frames[model.soma.compartment]!
  const ramp = useMemo(
    () => extent && movieRamp(extent, rest, rise, mode, scale),
    [extent, rest, rise, mode, scale],
  )
  const colors = useMemo(
    () =>
      ramp ? frameColors(movie, frame, ramp.colorOf, baselineOf(movie, scale)) : undefined,
    [movie, frame, ramp, scale],
  )
  const { nodeCompartment } = model
  // A compartment's colour this frame; none off the modelled piece (`-1`), drawn in the plain line.
  const compartmentColor = useCallback(
    (c: number): string | undefined => (c < 0 ? undefined : colors?.[c]),
    [colors],
  )
  const nodeColor = useMemo(
    () =>
      (_item: number, node: number): string | undefined =>
        compartmentColor(nodeCompartment[node]!),
    [compartmentColor, nodeCompartment],
  )

  /* --- the dendrogram ----------------------------------------------------------------------- */

  const skeleton = model.skeleton
  const arbor = useMemo(() => splitArbor(skeleton), [skeleton])
  const tree = useMemo(() => keyTree(arbor), [arbor])
  const landmarkD = useMemo(() => landmarkDistances(tree, arbor.geodesic), [tree, arbor])
  const sub = useMemo(
    () => subSegments(arbor, tree, landmarkD, arbor.geodesic),
    [arbor, tree, landmarkD],
  )
  const { shape } = useArborLayout('equalAngle', tree, landmarkD, {
    order: 'balanced',
    subway: SUBWAY_DEFAULTS,
    daylight: DAYLIGHT_PASSES,
  })
  // `Radius` draws each branch as wide as its calibre, the dendrogram and the 3D view alike.
  const [byRadius, setByRadius] = useState(false)
  const withRadii = useMemo(() => hasRadii(skeleton.radii), [skeleton.radii])
  const radiusOn = byRadius && withRadii
  const widths = useMemo(
    () => (radiusOn ? radiusWidths(arbor, sub, skeleton.radii, LINE_WIDTH) : undefined),
    [radiusOn, arbor, sub, skeleton.radii],
  )
  // Which edges share a stroke whatever the frame — an edge takes its compartment's colour, at a
  // width fixed until `Radius` changes — so a frame colours parts, not every edge.
  const parts = useMemo(
    () =>
      branchParts(sub.node.length, (i) => nodeCompartment[sub.node[i]!]!, widths ?? LINE_WIDTH),
    [sub, nodeCompartment, widths],
  )
  const branches = useMemo(() => {
    const colorOf = (c: number) => compartmentColor(c) ?? ink.secondary
    return {
      sub,
      groups: partStrokes(parts, colorOf),
      landmarkColor: Array.from(tree.nodes, (node) => colorOf(nodeCompartment[node]!)),
    }
  }, [parts, compartmentColor, sub, tree, nodeCompartment, ink.secondary])

  /* --- the traces ------------------------------------------------------------------------- */

  // Kept on the node as positions on the neuron (`TRACES_PARAM`), so a re-run, a rebuilt model or
  // a reload keeps them; placed and named by the run (`placedTraces`), by the rule a click is.
  const rawTraces = params[TRACES_PARAM]
  const stored = useMemo(() => readManualPoints(rawTraces), [rawTraces])
  const writeTraces = (next: readonly ManualPoint[]) =>
    onParamChange?.(TRACES_PARAM, next.map(writeManualPoint))
  const traces = useMemo(
    (): MovieTrace[] => [
      { label: SOMA_COLUMN, compartment: model.soma.compartment },
      ...placed,
    ],
    [model.soma.compartment, placed],
  )
  // Kept on the node, so a view laid out without them stays so across a reopen and a reload.
  const showTraces = params[SHOW_TRACES_PARAM] === true
  const table = useMemo(() => traceTable(movie, traces), [movie, traces])
  const ys = useMemo(() => traces.map(({ label }) => label), [traces])
  // The injected current under the traces, on their time axis, as the Traces output's column has it.
  const strip = useMemo((): ChartStrip | undefined => {
    if (!stimulus) return undefined
    const t = getColumn(table, TIME_COLUMN) as number[]
    return {
      label: stimulus.label,
      unit: 'nA',
      x: t,
      y: injectedTrace(stimulus.clamps, stimulus.compartment, t, stimulus.dt),
    }
  }, [stimulus, table])
  const arrivals = useMemo(() => inputArrivals(model, firing), [model, firing])

  /*
   * The marks on the dendrogram, one placement: the fired partners' synapses first when `Inputs`
   * is on, then each trace in its line's colour, drawn last so a trace is never under an input.
   */
  const [showInputs, setShowInputs] = useState(false)
  const fired = useMemo(
    () => (showInputs ? firedSites(model, firing) : undefined),
    [showInputs, model, firing],
  )
  const inputs = useMemo(() => fired && orientPlacement(arbor, fired), [fired, arbor])
  /*
   * Excitatory and inhibitory inputs are told apart by side as well as ink: an inhibitory input
   * ticks the other side of its branch, and the key names both. The inks are achromatic, the
   * palette being spent on the traces.
   */
  const signInk = useMemo(
    () => ({ excitatory: ink.primary, inhibitory: ink.muted }),
    [ink.primary, ink.muted],
  )
  const anyInhibitory = useMemo(() => fired?.inhibitory.includes(1) ?? false, [fired])
  const { marks, ticks } = useMemo(() => {
    const first = inputs?.node.length ?? 0
    const node = new Int32Array(first + placed.length)
    const t = new Float32Array(node.length)
    const ticks: TickGroup[] = []
    if (inputs && fired) {
      node.set(inputs.node)
      t.set(inputs.t)
      const bySign: [number[], number[]] = [[], []]
      for (let s = 0; s < first; s++) bySign[fired.inhibitory[s]!]!.push(s)
      ticks.push({ color: signInk.excitatory, alpha: 0.7, rows: Int32Array.from(bySign[0]) })
      ticks.push({ color: signInk.inhibitory, alpha: 0.9, rows: Int32Array.from(bySign[1]) })
    }
    placed.forEach((trace, k) => {
      node[first + k] = trace.node
      t[first + k] = trace.t
      ticks.push({ color: traceColor(k, mode), alpha: 1, rows: Int32Array.of(first + k) })
    })
    const placement = { node, t, unplaced: 0 }
    // `pre`'s side for an inhibitory input; every trace on the other.
    const side = (s: number) => (s < first && fired?.inhibitory[s] === 1 ? 'pre' : 'post')
    const marks = synapseMarks(tree, landmarkD, arbor, arbor.geodesic, placement, side)
    return { marks, ticks }
  }, [tree, landmarkD, arbor, inputs, fired, placed, signInk, mode])

  const stage = useArborStage(shape, skeleton.id)
  const { stageRef, canvasRef, transform, pieces, panning, handlers } = stage
  const time = frame * movie.frameMs
  const timeText = useMemo(() => timeFormat(movie), [movie])
  const end = timeText(last * movie.frameMs)
  const scene = useMemo(() => {
    if (!shape || !transform || !pieces) return undefined
    return buildScene({
      width: transform.width,
      height: transform.height,
      background: chartSurface(mode),
      title: `${model.neuronId}, membrane voltage at ${formatNumber(time)} ms`,
      ink: { line: ink.secondary, text: ink.primary, accent: ink.primary },
      shape,
      transform,
      pieces,
      settled: true,
      tree,
      lineWidth: LINE_WIDTH,
      branches,
      marks,
      ticks,
      synapseSize: 9,
      ...(anyInhibitory
        ? {
            key: {
              entries: [
                { label: 'excitatory input', color: signInk.excitatory },
                { label: 'inhibitory input', color: signInk.inhibitory },
              ],
              more: 0,
            },
          }
        : {}),
      ...(ramp
        ? {
            legend: {
              title: scale === 'sequential' ? 'mV above rest' : 'mV',
              stops: ramp.legend.stops,
              lo: formatNumber(ramp.legend.domain[0]),
              hi: formatNumber(ramp.legend.domain[1]),
            },
          }
        : {}),
    })
  }, [
    shape,
    transform,
    pieces,
    tree,
    branches,
    marks,
    ticks,
    ramp,
    mode,
    ink,
    signInk,
    anyInhibitory,
    scale,
    model.neuronId,
    time,
  ])
  usePaintedScene(canvasRef, scene)

  // The frame on screen when the ⤓ is pressed, through a ref: the source itself never changes.
  const sceneRef = useRef(scene)
  sceneRef.current = scene
  const exportSource = useMemo(
    (): ExportSource => ({
      svg: () => (sceneRef.current ? sceneToSvg(sceneRef.current, uiFontFamily()) : null),
    }),
    [],
  )

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!pieces) return
    const point = tooltipPoint(event, event.currentTarget)
    const hit = pickPiece(pieces, point.x, point.y)
    if (!hit) return
    const on = arborPointAt(arbor, tree, landmarkD, arbor.geodesic, hit.piece, hit.along)
    const compartment = traceCompartment(model, arbor, on)
    if (compartment === undefined) return
    // A compartment already traced: the click takes its trace away again.
    const there = placed.filter((trace) => trace.compartment === compartment)
    if (there.length > 0) {
      const gone = new Set(there.map((trace) => trace.point))
      writeTraces(stored.filter((p) => !gone.has(p)))
      return
    }
    const at = manualPointAt(skeleton.positions, arbor.parent, on)
    writeTraces([...stored, { neuron: model.neuronId, at, name: nextTraceName(stored) }])
  }

  /* --- the 3D view -------------------------------------------------------------------------- */

  const skeletons = useMemo(() => modelSkeletons(model), [model])
  // The same inputs in 3D: a point on the cable per fired synapse, as the dendrogram ticks them.
  const inputPoints = useMemo((): PointsValue | undefined => {
    if (!fired) return undefined
    const positions = sitePositions(skeleton.positions, fired)
    return {
      kind: 'points',
      positions,
      attributes: makeTable(
        tableSchema(column(ID_COLUMN_NAME, 'str'), column(SIGN_COLUMN, 'str')),
        {
          [ID_COLUMN_NAME]: Array.from({ length: fired.child.length }, () => model.neuronId),
          [SIGN_COLUMN]: Array.from(fired.inhibitory, (k) => (k ? 'inhibitory' : 'excitatory')),
        },
      ),
      bounds: boundsOf([positions]),
      units: 'nm',
      ...(model.space ? { space: model.space } : {}),
    }
  }, [fired, skeleton.positions, model.neuronId, model.space])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isTypingTarget(event.target)) return
    if (event.key === ' ') togglePlay()
    else if (event.key === 'ArrowLeft') seek(frame - 1)
    else if (event.key === 'ArrowRight') seek(frame + 1)
    else return
    event.preventDefault()
  }

  return (
    <div className="playback nokey" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="playback__controls">
        <button
          type="button"
          className="btn btn--ghost"
          aria-label="Previous frame"
          title="Previous frame (←)"
          disabled={frame <= 0}
          onClick={() => seek(frame - 1)}
        >
          ⏮
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={togglePlay}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          aria-label="Next frame"
          title="Next frame (→)"
          disabled={frame >= last}
          onClick={() => seek(frame + 1)}
        >
          ⏭
        </button>
        <input
          type="range"
          className="playback__scrubber nodrag"
          aria-label="Time"
          min={0}
          max={last}
          step={1}
          value={frame}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span
          className="playback__time"
          // Wide enough for the run's last time, whatever frame is shown.
          style={{ minWidth: `${2 * end.length + 6}ch` }}
        >
          {timeText(time)} / {end} ms
        </span>
        {sweep && (
          <span
            className="playback__hint"
            title="Playback replays one sweep of the current table: the first. The Traces output has every one."
          >
            {sweep}
          </span>
        )}
        {movie.coarse && (
          <span
            className="playback__hint"
            title={`Sample every is ${formatNumber(Number(params.sampleEvery))} ms, but a movie that fine would hold more than ${formatBytes(MOVIE_BUDGET_BYTES)}. The Traces output keeps the finer sampling.`}
          >
            frames every {timeText(movie.frameMs)} ms
          </span>
        )}
        {placed.length === 0 ? (
          <span className="playback__hint">Click a branch to add its trace.</span>
        ) : (
          <ul className="playback__traces-list" aria-label="Added traces">
            {placed.map((trace, k) => (
              <li key={trace.label} className="playback__trace">
                <span
                  className="playback__swatch"
                  style={{ background: traceColor(k, mode) }}
                />
                {trace.label}
                <button
                  type="button"
                  className="btn btn--ghost nodrag"
                  aria-label={`Remove ${trace.label}`}
                  title="Remove this trace (or click its branch again)"
                  onClick={() => writeTraces(stored.filter((p) => p !== trace.point))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        {off > 0 && (
          <span
            className="playback__hint"
            title="Kept on the node, but not on this model: another neuron's, too far from this one's cable, or at the soma."
          >
            {plural(off, 'trace')} not shown
          </span>
        )}
        <label
          className="playback__toggle nodrag"
          title="Draw the traces under the scrubber. Off, the neuron takes the whole view; the Traces output carries them to a Line Chart."
        >
          <input
            type="checkbox"
            checked={showTraces}
            disabled={!onParamChange}
            onChange={(event) => onParamChange?.(SHOW_TRACES_PARAM, event.target.checked)}
          />
          Traces
        </label>
        <label className="playback__toggle nodrag">
          <input
            type="checkbox"
            checked={showInputs}
            onChange={(event) => setShowInputs(event.target.checked)}
          />
          Inputs
        </label>
        <label
          className="playback__toggle nodrag"
          title={
            withRadii
              ? 'Draw each branch as wide as its radius, on the dendrogram and in 3D.'
              : 'This skeleton has no radii to draw.'
          }
        >
          <input
            type="checkbox"
            checked={radiusOn}
            disabled={!withRadii}
            onChange={(event) => setByRadius(event.target.checked)}
          />
          Radius
        </label>
        <select
          className="nodrag"
          aria-label="Colours"
          title="From rest: the whole ramp from rest up to the run's peak, for small depolarisations. About rest: depolarisation and hyperpolarisation either side of rest, for inhibitory inputs."
          value={scale}
          onChange={(event) => setScale(event.target.value as MovieScale)}
        >
          <option value="sequential">from rest</option>
          <option value="diverging">about rest</option>
        </select>
        {scale === 'sequential' && !risesAboveRest(rise) && (
          <span className="playback__hint">Nothing rises above rest: choose about rest.</span>
        )}
        <select
          className="playback__speed nodrag"
          aria-label="Speed"
          value={speed}
          onChange={(event) => setSpeed(Number(event.target.value))}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>

      <div className="playback__main">
        <div className="playback__dendrogram">
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
              aria-label={`${model.neuronId}: click a branch to add its trace`}
            />
          </div>
          {/* In a foot row, as the 3D view's beside it, so nothing sits over the drawing's corner. */}
          <div className="viewer__caption">
            <span>{model.neuronId}</span>
            <ViewerActions
              baseName={`${baseName ?? 'simulate'}-dendrogram`}
              source={exportSource}
              {...(onError ? { onError } : {})}
            />
          </div>
        </div>
        <div className="playback__scene">
          {ramp && (
            <PlaybackScene
              skeletons={skeletons}
              nodeColor={nodeColor}
              line={ink.secondary}
              inputs={inputPoints}
              inputColor={signInk}
              widthMode={radiusOn ? 'radius' : 'uniform'}
              frameKey={model.neuronId}
              viewerId={`${viewerKey}:playback`}
              baseName={`${baseName ?? 'simulate'}-3d`}
            />
          )}
        </div>
      </div>

      {showTraces && (
        <div className="playback__traces">
          <LineChartViewer
            table={table}
            x="t"
            ys={ys}
            cursor={time}
            xMarks={arrivals}
            xMarksLabel="input spikes arriving"
            strip={strip}
            compact={false}
          />
        </div>
      )}
    </div>
  )
}

const NO_SELECTION: string[] = []
const NOTHING_HIDDEN = { skeleton: [], mesh: [], point: [], volume: [] }
const SHOWN = { skeletons: true, meshes: false, points: true, volumes: false }

/** The 3D half, memoised: a tick changes its colours and nothing else. */
const PlaybackScene = memo(function PlaybackScene({
  skeletons,
  nodeColor,
  line,
  inputs,
  inputColor,
  widthMode,
  frameKey,
  viewerId,
  baseName,
}: {
  skeletons: SkeletonsValue
  nodeColor: (itemIndex: number, nodeIndex: number) => string | undefined
  line: string
  inputs: PointsValue | undefined
  inputColor: { readonly excitatory: string; readonly inhibitory: string }
  widthMode: SkeletonWidthMode
  frameKey: string
  viewerId: string
  baseName: string
}) {
  // Off the modelled piece, a node is drawn in the plain line colour.
  const plain = useMemo(() => constantColor(line), [line])
  // By the points' sign column, each sign its own ink — the dendrogram's two.
  const inputInk = useMemo(
    (): ColorSpec => ({
      mode: 'categorical',
      column: SIGN_COLUMN,
      constant: inputColor.excitatory,
      overrides: { ...inputColor },
    }),
    [inputColor],
  )
  return (
    <LazyViewer3D
      skeletons={skeletons}
      {...(inputs ? { points: inputs } : {})}
      frameKey={frameKey}
      skeletonColor={plain}
      skeletonNodeColor={nodeColor}
      meshColor={plain}
      pointColor={inputInk}
      volumeColor={plain}
      skeletonWidth={2}
      skeletonWidthMode={widthMode}
      skeletonRadiusWidth={RADIUS_WIDTH_3D}
      skeletonWorldWidth={1}
      lightIntensity={1}
      meshOpacity={1}
      pointSize={5}
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
      baseName={baseName}
    />
  )
})
