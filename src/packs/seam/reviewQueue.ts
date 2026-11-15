/**
 * The review queue: one row per tip, each showing one of that tip's candidates.
 *
 * Headless, and holding every decision the card makes — which rows there are, which candidate of
 * a tip is being shown, how the filters and the sort read, and how a verdict is written down.
 * The card draws it. Arithmetic inside a React component is arithmetic no test can reach.
 *
 * ## The unit of review is a tip, not a candidate
 *
 * Every candidate belongs to exactly one tip (`end_uid`), and the own-tip rule is what makes
 * that exclusive: a candidate stays on a tip's list only if its contact is within 2 µm of that
 * tip and no other tip is nearer. So the queue is tips, and the **first** candidate is the
 * suggestion — SEAM's cutoff was calibrated on first candidates only, and every shown row is
 * rank 1. The rest of the list is context a reader can page through, not further suggestions.
 *
 * A *piece* can still appear on two tips' lists, because a piece can touch the neuron in more
 * than one place. That is why a verdict is keyed on the **pair**: "belongs" on one tip and "not
 * it" on another is not a contradiction, it is two contacts.
 *
 * ## Filters are the reader's, and they never move the cursor
 *
 * The filters narrow what is *listed*; they do not decide what is a suggestion. `shown` is
 * SEAM's own absolute cutoff and travels as a column. The cursor is a tip's `end_uid` rather
 * than a position in the list, so narrowing the list does not quietly move it to another tip —
 * which is the failure that would have a reader judge the row above the one they were looking at.
 */

import type { CellValue, TableValue } from '../../core/values'
import { numberAt } from './suggestionTables'

/** What a reader can say about one (tip, candidate) pair. SEAM's vocabulary, in their words. */
export type Verdict = 'accept' | 'reject' | 'unsure'

export const VERDICTS: readonly Verdict[] = ['accept', 'reject', 'unsure']

/** One candidate of a tip, as the card draws it. */
export interface Candidate {
  readonly candidateId: string
  /** 1-based, renumbered within the tip's kept list. The suggestion is rank 1. */
  readonly rank: number
  /** The search's own order, kept beside the rank the scoring produced. */
  readonly geoRank: number | undefined
  readonly volumeUm3: number | undefined
  readonly minDistUm: number | undefined
  readonly contactNm: readonly [number, number, number]
  /** Its share of its tip's list — the model's "and it is this one". */
  readonly pCand: number | undefined
  /** `p_tip × p_cand`, which is what the cutoff is applied to. */
  readonly conf: number | undefined
  /** Whether SEAM shows this one, i.e. it cleared the absolute cutoff. */
  readonly shown: boolean
}

/** One tip, with every candidate the own-tip rule kept for it. */
export interface QueueTip {
  readonly endUid: number
  readonly neuronId: string
  /** `tip` or `kink` — a leaf, or a sharp bend where a merge often sits. */
  readonly kind: string
  readonly tipNm: readonly [number, number, number]
  /** The calibrated chance the **first** candidate is right. */
  readonly r: number | undefined
  readonly q: number | undefined
  /** The chance anything belongs at this tip at all, before which piece. */
  readonly pTip: number | undefined
  readonly shown: boolean
  readonly candidates: readonly Candidate[]
}

/** Build the queue from the two tables `seam:suggestions` publishes. */
export function buildQueue(
  tips: TableValue | undefined,
  candidates: TableValue | undefined,
): QueueTip[] {
  if (!tips) return []
  const lists = candidateLists(candidates)
  const out: QueueTip[] = []
  for (let i = 0; i < tips.length; i++) {
    const endUid = numberAt(tips, 'end_uid', i)
    if (endUid === undefined) continue
    out.push({
      endUid,
      neuronId: text(tips, 'neuronId', i) ?? '',
      kind: text(tips, 'kind', i) ?? 'tip',
      tipNm: [
        numberAt(tips, 'x', i) ?? 0,
        numberAt(tips, 'y', i) ?? 0,
        numberAt(tips, 'z', i) ?? 0,
      ],
      r: numberAt(tips, 'r', i),
      q: numberAt(tips, 'q', i),
      pTip: numberAt(tips, 'p_tip', i),
      shown: wasShown(tips, i),
      candidates: lists.get(endUid) ?? [],
    })
  }
  return out
}

/** Every tip's candidates, in rank order. */
function candidateLists(table: TableValue | undefined): Map<number, Candidate[]> {
  const lists = new Map<number, Candidate[]>()
  if (!table) return lists
  for (let i = 0; i < table.length; i++) {
    const endUid = numberAt(table, 'end_uid', i)
    const candidateId = text(table, 'candidateId', i)
    if (endUid === undefined || !candidateId) continue
    const held = lists.get(endUid) ?? []
    held.push({
      candidateId,
      rank: numberAt(table, 'rank', i) ?? held.length + 1,
      geoRank: numberAt(table, 'geo_rank', i),
      volumeUm3: numberAt(table, 'vol_um3', i),
      minDistUm: numberAt(table, 'min_dist_um', i),
      contactNm: [
        numberAt(table, 'contact_x', i) ?? 0,
        numberAt(table, 'contact_y', i) ?? 0,
        numberAt(table, 'contact_z', i) ?? 0,
      ],
      pCand: numberAt(table, 'p_cand', i),
      conf: numberAt(table, 'conf', i),
      shown: wasShown(table, i),
    })
    lists.set(endUid, held)
  }
  // Rank order, because the file's row order is nobody's promise and rank 1 is the suggestion.
  for (const list of lists.values()) list.sort((a, b) => a.rank - b.rank)
  return lists
}

/**
 * How many tips the run still has to search, or `undefined` where the table does not say.
 *
 * Counts the nulls in `searched`, which is `seam:suggestMerges`' three-state statement about its
 * own run (`searchTips.ts`): `true` searched, `false` never going to be, `null` not yet. So the
 * number is exact and reaches zero — a count of "rows with no answer" would stall at whatever
 * the node could not reach and read as a run that stopped early.
 *
 * **Absent means finished**, which is why this is `undefined` rather than 0: a `seam:suggestions`
 * table is a published set, complete by definition, and it carries no such column. Reported as a
 * number, a set with nothing left to search and a table that cannot say would print the same.
 */
export function stillToSearch(tips: TableValue | undefined): number | undefined {
  const column = tips?.data['searched']
  if (!column) return undefined
  let waiting = 0
  for (const cell of column) if (cell === null || cell === undefined) waiting += 1
  return waiting
}

export type SortBy = 'confidence' | 'size' | 'tip'

/**
 * What one row of the queue is about.
 *
 * **`tip`** is the unit SEAM calibrated: one row per tip, leading with `r` — the chance that
 * tip's *first* candidate is right — and the rest of the list reachable with the arrows. It is
 * the default because the cutoff, `p_tip` and `r` were all fitted on first candidates, so a
 * row here is a suggestion somebody made.
 *
 * **`candidate`** is one row per (tip, candidate), leading with that candidate's own `conf`
 * (`p_tip × p_cand`). Nothing is calibrated at this grain — `r` does not exist for a rank 4 —
 * but it is how a reader works when the first candidate is clearly wrong and something further
 * down is clearly right, and it is the shape of the panel they already have.
 */
export type QueueMode = 'tip' | 'candidate'

/** One row of the queue: a tip, the candidate the row is about, and the number it leads with. */
export interface QueueRow {
  readonly tip: QueueTip
  /** Undefined only in `tip` mode, for a tip whose search found nothing within reach. */
  readonly candidate: Candidate | undefined
  /** `r` per tip, `conf` per candidate. Undefined where the set does not carry it. */
  readonly score: number | undefined
}

export interface QueueFilters {
  /** Keep tips whose `r` is at or above this. Undefined keeps every tip. */
  readonly minConfidence: number | undefined
  /** Keep tips whose **first** candidate is at least this many µm³. */
  readonly minVolumeUm3: number | undefined
  /** Keep only the tips SEAM shows — its own absolute cutoff, never one invented here. */
  readonly shownOnly: boolean
  readonly sortBy: SortBy
  readonly mode: QueueMode
}

export const DEFAULT_FILTERS: QueueFilters = {
  minConfidence: undefined,
  minVolumeUm3: undefined,
  shownOnly: false,
  sortBy: 'confidence',
  mode: 'tip',
}

/**
 * The queue as rows: narrowed, ordered, and at the grain the reader asked for.
 *
 * **Every filter reads the row's own candidate**, which is what makes the two modes behave the
 * same way: per tip that is the *first* candidate, so paging through a tip's others never makes
 * its row jump or vanish; per candidate it is the row itself.
 *
 * A tip with no candidates is kept in `tip` mode unless a filter asks about one — seventeen of
 * rv2's tips have an empty list, and "the model found nothing here" is an answer worth seeing.
 * It has no rows at all in `candidate` mode, where a row *is* a candidate.
 */
/**
 * Whether SEAM's cutoff kept this row — and **`true` where no cutoff was applied at all.**
 *
 * An absent `shown` column is not a row the cutoff excluded; it is a table nobody applied a
 * cutoff to. `seam:suggestMerges` publishes one: its ranking is geometric, and the calibration
 * `shown` comes from is a stage Coda cannot run yet. Read as `=== true`, every one of its rows
 * was hidden — the annotation layer in `seam:review` drew nothing, and `Shown only` emptied the
 * queue, both without a word.
 *
 * **A null cell means it too**, and that is not the same rule arriving twice. `tipsWithFirsts`
 * clears every first-candidate column when it searches a tip, so a `seam:suggestions` table fed
 * through `seam:suggestMerges` keeps its `shown` *column* and holds `null` in it — the old run's
 * verdict about a candidate this run replaced. Read as `=== true` those rows were hidden again,
 * which is the first fix walking into the second.
 *
 * Only an explicit `false` hides a row, so a set that was cut keeps being cut.
 */
function wasShown(table: TableValue, row: number): boolean {
  return table.data['shown']?.[row] !== false
}

export function arrangeRows(queue: readonly QueueTip[], filters: QueueFilters): QueueRow[] {
  const rows: QueueRow[] =
    filters.mode === 'candidate'
      ? queue.flatMap((tip) =>
          tip.candidates.map((candidate) => ({ tip, candidate, score: candidate.conf })),
        )
      : queue.map((tip) => ({ tip, candidate: tip.candidates[0], score: tip.r }))

  const kept = rows.filter((row) => {
    const shown = filters.mode === 'candidate' ? row.candidate?.shown : row.tip.shown
    if (filters.shownOnly && !shown) return false
    if (filters.minConfidence !== undefined && (row.score ?? 0) < filters.minConfidence) {
      return false
    }
    if (filters.minVolumeUm3 !== undefined) {
      const volume = row.candidate?.volumeUm3
      if (volume === undefined || volume < filters.minVolumeUm3) return false
    }
    return true
  })

  /*
   * **`-Infinity`, not `-1`.** The sentinel for "this row has no such number" has to sort below
   * every real one, and `-1` is inside the range of things being compared — a volume cannot be
   * negative but a confidence fit can, so an unmeasured row was sorting above a measured one.
   *
   * A table with no `r` at all — `seam:suggestMerges` publishes one, its ranking being
   * geometric — scores every row the same and falls through to the `end_uid` tie-break below,
   * which is the table's own order. That is the honest answer rather than a defect to patch
   * here: there is no confidence to sort by, and substituting a number on another scale (the
   * open-end score is a logit, not a chance) would sort, filter and *print* as though there
   * were.
   */
  const by = (row: QueueRow): number => {
    if (filters.sortBy === 'size') return row.candidate?.volumeUm3 ?? Number.NEGATIVE_INFINITY
    if (filters.sortBy === 'tip') return -row.tip.endUid
    return row.score ?? Number.NEGATIVE_INFINITY
  }
  /*
   * Descending, with the tip and then the rank breaking ties, so the order is the same on every
   * render — a list whose equal rows shuffle is one a reader cannot keep their place in.
   */
  return kept.sort(
    (a, b) =>
      by(b) - by(a) ||
      a.tip.endUid - b.tip.endUid ||
      (a.candidate?.rank ?? 0) - (b.candidate?.rank ?? 0),
  )
}

/** The tip and candidate a card is on, where both still exist. */
export interface CurrentItem {
  readonly tip: QueueTip
  readonly candidate: Candidate
}

/**
 * Resolve the cursor.
 *
 * By `end_uid` rather than by position, so a filter narrowing the list cannot move the cursor to
 * a different tip — which would have a reader judge the row above the one they were looking at.
 * A rank past the end of a tip's list falls back to its first candidate rather than to nothing:
 * paging past the end is a gesture, not an error.
 */
export function currentOfQueue(
  queue: readonly QueueTip[],
  current: string,
  rank: number,
): CurrentItem | undefined {
  const endUid = Number(String(current).trim())
  if (!Number.isFinite(endUid) || !String(current).trim()) return undefined
  const tip = queue.find((item) => item.endUid === endUid)
  if (!tip || tip.candidates.length === 0) return undefined
  const candidate = tip.candidates.find((item) => item.rank === rank) ?? tip.candidates[0]
  return candidate ? { tip, candidate } : undefined
}

/**
 * A verdict, keyed on the pair.
 *
 * Text rather than a nested object because this is a param: it is saved with the workflow, it is
 * in the provenance key, and a flat string is something a reader can see in the inspector and a
 * diff can show. `end_uid` is an integer and a candidate id is digits, so neither can hold the
 * separators.
 */
export type Verdicts = ReadonlyMap<string, Verdict>

export const verdictKey = (endUid: number, candidateId: string): string =>
  `${endUid}:${candidateId}`

export function decodeVerdicts(raw: unknown): Map<string, Verdict> {
  const out = new Map<string, Verdict>()
  for (const entry of String(raw ?? '').split(';')) {
    const at = entry.lastIndexOf('=')
    if (at <= 0) continue
    const key = entry.slice(0, at)
    const value = entry.slice(at + 1) as Verdict
    if (VERDICTS.includes(value)) out.set(key, value)
  }
  return out
}

/**
 * Write the verdicts back, in a stable order.
 *
 * Sorted, because this string is a param and a param is in the provenance key: an unordered
 * encoding would re-key the node — and so re-run everything downstream — every time a map
 * happened to iterate differently.
 */
export function encodeVerdicts(verdicts: Verdicts): string {
  return [...verdicts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(';')
}

/** The verdict on one pair, where there is one. */
export function verdictFor(
  verdicts: Verdicts,
  endUid: number,
  candidateId: string,
): Verdict | undefined {
  return verdicts.get(verdictKey(endUid, candidateId))
}

/** Set or clear one pair's verdict, returning a new map. Setting the same one again clears it. */
export function withVerdict(
  verdicts: Verdicts,
  endUid: number,
  candidateId: string,
  verdict: Verdict,
): Map<string, Verdict> {
  const out = new Map(verdicts)
  const key = verdictKey(endUid, candidateId)
  if (out.get(key) === verdict) out.delete(key)
  else out.set(key, verdict)
  return out
}

function text(table: TableValue, name: string, row: number): string | undefined {
  const cell: CellValue | undefined = table.data[name]?.[row]
  return typeof cell === 'string' && cell ? cell : undefined
}
