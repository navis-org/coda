/**
 * A long list of ids, written into a document compactly.
 *
 * A viewer's selection is an `ids` param, so it is in the document: the autosave, every file, every
 * share link. A lasso round a cluster of a whole-connectome embedding is 100,000 ids or more, and as
 * JSON strings that is 1.5 MB for fish2's 129,325 nine-digit ids and 2.7 MB for as many CAVE root
 * ids — written twice into a `localStorage` budget of about 5M characters (the shared autosave key
 * and the tab's slot), so the second save of a big lasso is the one that silently does not happen.
 *
 * So the *document* spells such a list as `{ "compactIds": "<text>" }`: each id's difference from
 * the one before, zigzagged and written as a base64url varint. **Order is kept**, which is what lets
 * a reload hand back the identical array — the provenance key and every reader are unchanged — and
 * it costs nothing in the common case, because a lasso records rows in table order and tables
 * arrive sorted by id: all of fish2 is 241 kB this way, sorted or not. A table in some other order
 * pays for it (50,000 random CAVE ids: 399 kB in order against 264 kB sorted), still 2.6x smaller
 * than the strings.
 *
 * Only the document edge knows about this: every graph written as text goes through `graphText`,
 * which applies `compactParams`, and `deserializeGraph` reads through `expandParams`, so in memory
 * an `ids` param is the plain `string[]` it always was. Only above `MIN_COMPACT`, below which the
 * plain list is the readable one.
 *
 * **An entry is a prefix and the integer it ends in**, so a comparative workflow's qualified ids
 * (`flywire:7205…`, `hemibrain:1234…`) compact as well as plain ones: the distinct prefixes are
 * written once, each entry as its prefix's index and its delta from the previous id *with that
 * prefix*. The split is exact whatever the text — `x007` is `x00` and `7` — so the rule for when a
 * list is compacted is only that every entry ends in a digit and the result is the shorter.
 *
 * Ids are text everywhere (invariant 8), and here too: an eighteen-digit root id is past a
 * double's integers, so the arithmetic falls back to `BigInt` wherever a double would round.
 */

import type { ParamValue, ParamValues } from './node'

/** Below this a plain list is kept: small enough not to matter, and readable in the file. */
const MIN_COMPACT = 64

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
/** Each character's value by char code, -1 for one the alphabet does not have. */
const DIGIT = new Int8Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) DIGIT[ALPHABET.charCodeAt(i)] = i
/** Five bits of value per character; the sixth says another character follows. */
const MORE = 32
/** Fifteen digits is below 2^53, so such an id and its zigzagged delta stay exact as a double. */
const SAFE_DIGITS = 15
/** A varint this short holds at most 50 bits, which a double holds exactly. */
const SAFE_CHARS = 10
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * The document's spelling of a compacted list. `prefixes` only where an entry has one, so a list of
 * plain integer ids is written as it was before prefixes were read.
 */
interface CompactIds {
  compactIds: string
  prefixes?: string[]
}

function isCompact(value: unknown): value is CompactIds {
  const compact = value as Partial<CompactIds> | null
  return (
    typeof compact?.compactIds === 'string' &&
    (compact.prefixes === undefined ||
      (Array.isArray(compact.prefixes) && compact.prefixes.every((p) => typeof p === 'string')))
  )
}

/**
 * Encoded once per array: the autosave writes the whole graph on every edit, and a selection's
 * array is the same object across every edit that did not touch it (`hash.ts` relies on the same).
 */
const encoded = new WeakMap<readonly string[], CompactIds | null>()

/**
 * An entry as its prefix and the canonical integer it ends in — `flywire:7205…` → `flywire:` and
 * `7205…` — or undefined where it ends in no digit. Leading zeros of the digits stay in the prefix
 * (`x007` → `x00`, `7`), so every split joins back to the entry it came from.
 */
function split(entry: string): [string, string] | undefined {
  let at = entry.length
  while (at > 0 && entry.charCodeAt(at - 1) >= 48 && entry.charCodeAt(at - 1) <= 57) at--
  if (at === entry.length) return undefined
  while (at < entry.length - 1 && entry[at] === '0') at++
  return [entry.slice(0, at), entry.slice(at)]
}

/**
 * Where a run of deltas stands: doubles while every value has fit one, `BigInt` from the first that
 * does not. fish2's nine-digit ids never leave the fast path, an eighteen-digit root id takes the
 * exact one, and the text is the same either way. One per prefix, so a selection alternating
 * between two datasets steps through each one's ids rather than jumping between their ranges.
 */
interface Cursor {
  prev: number
  big: bigint | undefined
}

const cursor = (): Cursor => ({ prev: 0, big: undefined })

function pushDelta(out: string[], at: Cursor, digits: string): void {
  if (at.big === undefined && digits.length <= SAFE_DIGITS) {
    const value = Number(digits)
    const delta = value - at.prev
    at.prev = value
    pushVarint(out, delta < 0 ? -2 * delta - 1 : 2 * delta)
  } else {
    const value = BigInt(digits)
    const delta = value - (at.big ?? BigInt(at.prev))
    at.big = value
    pushVarint(out, delta < 0n ? (-delta << 1n) - 1n : delta << 1n)
  }
}

/** The cursor moved by a zigzagged delta, as text; undefined where it would go below zero. */
function step(at: Cursor, zigzag: number | bigint): string | undefined {
  if (at.big === undefined && typeof zigzag === 'number') {
    const value = at.prev + (zigzag % 2 ? -(zigzag + 1) / 2 : zigzag / 2)
    if (Number.isSafeInteger(value)) {
      if (value < 0) return undefined
      at.prev = value
      return String(value)
    }
  }
  const z = BigInt(zigzag)
  at.big = (at.big ?? BigInt(at.prev)) + (z & 1n ? -((z + 1n) >> 1n) : z >> 1n)
  return at.big < 0n ? undefined : at.big.toString()
}

function pushVarint(out: string[], value: number | bigint): void {
  let rest = value
  while (typeof rest === 'bigint') {
    if (rest <= MAX_SAFE) rest = Number(rest)
    else {
      out.push(ALPHABET[Number(rest & 31n) | MORE]!)
      rest >>= 5n
    }
  }
  do {
    const low = rest % 32
    rest = Math.floor(rest / 32)
    out.push(ALPHABET[rest ? low | MORE : low]!)
  } while (rest)
}

/**
 * Each varint in `text` in turn — a double where it is short enough to be exact, a `BigInt` where
 * not — until `visit` refuses one. False where the text is not varints, or ends part way through
 * one: a list cut short is not a shorter list.
 */
function eachVarint(text: string, visit: (value: number | bigint) => boolean): boolean {
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const digit = code < 128 ? DIGIT[code]! : -1
    if (digit < 0) return false
    if (digit & MORE) continue
    // One varint is `text[start..i]`, least significant character first.
    let value: number | bigint
    if (i - start < SAFE_CHARS) {
      value = 0
      for (let j = i; j >= start; j--) value = value * 32 + (DIGIT[text.charCodeAt(j)]! & 31)
    } else {
      value = 0n
      for (let j = i; j >= start; j--)
        value = (value << 5n) | BigInt(DIGIT[text.charCodeAt(j)]! & 31)
    }
    start = i + 1
    if (!visit(value)) return false
  }
  return start === text.length
}

/**
 * A list's compact spelling, or undefined where an entry ends in no digit or the spelling would not
 * be the shorter — a list of cell types such as `LC4` splits exactly, into a prefix per entry.
 */
function encodeIds(ids: readonly string[]): CompactIds | undefined {
  const parts: [string, string][] = []
  const indexOf = new Map<string, number>()
  for (const id of ids) {
    const part = typeof id === 'string' ? split(id) : undefined
    if (!part) return undefined
    if (!indexOf.has(part[0])) indexOf.set(part[0], indexOf.size)
    parts.push(part)
  }
  const prefixes = [...indexOf.keys()]
  const plain = prefixes.length === 1 && prefixes[0] === ''
  const cursors = prefixes.map(cursor)
  const out: string[] = []
  for (const [prefix, digits] of parts) {
    const index = indexOf.get(prefix)!
    if (!plain) pushVarint(out, index)
    pushDelta(out, cursors[index]!, digits)
  }
  const text = out.join('')
  const json = ids.reduce((n, id) => n + id.length + 3, 2)
  const written = text.length + (plain ? 0 : JSON.stringify(prefixes).length)
  return written < json ? { compactIds: text, ...(plain ? {} : { prefixes }) } : undefined
}

/**
 * The list back, or undefined where the text is not one `encodeIds` writes. A plain list is the
 * prefixed form with one empty prefix whose index is never written.
 */
function decodeIds({ compactIds, prefixes }: CompactIds): string[] | undefined {
  const table = prefixes ?? ['']
  const unread = prefixes ? undefined : 0
  const cursors = table.map(cursor)
  const ids: string[] = []
  let index = unread
  const read = eachVarint(compactIds, (value) => {
    if (index === undefined) {
      if (typeof value !== 'number' || value >= table.length) return false
      index = value
      return true
    }
    const id = step(cursors[index]!, value)
    if (id === undefined) return false
    ids.push(table[index] + id)
    index = unread
    return true
  })
  // An index with no delta after it is a list cut short too.
  return read && index === unread ? ids : undefined
}

function compacted(value: readonly string[]): CompactIds | null {
  let out = encoded.get(value)
  if (out === undefined) {
    out = (value.length >= MIN_COMPACT && encodeIds(value)) || null
    encoded.set(value, out)
  }
  return out
}

/**
 * Params as a document writes them: each of `keys` that holds a long list of entries ending in an
 * integer compacted, everything else as it is — `writtenNode` hands it the params declared as id
 * lists. Returns the same object when there is nothing to compact, which is nearly every node.
 */
export function compactParams(params: ParamValues, keys?: ReadonlySet<string>): ParamValues {
  let out: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(params)) {
    if (!Array.isArray(value) || (keys && !keys.has(key))) continue
    const compact = compacted(value)
    if (compact) (out ??= { ...params })[key] = compact
  }
  return (out as ParamValues | undefined) ?? params
}

/**
 * Stored params as memory holds them: each compacted list expanded. Lenient like every load path —
 * text that does not decode is dropped (an absent param reads as its default) rather than kept as
 * an object no reader expects.
 */
export function expandParams(params: Record<string, unknown>): ParamValues {
  for (const [key, value] of Object.entries(params)) {
    if (!isCompact(value)) continue
    const ids = decodeIds(value)
    if (ids) params[key] = ids satisfies ParamValue
    else delete params[key]
  }
  return params as ParamValues
}
