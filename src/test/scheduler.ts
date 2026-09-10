/**
 * A Scheduler for the test suites, shared because nineteen of them had written the same one.
 */

import { Scheduler } from '../core/scheduler'
import type { DataSource } from '../data/source'

/**
 * A Scheduler whose only source is `source`, refusing any other id loudly: a node reaching for a
 * source the test did not give it is a bug in the node or in the test, never a fallback.
 */
export function mockScheduler(source: DataSource): Scheduler {
  return new Scheduler({
    resolveSource: (id) => {
      if (id !== source.id) throw new Error(`unexpected source ${id}`)
      return source
    },
  })
}
