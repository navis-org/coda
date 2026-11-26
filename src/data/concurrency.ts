/**
 * The two bounded-concurrency pools, and the difference between them is the whole point — plus
 * `slots`, a budget *shared* across callers rather than one call's own bound.
 *
 * `mapWithConcurrency` **forgives a failed item**, which is right when the items are separate
 * answers — forty-nine skeletons should survive the fiftieth. `inFlight` **fails the whole read
 * on the first failure**, which is right when the items are pieces of one answer — a chunk of a
 * volume cutout, a byte range of a shard — because forgiving one there means a silently
 * zero-filled hole in something that looks like data.
 *
 * Both live here rather than in a caller because that rule is the load-bearing part, and each
 * was written twice before it moved: `mapWithConcurrency` once for Cypher and once for the
 * object stores, `inFlight` once in `precomputed/volume.ts` before `precomputed/sharded.ts`
 * needed it too.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight, collecting results in order.
 *
 * One body without a skeleton must not lose the other forty-nine, so a failure becomes
 * `undefined` — but if *every* item failed, that is not a patchy dataset, it is a broken
 * request, and the first error is rethrown. Swallowing the lot is how a percent-encoded
 * dataset id once turned into a silent "0 skeletons" instead of a 400.
 *
 * An abort is never a failure to count: it propagates immediately, because the caller asked
 * for the work to stop rather than for it to be attempted and missed.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length)
  let next = 0
  let failures = 0
  let firstError: unknown

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index]!)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        failures++
        firstError ??= error
        results[index] = undefined
      }
    }
  })
  await Promise.all(workers)

  if (items.length > 0 && failures === items.length) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError))
  }
  return results
}

/**
 * Run `work` over `items`, at most `limit` at a time.
 *
 * **The strict sibling of `mapWithConcurrency` above**: the first failure fails the read. The
 * module header argues why. **And nothing new starts after it** — the items already in flight
 * finish, but the rest are never sent: the answer is a rejection whatever they say, and every
 * caller's items are requests at a shared server, which at a `429` is asking for fewer.
 *
 * A pool rather than `Promise.all` because the limit is politeness at a shared public bucket: a
 * caller reading a hundred boxes would otherwise have every chunk of every one of them in flight
 * at once. The number is the caller's to set and each has measured its own —
 * `precomputed/volume.ts` has the curve behind its.
 */
export async function inFlight<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  let failed = false
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const at = next
        next += 1
        // `at >= length` rather than `items[at] === undefined`, so an array holding an `undefined`
        // does not end the work early — a trap for the next caller rather than a bug today.
        if (failed || at >= items.length) return
        try {
          await work(items[at]!)
        } catch (error) {
          failed = true
          throw error
        }
      }
    },
  )
  await Promise.all(runners)
}

/** A budget of requests in flight, shared by every caller that holds it (`slots`). */
export interface Slots {
  /** Run `work` once a slot is free. A caller cancelled while waiting leaves the queue. */
  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>
}

/**
 * At most `limit` pieces of work at once, **across callers** — where `inFlight` bounds one
 * call's own items, this bounds everyone who shares it. First come, first served.
 *
 * For politeness at a shared server whose load is the sum of several readers: Find Merge Candidates
 * reads one end's boxes while it counts another's, and a cap per call let those add up past
 * what any of them was allowed (`rootIds.ts`' `CHUNKEDGRAPH_BUDGET`).
 */
export function slots(limit: number): Slots {
  let busy = 0
  const waiting: (() => void)[] = []
  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else busy -= 1
  }
  return {
    async run(work, signal) {
      if (busy >= limit) {
        await new Promise<void>((resolve, reject) => {
          const go = () => {
            signal?.removeEventListener('abort', leave)
            resolve()
          }
          const leave = () => {
            const at = waiting.indexOf(go)
            if (at >= 0) waiting.splice(at, 1)
            reject(signal!.reason)
          }
          if (signal?.aborted) return leave()
          signal?.addEventListener('abort', leave, { once: true })
          waiting.push(go)
        })
      } else {
        busy += 1
      }
      try {
        return await work()
      } finally {
        release()
      }
    },
  }
}
