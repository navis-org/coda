/**
 * The Compartment Model's Model tab: the built model, literally — its cable tree as the solver has
 * it (`modelCable`), rooted at the soma's centre where every neurite is wired, the soma drawn as
 * what it is (a cylinder as long as it is wide, seen from the side) and each edge cut where its
 * compartments end, in its region's colour with alternate compartments lighter (flipping at every
 * branching), and the numbers a broken model fails.
 *
 * What the Regions tab cannot show: how finely each branch is cut, that an ignored branch and the
 * nodes the soma replaced are no cable at all, that a neurite starts at its own radius. Drawn from
 * the **built** model, so it is the last run's; the Compartment Model is `cheap` and re-runs on every
 * edit, which keeps the two close.
 *
 * Lengths in µm, or in λ — each edge's cable length over λ at its own radius and the model's Rm and
 * Ra (`electrotonicAlong`) — which is the cell as the solver feels it: where it is compact, where it
 * is far.
 */

import { useMemo, useState } from 'react'

import type { CellModelValue } from '../../core/values'
import { NM_PER_UM } from '../../data/units'
import { DAYLIGHT_PASSES, SUBWAY_DEFAULTS } from '../../nodes/lib/arborLayout'
import {
  buildArbor,
  distanceAt,
  electrotonicAlong,
  keyTree,
  landmarkDistances,
  lengthConstantNm,
} from '../../nodes/lib/arborOps'
import type { ModelCable } from '../../packs/biophys/build'
import { cableCompartmentAt, modelCable } from '../../packs/biophys/build'
import type { CompartmentLoad, ModelStats } from '../../packs/biophys/modelStats'
import { cableConstants, compartmentLoads, modelStats } from '../../packs/biophys/modelStats'
import { CHART_INK, chartSurface, mixHex, seriesColor } from '../../style/colors'
import {
  formatMeasure,
  formatNumber,
  formatSignificant,
  formatShare,
  formatSigned,
  plural,
} from '../../style/format'
import { regionInks } from '../compartmentInk'
import { currentMode } from '../useThemeMode'
import type { SubSegments } from '../viewers/arborPlot'
import {
  arborPointAt,
  PICK_TOLERANCE,
  pickPiece,
  scaleBarFor,
  scaleWidths,
  showDistance,
  subSegments,
} from '../viewers/arborPlot'
import { branchGroups, buildScene } from '../viewers/arborScene'
import { useArborLayout } from '../viewers/useArborLayout'
import { useArborStage, usePaintedScene } from '../viewers/useArborStage'
import { ChartTooltip, TooltipRow } from '../viewers/ChartTooltip'
import { Swatch } from '../viewers/LegendKeys'
import { tooltipPoint } from '../viewers/tooltipPoint'
import { ViewerEmpty } from '../viewers/ViewerEmpty'
import { useWidthControls } from './WidthControls'

/** Every branch's width where widths are not to scale, px. */
const LINE_WIDTH = 2

/**
 * How much of its region's colour every other compartment keeps, so a cut shows between two —
 * mixed opaquely with the surface rather than drawn translucent, or the round caps where two edges
 * meet stack and bead the lighter shade darker at every joint.
 */
const ALTERNATE_SHARE = 0.5

/** What the pointer is over: a compartment, and how far out — undefined on the soma block. */
interface Hovered {
  readonly x: number
  readonly y: number
  readonly compartment: number
  readonly distance?: number
}

/**
 * Where a span's `t` on the edge into `v` (`ModelCable.edges`) is drawn, 0 to 1 of the drawn edge.
 * In µm the edge is drawn its whole length, the soma block over the stretch inside it; in λ it is
 * drawn as long as its cable alone (`edgeLength`), so that stretch takes none of it — read as the
 * whole edge, a fibre's compartments squeezed into its far end behind a gap.
 */
function drawnAlong(cable: ModelCable, v: number, inLambda: boolean): (t: number) => number {
  const inside = inLambda ? cable.edgeShare[v]! : 0
  return inside > 0 && inside < 1 ? (t) => (t - inside) / (1 - inside) : (t) => t
}

/** Three significant figures, grouped: a tooltip's measured quantities. */
const sig = (value: number) => formatSignificant(value, 3)

/** A channel's shift in words, `activation +5 mV`; empty for none. */
function shiftWords(shift: CompartmentLoad['channels'][number]['shift']): string {
  const parts = [
    shift?.activation ? `activation ${formatSigned(shift.activation, { plus: true })} mV` : '',
    shift?.inactivation
      ? `inactivation ${formatSigned(shift.inactivation, { plus: true })} mV`
      : '',
  ].filter(Boolean)
  return parts.length > 0 ? `, ${parts.join(', ')}` : ''
}

/** What the membrane carries: the leak, each channel placed there, and the synapses on it. */
function LoadRows({ load }: { load: CompartmentLoad }) {
  const synapses = load.excitatory + load.inhibitory
  return (
    <>
      <TooltipRow>leak {sig(load.leak)} nS</TooltipRow>
      {load.channels.map((ch) => (
        <TooltipRow key={ch.label}>
          {ch.label} {sig(ch.density * 1000)} mS/cm², {sig(ch.conductance)} nS
          {shiftWords(ch.shift)}
        </TooltipRow>
      ))}
      <TooltipRow>
        {synapses === 0
          ? 'no synapses'
          : `${plural(synapses, 'synapse')} (${formatNumber(load.excitatory)} exc., ` +
            `${formatNumber(load.inhibitory)} inh.) from ${plural(load.partners, 'partner')}`}
      </TooltipRow>
    </>
  )
}

/**
 * What a hovered compartment is: its region, its share of its section, its cable and membrane, and
 * what that membrane carries.
 */
function CompartmentTooltip({
  at,
  model,
  cable,
  stats,
  loads,
  ink,
  inLambda,
}: {
  at: Hovered
  model: CellModelValue
  cable: ModelCable
  stats: ModelStats
  loads: (compartments: readonly number[]) => CompartmentLoad
  ink: string
  inLambda: boolean
}) {
  const c = at.compartment
  const { area, gAxial, region } = model.compartments
  const { length, diameter, segment, of } = cable.compartments
  const name = model.regionNames[region[c]!] ?? ''
  const d = model.soma.diameter
  if (c === model.soma.compartment && d) {
    return (
      <ChartTooltip at={at}>
        <TooltipRow swatch={ink}>
          <strong>{name}</strong>
        </TooltipRow>
        <TooltipRow>{formatMeasure(d, 'µm')} long and as wide</TooltipRow>
        <TooltipRow>
          {sig(stats.somaArea)} µm² of membrane, {formatShare(stats.somaShare)} of the cell’s
        </TooltipRow>
        <LoadRows load={loads(cable.somaCompartments)} />
        <TooltipRow>two compartments, one each side of its centre</TooltipRow>
      </ChartTooltip>
    )
  }
  const lambda = lengthConstantNm((diameter[c]! / 2) * NM_PER_UM, cableConstants(model))
  return (
    <ChartTooltip at={at}>
      <TooltipRow swatch={ink}>
        <strong>{name}</strong>
      </TooltipRow>
      {segment[c]! >= 0 && (
        <TooltipRow>
          segment {segment[c]! + 1} of {of[c]} in its section
        </TooltipRow>
      )}
      <TooltipRow>
        {formatMeasure(length[c]!, 'µm')} long, {formatMeasure(diameter[c]!, 'µm')} across
        {lambda > 0 && ` (${sig((length[c]! * NM_PER_UM) / lambda)} λ)`}
      </TooltipRow>
      <TooltipRow>{sig(area[c]!)} µm² of membrane</TooltipRow>
      {gAxial[c]! > 0 && (
        <TooltipRow>{sig(1 / gAxial[c]!)} MΩ to the compartment before it</TooltipRow>
      )}
      {at.distance !== undefined && (
        <TooltipRow>{showDistance(at.distance, inLambda)} from the soma’s centre</TooltipRow>
      )}
      <LoadRows load={loads([c])} />
      <TooltipRow>compartment {c}</TooltipRow>
    </ChartTooltip>
  )
}

export interface CompartmentsViewProps {
  /** The node's last built model. */
  model: CellModelValue | undefined
}

export function CompartmentsView({ model }: CompartmentsViewProps) {
  const mode = currentMode()
  const [electrotonic, setElectrotonic] = useState(false)
  const { scale: widthScale, controls: widthControls } = useWidthControls(
    true,
    'Draw each section as wide as it is, to scale with its length, the soma included',
  )

  /* --- the model's cable tree, and its lengths in µm or λ ------------------------------- */

  const cable = useMemo(() => (model ? modelCable(model) : undefined), [model])
  // Rooted at node 0: the soma's centre, where every neurite is wired.
  const arbor = useMemo(() => (cable ? buildArbor(cable.skeleton, 0) : undefined), [cable])
  const tree = useMemo(() => (arbor ? keyTree(arbor) : undefined), [arbor])
  // Each edge in its own length constants: its own radius and cable length, the model's Rm and Ra.
  const lambda = useMemo(() => {
    if (!electrotonic || !cable || !arbor || !model) return undefined
    return electrotonicAlong(
      arbor,
      (v) => cable.edgeRadius[v]!,
      (v) => cable.edgeLength[v]!,
      cableConstants(model),
    )
  }, [electrotonic, cable, arbor, model])
  const inLambda = lambda?.ok === true
  const nodeD = lambda?.ok ? lambda.distance : arbor?.geodesic
  const landmarkD = useMemo(
    () => (tree && nodeD ? landmarkDistances(tree, nodeD) : undefined),
    [tree, nodeD],
  )
  const { shape } = useArborLayout('equalAngle', tree, landmarkD, {
    order: 'balanced',
    subway: SUBWAY_DEFAULTS,
    daylight: DAYLIGHT_PASSES,
  })
  const stage = useArborStage(shape, `${model?.skeleton.id} ${inLambda}`)
  const { stageRef, canvasRef, transform, pieces, panning, handlers } = stage

  /* --- every edge cut where its compartments end ---------------------------------------- */

  const inks = useMemo(() => (model ? regionInks(model.regionNames, mode) : []), [model, mode])
  // Each region's ink and its lighter alternate, so a span's colour is a lookup.
  const palette = useMemo(
    () => inks.flatMap((ink) => [ink, mixHex(ink, chartSurface(mode), 1 - ALTERNATE_SHARE)]),
    [inks, mode],
  )
  // The subdivision, which neither a zoom nor a theme moves: a palette index per span.
  const spans = useMemo(() => {
    if (!model || !cable || !arbor || !tree || !landmarkD || !nodeD) return undefined
    const { edges } = cable
    const whole = subSegments(arbor, tree, landmarkD, nodeD)
    const node: number[] = []
    const piece: number[] = []
    const f0: number[] = []
    const f1: number[] = []
    // Region × 2 + shade.
    const color: number[] = []
    const { region } = model.compartments
    for (let i = 0; i < whole.node.length; i++) {
      const v = whole.node[i]!
      const a = whole.f0[i]!
      const span = whole.f1[i]! - a
      const onCable = drawnAlong(cable, v, inLambda)
      for (let k = edges.start[v]!; k < edges.start[v + 1]!; k++) {
        node.push(v)
        piece.push(whole.piece[i]!)
        f0.push(a + onCable(edges.t0[k]!) * span)
        f1.push(a + onCable(edges.t1[k]!) * span)
        color.push(region[edges.compartment[k]!]! * 2 + edges.shade[k]!)
      }
    }
    const sub: SubSegments = {
      node: Int32Array.from(node),
      piece: Int32Array.from(piece),
      f0: Float32Array.from(f0),
      f1: Float32Array.from(f1),
    }
    // A branch point's connector in the colour of the compartment arriving at it; -1 for none.
    const landmarkColor = Int32Array.from(tree.nodes, (v) => {
      const last = edges.start[v + 1]! - 1
      return last >= edges.start[v]! ? region[edges.compartment[last]!]! * 2 : -1
    })
    return { sub, color: Uint8Array.from(color), landmarkColor }
  }, [model, cable, arbor, tree, landmarkD, nodeD, inLambda])
  // Connector colours, which a zoom never moves.
  const landmarkColor = useMemo(
    () =>
      spans
        ? Array.from(spans.landmarkColor, (c) => (c >= 0 ? palette[c]! : 'transparent'))
        : undefined,
    [spans, palette],
  )
  // To scale, the widths follow the zoom — regrouped on a zoom, never a pan. In λ a width has
  // nothing to be to scale with.
  const pxPerUnit =
    !inLambda && transform && widthScale !== undefined ? transform.sx * widthScale : undefined
  const branches = useMemo(() => {
    if (!spans || !cable || !landmarkColor) return undefined
    const { sub, color } = spans
    const widths =
      pxPerUnit !== undefined ? scaleWidths(sub, cable.edgeRadius, pxPerUnit) : LINE_WIDTH
    return {
      sub,
      groups: branchGroups(color.length, (i) => palette[color[i]!]!, widths),
      landmarkColor,
    }
  }, [spans, cable, pxPerUnit, palette, landmarkColor])

  const somaRadius =
    !inLambda && model?.soma.diameter ? (model.soma.diameter * NM_PER_UM) / 2 : 0
  // Thinner with the branches it is drawn with, where they are; its length is a length.
  const somaHalfWidth = somaRadius * (widthScale ?? 1)
  const somaInk = model ? inks[model.compartments.region[model.soma.compartment]!] : undefined
  const scene = useMemo(() => {
    if (!shape || !transform || !pieces || !tree || !branches) return undefined
    const ink = CHART_INK[mode]
    return buildScene({
      width: transform.width,
      height: transform.height,
      background: chartSurface(mode),
      title: 'Model',
      ink: { line: ink.secondary, text: ink.primary, accent: seriesColor(0, mode) },
      shape,
      transform,
      pieces,
      settled: true,
      tree,
      lineWidth: LINE_WIDTH,
      branches,
      ticks: [],
      synapseSize: 5,
      scaleBar: scaleBarFor(transform, inLambda),
      // The soma section whole: as long as it is wide, centred where every neurite is wired.
      ...(somaRadius > 0
        ? {
            rootBlock: {
              halfLength: somaRadius,
              halfWidth: somaHalfWidth,
              color: somaInk ?? ink.primary,
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
    inLambda,
    somaRadius,
    somaHalfWidth,
    somaInk,
    mode,
  ])
  usePaintedScene(canvasRef, scene)

  const stats = useMemo(() => (model ? modelStats(model) : undefined), [model])
  const loads = useMemo(() => (model ? compartmentLoads(model) : undefined), [model])

  /* --- pointing ------------------------------------------------------------------------ */

  const [hover, setHover] = useState<Hovered | undefined>()
  // The compartment under a point of the plot: the soma block first, drawn over what it centres.
  const hoveredAt = (x: number, y: number): Hovered | undefined => {
    if (!model || !cable || !arbor || !tree || !landmarkD || !nodeD || !pieces || !transform)
      return undefined
    const soma = model.soma.compartment
    if (somaRadius > 0) {
      const dx = Math.abs(x - pieces.bx[0]!)
      const dy = Math.abs(y - pieces.by[0]!)
      const halfWidth = Math.max(somaHalfWidth * transform.sx, PICK_TOLERANCE)
      if (dx <= somaRadius * transform.sx && dy <= halfWidth) return { x, y, compartment: soma }
    }
    const hit = pickPiece(pieces, x, y)
    if (!hit) return undefined
    const point = arborPointAt(arbor, tree, landmarkD, nodeD, hit.piece, hit.along)
    // In λ the drawn edge is its cable alone: back to the edge's own `t`, the soma's share first.
    const inside = inLambda ? cable.edgeShare[point.node]! : 0
    const compartment = cableCompartmentAt(cable, point.node, inside + point.t * (1 - inside))
    // Short of an edge's first span is inside the soma it starts in.
    if (compartment === undefined) return { x, y, compartment: soma }
    return { x, y, compartment, distance: distanceAt(arbor, nodeD, point) }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    handlers.onPointerMove(event)
    if (panning) return setHover(undefined)
    const at = tooltipPoint(event, event.currentTarget)
    setHover(hoveredAt(at.x, at.y))
  }

  if (!model || !stats) return <ViewerEmpty>Run the model to see its compartments.</ViewerEmpty>

  return (
    <div className="split-editor">
      <div className="topo__bar">
        <span className="split-editor__keys">
          {stats.areaByRegion.map(({ region, index }) => (
            <Swatch key={region} color={inks[index]!} label={region} />
          ))}
        </span>
        <label
          className="topo__check nodrag"
          title="Branch lengths in length constants at each section's own radius and the model's Rm and Ra: the cell as the solver feels it"
        >
          <input
            type="checkbox"
            checked={electrotonic}
            onChange={(e) => setElectrotonic(e.target.checked)}
          />
          Lengths in λ
        </label>
        {!inLambda && widthControls}
      </div>

      <div className="split-editor__main">
        <div
          ref={stageRef}
          className="arbor__plot nodrag"
          data-panning={panning || undefined}
          data-zoomed={stage.zoomed || undefined}
          {...handlers}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(undefined)}
          onDoubleClick={stage.resetView}
        >
          <canvas ref={canvasRef} className="arbor__canvas" aria-label="Compartments" />
          {hover && cable && loads && (
            <CompartmentTooltip
              at={hover}
              model={model}
              cable={cable}
              stats={stats}
              loads={loads}
              ink={inks[model.compartments.region[hover.compartment]!] ?? CHART_INK[mode].muted}
              inLambda={inLambda}
            />
          )}
        </div>

        <aside className="split-editor__list" aria-label="The model in numbers">
          <h4>Passive</h4>
          <dl className="model-stats">
            <dt>Input resistance</dt>
            <dd>{formatNumber(Math.round(stats.inputResistance))} MΩ</dd>
            <dt>Time constant</dt>
            <dd>{formatNumber(Math.round(stats.timeConstant * 10) / 10)} ms</dd>
            <dt>Soma’s membrane</dt>
            <dd>{formatShare(stats.somaShare)}</dd>
            <dt>Compartments</dt>
            <dd>{formatNumber(model.compartments.count)}</dd>
          </dl>
          <h4>Membrane</h4>
          <dl className="model-stats">
            {stats.areaByRegion.map(({ region, area }) => (
              <div key={region}>
                <dt>{region}</dt>
                <dd>{formatNumber(Math.round(area))} µm²</dd>
              </div>
            ))}
            <dt>total</dt>
            <dd>{formatNumber(Math.round(stats.area))} µm²</dd>
          </dl>
          {lambda && !lambda.ok && <p className="split-editor__hint">{lambda.reason}</p>}
        </aside>
      </div>

      <div className="viewer__caption">
        The built model: its cable from the soma’s centre, each compartment in its region’s
        colour, every other one lighter. The soma is one section as long as it is wide. Lengths
        in {inLambda ? 'λ at each section’s own radius and the model’s Rm and Ra' : 'µm'}. The
        panel’s numbers are the leak’s alone, channels left out; hover over a compartment for
        what it carries.
      </div>
    </div>
  )
}
