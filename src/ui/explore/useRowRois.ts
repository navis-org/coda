/**
 * Where each neuron on the current page has its synapses, for the row's region bar.
 *
 * **The one thing an Explore row draws that is not already downloaded.** Everything else on a row
 * comes out of the neuron index, which is fetched whole and searched locally; `roiInfo` is
 * deliberately kept out of that table — `neuprint/schema.ts` suppresses it, because as a cell it
 * is a kilobyte of JSON per neuron and the index is 26 MB before it. So this is a real query, and
 * it is shaped to be the cheapest possible one: **a page at a time**, in a single round trip, for
 * the twenty-five neurons on screen.
 *
 * Three rules borrowed from `useNeuronProfile`, which is the same problem one widget over:
 *
 *  - **Settled, not aborted.** A held-down page key would otherwise put a query in flight per
 *    press. Aborting is the wrong reach — two rows on one page share a request, so cancelling on
 *    unmount kills a fetch something else is waiting for. Not asking has no such failure mode.
 *  - **Cached by page.** Paging back through what you have already seen stays instant, and the
 *    cache is bounded by rows rather than entries because a page of well-innervated neurons is
 *    worth many times one of fragments.
 *  - **A missing capability is a missing mark, not an error.** `capabilities.roiCounts` is false
 *    on CAVE and CATMAID; those datasets simply draw no region bar.
 *
 * The nesting trap is the one specific to this data and it is why `primaryRois` is here at all:
 * `roiInfo` nests, so a neuron's synapses in `LO(R)` are counted again in `OL(R)`, and only the
 * primary set may be summed. Filtering is `regionShares`' job in `rowRois.ts`; what this hook
 * does is carry the list alongside the rows so the two cannot come apart.
 */

import type { NeuronId } from '../../core/ids'
import type { TableValue } from '../../core/values'
import { capabilityOf, getSource } from '../../data/source'
import { keyedCache } from '../viewers/keyedCache'
import { useSettledFetch } from '../viewers/useSettledFetch'

export interface RowRoiData {
  /** One row per (neuron, ROI), nested regions included — filter before summing. */
  rows: TableValue
  /**
   * The dataset's non-overlapping ROI list, or undefined where discovery has not answered.
   *
   * Undefined is not "empty": it means the caller cannot say the totals are sound, which is why
   * `regionShares` draws nothing rather than a bar that silently double-counts.
   */
  primaryRois: string[] | undefined
}

/** Pages held. Enough to cover paging forward and back across a few screens. */
const MAX_CACHED = 8

/** Rows held, which is the honest budget — a page of well-innervated neurons is many times one of fragments. */
const MAX_CACHED_ROWS = 40_000

const cache = keyedCache<RowRoiData>(MAX_CACHED, {
  budget: { weigh: (data) => data.rows.length, max: MAX_CACHED_ROWS },
})

/**
 * How long the page must hold still before anything is fetched.
 *
 * `useNeuronProfile`'s reasoning and its number: this is what stops a held-down page key from
 * querying once per press, and a page already cached skips the wait entirely.
 */
const SETTLE_MS = 180

/** Forget every page, so the next look re-queries. Behind the widget's reload control. */
export function clearRowRoiCache(): void {
  cache.clear()
}

/**
 * The region breakdown for one page of neurons.
 *
 * `undefined` for a dataset that publishes none, which the row reads as "draw no bar".
 */
export function useRowRois(
  sourceId: string | undefined,
  datasetId: string | undefined,
  neuronIds: readonly NeuronId[],
  enabled: boolean,
): RowRoiData | undefined {
  const source = sourceId ? getSource(sourceId) : undefined
  const supported =
    enabled &&
    !!source?.fetchRoiCounts &&
    !!datasetId &&
    neuronIds.length > 0 &&
    // `capabilityOf` and not `source.capabilities` directly: the per-dataset override is the
    // whole point of it, and six readers skipped it once already.
    capabilityOf(source, datasetId, 'roiCounts')

  /*
   * The page's ids *are* the key. Not the page number — a search that changes what is on page
   * one must re-ask, and two different searches that happen to show the same neurons should
   * share one answer.
   */
  const key = supported ? `rois:${sourceId}:${datasetId}:${neuronIds.join(',')}` : undefined

  const state = useSettledFetch<RowRoiData>(
    key,
    async () => {
      const rows = await source!.fetchRoiCounts!({
        datasetId: datasetId!,
        neuronIds: [...neuronIds],
      })
      return { rows, primaryRois: source!.peekDataset?.(datasetId!)?.primaryRois }
    },
    { settleMs: SETTLE_MS, cache },
  )

  // A failure is a missing mark rather than a broken list: the row's every other field came out
  // of the index and is perfectly good, and a region bar is the one thing that needed a server.
  return state.status === 'ready' ? state.data : undefined
}
