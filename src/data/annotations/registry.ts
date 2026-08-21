/**
 * Which annotation providers exist, and how a ref finds its implementation.
 *
 * A plain map rather than `registerSource`'s lazy factory, because a provider is stateless
 * configuration rather than a connection: `SeaTableProvider` serves both FlyTable and
 * cloud.seatable.io from one instance, with the host in the ref. Registration happens at module
 * load for the same reason node types do — a saved graph resolves its refs the moment it
 * deserialises, and a provider registered later would make one visibly lose its annotations.
 */

import { channel } from '../channel'
import type { TableValue } from '../../core/values'
import { loadCachedTable } from '../neuronIndex'
import type { TableSchema } from '../../core/types'
import type { AnnotationFetchOptions, AnnotationProvider, AnnotationRef } from './types'
import { refKey } from './types'

const providers = new Map<string, AnnotationProvider>()

export function registerAnnotationProvider(provider: AnnotationProvider): void {
  providers.set(provider.id, provider)
}

export function annotationProvider(id: string): AnnotationProvider | undefined {
  return providers.get(id)
}

/**
 * The columns one ref would produce, or undefined while it is still unknown.
 *
 * Per **ref**, not per chain: the chain is assembled by the nodes, each of which holds the
 * upstream's already-published schema on its input type and only has to add its own. A
 * chain-level merge here was a second statement of the same rule, and the two disagreed about
 * the case that matters — whether a half-resolved chain publishes half a schema. It does not;
 * unknown is not empty, the rule `columnSchemaFor` and `resolveColumns` already follow.
 */
export function peekRefColumns(ref: AnnotationRef): TableSchema | undefined {
  return annotationProvider(ref.provider)?.peekColumns(ref)
}

// ---------------------------------------------------------------------------
// "A provider learned its columns" — the signal that inference is out of date
// ---------------------------------------------------------------------------

/**
 * Announce that a provider has filled in something `peekColumns` reads synchronously.
 *
 * `reportSourceLearned`'s twin, for the same reason and on the same terms: a peek answers
 * `undefined` on a fresh session, inference may not await (invariant 2), and without this
 * nothing would ever ask again — every column picker downstream of an annotation node would sit
 * empty until the next unrelated graph edit. It is not a data-changed event and invalidates
 * nothing.
 */
const learned = channel()
export const reportAnnotationsLearned = learned.notify
export const subscribeAnnotationsLearned = learned.subscribe

// ---------------------------------------------------------------------------
// Caching one annotation table
// ---------------------------------------------------------------------------

/**
 * How the providers shape a fetched table into a Coda one. **Bump it when that changes.**
 *
 * "Shaping" is precise rather than a gesture: it is every decision that turns the bytes a server
 * sent into a `TableValue`, so the rule is **bump when the same reply would now produce a
 * different table**. Which rows survive, what the columns are called, what dtype each gets, how a
 * cell is narrowed, whether a long table is folded. Not how the fetch was made — paging, routes,
 * retries and credentials all leave the same table behind and none of them belong here.
 *
 * `annotations.test.ts` is the operative definition. `shapeRows`, `wideRows` and `pivotRows` each
 * have their decisions asserted there, and one test in that file asserts *this constant*, so a
 * change to any of them fails a test that names it. That is deliberate: a version somebody has to
 * remember to bump is a discipline, and a discipline honoured at a fraction of its sites is worse
 * than none — it makes the cache look guarded when it is not.
 *
 * A cached table is kept for a month, and the fingerprint used to be the ref key alone — which
 * says what was *asked for* and nothing about how the answer was built. So a change to the
 * shaping rules did not invalidate a single stored table: every browser that had already read a
 * base kept being served the old shape, for up to a month, with nothing anywhere to say why.
 *
 * It bit immediately. Dropping the providers' duplicate-id collapse changed FlyTable's
 * `main.info` from 56,309 rows to the 58,340 the base actually holds — and a session that had
 * read it before the change went on reporting 56,309, so the fix looked like it had not shipped.
 * `Refresh` on the node was the only way through, which is a workaround somebody has to be told
 * about rather than a cache that knows it is stale.
 *
 * Same trap, and same fix, as `MASK_FORMAT` on the thumbnail cache — an entry that outlived the
 * policy that produced it, because nothing in it recorded which policy that was. In the
 * *fingerprint* rather than the key, deliberately: a fingerprint mismatch is a miss that
 * overwrites, and there is only ever one current shape, so the old entry should be replaced
 * rather than kept beside its replacement.
 */
export const SHAPE_FORMAT = 2

/**
 * Read a ref's table, from the cache where possible.
 *
 * `loadCachedTable`'s wrapper with the key rule folded in, so both providers state the cache
 * policy — the key prefix, the fingerprint, the expiry, the in-flight sharing — once rather than
 * twice. They had copied it line for line, including the `void cacheSet` and its reasoning.
 *
 * The key is the ref, which is right: a ref names its columns, so a differently-configured ref is
 * a different entry rather than the same entry with a different shape. The fingerprint is that
 * plus `SHAPE_FORMAT`, which is the half the key cannot carry.
 */
export function cachedAnnotationTable(
  ref: AnnotationRef,
  options: AnnotationFetchOptions,
  read: () => Promise<TableValue>,
): Promise<TableValue> {
  const key = `annotations:${refKey(ref)}`
  return loadCachedTable({
    key,
    fingerprint: `${key}|shape=${SHAPE_FORMAT}`,
    ...(options.refresh ? { refresh: options.refresh } : {}),
    fetch: read,
  })
}
