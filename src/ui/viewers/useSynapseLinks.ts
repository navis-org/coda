/**
 * The partner-resolved synapse cloud, fetched only when somebody asks to see one.
 *
 * Most sources need this hook for nothing: `CANONICAL_SCHEMAS.synapses` carries `partnerId` and
 * `partnerType`, so the ordinary cloud `useNeuronTopology` already has says who is on the far
 * side of every synapse. **neuPrint is the exception** — `neuprint/schema.ts` drops both columns
 * because resolving them turns one walk into a join — and neuPrint is also the source most people
 * are looking at. So it gets a second query, and this is it.
 *
 * ## Why it is lazy, with a number
 *
 * Measured against `male-cns:v1.0` body 10003 (VCH), which is an ordinary large cell rather than
 * a pathological one: **57,034 rows in 2.7 s**, being 30,020 outgoing connections over 14,983
 * partners and 27,014 incoming over 3,016. That is exactly `n.synweight`, and per-partner it
 * matches `ConnectsTo` exactly — but it is twenty times the size of the site cloud and it is
 * fetched for a *presentational* act. Paying it on arrival would make every page turn cost a
 * query nobody had asked a question of.
 *
 * So it runs when a partner is lit, and not before. That is also why highlighting stays
 * presentational despite costing a fetch: the same trade Profile's `minWeight` makes.
 *
 * ## What it must never be used for
 *
 * **Measuring the neuron.** A presynaptic site appears once per partner it drives — 30,020 rows
 * for 4,425 T-bars on the body above, a factor of 6.8 — so cable density, the flow centrality
 * behind the axon/dendrite split, and every count on the Morphology tab read the *site* cloud.
 * Only the picture reads this one.
 */

import { useRef } from 'react'

import type { DatasetAnnotations, PointsValue } from '../../core/values'
import { canFetchSynapseLinks, getSource } from '../../data/source'
import { keyedCache } from './keyedCache'
import { useSettledFetch } from './useSettledFetch'

export type SynapseLinksState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; points: PointsValue }
  | { status: 'error'; message: string }

/**
 * Whether this dataset can name a synapse's partner through the second query.
 *
 * A thin lookup over `canFetchSynapseLinks`, which is where the rule lives — beside
 * `canTotalGroups`, in `data/source.ts`, so it asks the *capability* as well as the method. This
 * used to check the method alone and from here, which promised highlighting on a neuPrint dataset
 * publishing no synapses.
 */
export function hasSynapseLinks(
  sourceId: string | undefined,
  datasetId: string | undefined,
): boolean {
  if (sourceId === undefined) return false
  return canFetchSynapseLinks(getSource(sourceId), datasetId)
}

/**
 * How many neurons' link clouds are kept.
 *
 * Two, against the site cloud's six. One of these is 57,000 rows where a site cloud is a few
 * thousand, and the movement it has to survive is lighting a second partner on the *same*
 * neuron — which is a cache hit at any size — rather than paging back and forth.
 */
const MAX_CACHED = 2

const cache = keyedCache<PointsValue>(MAX_CACHED)

/**
 * Forget every cached link cloud.
 *
 * Its only caller is the test suite, and that is the point rather than an apology: without it one
 * test's cached cloud is served to the next, which would have hidden the detached-method bug this
 * whole path now guards against — the second test never calls the source at all.
 */
export function clearSynapseLinksCache(): void {
  cache.clear()
}

export function useSynapseLinks(
  sourceId: string | undefined,
  datasetId: string | undefined,
  neuronId: string | undefined,
  enabled: boolean,
  annotations?: DatasetAnnotations,
): SynapseLinksState {
  const key =
    sourceId && datasetId && neuronId
      ? `${sourceId}|${datasetId}|${annotations?.key ?? ''}|${neuronId}`
      : undefined
  /*
   * Held in a ref rather than as a dependency, `useNeuronProfile`'s rule and for its reason:
   * `ValuePreview` peels this off a fresh `DatasetValue` on every store tick, so the object
   * identity churns while the *chain* does not — and `key` already says which chain it is.
   * Listed as a dependency it would refetch a fifty-thousand-row query on every unrelated edit.
   */
  const chain = useRef(annotations)
  chain.current = annotations

  /*
   * **`.bind(source)`, never a bare lift.**
   *
   * Every backend is a class, and `NeuPrintSource.fetchSynapseLinks` reaches for `this.discover`,
   * `this.scaleFor`, `this.options` and `this.frame` before it does anything else. Written as
   * `const fetchLinks = source.fetchSynapseLinks` — the obvious way to satisfy the narrowing
   * inside a closure — it is detached from its receiver and throws on its first line, which the
   * widget then reports as "could not load partner-resolved synapses": a message that reads like
   * a query that came back empty rather than like a call that never left the browser.
   *
   * This is the idiom `roiOutlines.ts`, `roiCompleteness.ts` and `roiConnectivity.ts` already use
   * at the three other places a source method is lifted.
   */
  const source = sourceId ? getSource(sourceId) : undefined
  const ready = Boolean(enabled && key && datasetId && neuronId && source?.fetchSynapseLinks)

  const state = useSettledFetch(
    ready ? key : undefined,
    () =>
      source!.fetchSynapseLinks!.bind(source)({
        datasetId: datasetId!,
        neuronIds: [neuronId!],
        ...(chain.current ? { annotations: chain.current } : {}),
      }),
    /*
     * No settle delay, unlike `useNeuronTopology`. That one exists to stop a held-down arrow key
     * putting twenty fetches in flight; this fires on a deliberate click, and a delay before a
     * two-second query would only make the click feel dead.
     */
    { cache },
  )

  // `points` rather than `data`, which is what the widget reads. An `if` rather than a ternary
  // so the remaining arms narrow: they are structurally identical, but only a statement tells
  // TypeScript that.
  if (state.status === 'ready') return { status: 'ready', points: state.data }
  return state
}
