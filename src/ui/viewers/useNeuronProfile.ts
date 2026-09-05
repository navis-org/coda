/**
 * Loading one profile's subject — a neuron, or every neuron of a cell type.
 *
 * The widget fetches for itself rather than waiting for the node to run, exactly as
 * `useNeuronIndex` does for Explore and `NeuronThumbnail` does for a row's silhouette. That
 * split is what makes paging feel live: the node's ports stay honestly stale until Run, while
 * turning the page costs three small queries and usually not even those.
 *
 * Three requests per subject — two connectivity (one per direction) and one ROI breakdown,
 * which neuPrint answers by handing back the whole `roiInfo` blob at once. **Three whether the
 * subject is one neuron or sixty**, because every one of those endpoints takes the whole id
 * list; that is the fact that makes a cell-type profile affordable at all, and it is the same
 * one the emitted `coda_profile` helper is built on. Everything else on the profile comes off
 * the neurons' own rows in the input table, which already carry every column discovery found.
 *
 * Two things follow from a subject being a *set*, and both are the reason this hook is no
 * longer a line-for-line sibling of `useNeuronTopology`:
 *
 * - **The cache is bounded by rows, not by entries.** Twenty-four single neurons is a few
 *   thousand rows; twenty-four cell types is a dataset's connectivity. `keyedCache`'s `weigh`
 *   is what says so.
 * - **A large subject is deferred, not refused.** See `MAX_AUTO_MEMBERS`.
 */

import { useCallback, useMemo, useState } from 'react'

import type { NeuronId } from '../../core/ids'
import { compareIds } from '../../core/ids'
import type { DatasetAnnotations, DatasetEdges, TableValue } from '../../core/values'
import { connectivityFor } from '../../data/queries'
import { getSource } from '../../data/source'
import { keyedCache } from './keyedCache'
import { useSettledFetch } from './useSettledFetch'

export interface NeuronProfileData {
  /**
   * Upstream partners — one row per connection, as `fetchConnectivity` returns them.
   *
   * Query-relative and covering every member: `neuronId` is the member that was asked about,
   * which is what lets `partitionByMember` split this back up per neuron and fold.
   */
  inputs: TableValue
  /** Downstream partners, on the same terms. */
  outputs: TableValue
  /**
   * Per-ROI pre/post counts, nested ROIs included; filter before summing.
   *
   * Undefined where the source publishes none — `capabilities.roiCounts`. That has to be a
   * *missing tile* rather than a failed card: a rejection inside the `Promise.all` below took
   * the two connectivity legs down with it, so every tile reported an error on a neuron whose
   * partners had loaded perfectly well. `regionRows` already answers `[]` for undefined, which
   * is the widget's own "a tile renders only when its data exists" rule.
   */
  regions: TableValue | undefined
  /**
   * The dataset's non-overlapping ROI list, or undefined when discovery has not answered.
   *
   * Captured at fetch time so the bars and the caption agree about whether the totals may be
   * trusted. Undefined is not "empty": it means the caller must say the regions are
   * unfiltered rather than quietly present a double-counted total.
   */
  primaryRois: string[] | undefined
}

export type NeuronProfileState =
  /** No dataset or no neuron to show. */
  | { status: 'none' }
  /**
   * A subject too large to fetch on a page turn, waiting to be asked for.
   *
   * Carries its own trigger rather than being a boolean the caller acts on, so there is one
   * place that knows a deferred subject becomes a loading one by being approved.
   */
  | { status: 'deferred'; members: number; load: () => void }
  | { status: 'loading' }
  | { status: 'ready'; data: NeuronProfileData }
  | { status: 'error'; message: string }

/**
 * How many entries are kept, and how much they may weigh between them.
 *
 * The entry count covers paging back and forth across a page of results, which is the movement
 * this exists for. The row budget is what stops that being a promise about memory it cannot
 * keep: a hub neuron returns several thousand connection rows in each direction — CT1 on FAFB
 * has over twelve thousand between them — and a *cell type* is that multiplied by its members,
 * so twenty-four of them is not twenty-four small things.
 */
const MAX_CACHED = 24
const MAX_CACHED_ROWS = 2_000_000

/**
 * Above this many members, nothing is fetched until somebody asks.
 *
 * Not a refusal — [docs/limits.md](../../../docs/limits.md)'s rule is that a guard rail warns
 * and only an allocation refuses, and the answer here is perfectly well defined at any size.
 * It is a *deferral*, and it exists because grouping turned the page turn into an unbounded
 * query: `Group by` is a column picker, so `status` is one mis-click away and would ask a
 * connectome for every traced neuron's partners between two presses of ›.
 *
 * Fifty is where a page turn stops being a page turn. A subject at that size is already a
 * multi-second query on neuPrint, which is the point at which somebody should be choosing to
 * wait for it rather than discovering they have.
 */
export const MAX_AUTO_MEMBERS = 50

const cache = keyedCache<NeuronProfileData>(MAX_CACHED, {
  budget: {
    weigh: (data) => data.inputs.length + data.outputs.length + (data.regions?.length ?? 0),
    max: MAX_CACHED_ROWS,
  },
})

/**
 * How long the subject must hold still before anything is fetched.
 *
 * This, rather than an abort, is what stops a held-down arrow key from putting twenty profiles'
 * worth of queries in flight. Aborting would have been the obvious reach and is wrong here: two
 * profiles on the same subject share one request, so cancelling on unmount kills the fetch the
 * other one is still waiting for. Not fetching in the first place has no such failure mode —
 * and a subject already cached skips the wait entirely, so paging back through what you have
 * seen stays instant.
 */
const SETTLE_MS = 180

/** Forget everything, so the next look re-queries. Behind the widget's reload button. */
export function clearProfileCache(): void {
  cache.clear()
}

async function load(
  sourceId: string,
  datasetId: string,
  members: readonly NeuronId[],
  annotations: DatasetAnnotations | undefined,
  edges: DatasetEdges | undefined,
): Promise<NeuronProfileData> {
  const source = getSource(sourceId)
  if (!source) throw new Error(`Data source "${sourceId}" is not registered`)

  /*
   * All three at once. They are independent queries and the slowest decides the wait; issued in
   * sequence, turning a page would cost three round trips end to end.
   *
   * `minWeight` is deliberately not passed down: the threshold is presentational, so raising
   * it must not cost a fetch. One request at weight 1 serves every threshold above it,
   * filtered locally in `profileStats`.
   *
   * The annotation chain rides along, or the card would name a partner's type out of the
   * datastack's own labels while the ports an inch away carry the chain's — the disagreement
   * phase 4 exists to avoid, on the one surface that shows a type in words.
   */
  const dataset = {
    datasetId,
    ...(annotations ? { annotations } : {}),
    ...(edges ? { edges } : {}),
  }
  const neuronIds = [...members]
  const [inputs, outputs, regions] = await Promise.all([
    connectivityFor(source, { ...dataset, neuronIds, direction: 'inputs' }),
    connectivityFor(source, { ...dataset, neuronIds, direction: 'outputs' }),
    source.fetchRoiCounts?.({ ...dataset, neuronIds }),
  ])

  // Read after the await: discovery may well have landed while these were in flight, and the
  // primary list is what makes the region totals sound.
  return { inputs, outputs, regions, primaryRois: source.peekDataset(datasetId)?.primaryRois }
}

/**
 * What one cached profile is a fact about.
 *
 * The chain is in it for `neuronIndexKey`'s reason: two graphs on one datastack with different
 * annotations hold genuinely different answers, and without it the first one looked at would be
 * served to the other for the rest of the session. The edge set is in it for the same reason —
 * one dataset with a file behind its connectivity and one without hold different answers.
 *
 * The members are **sorted** into it, so a set is one cache entry however the table happened to
 * order it. Two paths reach the same subject in different orders routinely: a group takes the
 * table's order, and a pin hands back whatever `selection` was stored with.
 */
function profileKey(
  sourceId: string | undefined,
  datasetId: string | undefined,
  members: readonly NeuronId[],
  annotations: DatasetAnnotations | undefined,
  edges: DatasetEdges | undefined,
): string | undefined {
  if (!sourceId || !datasetId || members.length === 0) return undefined
  const ids = [...members].sort(compareIds).join(',')
  return `${sourceId}|${datasetId}|${annotations?.key ?? ''}|${edges?.id ?? ''}|${ids}`
}

export function useNeuronProfile(
  sourceId: string | undefined,
  datasetId: string | undefined,
  members: readonly NeuronId[],
  annotations?: DatasetAnnotations,
  edges?: DatasetEdges,
): NeuronProfileState {
  /*
   * Memoised, because building it sorts and joins the whole member list. That is nothing for one
   * neuron and real for a subject the gate exists to catch: grouping by `status` makes a subject
   * of every traced neuron, and an unmemoised key allocated a megabyte-scale string on every
   * render of the pager — the one path this hook is supposed to keep cheap. `members` is the
   * viewer's `subjects` memo talking, so its identity is already stable.
   */
  const key = useMemo(
    () => profileKey(sourceId, datasetId, members, annotations, edges),
    // The chain's *key* and the edge set's *id*, not the objects: those are what `profileKey`
    // reads, and the hook this replaced kept both behind refs precisely because a fresh
    // `DatasetValue` can churn their identity on an unrelated store tick. Depending on the
    // objects would put the sort-and-join back on every render of the pager.
    [sourceId, datasetId, members, annotations?.key, edges?.id],
  )

  /*
   * Which subjects the reader has asked for by name, and nothing more.
   *
   * A **set of keys**, not a boolean and not one key: approving one large type must neither
   * approve the next one the pager lands on nor un-approve the last, because the whole point of
   * the gate is that each subject is its own decision. A fresh `Set` per approval, so the state
   * update is what re-renders — a ref plus a counter says the same thing in two places.
   */
  const [approved, setApproved] = useState<ReadonlySet<string>>(() => new Set())
  const approve = useCallback(() => {
    if (key) setApproved((held) => new Set(held).add(key))
  }, [key])

  /*
   * The gate is about work a *browsing gesture* would incur, so an answer already in hand is
   * never deferred — paging away from an approved type and back would otherwise re-ask for a
   * decision about a fetch that is not going to happen, and so would a second card on the same
   * group, since the approvals are this component's and the cache is the module's.
   */
  const deferred =
    key !== undefined &&
    members.length > MAX_AUTO_MEMBERS &&
    !approved.has(key) &&
    !cache.get(key)

  /*
   * The gate is expressed by withholding the key, which is `useSettledFetch`'s own "nothing has
   * been asked for" state. A second mechanism inside the hook would be a second thing that can
   * disagree with the cache about what is in flight.
   */
  const fetched = useSettledFetch(
    deferred ? undefined : key,
    () =>
      sourceId && datasetId
        ? load(sourceId, datasetId, members, annotations, edges)
        : Promise.reject(new Error('No dataset')),
    { settleMs: SETTLE_MS, cache },
  )

  return useMemo<NeuronProfileState>(() => {
    // `!key` first: without a dataset there is nothing to defer *to*, and a large member list
    // would otherwise put the banner in front of somebody who has wired nothing up.
    if (!key) return { status: 'none' }
    if (deferred) return { status: 'deferred', members: members.length, load: approve }
    if (fetched.status === 'idle') return { status: 'none' }
    return fetched
  }, [key, deferred, members.length, approve, fetched])
}
