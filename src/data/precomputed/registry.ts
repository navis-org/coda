/**
 * One `PrecomputedSource` per URL, created on demand.
 *
 * `neuprint/registry.ts`'s twin, and for exactly the same reason: a node stores an address, and
 * every node resolves its source through `ctx.resolveSource(sourceId)` — a lookup in the global
 * registry. A node pointing at a bucket therefore needs a registered source for that bucket, and
 * the only moment that can happen is when something asks. Hence a lazy factory rather than a
 * fixed registration list, and hence **no entry in `builtins.ts`**: there is no default
 * precomputed source to register, the way there is a default neuPrint deployment.
 *
 * Keyed by the canonical spelling, so `precomputed://gs://b/p`, `gs://b/p/` and
 * `gs://b/p|neuroglancer-precomputed:` all land on one instance and share its probe and its
 * resolved mesh directory.
 *
 * **Safe to call from `inferOutputs`**: it parses a string and constructs an object. The probe is
 * network work and starts only when something peeks, which is the "answer with what you have,
 * learn in the background" contract `peekDatasets` states.
 */

import { getSource, registerSource, reportSourceLearned } from '../source'
import { parseNgSource } from '../neuroglancer/sourceUrl'
import { PrecomputedSource, precomputedSourceId } from './PrecomputedSource'

/**
 * The source for a neuroglancer URL, registering it the first time it is asked for.
 *
 * Undefined for a string that names nothing at all — an empty box on a freshly added node, which
 * is the ordinary state and not an error. A spec that parses but names a format or a location
 * nothing here can read *does* get a source: it is the source that says so, in a message naming
 * what it was pointed at, and that is a better report than a node with no output type.
 */
export function precomputedSourceFor(spec: string | undefined): PrecomputedSource | undefined {
  const ref = parseNgSource(spec ?? '')
  if (!ref) return undefined
  const existing = getSource(precomputedSourceId(ref.canonical))
  if (existing instanceof PrecomputedSource) return existing
  return registerSource(new PrecomputedSource(ref, reportSourceLearned)) as PrecomputedSource
}
