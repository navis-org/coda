/**
 * Turning labels into a lookup, and reading back which of them found nothing.
 *
 * Headless and pure, so both halves of the node agree by construction: `evaluate` builds the
 * request from `collectLabels`, and the card's readout reports against the *same* list. The
 * failure this shape prevents is a card saying "18 of 20" about a query that was issued with
 * a different 20 — which is unfalsifiable from the screen, since both numbers look plausible.
 */

import type { TableValue } from '../../core/values'
import type { LabelMatch } from '../../data/source'

/**
 * Split hand-typed labels on commas and newlines.
 *
 * Both, because the two ways of writing a list arrive from different places: a comma-separated
 * line is what someone types, and newline-separated is what a paste out of a spreadsheet column
 * or a Slack message looks like. Empty entries are dropped rather than passed on as `''`, which
 * would otherwise match every neuron whose property is the empty string.
 *
 * Whitespace inside a label survives — `LC4 unclear` is a real instance name — so only the ends
 * are trimmed.
 */
export function parseTypedLabels(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/[,\n\r]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** The labels in a table column, as text, in row order. */
function labelsFromColumn(table: TableValue | undefined, column: string | undefined): string[] {
  if (!table || !column) return []
  const values = table.data[column]
  if (!values) return []
  const out: string[] = []
  for (let i = 0; i < table.length; i++) {
    const v = values[i]
    // A null cell is an absent label, not a label spelled "null" — and it must not become one,
    // or a table with gaps would send a nonsense entry to the backend and report it unmatched.
    if (v === null || v === undefined) continue
    const text = String(v).trim()
    if (text.length > 0) out.push(text)
  }
  return out
}

export interface LabelSources {
  /** Raw text of the `labels` param. */
  typed: unknown
  /** The wired labels table, when connected. */
  table?: TableValue | undefined
  /** Which of its columns holds the labels. */
  column?: string | undefined
}

/**
 * The full set of labels to look up: typed first, then the wired column.
 *
 * A union rather than one overriding the other. Both are things somebody asked for, and a node
 * that silently ignored the text field the moment a wire arrived would look broken in exactly
 * the way that takes longest to notice — the result is a valid neuron table either way.
 *
 * Deduplicated with first-occurrence order kept. The order is not something the backend cares
 * about, but it is what the unmatched report is printed in, and a report that reshuffles
 * between runs is hard to read against the list that produced it.
 */
export function collectLabels(sources: LabelSources): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const label of [
    ...parseTypedLabels(sources.typed),
    ...labelsFromColumn(sources.table, sources.column),
  ]) {
    if (seen.has(label)) continue
    seen.add(label)
    out.push(label)
  }
  return out
}

export interface MatchMode {
  regex?: boolean
  ignoreCase?: boolean
}

/**
 * Which of the requested labels are absent from the result.
 *
 * Derived from the run rather than reported by it, which is what keeps it correct after a
 * reload and after a cache restore — there is no run-time warning channel to go stale. The
 * cost is that this re-does the comparison the backend already did, in the browser.
 *
 * Two refusals matter more than the arithmetic:
 *
 * - **No result table, no report.** Before the first run there is nothing to be missing from,
 *   and claiming every label unmatched would put a warning on a node that has not run.
 * - **A field the result does not carry, no report.** Every source returns the property it
 *   was asked to match on, so this should not happen — but if one ever does not, silence is
 *   the honest answer. "Nothing matched" on a table full of matches is worse than saying
 *   nothing at all, because it is a specific and wrong claim.
 */
export function unmatchedLabels(
  labels: readonly string[],
  result: TableValue | undefined,
  field: string | undefined,
  mode: MatchMode = {},
): string[] {
  if (labels.length === 0 || !result || !field) return []
  const values = result.data[field]
  if (!values) return []

  const present = new Set<string>()
  for (let i = 0; i < result.length; i++) {
    const v = values[i]
    if (v === null || v === undefined) continue
    present.add(mode.ignoreCase ? String(v).toLowerCase() : String(v))
  }

  if (!mode.regex) {
    return labels.filter((l) => !present.has(mode.ignoreCase ? l.toLowerCase() : l))
  }

  /*
   * Regex mode scans the distinct values per pattern, which is the same anchored whole-string
   * test the query ran. It is O(patterns x distinct) with an early exit on the first hit, so
   * the expensive case is exactly the one being reported: a pattern that matches nothing has
   * to look at everything before it can say so.
   */
  const distinct = [...present]
  const flags = mode.ignoreCase ? 'i' : ''
  return labels.filter((pattern) => {
    let re: RegExp
    try {
      re = new RegExp(`^(?:${pattern})$`, flags)
    } catch {
      // An unparseable pattern matched nothing, which is true and is what `validate` is
      // separately complaining about. Throwing here would take the card's readout down.
      return true
    }
    return !distinct.some((v) => re.test(v))
  })
}

/** The request half of a lookup, or undefined when there is nothing to look up. */
export function labelMatch(
  field: string | undefined,
  labels: readonly string[],
  mode: MatchMode,
): LabelMatch | undefined {
  if (!field || labels.length === 0) return undefined
  return {
    field,
    values: labels,
    ...(mode.regex ? { regex: true } : {}),
    ...(mode.ignoreCase ? { ignoreCase: true } : {}),
  }
}
