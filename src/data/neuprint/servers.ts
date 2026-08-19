/**
 * Which neuPrint deployment a node talks to, and how a browser can reach it.
 *
 * Two different things wear the word "server" in this app and conflating them is the trap:
 *
 *  - a **deployment** — `https://neuprint.janelia.org`, what a scientist means by "which
 *    neuPrint"; it is what the Custom neuPrint node asks for.
 *  - a **base URL** — the same-origin path the browser actually fetches, `/neuprint`, because
 *    neuPrint sends no CORS headers and a direct request is blocked before it is sent.
 *
 * A node stores the deployment, since that is the durable, meaningful thing to save in a graph
 * file; this module maps it to a base URL at request time. The default deployment maps to
 * whatever Sources → Server is set to (the configured proxy). Anything else routes through the
 * generic `/np/<deployment>/…` proxy, which the vite plugin in `vite.config.ts` serves in
 * development. A static deploy has neither, and `client.ts` already recognises an empty-bodied
 * 404 on a same-origin path and blames the missing proxy rather than the server.
 */

import { getBaseUrl } from './credentials'

/** The public Janelia deployment: what "neuPrint" means unless someone says otherwise. */
export const DEFAULT_SERVER = 'https://neuprint.janelia.org'

/** Path prefix of the generic per-deployment proxy. */
export const PROXY_PREFIX = '/np'

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

/**
 * The base URL to fetch for a deployment.
 *
 * The default deployment defers to the configured base URL, so Sources → Server keeps working
 * and an existing graph keeps hitting the same proxy it always did. Everything else goes
 * through the generic proxy — encoded, because the deployment contains `://`.
 */
export function baseUrlForServer(server: string | undefined): string {
  const deployment = normaliseServer(server)
  if (deployment === DEFAULT_SERVER) return getBaseUrl()
  return `${PROXY_PREFIX}/${encodeURIComponent(deployment)}`
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
