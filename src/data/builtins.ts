/**
 * The sources every Coda has, registered in one place.
 *
 * There were four lines of this in `store/graphStore.ts` and a copy of some subset of them at
 * the top of a dozen test files, which was tolerable while the app was the only consumer. It
 * stopped being tolerable when `scripts/zoo-index.ts` arrived: that script validates deposited
 * workflows against the registry, and a script registering *three* of the four would report
 * every CATMAID workflow in the zoo as broken — a false failure with a persuasive message,
 * against contributions nobody could fix.
 *
 * So the set is stated once, and the app and the validator ask for the same one. The ordering is
 * load-bearing: **mock first**, because it stays the default for a fresh graph and the examples
 * must open and run with no token and no network.
 *
 * Most tests still register `MockSource` themselves, and that is not an oversight left to tidy:
 * they want *only* the mock, at `latencyMs: 0`, and several assert on the registered set. What
 * they share is a one-line fast-mock helper, which is a different extraction from this one.
 *
 * Idempotent, so a caller that cannot know whether the store already loaded — a test, a script
 * — can simply call it. `registerSource` replaces by id, which is what makes that true.
 */

import { CaveSource } from './cave/CaveSource'
import { catmaidSourceFor } from './catmaid/registry'
import { MockSource } from './mock/MockSource'
import { NeuPrintSource } from './neuprint/NeuPrintSource'
import { registerSource } from './source'

export interface BuiltinSourceOptions {
  /**
   * Passed to `MockSource`. Zero in tests and in the validator, where the synthetic latency is
   * a few hundred milliseconds of nothing per graph and there is no interface to keep honest.
   */
  mockLatencyMs?: number
}

export function registerBuiltinSources(options: BuiltinSourceOptions = {}): void {
  registerSource(
    new MockSource(
      options.mockLatencyMs === undefined ? {} : { latencyMs: options.mockLatencyMs },
    ),
  )
  registerSource(new NeuPrintSource())
  registerSource(new CaveSource())
  // Registers itself as a side effect of being asked for the default server.
  catmaidSourceFor(undefined)
}
