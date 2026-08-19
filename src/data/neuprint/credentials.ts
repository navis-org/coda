/**
 * The neuPrint token, and the signal that it is missing or wrong.
 *
 * Headless on purpose — `src/data` must not import the store or React — so this is a small
 * observable that the UI subscribes to rather than a hook. It holds two things:
 *
 *  - the token, persisted to `localStorage` because the alternative is re-pasting a JWT
 *    every reload. That is a deliberate trade: a year-long credential sits in storage where
 *    any script running in the page can read it. It is never written into a saved graph,
 *    never sent anywhere but the configured neuPrint host, and `forget()` clears it.
 *  - an auth-failure signal, so a 401 from any query can open the connection panel. It is a
 *    separate channel rather than an error type because errors cross the scheduler as
 *    messages, and matching on message text is how that stops working quietly.
 */

const TOKEN_KEY = 'coda.neuprint.token'
const SERVER_KEY = 'coda.neuprint.server'

/** Where the dev proxy in `vite.config.ts` forwards from. */
export const DEFAULT_BASE_URL = '/neuprint'

let token: string | undefined
let baseUrl: string = DEFAULT_BASE_URL
let loaded = false

const tokenListeners = new Set<() => void>()
const authFailureListeners = new Set<(message: string) => void>()

/** localStorage is undefined under Node + jsdom without `--localstorage-file`. */
function readStorage(key: string): string | undefined {
  try {
    return window.localStorage?.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function writeStorage(key: string, value: string | undefined): void {
  try {
    if (value) window.localStorage?.setItem(key, value)
    else window.localStorage?.removeItem(key)
  } catch {
    // Storage disabled or full. The in-memory value still works for this session.
  }
}

function load(): void {
  if (loaded) return
  loaded = true
  token = readStorage(TOKEN_KEY)
  baseUrl = readStorage(SERVER_KEY) || DEFAULT_BASE_URL
}

export function getToken(): string | undefined {
  load()
  return token
}

/**
 * Store a token. Whitespace is stripped and a `Bearer ` prefix tolerated, because the
 * obvious thing to do with a token from a web page is paste whatever was on the clipboard.
 */
export function setToken(raw: string | undefined): void {
  load()
  const cleaned = raw?.trim().replace(/^Bearer\s+/i, '')
  token = cleaned || undefined
  writeStorage(TOKEN_KEY, token)
  for (const listener of tokenListeners) listener()
}

export function forgetToken(): void {
  setToken(undefined)
}

export function getBaseUrl(): string {
  load()
  return baseUrl
}

/** Trailing slashes are stripped so path joining stays a plain concatenation. */
export function setBaseUrl(raw: string | undefined): void {
  load()
  baseUrl = (raw?.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL) as string
  writeStorage(SERVER_KEY, baseUrl === DEFAULT_BASE_URL ? undefined : baseUrl)
  for (const listener of tokenListeners) listener()
}

/** Raised by the client on 401/403 so the UI can offer the fix instead of a bare error. */
export function reportAuthFailure(message: string): void {
  for (const listener of authFailureListeners) listener(message)
}

export function subscribeAuthFailure(listener: (message: string) => void): () => void {
  authFailureListeners.add(listener)
  return () => authFailureListeners.delete(listener)
}

/** Test seam: drop everything held in memory and in storage. */
export function resetCredentials(): void {
  loaded = false
  token = undefined
  baseUrl = DEFAULT_BASE_URL
  writeStorage(TOKEN_KEY, undefined)
  writeStorage(SERVER_KEY, undefined)
}
