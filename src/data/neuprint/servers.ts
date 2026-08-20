/**
 * Which neuPrint deployment a node talks to, and how a browser can reach it.
 *
 * Two different things wear the word "server" in this app and conflating them is the trap:
 *
 *  - a **deployment** — `https://neuprint.janelia.org`, what a scientist means by "which
 *    neuPrint"; it is what the Custom neuPrint node asks for.
 *  - a **route** — the URL the browser actually fetches. Where the deployment sends CORS
 *    headers that is the deployment itself; where it does not, it has to be a same-origin
 *    path that relays the request.
 *
 * A node stores the deployment, since that is the durable, meaningful thing to save in a graph
 * file; this module maps it to the routes worth trying, in order.
 *
 * **Direct comes first, and the proxy is the fallback.** That is the reverse of how this
 * started, and it changed when Janelia enabled CORS: `neuprint-test.janelia.org` answers a
 * preflight with 204 and carries `Access-Control-Allow-Origin: *` on every response including
 * its errors, so a browser can call it with no relay at all. The public deployment does not do
 * this *yet*, which is exactly why the proxy has to stay — and why the choice cannot be a
 * setting. A browser reports a CORS refusal as an opaque `TypeError` indistinguishable from a
 * dead host, so "does direct work here?" is only answerable by trying; `client.ts` tries, and
 * remembers the answer per deployment. Same trade, and the same reasoning, as
 * `data/precomputed/transport.ts` makes for the mesh buckets.
 */

import { getBaseUrlOverride } from './credentials'

/** The public Janelia deployment: what "neuPrint" means unless someone says otherwise. */
export const DEFAULT_SERVER = 'https://neuprint.janelia.org'

/** Path prefix of the generic per-deployment proxy. */
export const PROXY_PREFIX = '/np'

/**
 * Where the dev proxy relays the *default* deployment.
 *
 * A path of its own rather than `/np/<encoded default>` because it predates the generic one and
 * every existing `vite.config.ts`, README and bug report names it.
 */
export const DEFAULT_PROXY_PATH = '/neuprint'

/** `direct` is the deployment itself and needs CORS; `proxy` is a same-origin relay. */
export type RouteKind = 'direct' | 'proxy'

/** One way of reaching a deployment. `base` is concatenated with an `/api/…` path. */
export interface Route {
  readonly base: string
  readonly kind: RouteKind
}

/**
 * Canonical form of a deployment URL.
 *
 * Tolerant on input because the obvious thing to do is paste whatever was in the address bar:
 * a bare host, a trailing slash, or a full URL with a path all mean the same deployment. An
 * empty value means the default rather than an error — an empty field should behave like an
 * untouched one.
 */
export function normaliseServer(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_SERVER
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    // Path and query are dropped: neuPrint's API lives at the origin, and keeping a stray
    // `/results` from a pasted link would produce 404s that look like a dead server.
    return url.origin
  } catch {
    return DEFAULT_SERVER
  }
}

/** The same-origin path that relays a deployment, for the dev proxy and any equivalent. */
export function proxyPathForServer(server: string | undefined): string {
  const deployment = normaliseServer(server)
  return deployment === DEFAULT_SERVER
    ? DEFAULT_PROXY_PATH
    : `${PROXY_PREFIX}/${encodeURIComponent(deployment)}`
}

/**
 * The routes worth trying for a deployment, best first.
 *
 * An explicit **Connections → Base URL** override collapses this to one route and disables the
 * fallback: somebody who named a base URL has said where the request goes, and quietly trying
 * somewhere else would make a wrong entry look like it worked. The override applies to the
 * default deployment only, because a Custom node names its own origin — letting the override
 * capture that too would send one deployment's queries to another's proxy.
 */
export function routesForServer(server: string | undefined): readonly Route[] {
  const deployment = normaliseServer(server)
  const override = deployment === DEFAULT_SERVER ? getBaseUrlOverride() : undefined
  if (override) return [{ base: override, kind: override.startsWith('/') ? 'proxy' : 'direct' }]
  return [
    { base: deployment, kind: 'direct' },
    { base: proxyPathForServer(deployment), kind: 'proxy' },
  ]
}

/** Source id for a deployment. The default keeps the bare `neuprint` id that graphs already use. */
export function sourceIdForServer(server: string | undefined): string {
  const deployment = normaliseServer(server)
  return deployment === DEFAULT_SERVER ? 'neuprint' : `neuprint:${deployment}`
}

/** Human-readable host, for node captions and error messages. */
export function serverLabel(server: string | undefined): string {
  return normaliseServer(server).replace(/^https?:\/\//, '')
}
