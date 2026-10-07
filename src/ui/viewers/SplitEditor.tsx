/**
 * Split Axon/Dendrite's expanded view: the split on a dendrogram, and the place it is corrected.
 *
 * A dendrogram rather than the 3D arbour because picking a branch is the whole job, and a 2D tree
 * has no depth to pick through. It is built from the Neuron Dendrogram's own layers — `arborLayout`,
 * `buildScene`/`paintScene`, `pickPiece`/`arborPointAt`, the pan and wheel gestures — not from that
 * viewer, which is welded to fetching a skeleton and to its partner list. The stage half (size,
 * transform, zoom, pan, paint, pick) is now the same dozen lines in both; a `useArborStage` hook is
 * the place for it once either needs to change. What it draws is the node's *output*: the labels
 * with every correction already applied, so what is on screen is what flows downstream.
 *
 * The layout is unrooted; the root is the dot, and corrections are measured from it. A click on a
 * branch opens a menu: the part away from the root, or everything else, becomes axon, dendrite or
 * linker — or the branch's nearer end becomes the root. A correction is appended to `corrections`
 * (`splitCorrections.ts`) with the root it was made against, the node re-runs — `cheap`, and on a
 * memoised automatic split, so without Python — and the new labels come back. The synapses the
 * split was computed from are drawn as ticks, and the bar shows the split's segregation index.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { idText } from '../../core/ids'
import type { ParamValue } from '../../core/node'
import type { PointsValue, SkeletonGeometry, SkeletonsValue } from '../../core/values'
import { getRow, perGeometry } from '../../core/values'
import { DAYLIGHT_PASSES, SUBWAY_DEFAULTS } from '../../nodes/lib/arborLayout'
import type { ArborPoint, SynapseProjection } from '../../nodes/lib/arborOps'
import {
  keyTree,
  landmarkDistances,
  orientPlacement,
  projectSynapses,
  rootNodeFor,
} from '../../nodes/lib/arborOps'
import { sitesByNeuron } from '../../nodes/lib/compartmentOps'
import type { SynapseAssignment, SynapseSite } from '../../nodes/lib/topologyOps'
import { assignSynapses, compartmentStats } from '../../nodes/lib/topologyOps'
import type {
  CorrectionScope,
  CorrectionTarget,
  SplitCorrection,
} from '../../nodes/lib/splitCorrections'
import {
  CORRECTIONS_PARAM,
  CORRECTION_SCOPES,
  CORRECTION_TARGETS,
  readCorrections,
  snapToNode,
  splitArbor,
  writeCorrection,
} from '../../nodes/lib/splitCorrections'
import { CHART_INK, chartSurface, seriesColor } from '../../style/colors'
import { compartmentInks, polarityInks, splitInks } from '../compartmentInk'
import { ContextMenu } from '../menu/ContextMenu'
import { currentMode } from '../useThemeMode'
import type { ArborView } from './arborPlot'
import {
  arborPointAt,
  fitTransform,
  panBy,
  pickPiece,
  pieceGeometry,
  subSegments,
  synapseMarks,
  zoomAbout,
} from './arborPlot'
import type { BranchGroup, TickGroup } from './arborScene'
import { buildScene, paintScene } from './arborScene'
import { prepareCanvas } from './canvas2d'
import { Pager } from './Pager'
import { tooltipPoint } from './tooltipPoint'
import { useArborLayout } from './useArborLayout'
import { useElementSize } from './useElementSize'
import { usePanGesture } from './usePanGesture'
import { useWheelZoom } from './useWheelZoom'
import { ViewerEmpty } from './ViewerEmpty'

export interface SplitEditorProps {
  /** The node's `Skeletons` output: labelled, corrections applied. */
  skeletons: SkeletonsValue
  /** The node's `Synapses` input — what the split was computed from, drawn as ticks. */
  synapses?: PointsValue | undefined
  /** The stored `corrections` param, as it is. */
  corrections: unknown
  /** `showSynapses`, the remembered toggle. */
  showSynapses: boolean
  onParamChange?: ((paramId: string, value: ParamValue) => void) | undefined
}

const SCOPE_WORDS: Readonly<Record<CorrectionScope, string>> = {
  distal: 'Away from the root',
  proximal: 'Everything else',
}

/** One width for every branch: the colour carries the compartment, not the stroke. */
const LINE_WIDTH = 1.5

/** The point a click resolved to, and where in the window to open the menu. */
interface Picked {
  /** A correction anchors on its `node`, the edge's child end; a re-root on `rootNodeFor` of it. */
  readonly on: ArborPoint
  readonly x: number
  readonly y: number
}

/** A legend swatch and its word — the 3D View's key's markup. */
function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="legend__item">
      <i className="legend__swatch" style={{ background: color }} />
      {label}
    </span>
  )
}

export function SplitEditor({
  skeletons,
  synapses,
  corrections,
  showSynapses,
  onParamChange,
}: SplitEditorProps) {
  const mode = currentMode()
  const inks = useMemo(() => compartmentInks(mode), [mode])
  const codeInks = useMemo(() => splitInks(mode), [mode])
  const [page, setPage] = useState(0)
  // Clamped rather than trusted: a re-run with fewer neurons leaves the stored page past the end.
  const index = Math.min(page, Math.max(0, skeletons.items.length - 1))
  const skeleton = skeletons.items[index]
  const row = getRow(skeletons.attributes, index)
  const neuronName = String(row?.['type'] ?? row?.['instance'] ?? skeleton?.id ?? '—')

  const stored = useMemo(() => readCorrections(corrections), [corrections])
  const mine = stored.filter((c) => c.neuron === skeleton?.id)

  /* --- the root ----------------------------------------------------------------------- */

  /*
   * Chosen on this screen: a click's "Make this the root". Not a param — corrections carry their own
   * root, so which one is drawn from changes nothing downstream. Held as a position, as corrections
   * hold theirs, so a re-run that renumbers the nodes cannot leave it on the wrong one. Without a
   * choice — or after paging away — a neuron opens on the root of its latest correction, so coming
   * back to it shows it as it was being corrected, and otherwise on the default (the soma where
   * labelled).
   */
  const [chosen, setChosen] = useState<{ neuron: string; at: [number, number, number] }>()
  const rootAt =
    chosen && chosen.neuron === skeleton?.id
      ? chosen.at
      : [...mine].reverse().find((c) => c.root)?.root
  const rootNode = useMemo(() => {
    const node = skeleton && rootAt ? snapToNode(skeleton, rootAt) : -1
    return node >= 0 ? node : undefined
  }, [skeleton, rootAt])

  /* --- the arbour, rooted where the corrections are measured from ------------------------- */

  /*
   * `splitArbor` is cached on the geometry's arrays and the root, which every re-run passes through
   * untouched, so a correction — a new output, a new item object — returns the same arbour and
   * nothing below it is laid out again: only the colours change.
   */
  const arbor = skeleton ? splitArbor(skeleton, rootNode) : undefined
  const tree = useMemo(() => (arbor ? keyTree(arbor) : undefined), [arbor])
  const landmarkD = useMemo(
    () => (tree && arbor ? landmarkDistances(tree, arbor.geodesic) : undefined),
    [tree, arbor],
  )
  /*
   * Unrooted: an arbour drawn as it branches, not hung from a root, so a neuron reads as itself and
   * re-rooting moves only the dot rather than turning the drawing inside out. The Neuron
   * Dendrogram's `equalAngle`, with its default daylight passes evening out the gaps.
   */
  const { shape } = useArborLayout('equalAngle', tree, landmarkD, {
    order: 'balanced',
    subway: SUBWAY_DEFAULTS,
    daylight: DAYLIGHT_PASSES,
  })

  /* --- colour by compartment ---------------------------------------------------------- */

  const labels = skeleton?.split
  const branches = useMemo(() => {
    if (!arbor || !tree || !landmarkD) return undefined
    const colorOf = (v: number): string => codeInks[labels?.[v] ?? -1] ?? inks.unlabelled
    const sub = subSegments(arbor, tree, landmarkD, arbor.geodesic)
    const groups = new Map<string, number[]>()
    for (let i = 0; i < sub.node.length; i++) {
      const color = colorOf(sub.node[i]!)
      const group = groups.get(color)
      if (group) group.push(i)
      else groups.set(color, [i])
    }
    return {
      sub,
      groups: [...groups].map(([color, list]): BranchGroup => ({
        color,
        width: LINE_WIDTH,
        sub: Int32Array.from(list),
      })),
      landmarkColor: Array.from(tree.nodes, colorOf),
    }
  }, [arbor, tree, landmarkD, labels, inks, codeInks])

  /* --- the synapses, and how segregated this split leaves them --------------------------- */

  const byNeuron = useMemo(() => (synapses ? sitesByNeuron(synapses) : undefined), [synapses])
  const sites = skeleton ? byNeuron?.get(skeleton.id)?.sites : undefined
  const projection = skeleton && sites ? projectionOf(skeleton, sites) : undefined
  const placement = useMemo(
    () => (arbor && projection ? orientPlacement(arbor, projection) : undefined),
    [arbor, projection],
  )
  const marks = useMemo(
    () =>
      showSynapses && tree && landmarkD && arbor && placement && sites
        ? synapseMarks(
            tree,
            landmarkD,
            arbor,
            arbor.geodesic,
            placement,
            (s) => sites[s]!.polarity,
          )
        : undefined,
    [showSynapses, tree, landmarkD, arbor, placement, sites],
  )
  // Outputs and inputs already sit on opposite sides of a branch; `polarityInks` says why the hues.
  const synapseInk = useMemo(() => polarityInks(mode), [mode])
  const ticks = useMemo((): TickGroup[] => {
    if (!marks) return []
    // `side` is the polarity, 1 for an output; a synapse on no drawn piece has `piece` -1.
    const rows = (side: number) =>
      Int32Array.from(marks.side.keys()).filter(
        (s) => marks.piece[s]! >= 0 && marks.side[s] === side,
      )
    return [
      { color: synapseInk.output, alpha: 1, rows: rows(1) },
      { color: synapseInk.input, alpha: 1, rows: rows(-1) },
    ]
  }, [marks, synapseInk])

  /*
   * The segregation index of the split on screen, corrections included — `compartmentStats`, the
   * function Summary's column comes from, over the node's own nearest-node assignment.
   */
  const segregation = useMemo(
    () =>
      skeleton && labels && sites
        ? compartmentStats(skeleton, labels, assignmentOf(skeleton, sites), 'ok')
            .segregationIndex
        : undefined,
    [skeleton, labels, sites],
  )

  /* --- the stage ---------------------------------------------------------------------- */

  const [stageRef, size] = useElementSize<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState<ArborView | undefined>()
  const [picked, setPicked] = useState<Picked | undefined>()
  // Another neuron starts fitted and with no menu open; a correction to this one keeps the view.
  const neuron = skeleton?.id
  useEffect(() => {
    setView(undefined)
    setPicked(undefined)
  }, [neuron])

  const transform = useMemo(
    () =>
      shape && size.width > 0 && size.height > 0
        ? fitTransform(shape, size.width, size.height, view)
        : undefined,
    [shape, size.width, size.height, view],
  )
  const pieces = useMemo(
    () => (shape && transform ? pieceGeometry(shape, transform) : undefined),
    [shape, transform],
  )
  useWheelZoom(stageRef, transform !== undefined, (factor, x, y) => {
    if (!transform) return
    const next = zoomAbout(transform, factor, x, y)
    setView(next.zoom <= 1 ? undefined : next)
  })
  const { panning, handlers } = usePanGesture(view !== undefined, (dx, dy) => {
    if (transform) setView(panBy(transform, dx, dy))
  })

  const scene = useMemo(() => {
    if (!shape || !transform || !pieces || !tree || !branches) return undefined
    const ink = CHART_INK[mode]
    return buildScene({
      width: transform.width,
      height: transform.height,
      background: chartSurface(mode),
      title: `${neuronName}, axon/dendrite split`,
      ink: { line: ink.secondary, text: ink.primary, accent: seriesColor(0, mode) },
      shape,
      transform,
      pieces,
      settled: true,
      tree,
      lineWidth: LINE_WIDTH,
      branches,
      ticks,
      synapseSize: 5,
      ...(marks
        ? {
            marks,
            key: {
              entries: [
                { label: 'output', color: synapseInk.output },
                { label: 'input', color: synapseInk.input },
              ],
              more: 0,
            },
          }
        : {}),
    })
  }, [shape, transform, pieces, tree, branches, marks, ticks, synapseInk, mode, neuronName])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !scene) return
    const ctx = prepareCanvas(canvas, scene.width, scene.height)
    if (ctx) paintScene(ctx, scene)
  }, [scene])

  /* --- correcting --------------------------------------------------------------------- */

  const write = (next: readonly SplitCorrection[]) =>
    onParamChange?.(CORRECTIONS_PARAM, next.map(writeCorrection))

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!pieces || !tree || !arbor || !landmarkD) return
    const point = tooltipPoint(event, event.currentTarget)
    const hit = pickPiece(pieces, point.x, point.y)
    if (!hit) {
      setPicked(undefined)
      return
    }
    const on = arborPointAt(arbor, tree, landmarkD, arbor.geodesic, hit.piece, hit.along)
    setPicked({ on, x: event.clientX, y: event.clientY })
  }

  const correct = (scope: CorrectionScope, to: CorrectionTarget) => {
    if (!skeleton || !picked || !arbor) return
    const p = skeleton.positions
    write([
      ...stored,
      {
        neuron: skeleton.id,
        at: positionOf(p, picked.on.node),
        scope,
        to,
        // The root this was made against, so it means the same when re-applied.
        root: positionOf(p, arbor.root),
      },
    ])
    setPicked(undefined)
  }

  const reroot = () => {
    if (!skeleton || !picked || !arbor) return
    const node = rootNodeFor(picked.on, arbor.parent)
    setChosen({ neuron: skeleton.id, at: positionOf(skeleton.positions, node) })
    // A new root is a new drawing: the menu refers to the old one.
    setPicked(undefined)
  }

  if (!skeleton) return <ViewerEmpty>No skeletons to split.</ViewerEmpty>

  const id = idText(row?.['neuronId']) ?? skeleton.id
  return (
    <div className="split-editor">
      <div className="topo__bar">
        <Pager
          index={index}
          total={skeletons.items.length}
          onStep={(delta) => setPage(index + delta)}
          unit="neuron"
        />
        <span className="topo__name" title={id}>
          {neuronName}
        </span>
        {segregation !== undefined && (
          <span
            className="topo__count"
            title="Segregation index of this split, corrections included: 1 when outputs and inputs are wholly apart, 0 when mixed (Schneider-Mizell et al. 2016). Summary's segregationIndex."
          >
            {segregation === null ? 'SI —' : `SI ${segregation.toFixed(2)}`}
          </span>
        )}
        {synapses && onParamChange && (
          <button
            type="button"
            className="topo__pin nodrag"
            aria-pressed={showSynapses}
            title="Show or hide the synapses on the dendrogram"
            onClick={() => onParamChange('showSynapses', !showSynapses)}
          >
            Synapses
          </button>
        )}
        {chosen?.neuron === skeleton.id && (
          <button
            type="button"
            className="btn btn--ghost nodrag"
            title="Go back to the root this neuron opened on: its latest correction’s, or the soma"
            onClick={() => setChosen(undefined)}
          >
            Reset root
          </button>
        )}
        <span className="split-editor__keys">
          {CORRECTION_TARGETS.map((key) => (
            <Swatch key={key} color={inks[key]} label={key} />
          ))}
        </span>
      </div>

      <div className="split-editor__main">
        <div
          ref={stageRef}
          className="arbor__plot nodrag"
          data-panning={panning || undefined}
          data-zoomed={view !== undefined || undefined}
          {...handlers}
          onClick={onClick}
          onDoubleClick={() => setView(undefined)}
        >
          {labels ? (
            <canvas
              ref={canvasRef}
              className="arbor__canvas"
              aria-label={`${neuronName} split`}
            />
          ) : (
            <ViewerEmpty>
              This neuron has no split (see <code>splitStatus</code> in Summary), so there is
              nothing here to correct.
            </ViewerEmpty>
          )}
        </div>

        <aside className="split-editor__list" aria-label="Corrections to this neuron">
          <h4>Corrections</h4>
          {mine.length === 0 ? (
            <p className="split-editor__hint">
              Click a branch to reassign it, or everything except it, to axon, dendrite or
              linker.
            </p>
          ) : (
            <>
              <ol>
                {mine.map((c, i) => (
                  <li key={i}>
                    <Swatch color={inks[c.to]} label={`${SCOPE_WORDS[c.scope]} → ${c.to}`} />
                    {onParamChange && (
                      <button
                        type="button"
                        className="btn btn--ghost rename-body__remove nodrag"
                        aria-label={`Remove correction ${i + 1}`}
                        title="Remove this correction"
                        onClick={() => write(stored.filter((x) => x !== c))}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              {onParamChange && (
                <button
                  type="button"
                  className="btn btn--ghost nodrag"
                  onClick={() => write(stored.filter((c) => c.neuron !== skeleton.id))}
                >
                  Reset this neuron
                </button>
              )}
            </>
          )}
        </aside>
      </div>

      {/*
       * The app's own context menu: Escape and a press elsewhere close it, and it is kept inside
       * the window. Portalled, because a full-size surface can be the containing block for a
       * fixed child (`backdrop-filter`), which would put the menu somewhere other than the click.
       */}
      {picked && (
        <ContextMenu
          at={{ x: picked.x, y: picked.y }}
          onClose={() => setPicked(undefined)}
          label="Correct the split"
          portal
        >
          <button type="button" role="menuitem" className="context-menu__item" onClick={reroot}>
            Make this the root
          </button>
          {onParamChange &&
            CORRECTION_SCOPES.map((scope) => (
              <div key={scope}>
                <div className="context-menu__sep" />
                <div className="context-menu__caption">{SCOPE_WORDS[scope]} →</div>
                {CORRECTION_TARGETS.map((to) => (
                  <button
                    key={to}
                    type="button"
                    role="menuitem"
                    className="context-menu__item"
                    onClick={() => correct(scope, to)}
                  >
                    <Swatch color={inks[to]} label={to} />
                  </button>
                ))}
              </div>
            ))}
        </ContextMenu>
      )}
    </div>
  )
}

/** Node `n`'s position, as a correction stores one. */
function positionOf(p: Float32Array, n: number): [number, number, number] {
  return [p[n * 3]!, p[n * 3 + 1]!, p[n * 3 + 2]!]
}

/*
 * A neuron's synapses placed on its arbour and counted on its nodes, once per geometry
 * (`perGeometry`, which says why the key is the arrays and not the item — the node hands back a new
 * item on every correction) and synapse list, which `sitesByNeuron` builds once per cloud.
 */
interface Placed {
  projection?: SynapseProjection
  assignment?: SynapseAssignment
}
const placed = perGeometry(() => new WeakMap<readonly SynapseSite[], Placed>())

function placedOf(skeleton: SkeletonGeometry, sites: readonly SynapseSite[]): Placed {
  const bySites = placed(skeleton)
  let entry = bySites.get(sites)
  if (!entry) bySites.set(sites, (entry = {}))
  return entry
}

/** Where on the arbour each synapse sits, for the ticks. */
function projectionOf(
  skeleton: SkeletonGeometry,
  sites: readonly SynapseSite[],
): SynapseProjection {
  const entry = placedOf(skeleton, sites)
  return (entry.projection ??= projectSynapses(skeleton, sites))
}

/** Which node each synapse counts on — the node's own rule, so the index is Summary's. */
function assignmentOf(
  skeleton: SkeletonGeometry,
  sites: readonly SynapseSite[],
): SynapseAssignment {
  const entry = placedOf(skeleton, sites)
  return (entry.assignment ??= assignSynapses(skeleton, sites))
}
