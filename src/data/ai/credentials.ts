/**
 * Which AI provider is in use, and the credential for each.
 *
 * **Kept per provider, not per session.** Switching to Gemini to try it and back to Anthropic
 * must not cost you the key you already pasted — a settings panel that forgets is one nobody
 * experiments in. So the key, the model, (where it is the user's to choose) the base URL, and
 * the three switches the assistant drawer offers are all stored under the provider's id, and
 * selecting a provider is a separate, single value. Three of those six are settings rather than
 * credentials, which is why the module is named for the harder half of what it holds.
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
 * Written as a table rather than as five near-identical getter/setter pairs because the rule
 * they share is the one that would drift: a value equal to the provider's own default is *not*
 * stored, so a provider changing its default in a later build moves everyone who never chose
 * otherwise. Five copies of that decision would mean five places to keep it, none of which
 * fails to compile when one is missed.
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
  /*
   * Reasoning, as `'on'` or nothing.
   *
   * A boolean in a table of strings, and it rides here rather than getting a pair of its own
   * because the rule it needs is the table's: a value equal to the default is not stored, so
   * off costs no storage and a later build changing the default moves everyone who never
   * chose. Off *is* the default — see `AiProvider.thinkingSwitch` for the measurement.
   */
  think: {
    prefix: 'coda.ai.think.',
    clean: (raw: string) => (raw === 'on' ? 'on' : ''),
    fallback: () => '',
  },
  /*
   * The full node catalogue rather than the lean one, as `'on'` or nothing.
   *
   * Rides in this table for `think`'s reason and one of its own. The table's reason: lean *is*
   * the default, so off costs no storage and a later build changing the default moves everyone
   * who never chose — see `catalogue.ts` for the measurement that made lean the default.
   *
   * Its own reason is that this is per *provider* even though the catalogue is a property of the
   * prompt rather than of the service. What varies between providers is what the extra 33k
   * characters cost: an hour-TTL cache read on Anthropic, and KV memory plus a re-prefill on a
   * model running on somebody's laptop. So the answer is reasonably different per provider, and
   * keeping it here means trying Gemini and coming back does not cost you what you already set.
   */
  full: {
    prefix: 'coda.ai.full.',
    clean: (raw: string) => (raw === 'on' ? 'on' : ''),
    fallback: () => '',
  },
  /*
   * Whether a question carries a summary of what the graph last produced, as `'off'` or nothing.
   *
   * **The one field here whose default is on, and it is stored inverted for that reason.** The
   * table's rule is that a value equal to the default is not kept, so what gets written is the
   * *departure* — `'off'` — and an absent value means the digest is sent. Spelling it the other
   * way round would store `'on'` for everybody and leave a later build unable to change its mind.
   *
   * On by default because it was measured: without it a model asked to filter to the commonest
   * partner type builds five nodes trying to *compute* the value it was not told, and leaves the
   * pickers unfinished. Refusable because it is the one setting here that decides whether data —
   * rather than structure — leaves the machine, and a disclosed behaviour with no control reads
   * as an oversight. See `docs/assistant.md`.
   */
  values: {
    prefix: 'coda.ai.values.',
    clean: (raw: string) => (raw === 'off' ? 'off' : ''),
    fallback: () => '',
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
// Derived from `FIELD_NAMES` rather than restated: a sixth field is one edit, not two.
const held = Object.fromEntries(
  FIELD_NAMES.map((name) => [name, new Map<string, string>()]),
) as Record<Field, Map<string, string>>
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

/**
 * Whether the model should reason before answering. Off unless the user turned it on.
 *
 * Off by default because on a local model it is most of the wait — 254 s against 49 s for the
 * same question, measured — and because the plans did not get worse without it. On is the
 * escape hatch for a request where they might.
 */
export function getThinking(id: string = getProviderId()): boolean {
  return read('think', id) === 'on'
}

export function setThinking(id: string, on: boolean): void {
  write('think', id, on ? 'on' : '')
}

/**
 * Whether to send the full node catalogue. Off — i.e. `lean` — unless the user turned it on.
 *
 * A boolean here and a `CatalogueDetail` at the seam that uses it, deliberately: naming the
 * level would make this module import `assistant/catalogue.ts`, which imports `data/ai` back.
 * The mapping is one ternary and it lives where the type already legitimately is.
 *
 * Lean is the default because it was measured, not assumed: three full-suite reps at each level
 * against Sonnet 5 were 15/15 either way, and the case `help` prose should matter most for
 * produced the identical graph on all six runs. It is roughly half the prompt. On is the escape
 * hatch for a request where the prose might be what was missing.
 */
export function getFullCatalogue(id: string = getProviderId()): boolean {
  return read('full', id) === 'on'
}

export function setFullCatalogue(id: string, on: boolean): void {
  write('full', id, on ? 'on' : '')
}

/**
 * Whether a question carries what the graph last produced. On unless the user turned it off.
 *
 * The digest is aggregates — row counts, ranges, medians, the commonest values of a column — for
 * nodes whose results match their current settings. No rows, and never an id. It is still the
 * only setting that sends *data* rather than structure, which is why it can be refused; see the
 * field above for why on is the default and why storage is inverted.
 */
export function getSendRunValues(id: string = getProviderId()): boolean {
  return read('values', id) !== 'off'
}

export function setSendRunValues(id: string, on: boolean): void {
  write('values', id, on ? '' : 'off')
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
