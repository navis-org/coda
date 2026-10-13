/**
 * The Compartment Model's Regions tab: the neuron on a dendrogram, coloured by region, and the
 * place regions are painted. The gesture is the Axon/Dendrite Split editor's — click a branch, then
 * everything distal of it, or everything else, becomes a region — with names in place of the
 * split's three targets: one the model already has, or a new one the channel list then offers.
 *
 * What is drawn is `paintedRegions` over the wired skeleton, the function the build itself calls, so
 * the picture is the model's regions before a run as well as after one. Strokes are kept in order
 * and a later one paints over an earlier one (`regions.ts`), so regions never overlap. "Distal" is
 * measured from the soma; the root does not move here.
 */

import { useEffect, useMemo, useState } from 'react'

import type { ParamValue } from '../../core/node'
import type { SkeletonGeometry } from '../../core/values'
import { DAYLIGHT_PASSES, SUBWAY_DEFAULTS } from '../../nodes/lib/arborLayout'
import { keyTree, landmarkDistances } from '../../nodes/lib/arborOps'
import { positionOf } from '../../nodes/lib/anchors'
import type { CorrectionScope } from '../../nodes/lib/splitCorrections'
import { CORRECTION_SCOPES, SCOPE_WORDS, splitArbor } from '../../nodes/lib/splitCorrections'
import type { ChannelRow } from '../../packs/biophys/channelRows'
import {
  CHANNELS_PARAM,
  isNameableRegion,
  nameableRegions,
  readChannelRows,
  writeChannelRow,
} from '../../packs/biophys/channelRows'
import type { RegionStroke, paintedRegions } from '../../packs/biophys/regions'
import { REGIONS_PARAM, staleStrokes, writeRegionStroke } from '../../packs/biophys/regions'
import { CHART_INK, chartSurface, cycleColor, seriesColor } from '../../style/colors'
import type { Mode } from '../../style/colors'
import { compartmentInks } from '../compartmentInk'
import { ContextMenu } from '../menu/ContextMenu'
import { TextField } from '../params/ParamField'
import { currentMode } from '../useThemeMode'
import { arborPointAt, pickPiece, subSegments } from '../viewers/arborPlot'
import { branchGroups, buildScene } from '../viewers/arborScene'
import { tooltipPoint } from '../viewers/tooltipPoint'
import { useArborLayout } from '../viewers/useArborLayout'
import { useArborStage, usePaintedScene } from '../viewers/useArborStage'
import { Swatch } from '../viewers/LegendKeys'
import { ViewerEmpty } from '../viewers/ViewerEmpty'

export interface RegionsEditorProps {
  /** The wired neuron's skeleton, as the model is built from it; its `id` files a stroke. */
  skeleton: SkeletonGeometry | undefined
  /** The stored strokes, every neuron's (`readRegionStrokes`). */
  stored: readonly RegionStroke[]
  /** This neuron's regions with them painted on, as the build will have them. */
  painted: ReturnType<typeof paintedRegions> | undefined
  /** The stored `channels` param: a rename carries the rows naming the region with it. */
  channels: unknown
  onParamChange?: ((paramId: string, value: ParamValue) => void) | undefined
  /** Several params in one commit (`setParams`): a rename's strokes and channel rows together. */
  onParamsChange?: ((values: Readonly<Record<string, ParamValue>>) => void) | undefined
}

const LINE_WIDTH = 1.5

/**
 * A region's ink: the compartment colours for the names the split and SWC labels give, the next
 * palette slots for painted ones, in the order they first appear.
 */
function regionInks(names: readonly string[], mode: Mode): string[] {
  const own: Readonly<Record<string, string>> = compartmentInks(mode)
  let painted = 0
  // Slots 0 and 1 are the dendrite's and the axon's.
  return names.map((name) => own[name] ?? cycleColor(2 + painted++, mode))
}

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
  const mine = stored.filter((s) => s.neuron === skeletonId)
  const inks = useMemo(() => (painted ? regionInks(painted.names, mode) : []), [painted, mode])
  const inkOf = (name: string) =>
    inks[painted?.names.indexOf(name) ?? -1] ?? CHART_INK[mode].muted

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

  // The pieces once per arbour; only their colours follow a stroke or a rename.
  const sub = useMemo(
    () =>
      arbor && tree && landmarkD
        ? subSegments(arbor, tree, landmarkD, arbor.geodesic)
        : undefined,
    [arbor, tree, landmarkD],
  )
  const branches = useMemo(() => {
    if (!sub || !tree || !painted) return undefined
    const colorOf = (v: number): string => inks[painted.label[v]!]!
    return {
      sub,
      groups: branchGroups(sub.node.length, (i) => colorOf(sub.node[i]!), LINE_WIDTH),
      landmarkColor: Array.from(tree.nodes, colorOf),
    }
  }, [sub, tree, painted, inks])

  /* --- the stage ----------------------------------------------------------------------- */

  const stage = useArborStage(shape, skeletonId)
  const { stageRef, canvasRef, transform, pieces, panning, handlers } = stage
  const [picked, setPicked] = useState<Picked | undefined>()
  useEffect(() => setPicked(undefined), [skeletonId])

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
    })
  }, [shape, transform, pieces, tree, branches, mode])

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

  const paint = (scope: CorrectionScope, region: string) => {
    if (!skeleton || !picked || !arbor) return
    const p = skeleton.positions
    write([
      ...stored,
      {
        neuron: skeleton.id,
        at: positionOf(p, picked.node),
        scope,
        region,
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

  if (!skeleton || !painted) {
    return <ViewerEmpty>Wire a skeleton to paint its regions.</ViewerEmpty>
  }

  // What the menu offers: every region but unlabelled cable, which no channel row can name.
  const targets = nameableRegions(painted.names)
  // New to every neuron's strokes and every channel row, not just this neuron's regions: a name in
  // use elsewhere would hand this region that one's channels.
  const fresh = freshName([
    ...painted.names,
    ...stored.map((s) => s.region),
    ...readChannelRows(channels).flatMap((row) => row.regions),
  ])
  const paintedNames = new Set(mine.map((s) => s.region))
  return (
    <div className="split-editor">
      <div className="topo__bar">
        <span className="split-editor__keys">
          {painted.names.map((name, i) => (
            <Swatch key={name} color={inks[i]!} label={name} />
          ))}
        </span>
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
                      color={inkOf(s.region)}
                      label={`${SCOPE_WORDS[s.scope]} → ${s.region}`}
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

      {picked && onParamChange && (
        <ContextMenu
          at={{ x: picked.x, y: picked.y }}
          onClose={() => setPicked(undefined)}
          label="Paint a region"
          portal
        >
          {CORRECTION_SCOPES.map((scope, k) => (
            <div key={scope}>
              {k > 0 && <div className="context-menu__sep" />}
              <div className="context-menu__caption">{SCOPE_WORDS[scope]} →</div>
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
            </div>
          ))}
        </ContextMenu>
      )}
    </div>
  )
}
