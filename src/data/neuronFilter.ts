/**
 * What a `FindNeuronsRequest` means to a source that answers **locally** — from rows it already
 * holds, rather than by compiling a query.
 *
 * Three sources do that: the mock filters its generated connectome, `CaveSource` filters the
 * neuron index it downloads once per datastack (CAVE has no server-side regex worth using and
 * the index is there anyway), and `CatmaidSource` does the same. A second copy of this logic is
 * how two backends come to disagree about whether `LC.*` matches `LPLC1` — which is not an error
 * anywhere, just a different set of neurons.
 *
 * The `rows` half is no longer written out here at all: `preparedRows` hands straight to
 * `filterRows.ts` and `terms.ts`, which are also what Explore's search box and the Table
 * viewer's header cells run on. One matcher rather than three that agree today.
 *
 * The rule it applies is neuPrint's, because neuPrint is the one with a server semantic to
 * match: Neo4j's `=~` matches the **whole** value, so a whole-string pattern is wrapped in
 * `^(?:…)$` (`anchoredPattern`). An unanchored local source would train the wrong intuition and
 * then silently change results the day the same graph is pointed at neuPrint.
 *
 * The other agreement is nulls. Cypher's `WHERE` keeps only *true*, and `null =~ p` is null — so
 * a neuron with no `hemilineage` is not a match for the empty string, or for anything else.
 * Everything below fails an absent value rather than coercing it to `''`.
 */

import type { TableValue } from '../core/values'
import type { FindNeuronsRequest, LabelMatch } from './source'
import { resolveRows } from './filterRows'
import type { PreparedFieldTerm } from './terms'
import { anchoredPattern, prepareFieldTerms } from './terms'

/**
 * Compile one anchored pattern, or say which field it came from.
 *
 * The anchoring itself is `anchoredPattern`, shared with the filter rows and the Cypher
 * compiler; what this adds is the error message, which names the field because an invalid
 * pattern reaches here from a control somebody has to go and fix.
 */
function anchored(pattern: string, field: string, flags = ''): RegExp {
  try {
    return new RegExp(anchoredPattern(pattern), flags)
  } catch (err) {
    throw new Error(`Invalid ${field} pattern /${pattern}/: ${(err as Error).message}`)
  }
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
 * The request's rows, compiled against the index that will answer them.
 *
 * The whole of what a local source needs, in one call, and the reason it is one call is that the
 * three of them had each hand-rolled the same loop — compile `typeRe`, compile `instanceRe`,
 * build a status `Set`, call `compileLabelMatch` — and each got a different corner of it wrong.
 *
 * **An unfilterable row throws rather than matching nothing**, and that is the decision worth
 * defending. `prepareFieldTerms` marks a column the table does not have as `unknown`, which
 * matches no row: correct for the Table viewer, where a stale column name emptying the table
 * reads as a node that has broken and can be seen. Here it would answer a query with nothing at
 * all, which is indistinguishable from a dataset that genuinely holds no such neurons — the
 * exact failure `refuseUnfilterable` was written for one field at a time, when `CaveSource` read
 * `index.data.size` through `Number(undefined ?? 0)` and dropped every row.
 *
 * The message is `resolveRows`', so it names the field as the card labels it — which is what
 * somebody has to go and change. Normally unreachable: Find Neurons' `validate` reports the same
 * problems at edit time, off the same function, because a Dataset socket carries its schema
 * before anything runs. What gets here is a saved graph repointed at another backend.
 */
export function preparedRows(
  index: TableValue,
  req: Pick<FindNeuronsRequest, 'rows'>,
  backend: string,
): PreparedFieldTerm[] {
  const { terms, problems } = resolveRows(index.schema, req.rows ?? [])
  const problem = problems[0]
  if (problem) throw new Error(`${backend}: ${problem.message}`)
  return prepareFieldTerms(index, terms)
}

/**
 * Refuse a region filter a backend has no way to answer.
 *
 * All that is left of `refuseUnfilterable`, and the shrinkage is the point: `minSize` and
 * `statuses` used to need refusing because they were named fields of the request that a card
 * offered whatever the dataset was. They are rows now, and a row can only name a column the
 * dataset's own schema publishes — so `size` on a CAVE datastack is not a filter that gets
 * refused, it is a field that was never in the dropdown.
 *
 * A region cannot follow them, because it is not a column anywhere: in neuPrint a neuron carries
 * one boolean property per ROI it innervates. So this stays, and it stays a *refusal*. CATMAID
 * is the case that makes it necessary: `volumeList` fills `DatasetInfo.rois` with eighty real
 * neuropils so the ROI Viewer can draw them, and `findNeurons` cannot read a single one — a
 * populated dropdown that narrows nothing, whose result is too *large* and looks correct.
 *
 * An empty result and an unnarrowed one both look like answers, which is what makes a refusal
 * the only one of the three that can be acted on. It names the control as the card labels it.
 */
export function refuseUnfilterableRoi(
  req: Pick<FindNeuronsRequest, 'roi'>,
  backend: string,
): void {
  if (req.roi) {
    throw new Error(
      `${backend} cannot filter neurons by region, so "In ROI" cannot narrow this query. ` +
        `Set it back to Any to search this dataset.`,
    )
  }
}
