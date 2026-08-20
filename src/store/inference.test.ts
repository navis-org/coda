/**
 * Inference against facts a source has not learned yet.
 *
 * `inferOutputs` must never await (invariant 2), so it runs against whatever a source has
 * cached synchronously and degrades when that is nothing. Two of those facts arrive over the
 * network — the dataset listing and a discovered schema — which leaves a window where the graph
 * is typed from an empty cache and nothing recomputes it once the answer lands.
 *
 * What that looked like: a fresh tab, a MaleCNS workflow, a pipeline that ran to completion,
 * and an Explore widget beside it saying "Connect a Dataset to browse its neurons". A dataset
 * node whose version is "Latest" reads its id out of `peekDatasets()`, which is empty until a
 * listing resolves, so the Dataset type it published carried no dataset id and the widget
 * downstream had nothing to load. Any edit at all fixed it — the signature of stale inference
 * rather than of a broken widget.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { CodaType } from '../core/types'
import { datasetRef } from '../core/types'
import type { DataSource, DatasetInfo } from '../data/source'
import { registerSource } from '../data/source'
import { MockSource } from '../data/mock/MockSource'
import { DATASET_FAMILIES } from '../nodes/lib/datasetFamilies'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

const FAMILY = DATASET_FAMILIES.find((f) => f.key === 'malecns')!
const DATASET_ID = `${FAMILY.family}:v1.0`

/**
 * A source that knows nothing until asked, like neuPrint over a network.
 *
 * Registered under the family's own source id, so the real `dataset.malecns` node resolves
 * through it — the point being to drive the node the bug was reported against rather than a
 * stand-in. `listDatasets` is what fills the synchronous peek cache, exactly as
 * `NeuPrintSource.loadDatasets` does.
 */
function unlistedSource(): DataSource & { listing(): Promise<DatasetInfo[]> } {
  const info: DatasetInfo = {
    id: DATASET_ID,
    label: 'MaleCNS',
    rois: [],
    statuses: ['Traced'],
    version: 'v1.0',
  }
  let known: DatasetInfo[] | undefined
  const base: DataSource = new MockSource({ latencyMs: 0 })
  return Object.assign(Object.create(base) as DataSource, {
    id: FAMILY.sourceId,
    peekDatasets: () => known,
    peekDataset: (id: string) => (id === DATASET_ID ? info : undefined),
    listDatasets: async () => {
      known = [info]
      // What `NeuPrintSource` does at the same point, and the whole subject of these tests.
      const { reportSourceLearned } = await import('../data/source')
      reportSourceLearned(FAMILY.sourceId)
      return known
    },
    listing: async () => [info],
  })
}

function datasetTypeOf(nodeId: string): CodaType | undefined {
  return useGraphStore.getState().inference.nodes[nodeId]?.outputs?.dataset
}

describe('inference after a source learns something', () => {
  let source: ReturnType<typeof unlistedSource>

  beforeEach(() => {
    clearStorage()
    source = unlistedSource()
    registerSource(source)
    useGraphStore.getState().newGraph()
  })

  it('types a "Latest" dataset node with no id while the listing is unknown', () => {
    // Not a failure — this is inference doing what it must, refusing to block on a fetch.
    const id = useGraphStore.getState().addNode(`dataset.${FAMILY.key}`, { x: 0, y: 0 })
    expect(datasetRef(datasetTypeOf(id))).toMatchObject({ sourceId: FAMILY.sourceId })
    expect(datasetRef(datasetTypeOf(id))?.datasetId).toBeUndefined()
  })

  it('re-infers when the listing arrives, with no graph edit in between', async () => {
    // The fix. A run is what fetched the listing in the reported case, but nothing here
    // touches the graph — which is the point, since touching it was the workaround.
    const id = useGraphStore.getState().addNode(`dataset.${FAMILY.key}`, { x: 0, y: 0 })
    const before = useGraphStore.getState().graph

    await source.listDatasets()

    expect(datasetRef(datasetTypeOf(id))?.datasetId).toBe(DATASET_ID)
    expect(useGraphStore.getState().graph).toBe(before)
  })

  it('reaches a node downstream, which is where the symptom was', async () => {
    // Explore reads `ctx.inputs.dataset` for the source and dataset to browse; with no id it
    // renders "Connect a Dataset" whatever the pipeline did.
    const store = useGraphStore.getState()
    const dataset = store.addNode(`dataset.${FAMILY.key}`, { x: 0, y: 0 })
    const explore = store.addNode('neuron.explore', { x: 300, y: 0 })
    store.connect({
      source: dataset,
      sourceHandle: 'dataset',
      target: explore,
      targetHandle: 'dataset',
    })

    expect(
      datasetRef(useGraphStore.getState().inference.nodes[explore]?.inputs?.dataset)?.datasetId,
    ).toBeUndefined()
    await source.listDatasets()
    expect(
      datasetRef(useGraphStore.getState().inference.nodes[explore]?.inputs?.dataset)?.datasetId,
    ).toBe(DATASET_ID)
  })
})
