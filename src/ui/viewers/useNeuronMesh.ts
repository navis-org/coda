/**
 * The neuron's mesh for the Topology stage, fetched only while the layer is on.
 *
 * The third of this card's three fetching hooks, and the one that holds nothing.
 *
 * ## Why there is no cache here
 *
 * `useNeuronTopology` keeps six neurons' skeletons and synapses in a `keyedCache`, and
 * `useCompartments` keeps a split per skeleton. Neither is right for a mesh: a mesh is the
 * largest single thing this card fetches, and `data/geometryCache.ts` — which every backend's
 * `fetchMeshes` already goes through — is a **byte-budgeted** LRU holding the same typed arrays.
 * A second strong reference here would not make a page-back faster (the shared cache already
 * answers it) and would keep megabytes alive outside the budget that exists to bound exactly
 * that. So this hook is a state machine over a fetch, and the memory question is answered one
 * layer down where the byte count is known.
 *
 * ## Opt-in, for `useCompartments`' reason rather than its size
 *
 * Nothing is fetched until `enabled`. The split is gated because Pyodide is a ~10 MB one-off
 * download; this is gated because the cost is *per neuron viewed* — paging through twenty cells
 * with the layer on is twenty mesh fetches, and with it off it is none. The layer toggle is
 * therefore a real control rather than a visibility flag over something already downloaded.
 *
 * **The triangle budget is deliberately a tenth of the Meshes node's.** That node draws the mesh
 * as the subject; here it is a translucent shell behind an opaque skeleton, where detail is spent
 * on something nobody can see through 15% alpha — and the budget is what `chooseLod` reads to
 * pick a level, so a lower one is fewer bytes off the wire rather than a decimation afterwards.
 */

import { useRef } from 'react'

import type { DatasetAnnotations, DatasetEdges, MeshesValue } from '../../core/values'
import { canFetchMeshes, getSource } from '../../data/source'
import { useSettledFetch } from './useSettledFetch'

export type NeuronMeshState =
  | { status: 'idle' }
  /** This dataset publishes no neuron meshes. A fact about the source, not a failed fetch. */
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'ready'; mesh: MeshesValue }
  | { status: 'error'; message: string }

/**
 * Triangles for one translucent shell. See the header — a tenth of `neuron.morphology`'s
 * "balanced" default, which is itself for a whole scene rather than for one cell.
 */
const MESH_TRIANGLES = 150_000

/** How long the page must hold still before anything is fetched. `useNeuronTopology`'s rule. */
const SETTLE_MS = 200

/**
 * Whether this dataset can answer at all. `hasSynapseLinks`' shape, and asked for its reason.
 *
 * The rule itself is `canFetchMeshes` in `data/source.ts`, beside the one for synapse links —
 * how a source declares a capability is that module's business, and spelling it here made it two
 * modules' business. This is only the id → source lookup the UI has and the data layer does not.
 */
export function hasNeuronMeshes(
  sourceId: string | undefined,
  datasetId: string | undefined,
): boolean {
  return canFetchMeshes(sourceId ? getSource(sourceId) : undefined, datasetId)
}

export function useNeuronMesh(
  sourceId: string | undefined,
  datasetId: string | undefined,
  neuronId: string | undefined,
  enabled: boolean,
  annotations?: DatasetAnnotations,
  edges?: DatasetEdges,
): NeuronMeshState {
  // Refs rather than dependencies, `useNeuronTopology`'s rule: `ValuePreview` peels these off a
  // fresh `DatasetValue` on every store tick, so their identity churns while the chain does not.
  const chain = useRef(annotations)
  chain.current = annotations
  const attached = useRef(edges)
  attached.current = edges

  const source = sourceId ? getSource(sourceId) : undefined
  const available = canFetchMeshes(source, datasetId)
  const wanted = Boolean(enabled && sourceId && datasetId && neuronId)

  const state = useSettledFetch(
    wanted && available ? `${sourceId}|${datasetId}|${neuronId}` : undefined,
    () =>
      source!.fetchMeshes!({
        datasetId: datasetId!,
        neuronIds: [neuronId!],
        triangleBudget: MESH_TRIANGLES,
        ...(chain.current ? { annotations: chain.current } : {}),
        ...(attached.current ? { edges: attached.current } : {}),
      }),
    // No `cache`, and that is the decision this hook is about — see the header.
    { settleMs: SETTLE_MS },
  )

  /*
   * The two ways of having no key are different answers, and only this layer can tell them
   * apart: nobody asked, or this dataset publishes no meshes. The second is what greys the
   * layer button out with a reason rather than leaving it looking broken.
   */
  if (state.status === 'idle') return wanted ? { status: 'unavailable' } : { status: 'idle' }
  if (state.status === 'ready') return { status: 'ready', mesh: state.data }
  return state
}
