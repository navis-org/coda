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
 * Read a ref's table, from the cache where possible.
 *
 * `loadCachedTable`'s wrapper with the key rule folded in, so both providers state the cache
 * policy — the key prefix, the fingerprint, the expiry, the in-flight sharing — once rather than
 * twice. They had copied it line for line, including the `void cacheSet` and its reasoning.
 *
 * The fingerprint *is* the key, which is right for a ref: a ref names its columns, so a
 * differently-configured ref is a different key rather than the same key with a different shape.
 */
export function cachedAnnotationTable(
  ref: AnnotationRef,
  options: AnnotationFetchOptions,
  read: () => Promise<TableValue>,
): Promise<TableValue> {
  const key = `annotations:${refKey(ref)}`
  return loadCachedTable({
    key,
    fingerprint: key,
    ...(options.refresh ? { refresh: options.refresh } : {}),
    fetch: read,
  })
}
