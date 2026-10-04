/**
 * A BigClust project's neuroglancer scene, as a data source the Neuroglancer node can read.
 *
 * A project's `neuroglancer` block is not a scene but what BigClust builds one from
 * (`NeuroglancerSpec`): where each neuron's segmentation lives, its colour, and a context mesh.
 * This builds the scene once per project — one segmentation layer per distinct source, then the
 * context mesh — and answers the Neuroglancer node's two questions about it: the scene itself
 * (`fetchViewerScene`) and which layer, in which colour, each selected neuron goes in
 * (`placeSegments`). So the node needs no knowledge of BigClust: a project's `Scene` output is a
 * Dataset like any other whose source publishes a scene.
 *
 * **A source per project and refresh nonce**, registered on demand like a precomputed URL's
 * (`precomputed/registry.ts`): a node resolves its source by id, and the id has to name what is
 * read. It holds the project's address and nothing read from it — meta is `readMeta`'s, held
 * weakly, so a source outliving its node pins nothing.
 *
 * Two parts of the block cannot travel in a link, and `sceneNotes` says so on the project's card:
 * landmark **transforms** (a warp between two datasets' spaces; neuroglancer applies only affine
 * transforms, so a second dataset is drawn in its own space), and a **local mesh file** as context
 * (a link cannot reach a file on somebody's disk).
 */

import type { CellValue } from '../../core/values'
import { uniqueName } from '../../core/types'
import { foreignColor } from '../foreignColor'
import { parseNgSource } from '../neuroglancer/sourceUrl'
import { framedScene } from '../neuroglancer/frame'
import { datasourceLabel } from '../precomputed/PrecomputedSource'
import type { NgScene } from '../neuroglancer/scene'
import type {
  DataSource,
  DatasetInfo,
  PlaceSegmentsRequest,
  SegmentPlacement,
  SourceCapabilities,
  SourceSchemas,
  ViewerSceneRequest,
} from '../source'
import { ID_ONLY, NO_CAPABILITIES, getSource, registerSource } from '../source'
import type { NeuroglancerSpec, ProjectInfo } from './info'
import type { ProjectRef } from './project'
import { isAddress, peekProject, projectKey, readMeta, readProjectSummary } from './project'

/** The one dataset a scene source has. Its layers are named by the project's own datasets. */
export const SCENE_DATASET = 'scene'

const SCHEMAS: SourceSchemas = {
  neurons: ID_ONLY,
  connectivity: ID_ONLY,
  roiCounts: ID_ONLY,
  morphology: ID_ONLY,
  synapses: ID_ONLY,
}

/** A scene and nothing else: every question but the viewer is refused at edit time. */
const CAPABILITIES: SourceCapabilities = { ...NO_CAPABILITIES, viewerScene: true }

const NOT_A_CONNECTOME =
  'A BigClust scene only holds a neuroglancer scene and has no neurons or connectivity. Wire it to a Neuroglancer node.'

/** The context mesh's layer: faint, unpickable, in BigClust's near-white. */
const NEUROPIL_LAYER = {
  objectAlpha: 0.1,
  segmentDefaultColor: '#cccccc',
  pick: false,
} as const

/** What a project's scene is, built once from meta: the scene, and where each neuron goes in it. */
interface ProjectScene {
  readonly scene: NgScene | undefined
  /**
   * By neuron id. The placements themselves are shared — one object per distinct layer and colour,
   * which for fish2's 129,325 neurons is one — so this costs the map and nothing per neuron.
   */
  readonly placements: ReadonlyMap<string, SegmentPlacement>
}

/** Per meta read, held as long as meta is (`readMeta` keeps its ids weakly). */
const built = new WeakMap<string[], ProjectScene>()

/**
 * What the scene leaves out of the project's block, as sentences for the project's card. Known
 * from `info` alone, so a card says it before anything runs.
 */
export function sceneNotes(spec: NeuroglancerSpec | undefined): string[] {
  if (!spec) return []
  const notes: string[] = []
  if (spec.transforms) {
    notes.push(
      'The project warps one dataset into another’s space with landmarks; neuroglancer cannot, ' +
        'so the Scene draws each dataset in its own space.',
    )
  }
  const mesh = spec.neuropilMesh
  if (mesh && !mesh.includes('@')) {
    notes.push(
      `The project’s context mesh, ${mesh}, is a plain file. Only a neuroglancer source ` +
        'can go into a link, so the mesh is left out of the scene.',
    )
  }
  return notes
}

/** Each meta row's value of a `source` or `color` spec: a column, a per-dataset map, or one value. */
function perRow(
  spec: NeuroglancerSpec['source'] | NeuroglancerSpec['color'],
  cells: Readonly<Record<string, CellValue[]>>,
): (row: number) => unknown {
  if (spec === undefined) return () => undefined
  if (typeof spec === 'string') {
    const data = cells[spec]
    return data ? (row) => data[row] : () => spec
  }
  if (Array.isArray(spec)) return () => spec
  const map = spec as Readonly<Record<string, unknown>>
  const datasets = cells['dataset']
  return datasets ? (row) => map[String(datasets[row])] : () => undefined
}

/** A row's source, where it is one neuroglancer can read rather than a path below the project. */
function sourceOf(raw: unknown): string | undefined {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return isAddress(text) ? text : undefined
}

function buildProjectScene(
  info: ProjectInfo,
  ids: string[],
  cells: Readonly<Record<string, CellValue[]>>,
): ProjectScene {
  const spec = info.neuroglancer
  const sourceAt = perRow(spec?.source, cells)
  const colorAt = perRow(spec?.color, cells)
  const datasets = cells['dataset']

  // A layer per distinct source, in order of first appearance, named by the dataset its neurons
  // come from where they all come from one — MCNS, BANC — and by the source's own name otherwise.
  const datasetOf = new Map<string, string | null>()
  for (let row = 0; row < ids.length; row++) {
    const source = sourceOf(sourceAt(row))
    if (!source) continue
    const dataset = datasets?.[row]
    const label = dataset === null || dataset === undefined ? null : String(dataset)
    if (!datasetOf.has(source)) datasetOf.set(source, label)
    else if (datasetOf.get(source) !== label) datasetOf.set(source, null)
  }
  const taken = new Set<string>()
  const nameOf = new Map<string, string>()
  for (const [source, dataset] of datasetOf) {
    // `dvid://…/segmentation?dvid-service=…` names its volume before the options.
    const location = parseNgSource(source)?.location.split('?')[0]
    const own = location ? datasourceLabel(location).split('/').pop() : undefined
    nameOf.set(source, uniqueName(taken, dataset ?? info.dataset ?? own ?? 'segmentation'))
  }

  // Colours memoised by the text a cell says (all 129,325 of fish2's say `orange`), and placements
  // shared by layer and colour.
  const colorMemo = new Map<string, string | undefined>()
  const colorOf = (raw: unknown) => {
    if (typeof raw !== 'string') return foreignColor(raw as readonly unknown[] | undefined)
    if (!colorMemo.has(raw)) colorMemo.set(raw, foreignColor(raw))
    return colorMemo.get(raw)
  }
  const shared = new Map<string, SegmentPlacement>()
  const placements = new Map<string, SegmentPlacement>()
  for (let row = 0; row < ids.length; row++) {
    const id = ids[row]!
    if (placements.has(id)) continue
    const source = sourceOf(sourceAt(row))
    const layer = source === undefined ? undefined : nameOf.get(source)
    const color = colorOf(colorAt(row))
    const key = `${layer ?? ''}\u0000${color ?? ''}`
    let placement = shared.get(key)
    if (!placement) {
      placement = { ...(layer ? { layer } : {}), ...(color ? { color } : {}) }
      shared.set(key, placement)
    }
    placements.set(id, placement)
  }

  const sceneLayers: Record<string, unknown>[] = [...nameOf].map(([source, name]) => ({
    type: 'segmentation',
    source,
    name,
    segments: [],
  }))
  const mesh = spec?.neuropilMesh
  const at = mesh?.indexOf('@') ?? -1
  if (mesh && at > 0 && isAddress(mesh.slice(at + 1))) {
    sceneLayers.push({
      type: 'segmentation',
      source: mesh.slice(at + 1),
      name: uniqueName(taken, 'neuropil'),
      // `1,2,3@…`: BigClust's example names three shells, which one id would not parse as.
      segments: mesh
        .slice(0, at)
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
      ...NEUROPIL_LAYER,
    })
  }
  return {
    scene: nameOf.size > 0 ? { layers: sceneLayers, layout: '3d' } : undefined,
    placements,
  }
}

class BigClustSceneSource implements DataSource {
  readonly id: string
  readonly label: string
  readonly capabilities = CAPABILITIES
  readonly schemas = SCHEMAS
  private readonly project: ProjectRef
  private readonly refresh: number

  constructor(project: ProjectRef, refresh: number) {
    this.project = project
    this.refresh = refresh
    this.id = sceneSourceId(project, refresh)
    this.label = project.kind === 'url' ? project.base : project.name
  }

  private info(): ProjectInfo | undefined {
    return peekProject(this.project, this.refresh)?.summary?.info
  }

  private datasetInfo(): DatasetInfo {
    const info = this.info()
    return {
      id: SCENE_DATASET,
      label: info?.name ?? this.label,
      ...(info?.description ? { description: info.description } : {}),
      rois: [],
      statuses: [],
    }
  }

  async listDatasets(): Promise<DatasetInfo[]> {
    return [this.datasetInfo()]
  }

  peekDatasets(): DatasetInfo[] {
    return [this.datasetInfo()]
  }

  peekDataset(datasetId: string): DatasetInfo | undefined {
    return datasetId === SCENE_DATASET ? this.datasetInfo() : undefined
  }

  /** No scene where the project's block names no source; unknown until `info` is read. */
  capabilitiesFor(): Partial<SourceCapabilities> | undefined {
    const info = this.info()
    return info ? { viewerScene: info.neuroglancer?.source !== undefined } : undefined
  }

  private async built(signal?: AbortSignal): Promise<ProjectScene> {
    const summary = await readProjectSummary(this.project, {
      refresh: this.refresh,
      ...(signal ? { signal } : {}),
    })
    const { ids, cells } = await readMeta(this.project, summary, this.refresh, signal)
    let scene = built.get(ids)
    if (!scene) {
      scene = buildProjectScene(summary.info, ids, cells)
      built.set(ids, scene)
    }
    return scene
  }

  async fetchViewerScene(req: ViewerSceneRequest): Promise<NgScene | undefined> {
    const { scene } = await this.built(req.signal)
    // Its neuron layers are often mesh directories, which give neuroglancer nowhere to open.
    return scene && framedScene(scene, req.signal)
  }

  /** Every neuron's placement, which answers for any selection: a lookup, not a copy. */
  async placeSegments(
    req: PlaceSegmentsRequest,
  ): Promise<ReadonlyMap<string, SegmentPlacement>> {
    return (await this.built(req.signal)).placements
  }

  async findNeurons(): Promise<never> {
    throw new Error(NOT_A_CONNECTOME)
  }

  async fetchConnectivity(): Promise<never> {
    throw new Error(NOT_A_CONNECTOME)
  }

  async fetchAdjacency(): Promise<never> {
    throw new Error(NOT_A_CONNECTOME)
  }
}

function sceneSourceId(project: ProjectRef, refresh: number): string {
  return `bigclust:${projectKey(project)}#${refresh}`
}

/** The scene source for a project, registering it the first time it is asked for. */
export function sceneSourceFor(project: ProjectRef, refresh: number): DataSource {
  const existing = getSource(sceneSourceId(project, refresh))
  if (existing instanceof BigClustSceneSource) return existing
  return registerSource(new BigClustSceneSource(project, refresh))
}
