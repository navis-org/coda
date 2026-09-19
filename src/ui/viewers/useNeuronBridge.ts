/**
 * What the NeuronBridge card fetches for the neuron on screen, in two steps.
 *
 * **The lookup** (`by_body`, ~1 kB) says which records NeuronBridge holds for the neuron in the
 * wired dataset — none, one, or one per area where a dataset spans brain and nerve cord. **The
 * match file** (`cdsresults`, ~3 MB and ~1 s) is fetched only for the record actually shown, and
 * only once the lookup has said there is one. Both settle before fetching (`useSettledFetch`), so
 * holding down the pager does not queue a request per neuron passed, and both are cached for the
 * session in `keyedCache`s, which share an in-flight request between two cards on one neuron and
 * never cache a failure.
 *
 * The version is resolved inside the lookup rather than before it, so a card on `Latest` costs one
 * `current.txt` for the session and nothing per neuron.
 */

import { useMemo } from 'react'

import type { NeuronId } from '../../core/ids'
import type { NbConfig, NbMethod } from '../../data/neuronbridge/client'
import {
  currentVersion,
  fetchConfig,
  fetchMatches,
  hasMatches,
  isReadableVersion,
  lookupBody,
} from '../../data/neuronbridge/client'
import type { NbDatasetLibraries } from '../../data/neuronbridge/libraries'
import { datasetLibraries, isCoveredDataset } from '../../data/neuronbridge/libraries'
import type { NbImage, NbMatches } from '../../data/neuronbridge/types'
import { keyedCache } from './keyedCache'
import { useSettledFetch } from './useSettledFetch'

/** What the lookup found for one neuron in one dataset. */
export interface NbNeuron {
  /** The data version actually read — the resolved one when the card is on Latest. */
  readonly version: string
  readonly config: NbConfig
  readonly libraries: NbDatasetLibraries
  /** This dataset's records for the neuron: empty, one, or one per anatomical area. */
  readonly records: readonly NbImage[]
}

export type NbLookupState =
  | { status: 'none' }
  /** Wired to a dataset NeuronBridge has no library for. Known without a request. */
  | { status: 'uncovered' }
  | { status: 'loading' }
  | { status: 'ready'; data: NbNeuron }
  | { status: 'error'; message: string }

export type NbMatchesState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; data: NbMatches }
  | { status: 'error'; message: string }

/** Long enough that paging steadily past neurons does not fetch each one it skips. */
const SETTLE_MS = 180

// A lookup is a few records; a few hundred of them are nothing.
const lookups = keyedCache<NbNeuron>(400)

/*
 * A match file is ~2,000 records, so the budget is in matches rather than files — the same
 * "an entry count is not always a budget" rule `keyedCache` records for grouped profiles. Parsed,
 * a record holds ~1.4 kB, so 12,000 is ~17 MB: about six neurons to page back to, where the card
 * only ever draws one.
 */
const matchFiles = keyedCache<NbMatches>(24, {
  budget: { weigh: (file) => file.results.length, max: 12_000 },
})

/** Forget everything, so the next look re-reads the bucket. */
export function clearNeuronBridgeCache(): void {
  lookups.clear()
  matchFiles.clear()
}

async function lookup(
  pinnedVersion: string,
  sourceId: string,
  datasetId: string,
  neuronId: NeuronId,
): Promise<NbNeuron> {
  const version = pinnedVersion || (await currentVersion())
  if (!isReadableVersion(version)) {
    throw new Error(`NeuronBridge data version "${version}" is not one this build can read.`)
  }
  const [config, all] = await Promise.all([fetchConfig(version), lookupBody(version, neuronId)])
  const libraries = datasetLibraries(config, sourceId, datasetId)
  if (!libraries) throw new Error(`${datasetId} is not a dataset NeuronBridge covers.`)
  return {
    version,
    config,
    libraries,
    records: all.filter((record) => libraries.names.has(record.libraryName)),
  }
}

export function useNeuronBridgeLookup(
  sourceId: string | undefined,
  datasetId: string | undefined,
  neuronId: NeuronId | undefined,
  pinnedVersion: string,
): NbLookupState {
  const covered = sourceId && datasetId ? isCoveredDataset(sourceId, datasetId) : false
  const key =
    sourceId && datasetId && neuronId && covered
      ? `${pinnedVersion || 'latest'}|${sourceId}|${datasetId}|${neuronId}`
      : undefined
  const fetched = useSettledFetch(
    key,
    () =>
      sourceId && datasetId && neuronId
        ? lookup(pinnedVersion, sourceId, datasetId, neuronId)
        : Promise.reject(new Error('Nothing to look up')),
    { settleMs: SETTLE_MS, cache: lookups },
  )
  return useMemo<NbLookupState>(() => {
    if (sourceId && datasetId && !covered) return { status: 'uncovered' }
    if (!key || fetched.status === 'idle') return { status: 'none' }
    return fetched
  }, [sourceId, datasetId, covered, key, fetched])
}

export function useNeuronBridgeMatches(
  version: string | undefined,
  record: NbImage | undefined,
  method: NbMethod,
): NbMatchesState {
  const key =
    version && record && hasMatches(record, method)
      ? `${version}|${record.id}|${method}`
      : undefined
  // No settle: the lookup that produced `record` already waited, and this is the slow half.
  const fetched = useSettledFetch(
    key,
    () =>
      version && record
        ? fetchMatches(version, record, method)
        : Promise.reject(new Error('Nothing to fetch')),
    { cache: matchFiles },
  )
  return fetched.status === 'idle' ? { status: 'none' } : fetched
}
