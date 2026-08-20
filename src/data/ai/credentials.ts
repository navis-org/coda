/**
 * Which AI provider is in use, and the credential for each.
 *
 * **Kept per provider, not per session.** Switching to Gemini to try it and back to Anthropic
 * must not cost you the key you already pasted — a settings panel that forgets is one nobody
 * experiments in. So the key, the model and (where it is the user's to choose) the base URL are
 * all stored under the provider's id, and selecting a provider is a separate, single value.
 *
 * **Bring your own key.** There is no Coda-side account and no server: the key is the user's,
 * the requests are billed to them, and nothing here ever reaches a machine we run. That is also
 * the honest statement of the risk — a key in `localStorage` is readable by any script running
 * in the page, which is the same trade the neuPrint token already makes, and `forgetKey` is the
 * way out.
 *
 * **Never written into a saved graph.** A `.coda.json` is a document people mail each other; a
 * credential in one would be shared the first time anybody did.
 */

import { channel } from '../channel'
import { readStorage, writeStorage } from '../localStore'
import { PROVIDERS, providerFor } from './providers'

/**
 * The per-provider values, as one table.
 *
 * Written as a table rather than as three near-identical getter/setter pairs because the rule
 * they share is the one that would drift: a value equal to the provider's own default is *not*
 * stored, so a provider changing its default in a later build moves everyone who never chose
 * otherwise. Three copies of that decision meant three places to keep it, none of which fails
 * to compile when one is missed.
 */
const FIELDS = {
  key: {
    prefix: 'coda.ai.key.',
    // Whitespace stripped: the obvious thing to do with a key from a web page is paste it.
    clean: (raw: string) => raw.trim(),
    fallback: () => '',
  },
  model: {
    prefix: 'coda.ai.model.',
    clean: (raw: string) => raw.trim(),
    fallback: (id: string) => providerFor(id)?.defaultModel ?? '',
  },
  base: {
    prefix: 'coda.ai.base.',
    // Trailing slashes stripped so joining a path stays a plain concatenation.
    clean: (raw: string) => raw.trim().replace(/\/+$/, ''),
    fallback: (id: string) => providerFor(id)?.defaultBaseUrl ?? '',
  },
} as const

type Field = keyof typeof FIELDS
const FIELD_NAMES = Object.keys(FIELDS) as Field[]

const PROVIDER_KEY = 'coda.ai.provider'

/**
 * Where the key lived when Anthropic was the only provider.
 *
 * Read once, on first load, and written forward under the new name. Somebody who has already
 * pasted a key should not have to find it again because the feature grew — and the old keys are
 * left in place rather than deleted, so rolling back to a previous build still finds them.
 */
const LEGACY: Partial<Record<Field, string>> = {
  key: 'coda.anthropic.key',
  model: 'coda.anthropic.model',
}

const DEFAULT_PROVIDER = 'anthropic'

let provider = DEFAULT_PROVIDER
const held: Record<Field, Map<string, string>> = {
  key: new Map(),
  model: new Map(),
  base: new Map(),
}
let loaded = false

const changed = channel()
/** Raised on a rejected credential so the UI can offer the fix instead of a bare error. */
const authFailure = channel<string>()

function load(): void {
  if (loaded) return
  loaded = true
  provider = readStorage(PROVIDER_KEY) || DEFAULT_PROVIDER

  for (const entry of PROVIDERS) {
    for (const field of FIELD_NAMES) {
      const value = readStorage(FIELDS[field].prefix + entry.id)
      if (value) held[field].set(entry.id, value)
    }
  }

  // The pre-provider layout, migrated forward rather than abandoned.
  for (const field of FIELD_NAMES) {
    const legacy = LEGACY[field]
    if (!legacy || held[field].has(DEFAULT_PROVIDER)) continue
    const value = readStorage(legacy)
    if (!value) continue
    held[field].set(DEFAULT_PROVIDER, value)
    writeStorage(FIELDS[field].prefix + DEFAULT_PROVIDER, value)
  }
}

function read(field: Field, id: string): string {
  load()
  return held[field].get(id) || FIELDS[field].fallback(id)
}

/** Store, or clear when the value is empty or is the provider's own default. Decided once. */
function write(field: Field, id: string, raw: string | undefined): void {
  load()
  const cleaned = FIELDS[field].clean(raw ?? '')
  const value = cleaned && cleaned !== FIELDS[field].fallback(id) ? cleaned : undefined
  if (value) held[field].set(id, value)
  else held[field].delete(id)
  writeStorage(FIELDS[field].prefix + id, value)
  changed.notify()
}

/** The provider id in use. Always one that exists — a stored id from a later build falls back. */
export function getProviderId(): string {
  load()
  return providerFor(provider) ? provider : DEFAULT_PROVIDER
}

export function setProviderId(id: string): void {
  load()
  provider = providerFor(id) ? id : DEFAULT_PROVIDER
  writeStorage(PROVIDER_KEY, provider === DEFAULT_PROVIDER ? undefined : provider)
  changed.notify()
}

export function getKey(id: string = getProviderId()): string | undefined {
  return read('key', id) || undefined
}

export function setKey(id: string, raw: string | undefined): void {
  write('key', id, raw)
}

export function forgetKey(id: string = getProviderId()): void {
  write('key', id, undefined)
}

export function getModel(id: string = getProviderId()): string {
  return read('model', id)
}

export function setModel(id: string, raw: string | undefined): void {
  write('model', id, raw)
}

export function getBaseUrl(id: string = getProviderId()): string {
  return read('base', id)
}

export function setBaseUrl(id: string, raw: string | undefined): void {
  write('base', id, raw)
}

/** Is the selected provider ready to be asked something? */
export function isConfigured(): boolean {
  const entry = providerFor(getProviderId())
  if (!entry) return false
  return entry.needsKey ? Boolean(getKey()) : true
}

export const subscribeCredentials = changed.subscribe
export const reportAuthFailure = authFailure.notify
export const subscribeAuthFailure = authFailure.subscribe

/** Test seam: drop everything held in memory and in storage. */
export function resetCredentials(): void {
  loaded = false
  provider = DEFAULT_PROVIDER
  writeStorage(PROVIDER_KEY, undefined)
  for (const field of FIELD_NAMES) {
    held[field].clear()
    const legacy = LEGACY[field]
    if (legacy) writeStorage(legacy, undefined)
    for (const entry of PROVIDERS) writeStorage(FIELDS[field].prefix + entry.id, undefined)
  }
}
