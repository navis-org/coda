/**
 * The CATMAID token and server, and the signal that the token is missing or wrong.
 *
 * A near-twin of `cave/credentials.ts` and `neuprint/credentials.ts` rather than a shared
 * module, for the reason recorded there: three backends hold three keys, read by three clients,
 * and the one part worth sharing — the `channel()` idiom — already is.
 *
 * What differs here is **what a token is for**, and it is not what either neighbour would lead
 * you to expect. A public CATMAID serves every `GET` to any origin unauthenticated: the
 * project list, the annotation vocabulary, skeletons, neuropil volumes. What it refuses is
 * `POST`, and it refuses that to a *browser* specifically — CATMAID's core query endpoints are
 * POST-only, Django's CSRF wants a `Referer` matching a trusted origin and a `csrftoken` cookie,
 * and a browser can supply neither: `Referer` is a forbidden header name, and the cookie is
 * `SameSite=Lax`. A token bypasses CSRF entirely, because DRF's token class runs before its
 * session class and never reaches `enforce_csrf`.
 *
 * So on this backend a token is not "credentials for private data" — it is the only way a page
 * can ask a question whose answer is already public. `docs/catmaid_vfb.md` is the write-up and
 * the upstream ask. Until that lands, `client.ts` falls back to a same-origin dev proxy, which
 * is why a missing token is **not** an error here the way it is for CAVE.
 */

import { channel } from '../channel'
import { readStorage, writeStorage } from '../localStore'

const TOKEN_KEY = 'coda.catmaid.token'
const SERVER_KEY = 'coda.catmaid.server'

/**
 * Virtual Fly Brain's public FAFB instance, which is the one Coda ships a dataset node for.
 *
 * Named rather than assumed: CATMAID is *software*, not a service, so unlike neuPrint there is
 * no canonical deployment and unlike CAVE there is no global service that lists them. Every
 * instance is somebody's server, which is also why the Custom node exists.
 */
export const DEFAULT_CATMAID_SERVER = 'https://catmaid-fafb.virtualflybrain.org'

let token: string | undefined
let server: string | undefined
let loaded = false

const authFailure = channel<string>()

function load(): void {
  if (loaded) return
  loaded = true
  token = readStorage(TOKEN_KEY)
  server = readStorage(SERVER_KEY) || undefined
}

export function getToken(): string | undefined {
  load()
  return token
}

/**
 * Store a token, tolerating what people actually paste.
 *
 * CATMAID's own UI presents the token bare, but its documentation and every client show it
 * inside `Authorization: Token <value>` — so both spellings arrive on the clipboard, and
 * storing the prefix would send `Token Token abc…`.
 */
export function setToken(raw: string | undefined): void {
  load()
  const cleaned = raw?.trim().replace(/^Token\s+/i, '')
  token = cleaned || undefined
  writeStorage(TOKEN_KEY, token)
}

/** The configured server, or the default. Trailing slashes are already stripped. */
export function getServer(): string {
  load()
  return server ?? DEFAULT_CATMAID_SERVER
}

/**
 * Name a server, or clear it back to the default with an empty value.
 *
 * A value equal to the default is stored as *unset*, the call `setServer` makes for CAVE and for
 * its reason: the panel shows the resolved server rather than an empty box, so saving an
 * untouched form would otherwise pin today's default into storage and keep it there after the
 * default moved.
 */
export function setServer(raw: string | undefined): void {
  load()
  const cleaned = raw?.trim().replace(/\/+$/, '') || undefined
  server = cleaned === DEFAULT_CATMAID_SERVER ? undefined : cleaned
  writeStorage(SERVER_KEY, server)
}

/** Raised by the client on 401/403 so the UI can offer the fix instead of a bare error. */
export const reportAuthFailure = authFailure.notify
export const subscribeAuthFailure = authFailure.subscribe

/** Test seam: drop everything held in memory and in storage. */
export function resetCredentials(): void {
  loaded = false
  token = undefined
  server = undefined
  writeStorage(TOKEN_KEY, undefined)
  writeStorage(SERVER_KEY, undefined)
}
