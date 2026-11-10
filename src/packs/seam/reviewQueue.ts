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
    const endUid = num(tips, 'end_uid', i)
    if (endUid === undefined) continue
    out.push({
      endUid,
      neuronId: text(tips, 'neuronId', i) ?? '',
      kind: text(tips, 'kind', i) ?? 'tip',
      tipNm: [num(tips, 'x', i) ?? 0, num(tips, 'y', i) ?? 0, num(tips, 'z', i) ?? 0],
      r: num(tips, 'r', i),
      q: num(tips, 'q', i),
      pTip: num(tips, 'p_tip', i),
      shown: tips.data['shown']?.[i] === true,
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
    const endUid = num(table, 'end_uid', i)
    const candidateId = text(table, 'candidateId', i)
    if (endUid === undefined || !candidateId) continue
    const held = lists.get(endUid) ?? []
    held.push({
      candidateId,
      rank: num(table, 'rank', i) ?? held.length + 1,
      geoRank: num(table, 'geo_rank', i),
      volumeUm3: num(table, 'vol_um3', i),
      minDistUm: num(table, 'min_dist_um', i),
      contactNm: [
        num(table, 'contact_x', i) ?? 0,
        num(table, 'contact_y', i) ?? 0,
        num(table, 'contact_z', i) ?? 0,
      ],
      pCand: num(table, 'p_cand', i),
      conf: num(table, 'conf', i),
      shown: table.data['shown']?.[i] === true,
    })
    lists.set(endUid, held)
  }
  // Rank order, because the file's row order is nobody's promise and rank 1 is the suggestion.
  for (const list of lists.values()) list.sort((a, b) => a.rank - b.rank)
  return lists
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

  const by = (row: QueueRow): number => {
    if (filters.sortBy === 'size') return row.candidate?.volumeUm3 ?? -1
    if (filters.sortBy === 'tip') return -row.tip.endUid
    return row.score ?? -1
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

function num(table: TableValue, name: string, row: number): number | undefined {
  const cell: CellValue | undefined = table.data[name]?.[row]
  return typeof cell === 'number' && Number.isFinite(cell) ? cell : undefined
}

function text(table: TableValue, name: string, row: number): string | undefined {
  const cell: CellValue | undefined = table.data[name]?.[row]
  return typeof cell === 'string' && cell ? cell : undefined
}
