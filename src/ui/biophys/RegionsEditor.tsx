/**
 * The Compartment Model's Regions tab: the neuron on a dendrogram, coloured by region, and the
 * place regions are painted. The gesture is the Axon/Dendrite Split editor's — click a branch, then
 * everything distal of it, or everything else, becomes a region — with names in place of the
 * split's three targets: one the model already has, or a new one the channel list then offers.
 *
 * What is drawn is `modelRegions` over the wired skeleton, the function the build itself calls, so
 * the picture is the model before a run as well as after one: what the idealised soma replaces is
 * in a hue of its own (`replacedInk`), what is ignored a faint grey. Strokes are kept in order and a later one paints over an
 * earlier one (`regions.ts`), so regions never overlap. "Distal" is measured from the soma; the root
 * does not move here. Line widths are the radii to scale (`scaleWidths`), which is what outlining a soma
 * is judged by.
 */

import { useEffect, useMemo, useState } from 'react'

import type { ParamValue } from '../../core/node'
import type { SkeletonGeometry } from '../../core/values'
import { DAYLIGHT_PASSES, SUBWAY_DEFAULTS } from '../../nodes/lib/arborLayout'
import { keyTree, landmarkDistances } from '../../nodes/lib/arborOps'
import { positionOf } from '../../nodes/lib/anchors'
import { hasRadii } from '../../nodes/lib/skeletonRadii'
import { splitArbor } from '../../nodes/lib/splitCorrections'
import { NM_PER_UM } from '../../data/units'
import type { ChannelRow } from '../../packs/biophys/channelRows'
import {
  CHANNELS_PARAM,
  isNameableRegion,
  nameableRegions,
  readChannelRows,
  writeChannelRow,
} from '../../packs/biophys/channelRows'
import type { ModelRegions, RegionScope, RegionStroke } from '../../packs/biophys/regions'
import {
  IGNORED_LABEL,
  REGIONS_PARAM,
  REGION_SCOPES,
  REGION_SCOPE_WORDS,
  SOMA_REGION,
  refusedStrokes,
  staleStrokes,
  writeRegionStroke,
} from '../../packs/biophys/regions'
import { CHART_INK, chartSurface, seriesColor, withAlpha } from '../../style/colors'
import { regionInks, replacedInk } from '../compartmentInk'
import { ContextMenu } from '../menu/ContextMenu'
import { TextField } from '../params/ParamField'
import { currentMode } from '../useThemeMode'
import {
  arborPointAt,
  pickPiece,
  scaleBarFor,
  meanEdgeRadius,
  scaleWidths,
  subSegments,
} from '../viewers/arborPlot'
import { branchGroups, buildScene } from '../viewers/arborScene'
import { tooltipPoint } from '../viewers/tooltipPoint'
import { useArborLayout } from '../viewers/useArborLayout'
import { useArborStage, usePaintedScene } from '../viewers/useArborStage'
import { Swatch } from '../viewers/LegendKeys'
import { ViewerEmpty } from '../viewers/ViewerEmpty'
import { useWidthControls } from './WidthControls'

export interface RegionsEditorProps {
  /** The wired neuron's skeleton, as the model is built from it; its `id` files a stroke. */
  skeleton: SkeletonGeometry | undefined
  /** The stored strokes, every neuron's (`readRegionStrokes`). */
  stored: readonly RegionStroke[]
  /** This neuron's regions with them painted on, as the build will have them. */
  painted: ModelRegions | undefined
  /** The stored `channels` param: a rename carries the rows naming the region with it. */
  channels: unknown
  onParamChange?: ((paramId: string, value: ParamValue) => void) | undefined
  /** Several params in one commit (`setParams`): a rename's strokes and channel rows together. */
  onParamsChange?: ((values: Readonly<Record<string, ParamValue>>) => void) | undefined
}

const LINE_WIDTH = 1.5

/** How much of the grey an ignored branch keeps: fainter than one the soma replaces, being in no model. */
const IGNORED_ALPHA = 0.45

/**
 * The first `region N` not already a name. Not `uniqueName`, whose first answer is the bare
 * `region`: a painted region is one of several, and numbered from the first.
 */
function freshName(names: readonly string[]): string {
  let k = 1
  while (names.includes(`region ${k}`)) k++
  return `region ${k}`
}

interface Picked {
  readonly node: number
  readonly x: number
  readonly y: number
}

export function RegionsEditor({
  skeleton,
  stored,
  painted,
  channels,
  onParamChange,
  onParamsChange,
}: RegionsEditorProps) {
  const mode = currentMode()
  const skeletonId = skeleton?.id
  const mine = useMemo(
    () => stored.filter((s) => s.neuron === skeletonId),
    [stored, skeletonId],
  )
  const inks = useMemo(() => (painted ? regionInks(painted.names, mode) : []), [painted, mode])
  // What the model leaves as no cable of its own: replaced by the soma, or ignored.
  const replaced = replacedInk(mode)
  const ignoredInk = withAlpha(CHART_INK[mode].muted, IGNORED_ALPHA)
  const inkOf = (name: string) =>
    inks[painted?.names.indexOf(name) ?? -1] ?? CHART_INK[mode].muted
  // A stroke's swatch and words: an ignoring one names no region.
  const strokeInk = (s: RegionStroke) => (s.ignore ? ignoredInk : inkOf(s.region))
  const strokeName = (s: RegionStroke) => (s.ignore ? IGNORED_LABEL : s.region)
  const withRadii = useMemo(() => (skeleton ? hasRadii(skeleton.radii) : false), [skeleton])
  const { scale: widthScale, controls: widthControls } = useWidthControls(
    withRadii,
    'Draw each branch as wide as it is, to scale with its length: what a soma’s outline is judged by',
  )

  /* --- the arbour, from the soma ------------------------------------------------------- */

  // Memoised: with no root given, `splitArbor` looks for the soma again on every call.
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

  const stage = useArborStage(shape, skeletonId)
  const { stageRef, canvasRef, transform, pieces, panning, handlers } = stage

  // The pieces once per arbour; only their colours follow a stroke or a rename.
  const sub = useMemo(
    () =>
      arbor && tree && landmarkD
        ? subSegments(arbor, tree, landmarkD, arbor.geodesic)
        : undefined,
    [arbor, tree, landmarkD],
  )
  // Each edge's radius, once per arbour: what a to-scale width is drawn from.
  const edgeRadius = useMemo(
    () => (arbor && skeleton ? meanEdgeRadius(arbor, skeleton.radii) : undefined),
    [arbor, skeleton],
  )
  // Colours, which a zoom never moves: recomputed on a stroke, a rename, a theme.
  const colored = useMemo(() => {
    if (!sub || !tree || !painted) return undefined
    const colorOf = (v: number): string =>
      painted.ignored[v] ? ignoredInk : painted.somaSet[v] ? replaced : inks[painted.label[v]!]!
    return {
      colors: Array.from(sub.node, colorOf),
      landmarkColor: Array.from(tree.nodes, colorOf),
    }
  }, [sub, tree, painted, inks, replaced, ignoredInk])
  // To scale: as wide as the cable is, so it follows the zoom — regrouped on a zoom, never a pan.
  const pxPerUnit =
    transform && widthScale !== undefined ? transform.sx * widthScale : undefined
  const branches = useMemo(() => {
    if (!sub || !colored) return undefined
    const widths =
      pxPerUnit !== undefined && edgeRadius
        ? scaleWidths(sub, edgeRadius, pxPerUnit)
        : LINE_WIDTH
    const { colors, landmarkColor } = colored
    return {
      sub,
      groups: branchGroups(colors.length, (i) => colors[i]!, widths),
      landmarkColor,
    }
  }, [sub, colored, pxPerUnit, edgeRadius])

  /* --- the stage ----------------------------------------------------------------------- */

  const [picked, setPicked] = useState<Picked | undefined>()
  useEffect(() => setPicked(undefined), [skeletonId])

  const somaRadius =
    painted && painted.somaDiameter > 0 ? (painted.somaDiameter * NM_PER_UM) / 2 : 0
  const scene = useMemo(() => {
    if (!shape || !transform || !pieces || !tree || !branches) return undefined
    const ink = CHART_INK[mode]
    return buildScene({
      width: transform.width,
      height: transform.height,
      background: chartSurface(mode),
      title: 'Regions',
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
      scaleBar: scaleBarFor(transform),
      // The idealised soma's size round its node: what the purple nodes are replaced by. The
      // layout's lengths are cable in nm, so this is its radius at the drawing's scale.
      ...(somaRadius > 0 ? { rootRing: { r: somaRadius } } : {}),
    })
  }, [shape, transform, pieces, tree, branches, somaRadius, mode])

  usePaintedScene(canvasRef, scene)

  /* --- painting ------------------------------------------------------------------------ */

  const write = (next: readonly RegionStroke[]) =>
    onParamChange?.(REGIONS_PARAM, next.map(writeRegionStroke))

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!pieces || !tree || !arbor || !landmarkD) return
    const point = tooltipPoint(event, event.currentTarget)
    const hit = pickPiece(pieces, point.x, point.y)
    if (!hit) {
      setPicked(undefined)
      return
    }
    const on = arborPointAt(arbor, tree, landmarkD, arbor.geodesic, hit.piece, hit.along)
    setPicked({ node: on.node, x: event.clientX, y: event.clientY })
  }

  /** Paint `region` over the picked node's `scope`; `undefined` ignores it instead. */
  const paint = (scope: RegionScope, region: string | undefined) => {
    if (!skeleton || !picked || !arbor) return
    const p = skeleton.positions
    write([
      ...stored,
      {
        neuron: skeleton.id,
        at: positionOf(p, picked.node),
        scope,
        region: region ?? '',
        ...(region === undefined ? { ignore: true as const } : {}),
        root: positionOf(p, arbor.root),
      },
    ])
    setPicked(undefined)
  }

  /*
   * A painted region renamed: every stroke painting it, this neuron's or another's, and every
   * channel row placed on it — names being shared across neurons as the rows are — so a channel
   * stays where it was put. Renaming onto a name already in use merges the two.
   */
  const rename = (from: string, to: string) => {
    const name = to.trim()
    if (name === from || !isNameableRegion(name)) return
    const values: Record<string, ParamValue> = {
      [REGIONS_PARAM]: stored
        .map((s) => (s.region === from ? { ...s, region: name } : s))
        .map(writeRegionStroke),
    }
    const rows = readChannelRows(channels)
    if (rows.some((row) => row.regions.includes(from))) {
      values[CHANNELS_PARAM] = rows
        .map((row): ChannelRow => ({
          ...row,
          regions: [...new Set(row.regions.map((r) => (r === from ? name : r)))],
        }))
        .map(writeChannelRow)
    }
    // One commit where the surface offers it, so one ⌘Z takes back the whole rename.
    if (onParamsChange) onParamsChange(values)
    else for (const [id, value] of Object.entries(values)) onParamChange?.(id, value)
  }

  // The menu's lists, kept: the editor re-renders on every pan frame, and `fresh` parses every row.
  const menu = useMemo(() => {
    const names = painted?.names ?? []
    // What the menu offers: every region but unlabelled cable, which no channel row can name.
    const targets = nameableRegions(names)
    // New to every neuron's strokes and every channel row, not just this neuron's regions: a name in
    // use elsewhere would hand this region that one's channels.
    const fresh = freshName([
      ...names,
      ...stored.map((s) => s.region),
      ...readChannelRows(channels).flatMap((row) => row.regions),
    ])
    // Not `soma`: painted touching the soma node it is what the idealised soma replaces, so a rename
    // would turn those nodes back into cable and carry the soma's channel rows off with it.
    const soma = names[SOMA_REGION]
    return {
      targets,
      fresh,
      paintedNames: new Set(
        mine.filter((s) => !s.ignore && s.region !== soma).map((s) => s.region),
      ),
    }
  }, [painted, stored, channels, mine])

  if (!skeleton || !painted) {
    return <ViewerEmpty>Wire a skeleton to paint its regions.</ViewerEmpty>
  }

  const { targets, fresh, paintedNames } = menu

  return (
    <div className="split-editor">
      <div className="topo__bar">
        <span className="split-editor__keys">
          {painted.names.map((name, i) => (
            <Swatch key={name} color={inks[i]!} label={name} />
          ))}
          {painted.replacedCount > 0 && (
            <Swatch color={replaced} label="replaced by the soma" />
          )}
          {painted.ignoredCount > 0 && <Swatch color={ignoredInk} label={IGNORED_LABEL} />}
        </span>
        {widthControls}
      </div>

      <div className="split-editor__main">
        <div
          ref={stageRef}
          className="arbor__plot nodrag"
          data-panning={panning || undefined}
          data-zoomed={stage.zoomed || undefined}
          {...handlers}
          onClick={onClick}
          onDoubleClick={stage.resetView}
        >
          <canvas ref={canvasRef} className="arbor__canvas" aria-label="Regions" />
        </div>

        <aside className="split-editor__list" aria-label="Painted regions">
          <h4>Painted</h4>
          {mine.length === 0 ? (
            <p className="split-editor__hint">
              Click a branch to make everything distal of it, or everything else, a region of
              its own. Later strokes paint over earlier ones.
            </p>
          ) : (
            <>
              <ol>
                {mine.map((s, i) => (
                  <li key={i}>
                    <Swatch
                      color={strokeInk(s)}
                      label={`${REGION_SCOPE_WORDS[s.scope]} → ${strokeName(s)}`}
                    />
                    {onParamChange && (
                      <button
                        type="button"
                        className="btn btn--ghost rename-body__remove nodrag"
                        aria-label={`Remove stroke ${i + 1}`}
                        title="Remove this stroke"
                        onClick={() => write(stored.filter((x) => x !== s))}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              {painted.stale > 0 && (
                <p className="split-editor__hint">{staleStrokes(painted.stale)}</p>
              )}
              {painted.refused > 0 && (
                <p className="split-editor__hint">{refusedStrokes(painted.refused)}</p>
              )}
              {onParamChange && (
                <>
                  <h4>Names</h4>
                  {[...paintedNames].map((name) => (
                    <TextField
                      key={name}
                      label={`Rename ${name}`}
                      value={name}
                      debounce={false}
                      onChange={(to) => rename(name, to)}
                    />
                  ))}
                  <button
                    type="button"
                    className="btn btn--ghost nodrag"
                    onClick={() => write(stored.filter((s) => s.neuron !== skeletonId))}
                  >
                    Clear painted regions
                  </button>
                </>
              )}
            </>
          )}
        </aside>
      </div>

      {/* What the lines are, since they look like the model and are not its compartments. */}
      <div className="viewer__caption">
        The skeleton, every edge: straightened between branch points, branch lengths to scale.
        Not the model’s compartments — the soma is drawn as the nodes it replaces.
      </div>

      {picked && onParamChange && (
        <ContextMenu
          at={{ x: picked.x, y: picked.y }}
          onClose={() => setPicked(undefined)}
          label="Paint a region"
          portal
        >
          {REGION_SCOPES.map((scope, k) => (
            <div key={scope}>
              {k > 0 && <div className="context-menu__sep" />}
              <div className="context-menu__caption">{REGION_SCOPE_WORDS[scope]} →</div>
              {targets.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="menuitem"
                  className="context-menu__item"
                  onClick={() => paint(scope, name)}
                >
                  <Swatch color={inkOf(name)} label={name} />
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                className="context-menu__item"
                onClick={() => paint(scope, fresh)}
              >
                New region ({fresh})
              </button>
              {/* Only away from the soma: the other two scopes would take the soma with them. */}
              {scope === 'distal' && (
                <button
                  type="button"
                  role="menuitem"
                  className="context-menu__item"
                  onClick={() => paint(scope, undefined)}
                >
                  <Swatch color={ignoredInk} label="Ignore (leave out of the model)" />
                </button>
              )}
            </div>
          ))}
        </ContextMenu>
      )}
    </div>
  )
}
