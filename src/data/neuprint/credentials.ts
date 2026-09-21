/**
 * The neuPrint token, and the signal that it is missing or wrong.
 *
 * Headless on purpose — `src/data` must not import the store or React — so this is a small
 * observable that the UI subscribes to rather than a hook. It holds two things:
 *
 *  - the token, persisted to `localStorage` because the alternative is signing in (or
 *    re-pasting) every reload. That is a deliberate trade: a credential sits in storage where
 *    any script running in the page can read it. A signed-in one is a seven-day DatasetGateway
 *    key (see `signIn.ts`); a pasted one lives as long as its issuer says. It is never written
 *    into a saved graph, never sent anywhere but a neuPrint host, and `forget()` clears it.
 *    Beside it, for a signed-in token only, the account it was issued to — see `SignInSession`.
 *  - an auth-failure signal, so a 401 from any query can open the connection panel. It is a
 *    separate channel rather than an error type because errors cross the scheduler as
 *    messages, and matching on message text is how that stops working quietly.
 */

import { channel } from '../channel'
import { readStorage, writeStorage } from '../localStore'
import type { SignInSession } from '../signIn'
import { cleanToken, parseStoredSession } from '../signIn'

const TOKEN_KEY = 'coda.neuprint.token'
const SERVER_KEY = 'coda.neuprint.server'
const SESSION_KEY = 'coda.neuprint.session'

let token: string | undefined
let session: SignInSession | undefined
let baseUrlOverride: string | undefined
let loaded = false

const changed = channel()
const authFailure = channel<string>()

function load(): void {
  if (loaded) return
  loaded = true
  token = readStorage(TOKEN_KEY)
  session = token ? parseStoredSession(readStorage(SESSION_KEY)) : undefined
  baseUrlOverride = readStorage(SERVER_KEY) || undefined
}

export function getToken(): string | undefined {
  load()
  return token
}

/**
 * Store a token, cleaned by `cleanToken`.
 *
 * The second argument is what a sign-in knows and a paste cannot: which account this came from.
 * **Omitting it clears the stored session** — CAVE's rule, for CAVE's reason: a pasted token that
 * inherited the last sign-in's email would put somebody else's address under it.
 */
export function setToken(raw: string | undefined, signedIn?: SignInSession): void {
  load()
  token = cleanToken(raw)
  session = token ? signedIn : undefined
  writeStorage(TOKEN_KEY, token)
  writeStorage(SESSION_KEY, session ? JSON.stringify(session) : undefined)
  changed.notify()
}

/** The sign-in behind the token, or undefined where it was pasted or there is none. */
export function getSession(): SignInSession | undefined {
  load()
  return session
}

export function forgetToken(): void {
  setToken(undefined)
}

/**
 * The base URL to fetch instead of working one out, when somebody has named one.
 *
 * `undefined` means "decide for me", which is what an untouched field has always meant and is
 * now a real answer rather than a synonym for the dev proxy: `routesForServer` tries the
 * deployment directly and falls back to the proxy path. Before CORS existed there was nothing
 * to decide, so this held `/neuprint` and an empty field silently became it — which is why
 * clearing the field looked like it reverted rather than like it turned something off.
 */
export function getBaseUrlOverride(): string | undefined {
  load()
  return baseUrlOverride
}

/**
 * Name a base URL, or clear it with an empty value.
 *
 * Trailing slashes are stripped so path joining stays a plain concatenation.
 */
export function setBaseUrl(raw: string | undefined): void {
  load()
  baseUrlOverride = raw?.trim().replace(/\/+$/, '') || undefined
  writeStorage(SERVER_KEY, baseUrlOverride)
  changed.notify()
}

/** Raised by the client on 401/403 so the UI can offer the fix instead of a bare error. */
export const reportAuthFailure = authFailure.notify
export const subscribeAuthFailure = authFailure.subscribe

/** Test seam: drop everything held in memory and in storage. */
export function resetCredentials(): void {
  loaded = false
  token = undefined
  session = undefined
  baseUrlOverride = undefined
  writeStorage(TOKEN_KEY, undefined)
  writeStorage(SESSION_KEY, undefined)
  writeStorage(SERVER_KEY, undefined)
}
