/**
 * The CAVE token, and the signal that it is missing or wrong.
 *
 * Deliberately a near-twin of `neuprint/credentials.ts` rather than a shared module: the two
 * hold different keys, are read by different clients, and the one thing that would be worth
 * sharing — the `channel()` idiom — already is. What is *not* duplicated is the reasoning, so
 * read that file for why a token lives in `localStorage` and why an auth failure travels on its
 * own channel instead of as an error message.
 *
 * One difference worth stating. neuPrint's client has to *discover* how to reach a deployment,
 * because that server historically sent no CORS headers and a browser reports a refusal and a
 * dead host identically. CAVE needs none of that: every service Coda calls answers a browser
 * directly, with `Access-Control-Allow-Origin` present **on its 401s too** — which is the part
 * that matters here, since the channel below only works if the browser lets us read the status.
 * Verified against `global.daf-apis.com` and `prod.flywire-daf.com`. So there is no route
 * memory, no proxy fallback, and no base-URL override: one server, named or defaulted.
 */

import { channel } from '../channel'
import { readStorage, writeStorage } from '../localStore'

const TOKEN_KEY = 'coda.cave.token'
const SERVER_KEY = 'coda.cave.server'
const SESSION_KEY = 'coda.cave.session'

/**
 * Where the datastack listing lives when nobody has said otherwise.
 *
 * CAVE splits into a *global* service that knows which datastacks exist and where each one is
 * served from, and a per-datastack `local_server` that answers the actual queries. Only the
 * global one is configurable, because the other is discovered — see `datastacks.ts`.
 */
export const DEFAULT_CAVE_SERVER = 'https://global.daf-apis.com'

/**
 * What is known about a token that was *signed in for* rather than pasted.
 *
 * Two facts, one key, and both are about telling one credential from another rather than about
 * using it. A CAVE token is 32 characters that look like every other CAVE token, and the whole
 * reason a sign-in exists per service is that somebody may hold one Google account here and a
 * different one at neuPrint — so the account it was issued to is the label that makes a wrong
 * one visible. The date is the other half of that: `middle_auth` issues a login token with a
 * seven-day life, so "signed in a fortnight ago" is the answer to why a run started failing.
 *
 * Deliberately **not** an expiry. The seven days is a server-side default that no response
 * states, and a countdown Coda computed from a constant it copied would keep claiming a token
 * was good after the deployment shortened it — the 401 is the only thing that actually knows.
 */
export interface CaveSession {
  /** The Google account the token was issued to, where the auth server would say. */
  email?: string
  /** When the sign-in happened, ms since the epoch. */
  at: number
}

let token: string | undefined
let server: string | undefined
let session: CaveSession | undefined
let loaded = false

const authFailure = channel<string>()

function load(): void {
  if (loaded) return
  loaded = true
  token = readStorage(TOKEN_KEY)
  server = readStorage(SERVER_KEY) || undefined
  session = readSession()
}

/** A stored session, or undefined for absent, corrupt, or written by some older shape. */
function readSession(): CaveSession | undefined {
  const raw = readStorage(SESSION_KEY)
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return undefined
    const { email, at } = parsed as { email?: unknown; at?: unknown }
    if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
    return typeof email === 'string' && email ? { email, at } : { at }
  } catch {
    // Corrupt: the token is still usable, and a missing label is a worse label rather than a
    // reason to be signed out.
    return undefined
  }
}

export function getToken(): string | undefined {
  load()
  return token
}

/**
 * Store a token. Whitespace is stripped and a `Bearer ` prefix tolerated, for the reason the
 * neuPrint field tolerates one: the obvious thing to do with a token on a web page is paste
 * whatever was on the clipboard.
 *
 * The second argument is what the sign-in flow knows and a paste cannot: which account this
 * came from. **Omitting it clears the stored session**, which is the important half — a pasted
 * token that inherited the last sign-in's email would put somebody else's address under a
 * credential that is not theirs, and that label is the only thing on screen saying which of two
 * Google accounts is in use.
 */
export function setToken(raw: string | undefined, signedIn?: CaveSession): void {
  load()
  const cleaned = raw?.trim().replace(/^Bearer\s+/i, '')
  token = cleaned || undefined
  writeStorage(TOKEN_KEY, token)
  session = token && signedIn ? signedIn : undefined
  writeStorage(SESSION_KEY, session ? JSON.stringify(session) : undefined)
}

/** The sign-in behind the stored token, or undefined where it was pasted. */
export function getSession(): CaveSession | undefined {
  load()
  return token ? session : undefined
}

/** The configured global server, or the default. Trailing slashes are already stripped. */
export function getServer(): string {
  load()
  return server ?? DEFAULT_CAVE_SERVER
}

/**
 * Name a global server, or clear it back to the default with an empty value.
 *
 * A value equal to the default is stored as *unset*, deliberately. The panel shows the resolved
 * server rather than an empty box — it is worth being able to see which deployment you are on —
 * so saving an untouched form would otherwise pin today's default into storage and keep it
 * there after the default moved.
 */
export function setServer(raw: string | undefined): void {
  load()
  const cleaned = raw?.trim().replace(/\/+$/, '') || undefined
  server = cleaned === DEFAULT_CAVE_SERVER ? undefined : cleaned
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
  session = undefined
  writeStorage(TOKEN_KEY, undefined)
  writeStorage(SERVER_KEY, undefined)
  writeStorage(SESSION_KEY, undefined)
}
