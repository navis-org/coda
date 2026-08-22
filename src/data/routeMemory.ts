/**
 * Which route last reached a host, remembered per backend.
 *
 * A browser reports a refused cross-origin read and a dead host identically — an opaque
 * `TypeError` — so "can this deployment be called directly?" is only answerable by trying. Two
 * backends now try: neuPrint's deployments (`data/neuprint/client.ts`) and SeaTable's
 * (`data/annotations/seaTable.ts`), with `data/precomputed/transport.ts` doing the same for the
 * mesh buckets in memory only. Written a third time by hand, the rules below existed in three
 * places at once — and they are exactly the kind whose violation is invisible.
 *
 * The **loop** deliberately stays with each caller: what a status means, which errors travel on
 * the auth channel and what a failure should say are per-backend. What is shared is the memory
 * and the ordering, which is the part that has no backend in it.
 */

import { readStorage, writeStorage } from './localStore'

/** `direct` is the host itself and needs CORS; `proxy` is a same-origin relay. */
export type RouteKind = 'direct' | 'proxy'

export interface RouteMemory {
  /**
   * The candidates in preference order, whatever answered last time first.
   *
   * Preferred rather than used exclusively: a dev server that is no longer running, or a
   * deployment that has since gained CORS, still resolves without anybody clearing anything.
   * Costs nothing when the memory is right, which is the common case.
   */
  prefer<T extends { kind: RouteKind }>(key: string, routes: readonly T[]): readonly T[]
  /**
   * Remember a route — **callers must only do this for a 2xx.**
   *
   * A 404 is not evidence a route works: it is what a static host answers for a relay path
   * nobody serves, and remembering it would pin a host to a route that can never succeed and
   * would outlive the day that host gains CORS.
   */
  remember(key: string, kind: RouteKind): void
  /** Drop what is known, so the next request re-probes. */
  forget(key?: string): void
  /** How each host is currently being reached. For a connections panel to show. */
  all(): Record<string, RouteKind>
}

export function makeRouteMemory(storageKey: string): RouteMemory {
  const routes = new Map<string, RouteKind>()
  let loaded = false

  function load(): Map<string, RouteKind> {
    if (loaded) return routes
    loaded = true
    try {
      const raw = readStorage(storageKey)
      if (!raw) return routes
      for (const [key, kind] of Object.entries(JSON.parse(raw) as Record<string, RouteKind>)) {
        if (kind === 'direct' || kind === 'proxy') routes.set(key, kind)
      }
    } catch {
      // Corrupt: start from scratch and re-probe. Not worth failing a fetch over.
    }
    return routes
  }

  function persist(): void {
    writeStorage(storageKey, routes.size ? JSON.stringify(Object.fromEntries(routes)) : undefined)
  }

  return {
    prefer(key, candidates) {
      const preferred = load().get(key)
      if (!preferred || candidates.length < 2) return candidates
      // A stable partition rather than a sort: the order among equals is the caller's, which is
      // its own statement of which route to try first when nothing is known.
      return [
        ...candidates.filter((route) => route.kind === preferred),
        ...candidates.filter((route) => route.kind !== preferred),
      ]
    },
    remember(key, kind) {
      if (load().get(key) === kind) return
      routes.set(key, kind)
      persist()
    },
    forget(key) {
      load()
      if (key) routes.delete(key)
      else routes.clear()
      persist()
    },
    all() {
      return Object.fromEntries(load())
    },
  }
}
