/**
 * The axon/dendrite split's typed wrapper over the Python bridge.
 *
 * The seventh capability, written to the shape `nblast.ts` set: a `.py` in `runtime.ts`'s
 * `MODULES`, the request and result types, and a function that calls `callPython` and reads the
 * answer by name. Nothing in `engine.ts`, `worker.ts` or `types.ts` moved for it.
 *
 * A `type` rather than an `interface` on the request, for the reason `NblastRequest` records:
 * TypeScript gives a type alias an implicit index signature and an interface none, so an
 * interface is not assignable to `PyArg` and the call fails to compile talking about `undefined`.
 */

import { callPython } from './engine'
import type { CallOptions } from './engine'
import { int32From } from './types'

/**
 * What a node was labelled, mirroring `topology.py`'s own constants.
 *
 * Two languages, so this is a second spelling of the same numbers and there is no way to share
 * them — which is exactly the arrangement `markGeometry.ts` refused, and the reason `topology.py`
 * names them rather than inlining. `topology.test.ts` asserts the two agree by reading the Python
 * source, so a renumbering on either side fails a test rather than mislabelling every axon.
 */
export const COMPARTMENT_UNASSIGNED = 0
export const COMPARTMENT_DENDRITE = 1
export const COMPARTMENT_AXON = 2
export const COMPARTMENT_LINKER = 3

/** Why a neuron has no split, per neuron. `0` is a split that worked. */
export const SPLIT_OK = 0
export const SPLIT_MULTIPLE_ROOTS = 1
export const SPLIT_NO_SYNAPSES = 2

/** Why a neuron has no split, in words. One reader of the codes, beside the codes. */
export type SplitStatus = 'ok' | 'multiple roots' | 'no synapses' | 'not split'

export function splitStatusOf(code: number | undefined): SplitStatus {
  if (code === SPLIT_MULTIPLE_ROOTS) return 'multiple roots'
  if (code === SPLIT_NO_SYNAPSES) return 'no synapses'
  return 'ok'
}

/**
 * A set of skeletons flattened for one crossing, with per-node synapse counts.
 *
 * `CleanSkeletonsRequest`'s shape minus the coordinates, which this does not need: the split is
 * pure topology plus synapse counts, so sending positions would double what crosses the bridge to
 * deliver something Python never reads. The nearest-node assignment that produces `presynapses`
 * and `postsynapses` happens in `nodes/lib/topologyOps.ts`, where the geometry still has its units
 * and a test can see it.
 */
export type SplitCompartmentsRequest = {
  /** Parent index per node, `-1` for a root. Neuron-local. */
  parents: Int32Array
  /** Presynaptic sites on each node. */
  presynapses: Uint32Array
  /** Postsynaptic sites on each node. */
  postsynapses: Uint32Array
  /** Where each neuron starts, counted in nodes. Length is `count + 1`. */
  offsets: Int32Array
  /**
   * The linker is every node at or above this fraction of peak flow. navis's default is 0.9, and
   * its own docstring says to lower it for atypical or poorly segregated neurons.
   */
  flowThresh: number
  /**
   * The pre/post fraction ratio at or above which a component is called axon. navis's default is
   * 1, and it is spelled inside navis's `split` argument — `split='prepost:0.5'` — which is why
   * it is easy to miss that the knob exists. Above 1 biases towards dendrite, below towards axon.
   */
  splitVal: number
}

export interface SplitCompartmentsResult {
  /** One `CompartmentCode` per node, in the order they were sent. */
  compartment: Int32Array
  /** One `SPLIT_*` code per neuron. */
  status: Int32Array
}

/** Split a whole set of skeletons into axon, dendrite and linker in one call. */
export async function runSplitCompartments(
  request: SplitCompartmentsRequest,
  options: CallOptions = {},
): Promise<SplitCompartmentsResult> {
  /*
   * Read before the await, not after: `transferable` detaches every buffer in the request the
   * moment the call is posted, so `request.parents.length` is 0 by the time this resolves. The
   * gotcha `callPython`'s callers have hit before, and here it would make the length check below
   * pass vacuously.
   */
  const nodeCount = request.parents.length
  const neuronCount = Math.max(0, request.offsets.length - 1)

  const result = await callPython(
    { module: 'topology', fn: 'coda_split_compartments', args: [request] },
    options,
  )

  const compartment = int32From(result, 'compartment')
  const status = int32From(result, 'status')

  /*
   * Checked rather than trusted, `runCleanSkeletons`' rule. A `compartment` array shorter than
   * the node list does not fail downstream — it colours part of a neuron and leaves the rest
   * looking like an honest "unassigned", which is the one value that has a legitimate meaning
   * here and would therefore never be questioned.
   */
  if (compartment.length !== nodeCount) {
    throw new Error(
      `Compartment split returned ${compartment.length} labels for ${nodeCount} nodes`,
    )
  }
  if (status.length !== neuronCount) {
    throw new Error(
      `Compartment split returned ${status.length} statuses for ${neuronCount} neurons`,
    )
  }

  return { compartment, status }
}
