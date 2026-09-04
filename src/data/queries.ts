/**
 * Every connectivity question, answered from the dataset's attached edge set where there is one
 * and from the backend where there is not.
 *
 * **One funnel, three questions, and nodes call it instead of the source.** That is the same
 * call `capabilityOf` already makes and for its stated reason: a per-dataset override is useless
 * to a reader that skips it, and the two halves of a gate usually sit in different layers — so a
 * node reaching past this to `source.fetchConnectivity` would work perfectly, ignore the edge
 * set, and answer a different question with nothing type-checking the pair.
 *
 * ## All three together
 *
 * If connectivity is user-supplied then Connectivity, Adjacency, Paths and Profile all read it.
 * Answering some of them from a file and the rest from the backend would put two connectomes in
 * one graph with nothing on any card saying which node used which.
 *
 * ## It refuses; it never falls back
 *
 * A dataset naming an edge set this browser does not have is a graph that cannot be run. Asking
 * the backend instead would produce a green node, a plausible table, and a different answer from
 * the one the author saw. The message names the set and says that importing the same file
 * resolves it — which is true, because the id is the content.
 *
 * ## Types are the dataset's
 *
 * A file of `pre, post, weight` says nothing about what either end is called, so `neuronType`
 * and `partnerType` come from the neuron index — the same lookup `CaveSource` uses, so an
 * annotation chain reaches these columns exactly as it reaches every other surface.
 */

import type { CellValue, DatasetEdges, MatrixValue, TableValue } from '../core/values'
import { tableFromRows } from '../core/values'
import type { DType } from '../core/types'
import type { NeuronId } from '../core/ids'
import { numericId } from '../core/ids'
import type { Edge } from './connectivity'
import { matrixFromEdges, typesOf } from './connectivity'
import { edgesBetween, edgesFrom, pathStepFrom } from './edges/query'
import type { LoadedEdgeSet } from './edges/store'
import { loadEdgeSet } from './edges/store'
import type {
  AdjacencyRequest,
  ConnectivityRequest,
  DataSource,
  GroupTotalsRequest,
  PathStepRequest,
  SourceSchemas,
  SynapseTotalsRequest,
} from './source'
import {
  canSplitConnectivityByRoi,
  canTotalGroups,
  canTotalSynapses,
  canTracePaths,
  capabilityOf,
  groupTotalsRefusal,
} from './source'

/**
 * The attached set, or a refusal naming it.
 *
 * Total rather than partial: given an identity it either answers or throws, so a caller has one
 * branch — is anything attached — rather than two that lead to the same place.
 */
async function attached(edges: DatasetEdges): Promise<LoadedEdgeSet> {
  const set = await loadEdgeSet(edges.id)
  if (set) return set
  throw new Error(
    `This dataset's connectivity comes from the edge set "${edges.name}", which is not in ` +
      `this browser. Import the same file under Edge data on the dataset node — an edge set is ` +
      `identified by its contents, so the same file will match.`,
  )
}

function schemasOf(source: DataSource, datasetId: string): SourceSchemas {
  return source.schemasFor?.(datasetId) ?? source.schemas
}

/**
 * Cell types for a dataset, or an empty map where the source cannot enumerate its neurons.
 *
 * Empty is a real answer rather than a failure: `neuronType`/`partnerType` come back null, which
 * is what a connectivity table already carries for an untyped partner. Refusing instead would
 * make an edge set unusable on exactly the datastacks that most need one.
 */
async function typeLookup(
  source: DataSource,
  datasetId: string,
  req: { annotations?: ConnectivityRequest['annotations']; signal?: AbortSignal },
): Promise<Map<NeuronId, string>> {
  if (!source.neuronIndex || !capabilityOf(source, datasetId, 'neuronIndex')) return new Map()
  const index = await source.neuronIndex({
    datasetId,
    ...(req.annotations ? { annotations: req.annotations } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  })
  return typesOf(index)
}

/**
 * Ids already checked against a dtype, so a hundred-thousand-entry dictionary is walked once.
 *
 * `WeakMap` on the loaded set, `typesOf`'s idiom — `loadEdgeSet` holds one object per set for
 * the session, so the memo hits across every hop of a traversal.
 */
const checked = new WeakSet<LoadedEdgeSet>()

/**
 * Refuse an edge set whose ids cannot survive the dataset's own id dtype.
 *
 * neuPrint publishes `neuronId` as `i64` because its ids are exact as doubles; CAVE publishes
 * `str`. An eighteen-digit id written into an `i64` column is a **different neuron**, so an edge
 * list from one connectome attached to a dataset from another has to stop here rather than
 * produce a table of neurons that do not exist. Checked against the dictionary — the distinct
 * ids — rather than per row, so it costs one pass over 140,000 entries instead of ten million.
 */
function requireIdsFit(set: LoadedEdgeSet, dtype: DType): void {
  // Only `i64` can lose an id, so the memo is "has this set been checked" rather than a set of
  // dtypes — the early return above means no second one could ever be recorded.
  if (dtype !== 'i64') return
  if (checked.has(set)) return
  const bad = set.ids.find((id) => numericId(id) === undefined)
  if (bad !== undefined) {
    throw new Error(
      `The edge set "${set.meta.name}" holds ids too wide for this dataset's numeric ids — ` +
        `"${bad}" cannot be stored exactly. It is probably from a different connectome.`,
    )
  }
  checked.add(set)
}

/** One id as the cell a dataset's own schema calls for. */
function idCell(id: NeuronId, dtype: DType): CellValue {
  return dtype === 'i64' ? (numericId(id) ?? null) : id
}

export async function connectivityFor(
  source: DataSource,
  req: ConnectivityRequest,
): Promise<TableValue> {
  /*
   * The region options are gated here rather than only on the card, and that is the same call
   * `pathStepFor` makes below: a `validate` issue is a **warning**, so a graph repointed at a
   * backend that cannot answer still runs. A source that cannot split simply ignores the two
   * fields — `CaveSource.fetchConnectivity` does — so without this the node would advertise a
   * `roi` column, fill it with nothing, and put whole-connection weights under it. A wrong
   * number wearing the right name, which is precisely what `canSplitConnectivityByRoi` exists
   * to prevent.
   *
   * One predicate for both arms, so the edge-set case reads as what it is: a dataset answering
   * from a file of `pre, post, weight` has no regions either, whatever its backend could do.
   */
  if (req.rois?.length || req.splitByRoi) {
    if (req.edges) {
      throw new Error(
        `This dataset's connectivity comes from the edge set "${req.edges.name}", which records ` +
          `pre, post and weight and nothing about regions. Turn off the region options on this ` +
          `node, or detach the edge set under Edge data on the dataset card.`,
      )
    }
    if (!canSplitConnectivityByRoi(source, req.datasetId, false)) {
      throw new Error(`${source.label} cannot break a connection down by region`)
    }
  }
  if (!req.edges) return source.fetchConnectivity(req)
  /*
   * Together, because they are independent and both are slow on a first run: the set is up to a
   * hundred megabytes out of IndexedDB and the index is a fetch — on CAVE, 139,255 rows. In
   * series that is a + b for the first query of a session; here it is the larger of the two.
   */
  const [set, types] = await Promise.all([
    attached(req.edges),
    typeLookup(source, req.datasetId, req),
  ])

  const schema = schemasOf(source, req.datasetId).connectivity
  const dtype = schema.columns.find((c) => c.name === 'neuronId')?.dtype ?? 'str'
  requireIdsFit(set, dtype)

  const outward = req.direction === 'outputs'
  const edges = edgesFrom(set, req.neuronIds, req.direction, req.minWeight)
  return tableFromRows(
    schema,
    edges.map((edge: Edge) => {
      // Query-relative, which is what the seam promises: `neuronId` is always the neuron that
      // was asked about, whichever way the synapse points.
      const self = outward ? edge.pre : edge.post
      const other = outward ? edge.post : edge.pre
      return {
        neuronId: idCell(self, dtype),
        neuronType: types.get(self) ?? null,
        partnerId: idCell(other, dtype),
        partnerType: types.get(other) ?? null,
        weight: edge.weight,
      }
    }),
  )
}

/**
 * Per-neuron synapse totals, or a refusal naming why there are none.
 *
 * A funnel like the three above, though this one has nothing to answer from: an edge set is the
 * *reason* the answer is unavailable rather than an alternative source for it. See
 * `canTotalSynapses` — a file's weights and a backend's published totals count different
 * populations, and a fraction built from one over the other is plausible and meaningless.
 *
 * Nodes call this rather than `source.fetchSynapseTotals` for `connectivityFor`'s reason: a
 * reader that skips the funnel skips the gate, and both halves would type-check.
 */
export async function synapseTotalsFor(
  source: DataSource,
  req: SynapseTotalsRequest,
): Promise<TableValue> {
  if (req.edges) throw edgeSetDenominator(req.edges.name)
  // The same predicate the node asks, rather than a third spelling — `pathStepFor`'s rule, and
  // it is that function's recorded incident: a funnel checking only that a method existed
  // accepted a source the node had already refused.
  if (!canTotalSynapses(source, req.datasetId, false)) {
    throw new Error(`${source.label} does not publish per-neuron synapse totals`)
  }
  return source.fetchSynapseTotals!(req)
}

/**
 * The same totals per group key, or a refusal naming why there are none.
 *
 * `synapseTotalsFor` with `canTotalGroups` in place of `canTotalSynapses`, and the second funnel
 * is the point rather than an oversight: written as one funnel that picked a method, a source
 * with the flag and no `fetchGroupTotals` would pass the gate the Paths node asks and then fail
 * on a `!`. Both refusals are shared, since the reason is the same either way.
 */
export async function groupTotalsFor(
  source: DataSource,
  req: GroupTotalsRequest,
): Promise<TableValue> {
  if (req.edges) throw edgeSetDenominator(req.edges.name)
  if (!canTotalGroups(source, req.datasetId, false)) {
    throw new Error(groupTotalsRefusal(source.label))
  }
  return source.fetchGroupTotals!(req)
}

/**
 * Why an attached edge set cannot supply a denominator, said once for both funnels.
 *
 * A file's weights over a server's published totals is one connectome divided by another — see
 * `canTotalSynapses`, which is where the rule lives. The sentence names a control on the dataset
 * card, which is the half a second copy silently leaves pointing at nothing when it is renamed.
 */
function edgeSetDenominator(name: string): Error {
  return new Error(
    `This dataset's connectivity comes from the edge set "${name}", so its weights are the ` +
      `file's rather than the server's — normalising them against the backend's published ` +
      `synapse totals would divide one connectome by another. Turn off Normalize, or detach ` +
      `the edge set under Edge data on the dataset card.`,
  )
}

export async function adjacencyFor(
  source: DataSource,
  req: AdjacencyRequest,
): Promise<MatrixValue> {
  if (!req.edges) return source.fetchAdjacency(req)
  const [set, types] = await Promise.all([
    attached(req.edges),
    req.groupByType ? typeLookup(source, req.datasetId, req) : undefined,
  ])
  const edges = edgesBetween(set, req.sourceIds, req.targetIds)
  return matrixFromEdges(edges, req.sourceIds, req.targetIds, types)
}

export async function pathStepFor(
  source: DataSource,
  req: PathStepRequest,
): Promise<TableValue> {
  if (!req.edges) {
    // The same predicate the node asks, rather than a third spelling: this one used to check
    // only that a method existed, so a source with `fetchPathStep` and `paths: false` was
    // refused by the node and accepted here.
    if (!canTracePaths(source, req.datasetId, false)) {
      throw new Error(`${source.label} cannot trace paths`)
    }
    return source.fetchPathStep!(req)
  }
  // Types always, not only when collapsing: a neuron-level step still reports each end's type,
  // and a step that dropped them would leave every node in the traversal unnamed.
  const [set, types] = await Promise.all([
    attached(req.edges),
    typeLookup(source, req.datasetId, req),
  ])
  return pathStepFrom(set, req, types)
}
