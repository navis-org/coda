/**
 * Virtual Fly Brain's **public** CATMAID tokens: a baked table, refreshed in the background.
 *
 * These are not credentials in the sense every other file in this directory means. Each one
 * authenticates as CATMAID's `AnonymousUser`, whose only permission is `can_browse`, so a token
 * grants exactly the read access the server already offers to everybody over `GET`. VFB publishes
 * them at `MANIFEST_URL` and says so in the file itself. What they buy is not data — it is the
 * *verb*: CATMAID's query endpoints are POST-only, an anonymous POST is refused by Django's CSRF,
 * and a browser can satisfy neither of its gates (`Referer` is a forbidden header name, and the
 * CSRF cookie is `SameSite=Lax`, so it is neither sent nor readable cross-site). A token bypasses
 * CSRF because DRF's token class runs before its session class and never reaches `enforce_csrf`.
 * `docs/catmaid_vfb.md` has the measurements and the history.
 *
 * **Two layers, and each covers the other's failure.** The table below is a snapshot committed to
 * the repository: it answers synchronously, on the first paint, offline, and in a test, and it is
 * the reason none of this is a network dependency. The refresh is what survives a rotation
 * without a release — VFB can mint new tokens and a reader gets them on their next visit rather
 * than on ours. Neither alone is enough: a snapshot goes stale with no way back, and a fetch
 * cannot answer the request that is already in flight.
 *
 * Three things that are easy to get wrong here:
 *
 *  - **A published token must lose to a user's own.** Somebody with a real VFB account has more
 *    than `can_browse`, and silently sending the anonymous token instead would make their own
 *    data invisible with nothing to say why. `client.ts` consults this only where
 *    `credentialsFor` supplied no token.
 *  - **The manifest is fetched with `cache: 'no-cache'`**, because it is served
 *    `max-age=31536000, immutable`. A year and `immutable` is a browser instructed never to
 *    re-check, which would make the refresh a no-op after the first visit — the exact failure it
 *    exists to prevent, and one that would look like the feature working.
 *  - **FAFB answers on two hostnames** and Coda ships the other one. `DEFAULT_CATMAID_SERVER` is
 *    `catmaid-fafb.virtualflybrain.org`; the manifest lists `fafb.catmaid.virtualflybrain.org`.
 *    One deployment — identical `/projects/`, and one token works on both — but
 *    `catmaidSourceId` hands out the bare `catmaid` id for that exact string, so the constant
 *    cannot move without re-keying every saved graph. `ALIASES` is that fact, written down.
 */

import { readStorage, writeStorage } from '../localStore'
import { hostPattern } from './credentials'

/** Where VFB publishes the set. Public by design; see the note above. */
export const MANIFEST_URL = 'https://virtualflybrain.org/data/EM/catmaid.json'

const OVERLAY_KEY = 'coda.catmaid.publicTokens.v1'

/**
 * The snapshot, from `catmaid.json` `generated: 2026-08-29`, `schema_version: 1`.
 *
 * Verified host by host on that date: every one answers `POST /{project}/skeleton/neuronnames`
 * with 200 carrying its token and 403 `CSRF Failed` without it. Four of the eight share a token
 * value, which is VFB's business rather than ours — they are separate deployments (each
 * `/projects/` lists only its own) and the mapping is used exactly as published.
 */
const SNAPSHOT: ReadonlyArray<readonly [host: string, token: string]> = [
  ['abd1.5.catmaid.virtualflybrain.org', 'ce6984c9d4d00a40d3173a9aad3924afe6612c43'],
  ['fafb.catmaid.virtualflybrain.org', '3ca85fe2f8351ae8f4550f050ab8c0815d53f576'],
  ['fanc.catmaid.virtualflybrain.org', '7ebf1358497a96845d6aa7b4d0fbd01538fb69c2'],
  ['iav-robo.catmaid.virtualflybrain.org', 'ce6984c9d4d00a40d3173a9aad3924afe6612c43'],
  ['iav-tnt.catmaid.virtualflybrain.org', 'ce6984c9d4d00a40d3173a9aad3924afe6612c43'],
  ['l1em.catmaid.virtualflybrain.org', '4c1c9c60d4864c41ebc79f42ba99014a9e912f49'],
  ['l3vnc.catmaid.virtualflybrain.org', 'ce6984c9d4d00a40d3173a9aad3924afe6612c43'],
  ['larva1099.catmaid.virtualflybrain.org', 'b0cbcf16d84f2b820673471445e3d64d04797d06'],
]

/**
 * Second hostnames for one deployment, as `alias -> canonical`.
 *
 * Only where measured, never guessed: a hostname that merely *looks* like an instance's is a
 * token sent to a server nobody checked.
 */
const ALIASES: ReadonlyArray<readonly [alias: string, canonical: string]> = [
  ['catmaid-fafb.virtualflybrain.org', 'fafb.catmaid.virtualflybrain.org'],
]

let tokens: Map<string, string> | undefined
let refreshing: Promise<void> | undefined

/** The snapshot plus whatever a previous session's refresh persisted, aliases resolved. */
function load(): Map<string, string> {
  if (tokens) return tokens
  const next = new Map<string, string>(SNAPSHOT)
  try {
    const raw = readStorage(OVERLAY_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : undefined
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [host, token] of Object.entries(parsed as Record<string, unknown>)) {
        // A stored overlay is data from another origin that has been through `localStorage`.
        // Both halves are checked rather than trusted: the alternative is an arbitrary string
        // travelling to an arbitrary host on an `X-Authorization` header.
        if (typeof token === 'string' && /^[a-z0-9]{20,64}$/i.test(token)) {
          const cleaned = hostPattern(host)
          if (cleaned) next.set(cleaned, token)
        }
      }
    }
  } catch {
    // Corrupt overlay: the snapshot alone is a working answer, which is the whole point of it.
  }
  for (const [alias, canonical] of ALIASES) {
    const token = next.get(canonical)
    if (token) next.set(alias, token)
  }
  tokens = next
  return tokens
}

/**
 * The published token for a server, or undefined for a host VFB does not publish.
 *
 * Synchronous and side-effect-free, because it is called on the way into every CATMAID request
 * and because `inferOutputs` must be able to reach anything on that path. Starting the refresh
 * is `client.ts`'s job, at the moment it is about to talk to the host anyway — see the note
 * there for why not here and why not at the app entry.
 */
export function publicTokenFor(server: string): string | undefined {
  const host = hostPattern(server)
  return host ? load().get(host) : undefined
}

/** Every host with a published token, for the panel's note and for tests. */
export function publicTokenHosts(): string[] {
  return [...load().keys()].sort()
}

/**
 * Re-read the manifest, once per session, and persist what it says.
 *
 * Fire-and-forget on purpose: nothing waits for it, every failure is swallowed, and a request
 * issued while it is in flight is answered from the snapshot. The only thing it changes is the
 * *next* request, and the next session.
 */
export function startPublicTokenRefresh(signal?: AbortSignal): Promise<void> {
  refreshing ??= refresh(signal).catch(() => undefined)
  return refreshing
}

interface ManifestInstance {
  url?: unknown
  api_token?: unknown
}

async function refresh(signal: AbortSignal | undefined): Promise<void> {
  const response = await fetch(MANIFEST_URL, {
    // See the module note: the file is served `immutable` with a one-year max-age, so without
    // this the refresh would run exactly once per browser and then never again.
    cache: 'no-cache',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) return
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') return
  const instances = (body as { instances?: unknown }).instances
  if (!Array.isArray(instances)) return

  const found = new Map<string, string>()
  for (const entry of instances as ManifestInstance[]) {
    if (!entry || typeof entry.url !== 'string' || typeof entry.api_token !== 'string') continue
    const host = hostPattern(entry.url)
    // The same shape check `load` applies to a stored overlay, for the same reason.
    if (host && /^[a-z0-9]{20,64}$/i.test(entry.api_token)) found.set(host, entry.api_token)
  }
  // An empty or unreadable manifest leaves the snapshot alone. A published file that has lost
  // its `instances` is a deployment accident at the other end, and treating it as "no instance
  // has a token" would turn their bad minute into our broken build.
  if (found.size === 0) return

  const map = load()
  for (const [host, token] of found) map.set(host, token)
  for (const [alias, canonical] of ALIASES) {
    const token = map.get(canonical)
    if (token) map.set(alias, token)
  }
  writeStorage(OVERLAY_KEY, JSON.stringify(Object.fromEntries(found)))
}

/** Test seam: drop the in-memory map, the persisted overlay and the once-per-session latch. */
export function resetPublicTokens(): void {
  tokens = undefined
  refreshing = undefined
  writeStorage(OVERLAY_KEY, undefined)
}
