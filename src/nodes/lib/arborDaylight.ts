/**
 * The equal-angle layout's daylight passes, off the main thread.
 *
 * A pass is quadratic — every branch point measures the whole tree around it — so two passes on a
 * 4,400-landmark arbour take a third of a second, which on the main thread is a card that freezes
 * whenever its neuron, root or distance changes. The card draws plain equal-angle at once (it is
 * exact and crossing-free on its own) and swaps in this answer when it lands.
 *
 * `runWorkerJob`'s arrangement: a worker where there is one, this thread where there is not —
 * jsdom and Node, where the answer is the same and merely blocks.
 */

import type { JobRunOptions } from '../../data/workerJob'
import { runWorkerJob } from '../../data/workerJob'
import type { ArborShape } from './arborLayout'
import { equalAngleLayout } from './arborLayout'
import type { KeyTree } from './arborOps'

/** What crosses to the worker: the reduced tree's shape and distances, nothing per skeleton node. */
export interface DaylightJob {
  readonly nodes: Int32Array
  readonly parent: Int32Array
  readonly distance: Float64Array
  readonly passes: number
}

/** The job's body, wherever it runs. */
export async function runDaylight(job: DaylightJob): Promise<ArborShape> {
  // `segmentOf` is per skeleton node and no layout reads it, so it stays behind.
  const tree: KeyTree = { nodes: job.nodes, parent: job.parent, segmentOf: new Int32Array(0) }
  return equalAngleLayout(tree, job.distance, job.passes)
}

/** The equal-angle layout with `passes` of daylight, in a worker where there is one. */
export function daylightLayout(
  tree: KeyTree,
  distance: Float64Array,
  passes: number,
  options: JobRunOptions = {},
): Promise<ArborShape> {
  return runWorkerJob<DaylightJob, ArborShape>(
    // Written out here, where vite can see it — see `workerJob.ts`.
    () => new Worker(new URL('./arborDaylight.worker.ts', import.meta.url), { type: 'module' }),
    { nodes: tree.nodes, parent: tree.parent, distance, passes },
    { ...options, label: 'arbour layout', here: runDaylight },
  )
}
