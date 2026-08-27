/**
 * Graphs two suites need to agree about.
 *
 * Same arrangement as `data/ai/fixture.ts` and `export/fixture.ts`, and for the reason that file
 * states: the point of these is that both suites describe the *same* graph, so two copies are
 * two things that can drift, and the copy that goes stale keeps passing while testing something
 * else. Not a `.test.ts` file, so both can import it; nothing outside a test does, so it never
 * reaches a bundle.
 *
 * Per-suite `node()` builders stay local — six files have one and they are four lines each. This
 * is the other case: a fixture with semantics, where the semantics are the assertion.
 */

import type { CodaGraph } from '../core/graph'
import { emptyGraph } from '../core/graph'
import type { TableSchema } from '../core/types'
import { applyPlan } from './apply'
import { emptyPlan } from './planShape'

/**
 * A pipeline ending in a Pivot, whose columns nothing can know until it has run.
 *
 * `core.pivot` declares `observesOutputSchema`: what it emits is the *values* of the column it
 * pivots on, so no amount of static inference produces them. That is what makes it the case
 * worth testing on both sides of the seam — the answer is genuinely absent before a run and
 * genuinely present after one.
 */
export function pivotGraph(): { graph: CodaGraph; pivotId: string } {
  const applied = applyPlan(emptyGraph(), {
    ...emptyPlan(),
    add: [
      { ref: 'ds', type: 'dataset.mock.opticlobe' },
      { ref: 'find', type: 'neuron.findNeurons' },
      { ref: 'conn', type: 'neuron.connectivity' },
      { ref: 'pivot', type: 'core.pivot' },
    ],
    connect: [
      { from: { node: 'ds', port: 'dataset' }, to: { node: 'find', port: 'dataset' } },
      { from: { node: 'ds', port: 'dataset' }, to: { node: 'conn', port: 'dataset' } },
      { from: { node: 'find', port: 'neurons' }, to: { node: 'conn', port: 'neurons' } },
      { from: { node: 'conn', port: 'connections' }, to: { node: 'pivot', port: 'in' } },
    ],
  })
  if (!applied.ok) throw new Error(applied.errors.join('; '))
  return { graph: applied.graph, pivotId: applied.created.pivot! }
}

/** What that Pivot published, in the shape `inferGraph`'s `observedSchemas` takes. */
export function pivotObserved(pivotId: string): Record<string, TableSchema | undefined> {
  return {
    [pivotId]: {
      columns: [
        { name: 'partnerType', dtype: 'str' },
        { name: 'weight', dtype: 'f64' },
      ],
    },
  }
}
