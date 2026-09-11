/**
 * CAVE tokens — **one per deployment** — and the signal that one is missing or wrong.
 *
 * A near-twin of `neuprint/credentials.ts` in *where* a token lives (read that file for why it is
 * `localStorage` and why an auth failure travels on its own channel), and of
 * `catmaid/credentials.ts` in being a list. Not a shared module with either: the three hold
 * different keys, are read by different clients, and the one thing worth sharing — the
 * `channel()` idiom — already is.
 *
 * **Why a list.** A CAVE token is issued by one deployment's `middle_auth` and means nothing to
 * another: `global.daf-apis.com` (FlyWire, BANC, MICrONS) and `global.brain-wire-test.org` (H01)
 * are two login services with two account tables. One field held the token for whichever
 * deployment the user had pointed a single global setting at, so using H01 meant switching the
 * setting — which dropped FlyWire's datastacks from the session — and a token kept for one would
 * have been sent to the other. So a row per deployment, keyed on the normalised global server,
 * and a request names its deployment rather than being matched to one by host; see
 * `deployments.ts` for why matching by host is wrong for CAVE in particular.
 *
 * One difference from neuPrint worth stating. neuPrint's client has to *discover* how to reach a
 * deployment, because that server historically sent no CORS headers and a browser reports a
 * refusal and a dead host identically. CAVE needs none of that: every service Coda calls answers a
 * browser directly, with `Access-Control-Allow-Origin` present **on its 401s too** — which is the
 * part that matters here, since the channel below only works if the browser lets us read the
 * status. Verified against `global.daf-apis.com`, `prod.flywire-daf.com` and — for its `auth_info`
 * — `global.brain-wire-test.org`.
 */

import { channel } from '../channel'
import { readStorage, writeStorage } from '../localStore'
import { normaliseCaveServer } from './deployments'

const CREDENTIALS_KEY = 'coda.cave.credentials.v1'

/*
 * The single-deployment layout this replaced: one token, one global server, one session label.
 * Read exactly once, to carry a stored token into a row for the server it was stored beside, and
 * then removed — a second reader of these keys is how a Forget in the panel would come back on the
 * next reload.
 */
const LEGACY_TOKEN_KEY = 'coda.cave.token'
const LEGACY_SERVER_KEY = 'coda.cave.server'
const LEGACY_SESSION_KEY = 'coda.cave.session'
const LEGACY_KEYS = [LEGACY_TOKEN_KEY, LEGACY_SERVER_KEY, LEGACY_SESSION_KEY]

function removeLegacy(): void {
  for (const key of LEGACY_KEYS) writeStorage(key, undefined)
}

/**
 * What is known about a token that was *signed in for* rather than pasted.
 *
 * Two facts, and both are about telling one credential from another rather than about using it. A
 * CAVE token is 32 characters that look like every other CAVE token, and one person routinely
 * holds a different Google account at each deployment — so the account it was issued to is the
 * label that makes a wrong one visible. The date is the other half: `middle_auth` issues a login
 * token with a seven-day life, so "signed in a fortnight ago" is the answer to why a run started
 * failing.
 *
 * Deliberately **not** an expiry. The seven days is a server-side default that no response
 * states, and a countdown Coda computed from a constant it copied would keep claiming a token was
 * good after the deployment shortened it — the 401 is the only thing that actually knows.
 */
export interface CaveSession {
  /** The Google account the token was issued to, where the auth server would say. */
  email?: string
  /** When the sign-in happened, ms since the epoch. */
  at: number
}

/** One deployment's credential. */
export interface CaveCredential {
  /** The global server, normalised to an origin — see `normaliseCaveServer`. */
  server: string
  token: string
  /** Present only where the token came from a sign-in. See `setToken`. */
  session?: CaveSession
}

let rows: CaveCredential[] | undefined

const authFailure = channel<string>()

function load(): CaveCredential[] {
  if (rows) return rows
  rows = readRows() ?? migrateLegacy()
  return rows
}

/** The stored list, or undefined where nothing has been written in this layout yet. */
function readRows(): CaveCredential[] | undefined {
  const raw = readStorage(CREDENTIALS_KEY)
  if (!raw) return undefined
  const parsed = parseJson(raw)
  // Corrupt: an empty list rather than a failure on every request. A lost token is recovered by
  // signing in again; refusing to load is not recoverable from inside the app.
  if (!Array.isArray(parsed)) return []
  return parsed.map(cleanRow).filter((row): row is CaveCredential => row !== undefined)
}

/** A stored row with its fields checked, or undefined for anything that is not one. */
function cleanRow(entry: unknown): CaveCredential | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const { server, token, session } = entry as Record<string, unknown>
  if (typeof server !== 'string' || typeof token !== 'string') return undefined
  const cleaned = cleanToken(token)
  if (!cleaned) return undefined
  return { server: normaliseCaveServer(server), token: cleaned, session: readSession(session) }
}

/**
 * Carry the single-token layout into a row, once.
 *
 * The token goes to the server it was stored beside — which for nearly everybody is the default,
 * since the setting was a field somebody had to go out of their way to change. Written in the new
 * layout and the old keys removed in the same step, so this runs at most once per browser.
 */
function migrateLegacy(): CaveCredential[] {
  const legacyToken = readStorage(LEGACY_TOKEN_KEY)
  const legacyServer = readStorage(LEGACY_SERVER_KEY)
  const legacySession = readStorage(LEGACY_SESSION_KEY)
  if ([legacyToken, legacyServer, legacySession].every((v) => v === undefined)) return []
  const token = cleanToken(legacyToken)
  const migrated: CaveCredential[] = token
    ? [
        {
          server: normaliseCaveServer(legacyServer),
          token,
          session: readSession(parseJson(legacySession)),
        },
      ]
    : []
  persist(migrated)
  removeLegacy()
  return migrated
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** A stored session, or undefined for absent, corrupt, or written by some older shape. */
function readSession(value: unknown): CaveSession | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { email, at } = value as { email?: unknown; at?: unknown }
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  return typeof email === 'string' && email ? { email, at } : { at }
}

/**
 * Whitespace stripped and a `Bearer ` prefix tolerated, for the reason the neuPrint field
 * tolerates one: the obvious thing to do with a token on a web page is paste whatever was on the
 * clipboard.
 */
export function cleanToken(raw: string | undefined): string | undefined {
  return raw?.trim().replace(/^Bearer\s+/i, '') || undefined
}

function persist(next: readonly CaveCredential[]): void {
  writeStorage(CREDENTIALS_KEY, next.length ? JSON.stringify(next) : undefined)
}

function rowFor(server: string): CaveCredential | undefined {
  const deployment = normaliseCaveServer(server)
  return load().find((row) => row.server === deployment)
}

/** The token for a deployment, or undefined where none is held. */
export function getToken(server: string): string | undefined {
  return rowFor(server)?.token
}

/**
 * Store a deployment's token, or forget it with an empty value.
 *
 * The third argument is what the sign-in flow knows and a paste cannot: which account this came
 * from. **Omitting it clears the stored session**, which is the important half — a pasted token
 * that inherited the last sign-in's email would put somebody else's address under a credential
 * that is not theirs, and that label is the only thing on screen saying which Google account is
 * in use.
 *
 * A row keeps its place in the list when it is replaced, so the panel does not reorder under
 * somebody signing in again.
 */
export function setToken(
  server: string,
  raw: string | undefined,
  signedIn?: CaveSession,
): void {
  const deployment = normaliseCaveServer(server)
  const token = cleanToken(raw)
  const current = load()
  const at = current.findIndex((row) => row.server === deployment)
  const next = current.filter((row) => row.server !== deployment)
  if (token) {
    next.splice(at === -1 ? next.length : at, 0, {
      server: deployment,
      token,
      session: signedIn,
    })
  }
  rows = next
  persist(next)
}

/** The sign-in behind a deployment's token, or undefined where it was pasted or there is none. */
export function getSession(server: string): CaveSession | undefined {
  return rowFor(server)?.session
}

/** Every deployment a token is held for, in the order they were first saved. */
export function listCredentials(): CaveCredential[] {
  return load().map((row) => ({ ...row }))
}

/** Raised by the client on 401/403 so the UI can offer the fix instead of a bare error. */
export const reportAuthFailure = authFailure.notify
export const subscribeAuthFailure = authFailure.subscribe

/** Test seam: drop everything held in memory and in storage, the legacy layout included. */
export function resetCredentials(): void {
  rows = undefined
  writeStorage(CREDENTIALS_KEY, undefined)
  removeLegacy()
}
