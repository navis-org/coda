/**
 * Every service whose credential Coda keeps in `localStorage`, as the Storage tab reports them.
 *
 * Each credentials module declares its own entry beside the key constants it already owns, so a
 * key is spelled once and "is a sign-in stored" is the module's own answer rather than a guess
 * made from the raw text. Listed here by import rather than collected by registration: a registry
 * filled as a side effect is complete only for the modules something happened to load.
 */

import { SIGN_IN as AI } from './ai/credentials'
import { SIGN_IN as CLIO } from './annotations/clioCredentials'
import { SIGN_IN as SEATABLE } from './annotations/credentials'
import { SIGN_IN as CATMAID } from './catmaid/credentials'
import { SIGN_IN as CAVE } from './cave/credentials'
import { SIGN_IN as NEUPRINT } from './neuprint/credentials'
import { SIGN_IN as GITHUB } from './share/credentials'

/** One service's stored credential: where it lives, and whether one is there. */
export interface StoredSignIn {
  /** What a reader calls the service. */
  service: string
  /** The `localStorage` keys holding it, legacy spellings included. */
  keys: readonly string[]
  /** Stems for keys written once per host or provider. */
  prefixes?: readonly string[]
  /** Whether a credential is stored now — the module's own reading, not the raw text's. */
  stored(): boolean
}

export const SIGN_INS: readonly StoredSignIn[] = [
  CAVE,
  NEUPRINT,
  CATMAID,
  CLIO,
  SEATABLE,
  GITHUB,
  AI,
]

/** Whether a `localStorage` key holds some service's credential. */
export function isSignInKey(key: string): boolean {
  return SIGN_INS.some(
    (entry) =>
      entry.keys.includes(key) || entry.prefixes?.some((prefix) => key.startsWith(prefix)),
  )
}
