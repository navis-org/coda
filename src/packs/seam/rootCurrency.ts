/**
 * Whether the review card's roots are still current, at the server's now — the query neuron and
 * every one of its candidates (user, 2026-11-16). **Reads only**, and only advice: Submit's check
 * (`mergePlan.ts`) asks again before anything is sent, and is the guarantee.
 *
 * ## Built for a queue that is still arriving
 *
 * Suggest Merges streams its candidates into the card, so the set of roots grows while it is on
 * screen. `ask` takes the whole set every time and asks only the roots it knows nothing about —
 * after a short wait (`GATHER_MS`), so a stream's arrivals go out together rather than a request
 * per published partial — in batches of `BATCH`, one at a time.
 *
 * ## How long an answer holds
 *
 * - **Outdated is for good.** A root, once edited, is never current again.
 * - **Current is re-asked** after `CURRENT_FOR_MS`, or sooner where `ask` is given an age: anybody
 *   can edit a neuron at any moment.
 * - **A failed ask is not repeated** for `RETRY_AFTER_MS`, so a card re-rendering against a
 *   refusing server does not send a request per render. Every ask is `quiet`: a tolerated failure
 *   is not the token alarm.
 */

import { channel } from '../../data/channel'
import type { CaveRequestOptions } from '../../data/cave/client'
import { datastackRecord } from '../../data/cave/datastack'
import type { GrapheneSource } from '../../data/cave/graphene'
import { parseGrapheneSource } from '../../data/cave/graphene'
import { isNodeId } from '../../data/cave/graphLayout'
import { isLatestRoots } from '../../data/cave/rootIds'

/** How long a stream's arrivals are gathered before one ask goes out. */
export const GATHER_MS = 400
/** Roots per `is_latest_roots` request. */
export const BATCH = 1000
/** How long "current" is believed before it is asked again. */
export const CURRENT_FOR_MS = 5 * 60_000
/** How long a failed ask waits before the same roots are asked again. */
export const RETRY_AFTER_MS = 60_000

/** Which chunkedgraph: a deployment and a datastack, as the card knows them. */
export interface CurrencyTarget {
  readonly deployment: string
  readonly datastack: string
}

/** What the module asks of the servers, apart so it can be tested without one. */
export interface CurrencyServices {
  chunkedgraph(target: CurrencyTarget, options: CaveRequestOptions): Promise<GrapheneSource>
  latest(
    graphene: GrapheneSource,
    roots: readonly string[],
    options: CaveRequestOptions,
  ): Promise<boolean[]>
  now(): number
}

const LIVE: CurrencyServices = {
  chunkedgraph: async (target, options) => {
    const graphene = parseGrapheneSource(
      (await datastackRecord(target.datastack, options)).segmentation_source,
    )
    if (!graphene) throw new Error(`${target.datastack} has no chunkedgraph.`)
    return graphene
  },
  latest: (graphene, roots, options) => isLatestRoots(graphene, roots, 'server', options),
  now: () => Date.now(),
}

/** What is known of one root. */
type Known = { readonly latest: boolean; readonly at: number } | { readonly failedAt: number }

export interface RootCurrency {
  /**
   * Ask about every root here not already known (or due again). Returns at once. `currentForMs`
   * asks sooner about a root believed current — the row in view, or a root a viewer's report
   * suggests was edited (`rootEdits.ts`); an outdated root stays outdated.
   */
  ask(target: CurrencyTarget, roots: readonly string[], currentForMs?: number): void
  /**
   * Ask for an answer to a question sent from now on — a root a viewer's report suggests was just
   * edited (`rootEdits.ts`). As `ask` with `currentForMs`, and where a question about it is already
   * out, which may predate the edit, it is asked once more when that one answers.
   */
  askAfter(target: CurrencyTarget, roots: readonly string[], currentForMs: number): void
  /** `true` current, `false` edited since, `undefined` not known (yet). */
  current(target: CurrencyTarget, root: string): boolean | undefined
  /** Raised when an answer lands; `version` moves with it, for `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void
  version(): number
}

export function createRootCurrency(services: CurrencyServices = LIVE): RootCurrency {
  const known = new Map<string, Known>()
  const asking = new Set<string>()
  const waiting = new Map<string, { target: CurrencyTarget; roots: Set<string> }>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let version = 0
  const changed = channel()

  const tableOf = (target: CurrencyTarget) => `${target.deployment}|${target.datastack}`
  const keyOf = (table: string, root: string) => `${table}|${root}`

  /** Whether a root needs asking now: never asked, or its answer has run out. */
  const due = (key: string, currentFor: number): boolean => {
    if (asking.has(key)) return false
    const held = known.get(key)
    if (!held) return true
    const age = services.now() - ('failedAt' in held ? held.failedAt : held.at)
    if ('failedAt' in held) return age >= RETRY_AFTER_MS
    return held.latest && age >= currentFor
  }

  async function send(target: CurrencyTarget, roots: readonly string[]): Promise<void> {
    const table = tableOf(target)
    /*
     * An answer is stamped with when its question went, not when it came back: an edit made while
     * the request was out is not something "current" can speak for.
     */
    const sentAt = services.now()
    const options: CaveRequestOptions = { deployment: target.deployment, quiet: true }
    try {
      const graphene = await services.chunkedgraph(target, options)
      for (let i = 0; i < roots.length; i += BATCH) {
        const batch = roots.slice(i, i + BATCH)
        let answers: boolean[] | undefined
        try {
          answers = await services.latest(graphene, batch, options)
        } catch {
          answers = undefined
        }
        const at = services.now()
        batch.forEach((root, j) => {
          const key = keyOf(table, root)
          asking.delete(key)
          const latest = answers?.[j]
          known.set(key, latest === undefined ? { failedAt: at } : { latest, at: sentAt })
        })
        version += 1
        changed.notify()
        askAgain(target, batch)
      }
    } catch {
      // No chunkedgraph to ask: every root here waits out the retry, as a failed batch does.
      const at = services.now()
      for (const root of roots) {
        const key = keyOf(table, root)
        asking.delete(key)
        // Failed, so nothing answered: no question to ask once more after.
        again.delete(key)
        known.set(key, { failedAt: at })
      }
    }
  }

  /**
   * Roots asked about by `askAfter` while a question about them was already out: that
   * question may predate what prompted this one, so they are asked once more when it answers.
   */
  const again = new Set<string>()
  function askAgain(target: CurrencyTarget, roots: readonly string[]): void {
    const table = tableOf(target)
    const due = roots.filter((root) => again.delete(keyOf(table, root)))
    if (due.length > 0) currency.ask(target, due, 0)
  }

  function flush(): void {
    timer = undefined
    const batches = [...waiting.values()]
    waiting.clear()
    // One table at a time, one batch at a time: this is advice, not worth a burst.
    void batches.reduce(
      (previous, { target, roots }) => previous.then(() => send(target, [...roots])),
      Promise.resolve(),
    )
  }

  const currency: RootCurrency = {
    ask(target, roots, currentForMs = CURRENT_FOR_MS) {
      const table = tableOf(target)
      for (const root of roots) {
        // A cell that is no id is never asked: it would fail the whole batch it went in.
        if (!isNodeId(root)) continue
        const key = keyOf(table, root)
        if (!due(key, currentForMs)) continue
        asking.add(key)
        let held = waiting.get(table)
        if (!held) waiting.set(table, (held = { target, roots: new Set() }))
        held.roots.add(root)
      }
      if (waiting.size > 0 && timer === undefined) timer = setTimeout(flush, GATHER_MS)
    },
    askAfter(target, roots, currentForMs) {
      const table = tableOf(target)
      for (const root of roots) {
        const key = keyOf(table, root)
        // Out, not merely queued: a queued question goes after the edit, and answers for it.
        if (asking.has(key) && !waiting.get(table)?.roots.has(root)) again.add(key)
      }
      currency.ask(target, roots, currentForMs)
    },
    current(target, root) {
      const held = known.get(keyOf(tableOf(target), root))
      return held && 'latest' in held ? held.latest : undefined
    },
    subscribe: changed.subscribe,
    version: () => version,
  }
  return currency
}

/** The card's, for the session. */
export const rootCurrency = createRootCurrency()
