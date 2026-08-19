/**
 * Loading one neuron's profile.
 *
 * The widget fetches for itself rather than waiting for the node to run, exactly as
 * `useNeuronIndex` does for Explore and `NeuronThumbnail` does for a row's silhouette. That
 * split is what makes paging feel live: the node's ports stay honestly stale until Run, while
 * turning the page costs three small queries and usually not even those.
 *
 * Three requests per neuron, all for a single body — two connectivity (one per direction) and
 * one ROI breakdown, which neuPrint answers by handing back the whole `roiInfo` blob at once.
 * Everything else on the profile comes off the neuron's own row in the input table, which
 * already carries every column schema discovery found.
 */

import { useEffect, useState } from 'react'

import type { TableValue } from '../../core/values'
import { getSource } from '../../data/source'
import { errorMessage } from '../../core/errors'

export interface NeuronProfileData {
  /** Upstream partners — one row per connection, as `fetchConnectivity` returns them. */
  inputs: TableValue
  /** Downstream partners. */
  outputs: TableValue
  /** Per-ROI pre/post counts, nested ROIs included; filter before summing. */
  regions: TableValue
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
  | { status: 'loading' }
  | { status: 'ready'; data: NeuronProfileData }
  | { status: 'error'; message: string }

/**
 * How many neurons' profiles are kept.
 *
 * Deliberately small. A hub neuron returns several thousand connection rows in each direction
 * — CT1 on FAFB has over twelve thousand between them — so this is not a cache of cheap
 * things. Twenty-four covers paging back and forth across a page of results, which is the
 * movement it exists for, without holding a dataset's worth of connectivity in memory.
 */
const MAX_CACHED = 24

/**
 * How long the page must hold still before anything is fetched.
 *
 * This, rather than an abort, is what stops a held-down arrow key from putting twenty
 * profiles' worth of queries in flight. Aborting would have been the obvious reach and is
 * wrong here: two profiles on the same neuron share one request, so cancelling on unmount
 * kills the fetch the other one is still waiting for. Not fetching in the first place has no
 * such failure mode — and a neuron already cached skips the wait entirely, so paging back
 * through neurons you have seen stays instant.
 */
const SETTLE_MS = 180

const memory = new Map<string, NeuronProfileData>()

/** In-flight fetches, so two profiles on one neuron cost one request between them. */
const pending = new Map<string, Promise<NeuronProfileData>>()

function remember(key: string, data: NeuronProfileData): void {
  memory.set(key, data)
  // Map iterates in insertion order, so the first key is the least recently added. Good
  // enough here: paging moves forward, and a revisit is served without reordering.
  while (memory.size > MAX_CACHED) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

/** Forget everything, so the next look re-queries. Behind the widget's reload button. */
export function clearProfileCache(): void {
  memory.clear()
  pending.clear()
}

async function load(sourceId: string, datasetId: string, bodyId: number): Promise<NeuronProfileData> {
  const source = getSource(sourceId)
  if (!source) throw new Error(`Data source "${sourceId}" is not registered`)

  /*
   * All three at once. They are independent single-body queries and the slowest decides the
   * wait; issued in sequence, turning a page would cost three round trips end to end.
   *
   * `minWeight` is deliberately not passed down: the threshold is presentational, so raising
   * it must not cost a fetch. One request at weight 1 serves every threshold above it,
   * filtered locally in `profileStats`.
   */
  const [inputs, outputs, regions] = await Promise.all([
    source.fetchConnectivity({ datasetId, bodyIds: [bodyId], direction: 'inputs' }),
    source.fetchConnectivity({ datasetId, bodyIds: [bodyId], direction: 'outputs' }),
    source.fetchRoiCounts({ datasetId, bodyIds: [bodyId] }),
  ])

  // Read after the await: discovery may well have landed while these were in flight, and the
  // primary list is what makes the region totals sound.
  return { inputs, outputs, regions, primaryRois: source.peekDataset(datasetId)?.primaryRois }
}

function profileKey(
  sourceId: string | undefined,
  datasetId: string | undefined,
  bodyId: number | undefined,
): string | undefined {
  if (!sourceId || !datasetId || bodyId === undefined || !Number.isFinite(bodyId)) return undefined
  return `${sourceId}|${datasetId}|${bodyId}`
}

export function useNeuronProfile(
  sourceId: string | undefined,
  datasetId: string | undefined,
  bodyId: number | undefined,
): NeuronProfileState {
  const key = profileKey(sourceId, datasetId, bodyId)

  // Seeded from the cache so paging back to a neuron already seen paints on the first render
  // rather than flashing a spinner for a frame.
  const [state, setState] = useState<NeuronProfileState>(() => initial(key))

  useEffect(() => {
    if (!key || !sourceId || !datasetId || bodyId === undefined) {
      setState({ status: 'none' })
      return
    }

    const cached = memory.get(key)
    if (cached) {
      setState({ status: 'ready', data: cached })
      return
    }

    let live = true
    setState({ status: 'loading' })

    const timer = setTimeout(() => {
      const shared = pending.get(key) ?? load(sourceId, datasetId, bodyId)
      pending.set(key, shared)

      shared
        .then((data) => {
          remember(key, data)
          if (live) setState({ status: 'ready', data })
        })
        .catch((error: unknown) => {
          if (!live) return
          setState({
            status: 'error',
            message: errorMessage(error),
          })
        })
        .finally(() => {
          // Cleared only once it has landed, so concurrent callers share it, and a failure is
          // retried the next time someone looks rather than being cached as a refusal.
          if (pending.get(key) === shared) pending.delete(key)
        })
    }, SETTLE_MS)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key, sourceId, datasetId, bodyId])

  return state
}

function initial(key: string | undefined): NeuronProfileState {
  if (!key) return { status: 'none' }
  const cached = memory.get(key)
  return cached ? { status: 'ready', data: cached } : { status: 'loading' }
}
