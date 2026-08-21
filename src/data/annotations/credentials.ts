/**
 * SeaTable account tokens, one per host.
 *
 * Per **host** rather than one token, because SeaTable is a product rather than a service:
 * FlyTable at `flytable.mrc-lmb.cam.ac.uk` and `cloud.seatable.io` are two deployments of it
 * with unrelated accounts, and a graph can plausibly read a base from each. Same storage trade
 * and same auth-failure channel as the other credential stores — read `neuprint/credentials.ts`
 * for why a token lives in `localStorage` and why a 401 travels on its own channel rather than
 * as an error message.
 *
 * **An account token, not a base API token**, and that distinction cost four failed probes. The
 * documented "app access token" exchange takes a token minted *for one base*; an account token
 * answers `Permission denied` there and works everywhere else. Verified against FlyTable: an
 * account token pings, lists workspaces, and mints per-base access tokens — which is the better
 * credential to ask for anyway, since one of them reaches every base the account can see instead
 * of one per base somebody has to go and create.
 */

import { channel } from '../channel'
import { readStorage, writeStorage } from '../localStore'

/** The two deployments Coda ships a node for. Any other is reachable by typing its host. */
export const SEATABLE_HOSTS = {
  flytable: 'https://flytable.mrc-lmb.cam.ac.uk',
  seatable: 'https://cloud.seatable.io',
} as const

const KEY_PREFIX = 'coda.seatable.token.'

const authFailure = channel<string>()

/** Trailing slashes off and a scheme on, so one deployment is one string however it was typed. */
export function normaliseHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '')
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

function keyFor(host: string): string {
  return `${KEY_PREFIX}${normaliseHost(host)}`
}

/**
 * The tokens held in memory, backed by storage rather than read from it.
 *
 * `writeStorage` is best-effort by design — `src/data` has to work where there is no
 * `localStorage` at all — so a store that read it back on every call would lose the token it had
 * just been given under Node and in a private window. Same shape as `neuprint/credentials.ts`,
 * where the module variable is the source of truth and storage is only how it survives a reload.
 */
const tokens = new Map<string, string | undefined>()

export function getToken(host: string): string | undefined {
  const key = keyFor(host)
  if (!tokens.has(key)) tokens.set(key, readStorage(key) || undefined)
  return tokens.get(key)
}

/** Store a token for one host. Whitespace and a `Token ` prefix are tolerated on paste. */
export function setToken(host: string, raw: string | undefined): void {
  const cleaned = raw?.trim().replace(/^Token\s+/i, '') || undefined
  tokens.set(keyFor(host), cleaned)
  writeStorage(keyFor(host), cleaned)
}

/** Raised on 401/403 so the Connections panel can offer the fix. */
export const reportAuthFailure = authFailure.notify
export const subscribeAuthFailure = authFailure.subscribe

/** Test seam: clears both shipped hosts, plus anything else a test named. */
export function resetSeaTableCredentials(hosts: readonly string[] = []): void {
  for (const host of [...Object.values(SEATABLE_HOSTS), ...hosts]) {
    writeStorage(keyFor(host), undefined)
  }
  tokens.clear()
}
