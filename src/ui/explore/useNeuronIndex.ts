/**
 * Loading a dataset's neuron index for the Explore widget.
 *
 * The widget loads the index *itself*, rather than waiting for the node to run, and that split
 * is the whole reason the thing feels like a browser instead of a query form: the list fills
 * and filters live, while the node's output ports stay honestly stale until Run. Both sides
 * call the same `source.neuronIndex`, which deduplicates and caches, so a widget load and a
 * subsequent evaluate cost one download between them, not two.
 */

import { useCallback, useEffect, useState } from 'react'

import type { TableValue } from '../../core/values'
import { getSource } from '../../data/source'
import { errorMessage } from '../../core/errors'

export type NeuronIndexState =
  /** No dataset resolved yet — usually an unconnected Dataset input. */
  | { status: 'none' }
  | { status: 'loading'; note: string | undefined }
  | { status: 'ready'; table: TableValue }
  | { status: 'error'; message: string }

export interface NeuronIndexHandle {
  state: NeuronIndexState
  /** Re-download, ignoring the cached copy. */
  reload: () => void
}

export function useNeuronIndex(
  sourceId: string | undefined,
  datasetId: string | undefined,
): NeuronIndexHandle {
  const [state, setState] = useState<NeuronIndexState>({ status: 'none' })
  // Bumped by `reload`, and part of the effect's dependencies so a reload re-runs it. Also
  // carries the "ignore the cache" intent, since only an explicit reload should do that.
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    if (!sourceId || !datasetId) {
      setState({ status: 'none' })
      return
    }
    const source = getSource(sourceId)
    if (!source) {
      setState({ status: 'error', message: `Data source "${sourceId}" is not registered` })
      return
    }
    if (!source.neuronIndex) {
      setState({
        status: 'error',
        message: `${source.label} cannot list a whole dataset — use Find Neurons instead`,
      })
      return
    }

    const controller = new AbortController()
    let live = true
    setState({ status: 'loading', note: undefined })

    source
      .neuronIndex({
        datasetId,
        refresh: reloads > 0,
        onProgress: (_fraction, note) => {
          // Notes only, no percentage: the response is gzipped, so there is no honest
          // fraction to report until it has all arrived.
          if (live) setState({ status: 'loading', note })
        },
        signal: controller.signal,
      })
      .then((table) => {
        if (live) setState({ status: 'ready', table })
      })
      .catch((error: unknown) => {
        if (!live) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setState({ status: 'error', message: errorMessage(error) })
      })

    return () => {
      live = false
      controller.abort()
    }
  }, [sourceId, datasetId, reloads])

  const reload = useCallback(() => setReloads((n) => n + 1), [])
  return { state, reload }
}
