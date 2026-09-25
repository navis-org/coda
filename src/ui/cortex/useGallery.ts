/**
 * What the Cortex gallery's card reads: the dataset's cells with their somata placed in the frame,
 * and the skeletons of the cells on the wall.
 *
 * Both load outside Run, the way Explore's index does, and both go through caches the node's own
 * `evaluate` shares — `useNeuronIndex`'s entry for the index, `nuclei.ts`' session memo for the
 * somata, the geometry cache below the source seam for skeletons — so a Run after browsing asks
 * for nothing the card has not already fetched.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { errorMessage } from '../../core/errors'
import type { NeuronId } from '../../core/ids'
import type { DatasetAnnotations, SkeletonGeometry, TableValue } from '../../core/values'
import { mapWithConcurrency } from '../../data/concurrency'
import { getSource } from '../../data/source'
import { idColumn } from '../../nodes/lib/tableOps'
import { cellsTable } from '../../packs/cortex/cells'
import { cellTypeAnnotations, cellTypeRefs, cellTypesKey } from '../../packs/cortex/cellTypes'
import type { CorticalFrame } from '../../packs/cortex/frames'
import { frameOf } from '../../packs/cortex/frames'
import type { DatasetInput } from '../useDatasetInput'
import { useNeuronIndex } from '../useNeuronIndex'
import { keyedCache } from '../viewers/keyedCache'
import { useSettledFetch } from '../viewers/useSettledFetch'

export type GalleryCells =
  | { status: 'none' }
  | { status: 'noFrame' }
  | { status: 'loading'; note: string | undefined }
  | { status: 'error'; message: string }
  | { status: 'ready'; cells: TableValue; frame: CorticalFrame }

type Somata = ReadonlyMap<NeuronId, readonly [number, number, number]>

/** A handful of datasets' somata; one is a few thousand triples. */
const somataCache = keyedCache<Somata>(4)
/**
 * The joined typing tables, per choice — boxed, since "the Dataset's own and nothing read" is an
 * `undefined` answer and a cache cannot hold one. The tables themselves are the reader's to keep.
 */
const typingCache = keyedCache<{ annotations: DatasetAnnotations | undefined }>(4)

/**
 * The dataset's cells, placed: the chosen typing tables read (`cellTypes.ts`, as `evaluate` reads
 * them), the index built over them, then the somata.
 */
export function useGalleryCells(dataset: DatasetInput, cellTypes: string): GalleryCells {
  const { sourceId, datasetId, annotations: wired, awaitingRun } = dataset
  const frame = frameOf({ sourceId, datasetId })
  const refs = useMemo(
    () => cellTypeRefs(frame, { sourceId, datasetId }, cellTypes),
    [frame, sourceId, datasetId, cellTypes],
  )
  const typing = useSettledFetch(
    awaitingRun || !frame ? undefined : cellTypesKey(wired, refs),
    async () => ({ annotations: await cellTypeAnnotations(wired, refs, {}) }),
    { cache: typingCache },
  )
  const annotations = typing.status === 'ready' ? typing.data.annotations : undefined
  const typed = typing.status === 'ready'
  const { state } = useNeuronIndex(
    typed ? sourceId : undefined,
    typed ? datasetId : undefined,
    annotations,
  )
  const index = state.status === 'ready' ? state.table : undefined

  const somata = useSettledFetch<Somata>(
    index && sourceId && datasetId
      ? `${sourceId}|${datasetId}|${annotations?.key ?? ''}|${index.length}`
      : undefined,
    async () => {
      const source = getSource(sourceId!)
      if (!source?.somaPositions) throw new Error('This source cannot place a cell’s soma.')
      return source.somaPositions({ datasetId: datasetId!, neuronIds: idColumn(index!) })
    },
    { cache: somataCache },
  )

  return useMemo((): GalleryCells => {
    if (!sourceId || !datasetId) return { status: 'none' }
    if (!frame) return { status: 'noFrame' }
    if (typing.status === 'error') return { status: 'error', message: typing.message }
    if (state.status === 'error') return { status: 'error', message: state.message }
    if (somata.status === 'error') return { status: 'error', message: somata.message }
    if (!typed) return { status: 'loading', note: 'cell types' }
    if (!index)
      return { status: 'loading', note: state.status === 'loading' ? state.note : undefined }
    if (somata.status !== 'ready') return { status: 'loading', note: 'somata' }
    return { status: 'ready', cells: cellsTable(index, somata.data, frame), frame }
  }, [sourceId, datasetId, frame, typing, typed, state, index, somata])
}

/** Skeleton requests in flight at once. */
const CONCURRENCY = 8

export interface WallSkeletons {
  /** An id's skeleton, or `null` where no route has one. Mutated as they land; see `version`. */
  held: ReadonlyMap<NeuronId, SkeletonGeometry | null>
  /** Bumped when `held` changes, so a memo over it knows to look again. */
  version: number
  /** The first failure, said once rather than drawn as a wall of silent gaps. */
  error: string | undefined
}

/**
 * The skeletons of the cells on the wall, arriving as they land.
 *
 * **One cell per request, on Automatic** — which over a single neuron *is* the best route for that
 * neuron, and keeps Automatic's all-or-nothing rule intact: one cell is one value, so nothing is
 * ever mixed. Each cell draws as it lands rather than when the slowest of a batch does. What the
 * choice of route needs to know is asked **once for the whole wall** first (`planSkeletons`):
 * asked per cell, CAVE's rate-limited `exists` refused a wall or two a minute, and the refused
 * cells drew from the level-2 route, unlabelled.
 *
 * Arrivals are gathered into one render per frame, the requests of a wall no longer shown are
 * cancelled, and what is held is pruned to what is wanted — the geometry cache below the source
 * seam is what serves a cell shown again, under its byte budget.
 */
export function useWallSkeletons(
  dataset: DatasetInput,
  ids: readonly NeuronId[],
): WallSkeletons {
  const { sourceId, datasetId, annotations } = dataset
  const datasetKey = `${sourceId}|${datasetId}|${annotations?.key ?? ''}`
  const store = useRef({ key: datasetKey, held: new Map<NeuronId, SkeletonGeometry | null>() })
  if (store.current.key !== datasetKey) store.current = { key: datasetKey, held: new Map() }
  const [version, bump] = useReducer((n: number) => n + 1, 0)
  const [error, setError] = useState<string>()
  const wanted = ids.join(',')

  useEffect(() => {
    const source = sourceId ? getSource(sourceId) : undefined
    if (!source?.fetchSkeletons || !datasetId || !wanted) return
    const held = store.current.held
    const keep = new Set(wanted.split(','))
    for (const id of [...held.keys()]) if (!keep.has(id)) held.delete(id)
    const missing = [...keep].filter((id) => !held.has(id))
    if (missing.length === 0) return

    const controller = new AbortController()
    let pending: [NeuronId, SkeletonGeometry | null][] = []
    let frame: number | undefined
    const flush = () => {
      frame = undefined
      for (const [id, skeleton] of pending) held.set(id, skeleton)
      pending = []
      bump()
    }
    const land = (id: NeuronId, skeleton: SkeletonGeometry | null) => {
      // A request that finished after the wall moved on is still an answer worth keeping, and
      // nothing to re-render for.
      if (controller.signal.aborted) {
        if (skeleton) held.set(id, skeleton)
        return
      }
      pending.push([id, skeleton])
      frame ??= requestAnimationFrame(flush)
    }
    const request = { datasetId, ...(annotations ? { annotations } : {}) }
    // The whole set's route lookups in one go, so the per-cell fetches below ask nothing — see
    // `DataSource.planSkeletons`. A plan that fails costs only that: each fetch asks for itself.
    const planned = (
      source.planSkeletons?.({ datasetId, neuronIds: missing, signal: controller.signal }) ??
      Promise.resolve()
    ).catch(() => undefined)
    void mapWithConcurrency(missing, CONCURRENCY, async (id) => {
      await planned
      if (controller.signal.aborted) return
      try {
        const value = await source.fetchSkeletons!({
          ...request,
          neuronIds: [id],
          signal: controller.signal,
        })
        land(id, value.items[0] ?? null)
      } catch (failure) {
        if (controller.signal.aborted) return
        land(id, null)
        setError((before) => before ?? errorMessage(failure))
      }
    })
    return () => {
      controller.abort()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
    // `annotations` is in `datasetKey`, which is what decides whether the answer would differ.
  }, [datasetKey, wanted])

  return { held: store.current.held, version, error }
}
