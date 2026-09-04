/**
 * Loading one neuron's geometry and partners for the Topology widget.
 *
 * `useNeuronProfile`'s shape, and deliberately so — the settle delay and the "seed from cache so
 * paging back paints on the first render" rule were both learned there. The store underneath is
 * `keyedCache`, shared rather than retyped; what differs here is what it fetches and how much it
 * weighs.
 *
 * **Four requests per neuron, not three.** A skeleton, its synapses, and connectivity in both
 * directions. The first two are the expensive pair: a traced CATMAID skeleton is megabytes, so
 * `MAX_CACHED` here is much smaller than Profile's twenty-four.
 *
 * **The node fetches the same things, and that is not a duplicated download.** `evaluate` pulls
 * skeletons for the whole incoming table on Run; this pulls one neuron's as you page. Both go
 * through `data/geometryCache.ts`, so whichever asks second is served from the session cache —
 * which is what makes the Explore-style split (expensive node, live widget) affordable rather
 * than merely defensible.
 */

import { useRef } from 'react'

import type {
  DatasetAnnotations,
  DatasetEdges,
  PointsValue,
  SkeletonsValue,
  TableValue,
} from '../../core/values'
import { connectivityFor } from '../../data/queries'
import { getSource, synapseUnitsOf } from '../../data/source'
import { keyedCache } from './keyedCache'
import { useSettledFetch } from './useSettledFetch'

export interface NeuronTopologyData {
  /** Exactly one item, or none where the source returned nothing for this body. */
  skeletons: SkeletonsValue | undefined
  /**
   * Synapse locations, or undefined where the dataset publishes none.
   *
   * A *missing channel* rather than a failed load, `NeuronProfileData.regions`' rule: a rejection
   * inside the `Promise.all` took the other three legs down with it, so a dataset without
   * synapses reported an error on a card whose skeleton had arrived perfectly well.
   */
  synapses: PointsValue | undefined
  inputs: TableValue | undefined
  outputs: TableValue | undefined
}

export type NeuronTopologyState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; data: NeuronTopologyData }
  | { status: 'error'; message: string }

/**
 * How many neurons' geometry is kept.
 *
 * Six, against Profile's twenty-four, and the difference is bytes rather than taste: a profile is
 * a few thousand table rows, where one traced FAFB skeleton is 4.2 MB before its synapses. Six
 * covers paging back and forth across a screenful, which is the movement this exists for.
 */
const MAX_CACHED = 6

/** How long the page must hold still before anything is fetched. `useNeuronProfile`'s reasoning. */
const SETTLE_MS = 200

const cache = keyedCache<NeuronTopologyData>(MAX_CACHED)

/** Forget everything, so the next look re-fetches. Behind the widget's reload control. */
export function clearTopologyCache(): void {
  cache.clear()
}

async function load(
  sourceId: string,
  datasetId: string,
  neuronId: string,
  annotations: DatasetAnnotations | undefined,
  edges: DatasetEdges | undefined,
): Promise<NeuronTopologyData> {
  const source = getSource(sourceId)
  if (!source) throw new Error(`Data source "${sourceId}" is not registered`)

  const dataset = {
    datasetId,
    ...(annotations ? { annotations } : {}),
    ...(edges ? { edges } : {}),
  }

  /*
   * The unit is resolved here rather than passed in, because `SynapseRequest.unit` is required
   * and the widget is a second door onto `fetchSynapses` — the node being the first. Absent
   * `synapseUnits` means the source cannot answer, so the channel is simply missing rather than
   * an error: see `NeuronTopologyData.synapses`.
   */
  const units = synapseUnitsOf(source)
  const unit = units?.[0]

  const [skeletons, synapses, inputs, outputs] = await Promise.all([
    source.fetchSkeletons?.({ ...dataset, neuronIds: [neuronId] }),
    unit && source.fetchSynapses
      ? source.fetchSynapses({ ...dataset, neuronIds: [neuronId], unit }).catch(() => undefined)
      : Promise.resolve(undefined),
    /*
     * `minWeight` is deliberately not passed down, Profile's rule: the threshold is
     * presentational, so raising it must not cost a fetch. One request at weight 1 serves every
     * threshold above it, filtered locally.
     */
    connectivityFor(source, { ...dataset, neuronIds: [neuronId], direction: 'inputs' }).catch(
      () => undefined,
    ),
    connectivityFor(source, { ...dataset, neuronIds: [neuronId], direction: 'outputs' }).catch(
      () => undefined,
    ),
  ])

  return { skeletons, synapses, inputs, outputs }
}

/** What one cached entry is a fact about. `profileKey`'s composition, for its reasons. */
function topologyKey(
  sourceId: string | undefined,
  datasetId: string | undefined,
  neuronId: string | undefined,
  annotations: DatasetAnnotations | undefined,
  edges: DatasetEdges | undefined,
): string | undefined {
  if (!sourceId || !datasetId || neuronId === undefined || neuronId === '') return undefined
  return `${sourceId}|${datasetId}|${annotations?.key ?? ''}|${edges?.id ?? ''}|${neuronId}`
}

export function useNeuronTopology(
  sourceId: string | undefined,
  datasetId: string | undefined,
  neuronId: string | undefined,
  annotations?: DatasetAnnotations,
  edges?: DatasetEdges,
): NeuronTopologyState {
  const key = topologyKey(sourceId, datasetId, neuronId, annotations, edges)

  // Held in refs rather than as dependencies: `ValuePreview` peels these off a fresh
  // `DatasetValue` on every store tick, so the identity churns while the chain does not — and
  // the key already says which chain it is.
  const chain = useRef(annotations)
  chain.current = annotations
  const attached = useRef(edges)
  attached.current = edges

  const state = useSettledFetch(
    key,
    () => load(sourceId!, datasetId!, neuronId!, chain.current, attached.current),
    { settleMs: SETTLE_MS, cache },
  )

  // `none` rather than `idle`, which is this hook's own word for "nothing is selected" and is
  // what `ValuePreview`'s callers read. The rename is the whole of what is local here.
  return state.status === 'idle' ? { status: 'none' } : state
}
