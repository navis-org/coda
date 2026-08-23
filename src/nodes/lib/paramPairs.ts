/**
 * How a list of two-string entries is written into an `ids` param.
 *
 * Two nodes store a list somebody grows: `out.table`'s per-column filter clauses and
 * `core.rename`'s remappings. Both hold `[a, b]` and both have to survive a hand-edited file,
 * so the encoding and the validating parse are here once rather than in each — the second
 * consumer rule this codebase applies to `uniqueName`, `rowKey` and `routeMemory`, all of which
 * record copies that had already drifted before anyone noticed.
 *
 * **JSON rather than a delimited pair**, and that is the decision worth keeping. A column name
 * is not a safe left-hand side here: `parseSearch` reads a field name only where it matches
 * `FIELD_NAME`, and the columns these lists name routinely do not — a wide pivot names its
 * columns after label values (`LC11_02(R)`) and an uploaded CSV's header can hold a comma, a
 * colon or a space. A `` separator would work and is the idiom `uploads.ts` uses, where
 * the joined string is never read by a person. These are: they sit in a `.coda.json` colleagues
 * mail each other and in the inspector's tooltip, where `["root_id","neuronId"]` says what it
 * is and a control character says nothing.
 *
 * What each caller keeps is its own named struct and its own rule about which entries are worth
 * storing — which is the real difference between them, and stays visible as a one-line filter
 * rather than being buried in a copied decoder. `out.table` drops a cleared cell; `core.rename`
 * keeps a half-typed row, because there a row is something somebody is still filling in.
 */

export function encodePair(first: string, second: string): string {
  return JSON.stringify([first, second])
}

/**
 * Read one entry back, or undefined for anything unreadable.
 *
 * Dropped rather than thrown — the same lenient pass `deserializeGraph` gives everything else
 * it cannot read, and the only thing standing between a hand-edited `.coda.json` and a crash.
 */
export function decodePair(raw: unknown): [string, string] | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
    const [first, second] = parsed as unknown[]
    if (typeof first !== 'string' || typeof second !== 'string') return undefined
    return [first, second]
  } catch {
    return undefined
  }
}

/** Read a whole param, dropping unreadable entries. */
export function decodePairs(raw: unknown): Array<[string, string]> {
  if (!Array.isArray(raw)) return []
  const out: Array<[string, string]> = []
  for (const entry of raw) {
    const pair = decodePair(entry)
    if (pair) out.push(pair)
  }
  return out
}
