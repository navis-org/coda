/**
 * The axon/dendrite split for the neuron on screen, run live.
 *
 * The node splits the whole incoming set on Run; this splits the one neuron you are looking at,
 * as you look at it. Both call `runSplitCompartments`, so there is one implementation and the
 * card cannot disagree with the port beside it.
 *
 * **It is opt-in and stays opt-in**, which is the only interesting thing here. The split needs
 * Pyodide, and that is ~10 MB the first time anything in the session uses it — so this hook does
 * nothing at all until `enabled`, and `enabled` is driven by the user picking compartment colours
 * or opening the Compartments tab. A widget that split every neuron it drew would make paging
 * through twenty cells twenty worker calls behind a download nobody asked for.
 *
 * The cache is keyed on the *skeleton object* rather than on a neuron id: `useNeuronTopology`
 * already holds one `SkeletonsValue` per neuron and hands back the same object for a cache hit,
 * so identity is exactly "the same geometry, split with these settings" — and it cannot go stale
 * against a re-fetch the way an id would. That is what makes the two tuning sliders affordable:
 * a value somebody has already tried costs nothing to go back to.
 */

import { useEffect, useState } from 'react'

import { errorMessage } from '../../core/errors'
import type { SkeletonGeometry } from '../../core/values'
import type { SynapseAssignment, SynapseSite } from '../../nodes/lib/topologyOps'
import { assignSynapses } from '../../nodes/lib/topologyOps'
import type { SplitStatus } from '../../pyodide/topology'
import { runSplitCompartments, splitStatusOf } from '../../pyodide/topology'

export interface Compartments {
  /** One compartment code per skeleton node — `COMPARTMENT_*` in `pyodide/topology.ts`. */
  readonly labels: Int32Array
  readonly status: SplitStatus
  /** Where each synapse landed, so the tabs can report per-compartment counts. */
  readonly synapses: SynapseAssignment
}

export type CompartmentState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: Compartments }
  | { status: 'error'; message: string }

/*
 * Keyed on the *settings*, not on one of them.
 *
 * This held a `Map<number, …>` on the linker threshold alone, which was right while that was the
 * only knob. With a second one it would have served the answer for the previous axon threshold
 * whenever somebody moved it back and forth across a threshold they had already tried — a stale
 * split that looks exactly like a working one, since both are plausible splits of the same cell.
 */
const memory = new WeakMap<SkeletonGeometry, Map<string, Compartments>>()

/** What one cached split is a fact about, beyond the skeleton the WeakMap is keyed on. */
function settingsKey(flowThresh: number, splitVal: number): string {
  return `${flowThresh}|${splitVal}`
}

export function useCompartments(
  skeleton: SkeletonGeometry | undefined,
  sites: readonly SynapseSite[] | undefined,
  flowThresh: number,
  splitVal: number,
  enabled: boolean,
): CompartmentState {
  const [state, setState] = useState<CompartmentState>({ status: 'idle' })

  useEffect(() => {
    if (!enabled || !skeleton) {
      setState({ status: 'idle' })
      return
    }

    const key = settingsKey(flowThresh, splitVal)
    const hit = memory.get(skeleton)?.get(key)
    if (hit) {
      setState({ status: 'ready', data: hit })
      return
    }

    let live = true
    setState({ status: 'loading' })

    void (async () => {
      try {
        const assignment = assignSynapses(skeleton, sites ?? [])
        /*
         * Statically imported. This was a dynamic `import()` guarding against `engine.ts`
         * constructing a `Worker` at module scope — but it does not: `ensureWorker()` is called
         * from inside `callPython`, and this file was already importing the status constants
         * statically, so the module was loaded either way and the guard bought nothing.
         */
        const nodeCount = skeleton.parents.length
        const result = await runSplitCompartments({
          parents: skeleton.parents.slice(),
          presynapses: assignment.pre.slice(),
          postsynapses: assignment.post.slice(),
          offsets: new Int32Array([0, nodeCount]),
          flowThresh,
          splitVal,
        })
        const data: Compartments = {
          labels: result.compartment,
          status: splitStatusOf(result.status[0]),
          synapses: assignment,
        }
        const bySettings = memory.get(skeleton) ?? new Map<string, Compartments>()
        bySettings.set(key, data)
        memory.set(skeleton, bySettings)
        if (live) setState({ status: 'ready', data })
      } catch (error) {
        if (live) setState({ status: 'error', message: errorMessage(error) })
      }
    })()

    return () => {
      live = false
    }
  }, [skeleton, sites, flowThresh, splitVal, enabled])

  return state
}
