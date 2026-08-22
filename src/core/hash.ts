/**
 * Stable hashing for cache keys.
 *
 * Cache keys are built from *provenance* (node type + params + upstream keys), not from
 * output data. Hashing a 500k-row table on every graph edit would be absurd; provenance
 * is cheap and is correct as long as `evaluate` is deterministic for fixed inputs.
 *
 * Consequence worth knowing: a node whose result depends on hidden mutable state — a
 * live server whose contents changed, `Math.random()` — is not covered by the key. Such
 * nodes must opt out by mixing a nonce into their params (see the Dataset node's
 * refresh counter) so a re-run is forced explicitly.
 */

/**
 * Serialised form of every array and object this has already seen.
 *
 * Keys are computed for the whole graph on every mutation, and the expensive input is an
 * Explore selection: at the documented `MAX_SELECT_ALL` of 10,000 neuron ids one param alone
 * is ~130 kB of string to build and hash, twice per settled edit, on a keystroke that did
 * not touch it. `setNodeParam` spreads the params record but keeps the *array* reference for
 * every param it did not write, so an unrelated edit hits this memo.
 *
 * Sound because the entries are values reached from a saved graph, which is treated as
 * immutable — the same object mutated in place would be a provenance bug with or without
 * this. Weak, so an array belonging to a deleted node is collected with it.
 */
const serialised = new WeakMap<object, string>()

/** Order-independent for object keys, order-preserving for arrays. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  const t = typeof value
  if (t === 'number' || t === 'boolean') return String(value)
  if (t === 'string') return JSON.stringify(value)
  if (t !== 'object') return JSON.stringify(String(value))

  const cached = serialised.get(value as object)
  if (cached !== undefined) return cached

  let out: string
  if (Array.isArray(value)) {
    out = `[${value.map(stableStringify).join(',')}]`
  } else {
    const keys = Object.keys(value as object).sort()
    out = `{${keys
      .map(
        (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`
  }
  serialised.set(value as object, out)
  return out
}

/**
 * FNV-1a, 64-bit, as two 32-bit halves to stay in safe-integer land.
 * Not cryptographic — we only need low collision probability across one session's graph.
 */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= (c << 3) ^ i
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return h1.toString(36) + h2.toString(36)
}

export function hashValue(value: unknown): string {
  return hashString(stableStringify(value))
}
