/**
 * The GitHub token, for putting a workflow in a gist.
 *
 * The third credential in the app, after the neuPrint token and the assistant's API key, and it
 * follows their rules exactly: it lives in `localStorage` on this machine, it is never written
 * into a saved graph or an export, it is never sent anywhere but `api.github.com`, and
 * `forgetGithubToken` is the way out. Storage is readable by any script running in the page,
 * which is the same trade the other two already make and is stated in the panel rather than
 * buried here.
 *
 * **A token is only needed to *write*.** Reading a gist is an unauthenticated `GET`, so every
 * `gh://` link opens for everyone whether or not anybody has pasted anything — which is what
 * makes a shared link work for a recipient who has never opened Connections. The token buys the
 * one-click *creation* of that link and nothing else.
 *
 * **Only the `gist` scope is asked for.** A classic token with `gist` alone cannot read a
 * repository, cannot push, and cannot see private code; a fine-grained token needs the Gists
 * permission set to read-and-write. The panel says both, because the obvious thing to do when a
 * page asks for a GitHub token is to tick everything.
 *
 * The login is cached beside the token because "is this gist mine?" is asked every time the
 * share dialog opens, and the answer decides whether pressing Share updates the existing gist
 * or litters a new one. It is a *cache*, not a second credential: it is cleared with the token
 * and re-fetched whenever it is missing.
 */

import { channel } from '../channel'
import { readStorage, writeStorage } from '../localStore'

const TOKEN_KEY = 'coda.github.token'
const LOGIN_KEY = 'coda.github.login'

let token: string | undefined
let login: string | undefined
let loaded = false

const changed = channel()
const authFailure = channel<string>()

function load(): void {
  if (loaded) return
  loaded = true
  token = readStorage(TOKEN_KEY)
  login = readStorage(LOGIN_KEY)
}

export function getGithubToken(): string | undefined {
  load()
  return token
}

/**
 * Store a token.
 *
 * Whitespace stripped and a `Bearer ` prefix tolerated, for the same reason the neuPrint field
 * does it: the obvious thing to do with a token from a web page is paste whatever was on the
 * clipboard. Changing the token drops the cached login — the new one may be somebody else's.
 */
export function setGithubToken(raw: string | undefined): void {
  load()
  const cleaned = raw?.trim().replace(/^Bearer\s+/i, '')
  const next = cleaned || undefined
  if (next !== token) setGithubLogin(undefined)
  token = next
  writeStorage(TOKEN_KEY, token)
  changed.notify()
}

export function forgetGithubToken(): void {
  setGithubToken(undefined)
}

/** Who the stored token belongs to, if it has been asked. A cache, not a credential. */
export function getGithubLogin(): string | undefined {
  load()
  return login
}

export function setGithubLogin(raw: string | undefined): void {
  load()
  login = raw?.trim() || undefined
  writeStorage(LOGIN_KEY, login)
}

export const subscribeGithubChanged = changed.subscribe

/** Raised on a 401 so the panel can open on the field that needs attention. */
export const reportGithubAuthFailure = authFailure.notify
export const subscribeGithubAuthFailure = authFailure.subscribe

/** Test seam: drop everything held in memory and in storage. */
export function resetGithubCredentials(): void {
  loaded = false
  token = undefined
  login = undefined
  writeStorage(TOKEN_KEY, undefined)
  writeStorage(LOGIN_KEY, undefined)
}
