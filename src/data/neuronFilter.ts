/**
 * What a `FindNeuronsRequest`'s pattern and label fields mean to a source that answers
 * **locally** — from rows it already holds, rather than by compiling a query.
 *
 * Two sources do that now, which is what moved this out of `MockSource`: the mock filters its
 * generated connectome, and `CaveSource` filters the neuron index it downloads once per
 * dataset, because CAVE has no server-side regex worth using and the index is there anyway.
 * A second copy of these two functions is how two backends come to disagree about whether
 * `LC.*` matches `LPLC1` — which is not an error anywhere, just a different set of neurons.
 *
 * The rule is neuPrint's, because neuPrint is the one with a server semantic to match:
 * Neo4j's `=~` matches the **whole** value, so every pattern is wrapped in `^(?:…)$` here.
 * An unanchored local source would train the wrong intuition and then silently change results
 * the day the same graph is pointed at neuPrint.
 *
 * The other agreement is nulls. Cypher's `WHERE` keeps only *true*, and `null =~ p` is null —
 * so a neuron with no `hemilineage` is not a match for the empty string, or for anything else.
 * Both functions below fail an absent value rather than coercing it to `''`.
 */

import type { LabelMatch } from './source'

/**
 * Compile a user-supplied regex, anchored to the whole string.
 *
 * `field` only ever appears in the error message, and it is worth passing: an invalid pattern
 * reaches this from a text box on a node, and "Invalid type pattern" says which box.
 */
/**
 * Compile one anchored pattern, or say which field it came from.
 *
 * The `^(?:…)$` and the error message live here rather than in both functions below, which is
 * this module's own rule applied to itself: it exists so that one anchoring decision cannot be
 * made twice, and having it written twice ten lines apart is the same drift on a shorter axis —
 * a `u` flag or a length cap added to one and not the other.
 */
function anchored(pattern: string, field: string, flags = ''): RegExp {
  try {
    return new RegExp(`^(?:${pattern})$`, flags)
  } catch (err) {
    throw new Error(`Invalid ${field} pattern /${pattern}/: ${(err as Error).message}`)
  }
}

/**
 * Compile a user-supplied regex, anchored to the whole string.
 *
 * `field` only ever appears in the error message, and it is worth passing: an invalid pattern
 * reaches this from a text box on a node, and "Invalid type pattern" says which box.
 */
export function compileRegex(pattern: string | undefined, field: string): RegExp | undefined {
  return pattern ? anchored(pattern, field) : undefined
}

/**
 * A predicate for `LabelMatch`, over a row read as a plain record.
 *
 * Undefined for an absent or empty match, which is the caller's signal to apply no filter at
 * all. That is *not* the same as the seam's "empty `values` matches nothing" rule: an empty
 * list never reaches here, because a lookup of nothing is answered before a request is built.
 * Keeping the two apart is what stops an unconfigured node returning a whole connectome.
 */
export function compileLabelMatch(
  match: LabelMatch | undefined,
): ((row: Record<string, unknown>) => boolean) | undefined {
  if (!match || match.values.length === 0) return undefined
  const { field, ignoreCase } = match

  let test: (text: string) => boolean
  if (match.regex) {
    const res = match.values.map((v) => anchored(v, field, ignoreCase ? 'i' : ''))
    test = (text) => res.some((re) => re.test(text))
  } else {
    const wanted = new Set(match.values.map((v) => (ignoreCase ? v.toLowerCase() : v)))
    test = (text) => wanted.has(ignoreCase ? text.toLowerCase() : text)
  }

  // The null rule, once: Cypher's `WHERE` keeps only true and `null =~ p` is null, so an absent
  // value fails every mode rather than being coerced to the empty string.
  return (row) => {
    const value = row[field]
    return value !== null && value !== undefined && test(String(value))
  }
}

/**
 * Refuse a filter this backend cannot answer, rather than applying it to something that is not
 * there.
 *
 * Both local sources met this and each got it wrong in a different direction, and neither
 * failure is visible from the result. `CaveSource` read `index.data.size` — a column no CAVE
 * index has — through `Number(undefined ?? 0)`, so any non-zero **Min size** compared 0 against
 * it and dropped every row: a node reporting "0 neurons" for a datastack full of them.
 * `CatmaidSource` never read `req.roi` at all, while its volume list fills `DatasetInfo.rois`
 * with eighty real neuropils — so **In ROI** was a populated dropdown that narrowed nothing, and
 * the answer came back too *large*.
 *
 * An empty result and an unnarrowed one both look like answers, which is what makes a refusal
 * the only one of the three that can be acted on. It names the control as the card labels it,
 * because that is what somebody has to go and clear.
 *
 * Deliberately not the same call as `compileLabelMatch`'s, whose absent value matches nothing on
 * purpose: that is neuPrint's `WHERE` semantics for a *property* the dataset may legitimately
 * lack per neuron, and every backend has to agree about it. These two are whole-query facts
 * about the backend, known before a single row is read.
 *
 * `status` is deliberately absent from this: its default is `Traced`, so refusing would fail a
 * value nobody chose. A source that cannot answer it ignores it instead — see `CatmaidSource`.
 */
export function refuseUnfilterable(
  req: { minSize?: number | undefined; roi?: string | undefined },
  can: { size: boolean; roi: boolean },
  backend: string,
): void {
  if (req.minSize && !can.size) {
    throw new Error(
      `${backend} publishes no neuron size, so "Min size" cannot narrow this query. ` +
        `Set it back to 0 to search this dataset.`,
    )
  }
  if (req.roi && !can.roi) {
    throw new Error(
      `${backend} cannot filter neurons by region, so "In ROI" cannot narrow this query. ` +
        `Set it back to Any to search this dataset.`,
    )
  }
}
