/**
 * CATMAID credentials: a **list of instances**, not one token.
 *
 * The departure from `cave/credentials.ts` and `neuprint/credentials.ts` is deliberate and it is
 * forced by what CATMAID *is*. neuPrint has a canonical deployment and CAVE has a global service;
 * CATMAID is software, so every instance is somebody's server with its own accounts. A token is
 * per user **and** per instance, and one field cannot hold "my VFB token" and "my lab's token" at
 * once — which a single-token store does not merely make awkward, it makes wrong, because
 * whichever was saved last would be sent to both.
 *
 * Three things a row can carry, and the first two are independent:
 *
 *  - **`token`** goes in `X-Authorization: Token …`, which is CATMAID's own header.
 *  - **`httpUser`/`httpPassword`** go in `Authorization: Basic …`, which is the *web server's*.
 *    Those coexist on one request rather than competing, and that is exactly why CATMAID uses a
 *    non-standard header at all — its own middleware says so: "CATMAID uses the `X-Authorization`
 *    HTTP header rather than `Authorization` to prevent conflicts with, e.g., HTTP server basic
 *    authentication." An instance behind nginx basic auth needs both.
 *  - **`server`** is a host pattern, so one row can cover a deployment that serves several
 *    hostnames — `*.virtualflybrain.org` rather than a row per subdomain.
 *
 * **Stored in `localStorage` in the clear**, including the basic-auth password. That is the same
 * standing every other credential here has and the panel says so, but it is worth stating twice
 * for this one: a password is reused across services in a way a scoped API token is not.
 */

import { channel } from '../channel'
import { readStorage, writeStorage } from '../localStore'

const INSTANCES_KEY = 'coda.catmaid.instances.v1'

/**
 * Virtual Fly Brain's public FAFB instance, and the default a Custom node starts on.
 *
 * Named rather than assumed: CATMAID has no canonical deployment the way neuPrint does, and no
 * service that lists them the way CAVE does. This is a *default server*, not a credential — the
 * instance list below is only about credentials, and a row is needed for this host only if the
 * deployment asks for one.
 */
export const DEFAULT_CATMAID_SERVER = 'https://catmaid-fafb.virtualflybrain.org'

/**
 * Virtual Fly Brain's L1 larval instance — the same organisation, a **different server**.
 *
 * Beside the constant above rather than derived from it, because that is the fact worth seeing
 * in one place: the two datasets Coda ships a CATMAID node for are two installations, and
 * `registry.ts` mints a separate `CatmaidSource` for each. They share nothing — not project
 * ids, not annotation ids, and **not a token**. Both are project `1` on their own server, which
 * is exactly why a project id is never carried across instances.
 *
 * This comment used to say the two "share a credential row — `*.virtualflybrain.org` covers
 * both, which is what host patterns are for". That is now advice that breaks things. A CATMAID
 * token is per user *and* per instance, so a wildcard row carrying one instance's token sends it
 * to all eight of VFB's, where seven answer `401 Invalid token` — and a token the user typed is
 * never dropped, so those seven stop working rather than falling back to the published token
 * they would otherwise use. One exact row per instance is the shape that works. The advice was
 * harmless while none of these hosts worked without a credential anyway; publishing tokens is
 * what made it wrong.
 *
 * Neither needs a credential to read. See `docs/catmaid_vfb.md`.
 */
export const L1_CATMAID_SERVER = 'https://l1em.catmaid.virtualflybrain.org'

/** One configured instance: which hosts it covers, and what to send them. */
export interface CatmaidInstance {
  /**
   * A host pattern — `catmaid.example.org`, or `*.example.org` for a whole deployment.
   *
   * Matched against the request's **host**, because a credential is a property of a host: a
   * scheme, a port, a path and a trailing slash are all accepted when typing and none of them
   * take part in the match. A CATMAID served from a subpath is therefore covered by its host's
   * row, which is right — the same nginx and the same accounts are in front of both.
   */
  server: string
  /** CATMAID's own API token, sent as `X-Authorization: Token …`. */
  token?: string
  /** HTTP Basic user, for an instance behind web-server auth. Sent as `Authorization: Basic …`. */
  httpUser?: string
  httpPassword?: string
}

let instances: CatmaidInstance[] | undefined
const authFailure = channel<string>()

function load(): CatmaidInstance[] {
  if (instances) return instances
  instances = []
  try {
    const raw = readStorage(INSTANCES_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        instances = parsed
          .filter((entry): entry is CatmaidInstance => {
            return Boolean(entry) && typeof (entry as CatmaidInstance).server === 'string'
          })
          .map(cleanInstance)
          .filter((entry) => entry.server !== '')
      }
    }
  } catch {
    // Corrupt: start from an empty list rather than failing every request. Losing a stored
    // credential is recoverable by retyping it; refusing to load is not.
    instances = []
  }
  return instances
}

/**
 * Normalise what somebody typed into a host pattern.
 *
 * Accepts `https://host/`, `host/`, `host:8080/catmaid` and `*.example.org` alike, because all
 * four are things people paste — the first is what a browser's address bar gives you and the
 * last is what this feature is for. Everything but the host is discarded; see `server` above.
 */
export function hostPattern(raw: string): string {
  let text = raw.trim().toLowerCase()
  if (!text) return ''
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  // Strip any path, query or fragment, then any port and any credentials-in-URL.
  text = text.split(/[/?#]/, 1)[0] ?? ''
  text = text.split('@').pop() ?? ''
  text = text.replace(/:\d+$/, '')
  return text
}

/** A row with its fields normalised and its empty optionals dropped. */
function cleanInstance(entry: CatmaidInstance): CatmaidInstance {
  const token = entry.token?.trim().replace(/^Token\s+/i, '')
  const httpUser = entry.httpUser?.trim()
  const httpPassword = entry.httpPassword
  return {
    server: hostPattern(entry.server),
    ...(token ? { token } : {}),
    ...(httpUser ? { httpUser } : {}),
    ...(httpUser && httpPassword ? { httpPassword } : {}),
  }
}

/**
 * Whether a host pattern covers a host.
 *
 * `*` stands for one or more characters, so `*.example.org` covers `a.example.org` and
 * `a.b.example.org` but **not** `example.org` itself or `notexample.org` — the literal dot is
 * required, which is what stops a pattern reaching a host somebody else registered. A pattern
 * with no literal characters at all is refused outright rather than matching everything: `*` is
 * an easy thing to type and would send a token to whatever host a graph happened to name.
 */
export function matchesHost(pattern: string, host: string): boolean {
  const cleanedPattern = hostPattern(pattern)
  const cleanedHost = hostPattern(host)
  if (!cleanedPattern || !cleanedHost) return false
  if (!cleanedPattern.includes('*')) return cleanedPattern === cleanedHost
  if (!/[a-z0-9]/.test(cleanedPattern.replace(/\*/g, ''))) return false
  const source = cleanedPattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+')
  return new RegExp(`^${source}$`).test(cleanedHost)
}

/** How specific a pattern is, for ranking two that both match. Exact beats wildcard. */
function specificity(pattern: string): number {
  const literal = pattern.replace(/\*/g, '').length
  return pattern.includes('*') ? literal : literal + 1000
}

/**
 * The credentials for a server URL, or undefined where none are configured.
 *
 * **Most specific wins**, so an exact host beats a wildcard and a longer wildcard beats a
 * shorter one. That ordering is what lets somebody hold `*.example.org` for a lab and one exact
 * row for the machine inside it that needs a different account, which is the ordinary shape of
 * this problem and would otherwise depend on list order.
 */
export function credentialsFor(server: string): CatmaidInstance | undefined {
  const host = hostPattern(server)
  if (!host) return undefined
  let best: CatmaidInstance | undefined
  let bestScore = -1
  for (const entry of load()) {
    if (!matchesHost(entry.server, host)) continue
    const score = specificity(entry.server)
    if (score > bestScore) {
      best = entry
      bestScore = score
    }
  }
  return best
}

/** The configured instances, in the order they were saved. */
export function listInstances(): CatmaidInstance[] {
  return load().map((entry) => ({ ...entry }))
}

/**
 * Replace the list.
 *
 * Rows with no host are dropped, and so are rows carrying no credential at all — an instance
 * with neither a token nor a user is the same as not having configured it, and keeping it would
 * put an empty row in front of somebody on every visit.
 */
export function setInstances(next: readonly CatmaidInstance[]): void {
  instances = next
    .map(cleanInstance)
    .filter((entry) => entry.server !== '' && (entry.token || entry.httpUser))
  writeStorage(INSTANCES_KEY, instances.length ? JSON.stringify(instances) : undefined)
}

/** The `Authorization` header value for an instance behind web-server basic auth. */
export function basicAuthHeader(entry: CatmaidInstance | undefined): string | undefined {
  if (!entry?.httpUser) return undefined
  const raw = `${entry.httpUser}:${entry.httpPassword ?? ''}`
  // `btoa` is DOM-ish but present in Node ≥16 too, so this stays usable outside a browser.
  return `Basic ${btoa(unescape(encodeURIComponent(raw)))}`
}

/** Raised by the client on 401/403 so the UI can offer the fix instead of a bare error. */
export const reportAuthFailure = authFailure.notify
export const subscribeAuthFailure = authFailure.subscribe

/** Test seam: drop everything held in memory and in storage. */
export function resetCredentials(): void {
  instances = undefined
  writeStorage(INSTANCES_KEY, undefined)
}
