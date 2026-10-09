/**
 * Opening an IndexedDB database, and running one transaction against it.
 *
 * Six modules keep something in IndexedDB — the data cache, uploads, edge sets, the workflow
 * library, the recipe shelf and the open-document session — and each had its own copy of the
 * open, the upgrade, the memo and the transaction wrapper. They stay **six databases**
 * (`library.ts` and `session.ts` both record why sharing one means racing on a version bump, and
 * `recipes.ts` was given its own for that reason); what is shared is the
 * plumbing, because the copies had drifted on the two parts that fail silently:
 *
 *  - **`onversionchange`.** An old tab holding a connection open blocks a later `DB_VERSION`
 *    bump, and the new tab then degrades — as "this browser has no storage" in the openers that
 *    reject, and permanently in the one that memoised its failure. Only `session.ts` had it.
 *    Every connection opened here closes itself when another tab asks to upgrade, and drops the
 *    memo so the next caller reopens at whatever version is current.
 *  - **The memo resets on failure.** A cached rejection makes one transient failure permanent
 *    for the life of the tab, and the user's next attempt is exactly when it is worth trying
 *    again — `library.test.ts` pins that a rejected open is not memoised. `cache.ts` and
 *    `session.ts` had both kept theirs. The memo is `memoPromise`'s, so this is the rule stated
 *    there rather than a sixth spelling of it.
 *
 * **Stores are created if missing and never recreated.** A version bump that dropped a store
 * would make every user re-download (or re-import) what it held to gain a feature that did not
 * need it to go — `cache.ts`' `meta` sidecar arrived this way.
 *
 * What stays with each caller is the **failure policy**, which genuinely differs and must:
 * `library.ts`, `recipes.ts`, `uploads.ts` and `edges/store.ts` *refuse* a write that did not
 * commit (a save that silently did not save is data loss), and each names the failure in its own
 * words;
 * `cache.ts` and `session.ts` *swallow* one (a failure to remember is not a failure to compute),
 * and every read everywhere degrades to "nothing stored". Hence two runners over one core:
 * `commit` for the first, `attempt` for the second.
 *
 * Headless and without a hard dependency on IndexedDB existing — under vitest's node environment
 * the identifier is absent, and a private window may refuse the open.
 */

import { memoPromise } from './memoPromise'

export interface DatabaseSpec {
  name: string
  version: number
  /** Object stores, created on upgrade where missing and never recreated. */
  stores: readonly string[]
}

/** A database's connection, opened on first use. */
export interface Database {
  /** The database's name, which is what `usage` asks the browser whether it exists by. */
  name: string
  /** Its object stores, as declared — every one of them is walked by `usage`. */
  stores: readonly string[]
  /**
   * The open connection, memoised on success only. Rejects when there is none to be had — no
   * IndexedDB, a refusal (private-mode Firefox, storage switched off), or an open blocked by a
   * tab that predates `onversionchange`.
   */
  open(): Promise<IDBDatabase>
  /** Test seam: forget the connection, so a fresh `indexedDB` is picked up. */
  reset(): void
}

export function database(spec: DatabaseSpec): Database {
  // One key: `memoPromise` is the memo, and its identity guard is what stops a late failure
  // from an old factory evicting a connection opened after a `reset`.
  const held = new Map<'connection', Promise<IDBDatabase>>()
  const connect = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      // `typeof` rather than truthiness: the identifier is simply absent under node.
      if (typeof indexedDB === 'undefined') return reject(new Error('No IndexedDB'))
      let request: IDBOpenDBRequest
      try {
        request = indexedDB.open(spec.name, spec.version)
      } catch (err) {
        return reject(err)
      }
      request.onupgradeneeded = () => {
        const db = request.result
        for (const store of spec.stores) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
        }
      }
      // Set when the caller has already been told no, so a late success does not leave a
      // connection nobody holds — and none holding up the next tab's upgrade.
      let blocked = false
      request.onsuccess = () => {
        const db = request.result
        if (blocked) {
          db.close()
          return
        }
        const opened = held.get('connection')
        db.onversionchange = () => {
          db.close()
          if (held.get('connection') === opened) held.delete('connection')
        }
        resolve(db)
      }
      // Private-mode Firefox rejects here; so does a browser with storage switched off.
      request.onerror = () => reject(request.error ?? new Error(`Could not open ${spec.name}`))
      request.onblocked = () => {
        blocked = true
        reject(new Error(`${spec.name} is held open by another tab`))
      }
    })
  return {
    name: spec.name,
    stores: spec.stores,
    open: () => memoPromise(held, 'connection', connect, { keep: 'resolved' }),
    reset: () => held.clear(),
  }
}

/** One transaction's work: queue requests, and return the one whose result is the answer. */
export type TransactionBody<T> = (tx: IDBTransaction) => IDBRequest<T> | void

/**
 * Run one transaction and settle when it **commits**, with the body's request's result.
 *
 * Waiting for `complete` rather than for the individual requests is the load-bearing part: a
 * quota failure lets the `put` succeed and then aborts the transaction, so a caller awaiting the
 * request would report a save that was rolled back.
 *
 * A body that throws — `put` does, synchronously, on a value that cannot be structured-cloned —
 * **aborts** what it had already queued, so a failure can never commit half a write. `cache.ts`
 * orders its two puts value-first for the same reason, which still matters to anyone reading it.
 */
function settle<T>(
  db: IDBDatabase,
  stores: string | readonly string[],
  mode: IDBTransactionMode,
  body: TransactionBody<T>,
  words?: RefusalWords,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    // With words, a refusing caller's sentence; without, the platform's error, for `attempt`.
    const fail = (cause: unknown, fallback: keyof RefusalWords) =>
      reject(words ? refusal(cause, words[fallback], words) : cause)
    let tx: IDBTransaction
    try {
      tx = db.transaction(stores as string | string[], mode)
    } catch (err) {
      return fail(err, 'unavailable')
    }
    let request: IDBRequest<T> | void
    tx.oncomplete = () => resolve(request ? request.result : undefined)
    tx.onerror = () => fail(tx.error, 'failed')
    tx.onabort = () => fail(tx.error, 'rolledBack')
    try {
      request = body(tx)
    } catch (err) {
      fail(err, 'failed')
      try {
        tx.abort()
      } catch {
        // Already finished; nothing was left to undo.
      }
    }
  })
}

/** How a refusing caller names each failure. Every field is a whole sentence the UI shows. */
export interface RefusalWords {
  /** No database, or none that would start a transaction. */
  unavailable: string
  /** The transaction aborted, which is what a quota failure does after the `put` succeeded. */
  rolledBack: string
  /** A request failed, or the body threw. */
  failed: string
  /**
   * Quota, the one failure worth naming: it is actionable, and the platform's own message for
   * it says nothing about what to do. Each caller says what the user can delete.
   */
  quota: string
}

function refusal(err: unknown, fallback: string, words: RefusalWords): Error {
  if (err instanceof Error) {
    return err.name === 'QuotaExceededError' ? new Error(words.quota) : err
  }
  return new Error(fallback)
}

/**
 * A read-write transaction that **rejects** unless it committed — the policy for a write somebody
 * asked for, where reporting success and losing the work is the one outcome worse than refusing.
 */
export async function commit(
  db: Database,
  stores: readonly string[],
  body: (tx: IDBTransaction) => void,
  words: RefusalWords,
): Promise<void> {
  let connection: IDBDatabase
  try {
    connection = await db.open()
  } catch {
    throw new Error(words.unavailable)
  }
  await settle(connection, stores, 'readwrite', body, words)
}

/**
 * A transaction that **resolves to `fallback`** on any failure, and on an absent result — the
 * policy for every read, and for a write nobody asked for. Broken storage reads as empty storage.
 */
export async function attempt<T, F = T>(
  db: Database,
  stores: string | readonly string[],
  mode: IDBTransactionMode,
  body: TransactionBody<T>,
  fallback: F,
): Promise<T | F> {
  try {
    return (await settle(await db.open(), stores, mode, body)) ?? fallback
  } catch {
    return fallback
  }
}

/** One value by key, resolving to `fallback` on any failure — `attempt`'s policy for the commonest read. */
export function readKey<T, F = T>(
  db: Database,
  store: string,
  key: IDBValidKey,
  fallback: F,
): Promise<T | F> {
  return attempt(
    db,
    store,
    'readonly',
    (tx) => tx.objectStore(store).get(key) as IDBRequest<T>,
    fallback,
  )
}

/** What one database holds, as the Memory dialog's Storage tab reports it. */
export interface StoredUsage {
  /** Records in the one store that holds a record per thing a reader would count. */
  entries: number
  /** `storedBytes` summed over every store, keys included — an estimate, not a measurement. */
  bytes: number
}

/**
 * How a database's payload is sized without reading it: the stores to leave unread, and the size
 * each counted record already declares for what they hold.
 *
 * For the shelves that record a size at write time — a saved workflow's JSON length, an edge set's
 * encoded bytes, an upload's file size. Reading the payload instead pulls every graph, every 8 MB
 * edge chunk and every uploaded table through a structured clone on the main thread to learn a
 * number already stored beside it.
 */
export interface SizedBy {
  skip: readonly string[]
  bytes: (record: unknown) => number
}

/**
 * Walk a database's stores and add up what they hold.
 *
 * **No browser says how big one database is** — `navigator.storage.estimate()` answers for the
 * whole origin — so this reads records and estimates each one, or takes the size a record already
 * declares (`SizedBy`). Whatever is read is deserialised, one record at a time, so this runs only
 * when somebody asks (the Storage tab opening), never on a clock.
 *
 * **Asks before opening.** Opening a database that does not exist creates it, so measuring would
 * otherwise leave an empty database behind for every feature somebody has never used. Where
 * `indexedDB.databases()` is missing (Firefox before 126) the open goes ahead, and creates an empty
 * database at the module's own version with its own stores — wasteful, never wrong.
 *
 * Resolves undefined when there is no IndexedDB or the database will not open: unknown, which the
 * dialog must not draw as a zero.
 */
export async function usage(
  db: Database,
  counted: string,
  sizedBy?: SizedBy,
): Promise<StoredUsage | undefined> {
  try {
    const listed = await indexedDB.databases?.()
    if (listed && !listed.some((entry) => entry.name === db.name))
      return { entries: 0, bytes: 0 }
  } catch {
    // Unlisted is not absent — and with no IndexedDB at all, the open below says so.
  }
  let connection: IDBDatabase
  try {
    connection = await db.open()
  } catch {
    return undefined
  }
  const read = db.stores.filter((name) => !sizedBy?.skip.includes(name))
  let entries = 0
  let bytes = 0
  try {
    await settle(connection, read, 'readonly', (tx) => {
      for (const name of read) {
        const request = tx.objectStore(name).openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          bytes += storedBytes(cursor.primaryKey) + storedBytes(cursor.value)
          if (name === counted) {
            entries += 1
            if (sizedBy) bytes += sizedBy.bytes(cursor.value)
          }
          cursor.continue()
        }
      }
    })
  } catch {
    return undefined
  }
  return { entries, bytes }
}

/** Any character outside Latin-1, which is what makes a string two bytes a character. */
const TWO_BYTE = /[Ā-￿]/

/**
 * Roughly what a value takes up once structured-cloned, in bytes.
 *
 * The payload only, with no allowance for the browser's own framing or for compression (Chrome
 * compresses large values), which is why the dialog marks every figure from this with `≈`. Strings
 * are a byte a character where every character is Latin-1 and two otherwise, which is how V8
 * stores them. A buffer is charged once however many views share it, because a clone writes it
 * once — the same rule as `ByteLedger`, for the same reason.
 */
export function storedBytes(value: unknown): number {
  const seen = new Set<object>()
  const walk = (item: unknown): number => {
    switch (typeof item) {
      case 'string':
        return item.length * (TWO_BYTE.test(item) ? 2 : 1)
      case 'number':
      case 'bigint':
        return 8
      case 'boolean':
      case 'undefined':
        return 1
      case 'object':
        break
      default:
        return 0
    }
    if (item === null) return 1
    if (seen.has(item)) return 0
    seen.add(item)
    if (item instanceof ArrayBuffer) return item.byteLength
    if (ArrayBuffer.isView(item)) {
      if (seen.has(item.buffer)) return 0
      seen.add(item.buffer)
      return item.buffer.byteLength
    }
    if (typeof Blob !== 'undefined' && item instanceof Blob) return item.size
    if (item instanceof Date) return 8
    let total = 0
    if (item instanceof Map) {
      for (const [key, entry] of item) total += walk(key) + walk(entry)
      return total
    }
    if (item instanceof Set || Array.isArray(item)) {
      for (const entry of item) total += walk(entry)
      return total
    }
    for (const [key, entry] of Object.entries(item)) total += key.length + walk(entry)
    return total
  }
  return walk(value)
}
