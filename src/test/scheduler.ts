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

/**
 * A Scheduler with no sources at all, refusing any id loudly.
 *
 * For the two upload nodes, whose whole point is that they reach no backend — a test that let one
 * quietly resolve a source would stop being a test of that. Written out in both suites before this;
 * see the module note.
 */
export function sourcelessScheduler(): Scheduler {
  return new Scheduler({
    resolveSource: (id) => {
      throw new Error(`this node must not reach a source (asked for ${id})`)
    },
  })
}
