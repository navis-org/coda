/**
 * The per-region completeness roll-up, for the Dataset Summary card.
 *
 * Deliberately much smaller machinery than `useNeuronIndex`, and the difference is the payload.
 * The neuron index is megabytes and needs a shared state machine so two widgets do not each
 * paint a spinner over one download; this is 9 kB on hemibrain and 217 kB on male-CNS, and
 * `loadCachedTable` inside `NeuPrintSource` already deduplicates it in flight and across
 * reloads — so ordinary per-component state costs a second consumer nothing but a render.
 *
 * It fetched region *connectivity* too, behind an `enabled` flag, while the summary drew a
 * matrix tile. That tile is gone — a 63×63 heatmap at the size a tile gets is texture rather
 * than a chart, and `neuron.roiConnectivity` draws the same data at whatever size it is given.
 * With one caller and one kind left, the `kind` argument and the flag were both dead, so this
 * says what it does instead. The source method behind the other one is untouched.
 */

import { useEffect, useState } from 'react'

import { errorMessage } from '../../core/errors'
import type { TableValue } from '../../core/values'
import { capabilityOf, getSource } from '../../data/source'

export type RoiCompletenessState =
  /** No dataset, or a source that does not publish this. */
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; table: TableValue }
  | { status: 'error'; message: string }

const NONE: RoiCompletenessState = Object.freeze({ status: 'none' })
const LOADING: RoiCompletenessState = Object.freeze({ status: 'loading' })

export function useRoiCompleteness(
  sourceId: string | undefined,
  datasetId: string | undefined,
): RoiCompletenessState {
  const [state, setState] = useState<RoiCompletenessState>(NONE)

  useEffect(() => {
    if (!sourceId || !datasetId) {
      setState(NONE)
      return
    }
    const source = getSource(sourceId)
    const fetch = source?.fetchRoiCompleteness?.bind(source)
    // Not an error: a source that cannot answer this is one whose tile is simply absent, the
    // same way a dataset without `superclass` draws one chart fewer.
    if (!source || !fetch || !capabilityOf(source, datasetId, 'roiSummary')) {
      setState(NONE)
      return
    }

    /*
     * `live` rather than an AbortController, for the reason `useNeuronIndex` documents at
     * length: the fetch is shared and cached, so cancelling on unmount would kill the request a
     * sibling card is still waiting for while saving nothing — the result is kept either way.
     * All this guards is a `setState` after unmount.
     */
    let live = true
    setState(LOADING)
    fetch({ datasetId })
      .then((table) => {
        if (live) setState({ status: 'ready', table })
      })
      .catch((error: unknown) => {
        if (live) setState({ status: 'error', message: errorMessage(error) })
      })

    return () => {
      live = false
    }
  }, [sourceId, datasetId])

  return state
}
