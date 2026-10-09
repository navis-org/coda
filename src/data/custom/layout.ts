/**
 * What a Custom Dataset is made of, and the two ids it answers to.
 *
 * A Custom Dataset is assembled from parts wired into one node — a neuron table, an edge list, a
 * synapse table, geometry borrowed from another dataset — and `CompositeSource` answers each
 * question from the part that can. Everything here is about telling the source *which* parts a
 * dataset id means.
 *
 * ## Two ids, because inference cannot see content
 *
 * Every cache, capability gate and reference port keys on `(sourceId, datasetId)`. For a backend
 * dataset the id comes from the node's params; here it cannot, because two different neuron
 * tables with the same columns are indistinguishable to inference, which sees only types. What
 * does distinguish them is each input's provenance key, and only `evaluate` has those. So:
 *
 *  - **A layout id**, which inference publishes on the type. It names *which parts are wired and
 *    where each delegates* — nothing about their content — and that is exactly what a capability
 *    depends on. So `capabilitiesFor` answers a layout id before anything has run, through the
 *    same `capabilityOf` every node already calls, and no reader has to learn this feature.
 *    Registered from `inferOutputs` the way `registerDatastackSpec` is for Custom CAVE:
 *    synchronous and network-free, which is what makes it safe there.
 *  - **A build id**, `<layout id>/<content hash>`, which `evaluate` mints from its inputs'
 *    provenance keys and publishes on the value. It is what a query is answered for.
 *
 * The type and the value therefore carry different ids, which the seam already allows — a family
 * node on "Latest" publishes no id on its type at all until the listing lands, and
 * `useDatasetInput` prefers the value's. What it costs is stated rather than hidden: a
 * `reference` port reads the *type*, so it sees a layout id and never a build, and is refused.
 *
 * ## What the registry holds, and why that is small
 *
 * A build keeps its geometry parts' **handles** — source and dataset id — and its edge set's
 * identity, and nothing heavier; the edge set itself is `edges/store.ts`' to hold.
 * The neuron table travels on the value as `annotations`, which every request already carries to
 * the source, so it is never held here: a stale build pins no table the scheduler has let go.
 */

import { hashValue } from '../../core/hash'
import { PinnedLru } from '../../core/lruMap'
import type { ColumnSchema } from '../../core/types'
import type { DatasetEdges } from '../../core/values'
import type { DataSource, SourceCapabilities } from '../source'
import { NO_CAPABILITIES, capabilityOf, getSource } from '../source'

/** The one registered id. A Custom Dataset's identity is its dataset id, never its source. */
export const CUSTOM_SOURCE_ID = 'custom'

/** The two parts answered by another dataset's source — each also the capability it answers. */
export type GeometryRole = 'meshes' | 'skeletons'

export const GEOMETRY_ROLES: readonly GeometryRole[] = ['meshes', 'skeletons']

/** What each geometry socket is called on the card, for every message naming the one to wire. */
export const GEOMETRY_SOCKETS: Readonly<Record<GeometryRole, string>> = {
  meshes: 'Meshes',
  skeletons: 'Skeletons',
}

/**
 * A part answered by another dataset: which source, and which of its datasets.
 *
 * Both optional, because inference sees whatever the wired node's type says — a neuPrint family
 * node on "Latest" names no dataset until its listing lands. An unresolved part refuses nothing,
 * `capabilityOf`'s rule, and the layout id changes when it resolves, which re-keys nothing that
 * matters: capabilities are asked live.
 */
interface DelegatePart {
  readonly sourceId?: string
  readonly datasetId?: string
}

/** Which parts are wired, and where each geometry part delegates. Content-free by design. */
interface CompositeLayout {
  /** A neuron table is wired. Its rows travel on the value, as `annotations`. */
  readonly neurons?: true
  /**
   * An edge list is wired (Edges, or Synapses counted per pair). It travels on the value as
   * `edges`, which the connectivity funnel (`data/queries.ts`) answers from — so this source is
   * never asked a connectivity question it would have to answer itself.
   */
  readonly edges?: true
  /**
   * A synapse table is wired, with the columns it carries onto its points — which are what its
   * synapse schema is, and so what every picker below a Synapses node offers before a Run.
   */
  readonly synapses?: readonly ColumnSchema[]
  readonly meshes?: DelegatePart
  readonly skeletons?: DelegatePart
}

/**
 * A dataset that has run: the layout `evaluate` built from its input *values*, so each geometry
 * part is resolved, plus its id and what to call it.
 */
interface CompositeBuild extends CompositeLayout {
  readonly id: string
  readonly label: string
  /**
   * The edge set, by identity — the one handle this source needs of it, for the neurons an edge
   * list names when no neuron table is wired. A few strings, like the geometry handles.
   */
  readonly edgeSet?: DatasetEdges
  /** The wired synapse table's handle (`custom/synapses.ts`), for the synapse questions. */
  readonly synapseTable?: string
}

const LAYOUT_PREFIX = 'layout-'
const BUILD_SEPARATOR = '/'

/**
 * Builds kept at once besides those a live dataset value pins (`pinBuild`). A build is a few
 * strings, so this bounds a session that runs thousands of edits rather than memory.
 */
const MAX_BUILDS = 256

const layouts = new Map<string, CompositeLayout>()
const builds = new PinnedLru<CompositeBuild>(MAX_BUILDS)

/** Keep a build for as long as `owner` — the dataset value it answers for — lives. */
export function pinBuild(owner: object, id: string): void {
  builds.pin(owner, id)
}

/**
 * A layout from what is wired, spelled one way for both of the node's halves.
 *
 * Inference builds it from the input *types* (`datasetRef`) and `evaluate` from the input
 * *values*; they differ only in how resolved a delegate's dataset id is. Each part is copied down
 * to its two ids — which is also what keeps a build from pinning a delegate's annotation table —
 * and an absent key is written as absent rather than `undefined`, so the two hash alike whenever
 * they say the same thing.
 */
export function compositeLayout(
  wired: { neurons: boolean; edges: boolean; synapses?: readonly ColumnSchema[] | undefined },
  parts: Partial<Record<GeometryRole, DelegatePart>>,
): CompositeLayout {
  const layout: {
    neurons?: true
    edges?: true
    synapses?: readonly ColumnSchema[]
  } & Partial<Record<GeometryRole, DelegatePart>> = {}
  if (wired.neurons) layout.neurons = true
  if (wired.edges) layout.edges = true
  if (wired.synapses) layout.synapses = wired.synapses
  for (const role of GEOMETRY_ROLES) {
    const part = parts[role]
    if (!part) continue
    layout[role] = {
      ...(part.sourceId ? { sourceId: part.sourceId } : {}),
      ...(part.datasetId ? { datasetId: part.datasetId } : {}),
    }
  }
  return layout
}

/** The id for a layout, registering it. Same layout, same id — `hashValue` is order-stable. */
export function registerLayout(layout: CompositeLayout): string {
  const id = `${LAYOUT_PREFIX}${hashValue(layout)}`
  if (!layouts.has(id)) layouts.set(id, layout)
  return id
}

/** A build id for a layout and whatever identifies its content. */
export function buildIdFor(layoutId: string, content: unknown): string {
  return `${layoutId}${BUILD_SEPARATOR}${hashValue(content)}`
}

export function registerBuild(build: CompositeBuild): void {
  builds.set(build.id, build)
}

/** The layout id half of either kind of id. One reader of the grammar. */
function layoutIdOf(datasetId: string): string {
  const cut = datasetId.indexOf(BUILD_SEPARATOR)
  return cut === -1 ? datasetId : datasetId.slice(0, cut)
}

export function layoutFor(datasetId: string): CompositeLayout | undefined {
  return layouts.get(layoutIdOf(datasetId))
}

export function buildFor(datasetId: string): CompositeBuild | undefined {
  return builds.get(datasetId)
}

/**
 * Where a geometry part delegates, for either kind of id.
 *
 * A build's answer is the resolved one, a layout's is whatever inference could see — which is
 * what the synchronous peeks (`skeletonSourcesFor`, `meshLevelsFor`) have to work with before a
 * Run, and all they need.
 */
export function partFor(datasetId: string, role: GeometryRole): DelegatePart | undefined {
  return (builds.get(datasetId) ?? layoutFor(datasetId))?.[role]
}

/** A part's source, where its id names a registered one. The one spelling of that lookup. */
function sourceOf(part: DelegatePart): DataSource | undefined {
  return part.sourceId ? getSource(part.sourceId) : undefined
}

/**
 * A geometry part that can be asked something now: its source registered and its dataset known.
 * Undefined for a part that is absent *or* unresolved; `partFor` tells those two apart.
 */
export function resolvedPart(
  datasetId: string,
  role: GeometryRole,
): { source: DataSource; datasetId: string } | undefined {
  const part = partFor(datasetId, role)
  const source = part && sourceOf(part)
  return source && part.datasetId ? { source, datasetId: part.datasetId } : undefined
}

/**
 * What a layout can answer. **Every key starts false**, so a capability `SourceCapabilities` gains
 * later is refused here until a part is wired that can supply it, rather than falling through to
 * the source's ceiling by omission.
 *
 * A geometry capability is the delegate's own, asked live through `capabilityOf` rather than
 * copied when the layout was registered: a precomputed probe or a CAVE skeleton check lands
 * after inference has run, fires `reportSourceLearned`, and the next ask sees the answer.
 */
export function compositeCapabilities(layout: CompositeLayout): SourceCapabilities {
  const delegated = (role: GeometryRole) => {
    const part = layout[role]
    return part ? capabilityOf(sourceOf(part), part.datasetId, role) : false
  }
  return {
    ...NO_CAPABILITIES,
    skeletons: delegated('skeletons'),
    meshes: delegated('meshes'),
    // An edge list alone names its neurons: every id it mentions, with no labels. What an edge
    // list adds besides — paths, the totals — is the shared edge-set predicates' to say
    // (`canTracePaths` and kin), off the `edges` flag the node publishes on its type.
    neuronIndex: Boolean(layout.neurons || layout.edges),
    synapses: Boolean(layout.synapses),
  }
}

/**
 * The ceiling: what a layout with every part wired answers before any of them has resolved —
 * `capabilityOf`'s unresolved-refuses-nothing rule, so it is derived rather than listed twice.
 * Safe at module load: an empty part never reaches the registry (`sourceOf` answers undefined).
 */
export const CUSTOM_CAPABILITIES: SourceCapabilities = compositeCapabilities({
  neurons: true,
  edges: true,
  synapses: [],
  meshes: {},
  skeletons: {},
})

/** Test seam: forget every layout and build. */
export function resetCustomDatasets(): void {
  layouts.clear()
  builds.clear()
}
