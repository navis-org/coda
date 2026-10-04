/**
 * The Clio token: one, for the one Clio store.
 *
 * A **ClioStore token** from clio.janelia.org/settings, sent as `Bearer`. The settings page and
 * clio-py's token file both hand it over as a JSON document, `{"token": "…"}`, so a paste is
 * accepted either way — clio-py's `_unwrap_token` rule. Same storage trade and same auth-failure
 * channel as the other stores; see `neuprint/credentials.ts`.
 */

import { channel } from '../channel'
import { readStorage, writeStorage } from '../localStore'
import { cleanToken } from '../signIn'
import type { StoredSignIn } from '../signIns'

const KEY = 'coda.clio.token'

const authFailure = channel<string>()

let token: string | undefined
let loaded = false

export function getClioToken(): string | undefined {
  if (!loaded) {
    token = readStorage(KEY) || undefined
    loaded = true
  }
  return token
}

/** A bare token, or the JSON document it arrives in; quotes and a `Bearer ` prefix tolerated. */
export function unwrapClioToken(raw: string): string {
  let text = raw.trim()
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { token?: unknown }
      if (typeof parsed.token === 'string') text = parsed.token
    } catch {
      // Not JSON after all; taken as typed, and the store will say if it is wrong.
    }
  }
  return cleanToken(text.replace(/"/g, '')) ?? ''
}

export function setClioToken(raw: string | undefined): void {
  token = raw ? unwrapClioToken(raw) || undefined : undefined
  loaded = true
  writeStorage(KEY, token)
}

/** Raised on 401/403 so the Connections panel can open on the Clio tab. */
export const reportClioAuthFailure = authFailure.notify
export const subscribeClioAuthFailure = authFailure.subscribe

/** Test seam. */
export function resetClioCredentials(): void {
  writeStorage(KEY, undefined)
  token = undefined
  loaded = false
}

/** The Storage tab's entry. */
export const SIGN_IN: StoredSignIn = {
  service: 'Clio',
  keys: [KEY],
  stored: () => getClioToken() !== undefined,
}
