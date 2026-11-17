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
 * than one place. A verdict is about the piece and the neuron — **keyed on the two root ids**
 * (`verdictKey`), never on the tip — so it shows on every row the piece is on. The tip number
 * `end_uid` is a counter of one run: a re-run renumbers it, and an old verdict keyed on it would
 * attach to whichever tip took the number, on another neuron as likely as not (audit of 77c0625,
 * 2026-11-16). Keyed on the roots, a verdict survives a re-run while neither is edited and is
 * gone once either is — and an edited piece needs looking at again anyway.
 *
 * ## Filters are the reader's, and they never move the cursor
 *
 * The filters narrow what is *listed*; they do not decide what is a suggestion. `shown` is
 * SEAM's own absolute cutoff and travels as a column. The cursor is a tip's key (`tipKey`) rather
 * than a position in the list, so narrowing the list does not quietly move it to another tip —
 * which is the failure that would have a reader judge the row above the one they were looking at.
 *
 * ## One neuron is a seed and the pieces it was extended with
 *
 * `docs/seam-extend-plan.md` has the feature. A reader accepts a candidate and presses Extend;
 * Suggest Merges then searches that piece's open ends, and its tips arrive in the same table with
 * `ID` the piece and `seed` the neuron being grown. So a neuron in the picker is a **seed**, and
 * its queue is its own tips and those of every piece in its tree.
 *
 * **Which pieces those are is read from the card's own params, never from the rows** (`extend`
 * and the verdicts, `extendedPairs`) — the same pairs Suggest Merges is handed. The rows are what
 * the search has got round to; the params are what the reader asked for. A piece that was
 * un-accepted is gone from the list on that click (`liveQueue`), whether or not the search has
 * run again and dropped its rows.
 *
 * **Every tip is named by its root and its number together** (`tipKey`). Each piece is a run of
 * its own, and every one of them has a tip 0.
 */

import { groupBy } from '../../core/collections'
import { ID_COLUMN_NAME } from '../../core/ids'
import type { CellValue, TableValue } from '../../core/values'
import { formatNumber, plural } from '../../style/format'
import type { MergedSoFar } from './mergeRecord'
import type { ExtendPair, Piece } from './pieces'
import { piecesOf } from './pieces'
import { numberAt, pointAt } from './suggestionTables'

/** What a reader can say about a piece for a neuron. SEAM's vocabulary, in their words. */
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
  /**
   * How many level-2 chunks the candidate object occupies — **the size `seam:review` means.**
   *
   * `volumeUm3` is the candidate's voxels inside the search box, so it measures how much of
   * the piece is near the tip; two candidates with the same number can be a whole fragment and
   * the tail of something large. This is the chunkedgraph's own decomposition of the *object*,
   * wherever it reaches, which is the better proxy for the question a reader triaging a queue is
   * asking. Coarse by construction: a chunk is a fixed box of the volume, so small things are
   * one chunk and the number only separates them further up.
   *
   * Absent on a `seam:suggestions` table, whose parquet carries no chunk count — see `sizeOf`.
   */
  readonly l2Chunks: number | undefined
  readonly minDistUm: number | undefined
  /**
   * Where the two pieces meet, absolute nm — **undefined where the row does not say**, never
   * `[0, 0, 0]`: a zero is a real place, and a merge looked for there would be a merge somewhere
   * else (`mergeAnchors.ts` refuses it instead).
   */
  readonly contactNm: readonly [number, number, number] | undefined
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
  /** The root the tip is on: the neuron itself, or a piece it was extended with. */
  readonly neuronId: string
  /**
   * The neuron this tip belongs to once the accepted pieces are counted in — `neuronId` itself
   * where the table has no `seed` column, which is every published set.
   */
  readonly seed: string
  /** The end a piece joins the neuron by: published, never searched, and nothing to review. */
  readonly junction: boolean
  /**
   * What the run has done with this tip (`SEARCHED_FIELD`): searched, still to come, or never
   * going to be. A table with no such column is a published set, complete by definition.
   */
  readonly search: 'done' | 'waiting' | 'never'
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
    const neuronId = text(tips, ID_COLUMN_NAME, i) ?? ''
    const searched = tips.data['searched']?.[i]
    out.push({
      endUid,
      neuronId,
      seed: text(tips, 'seed', i) ?? neuronId,
      junction: tips.data['junction']?.[i] === true,
      search:
        !tips.data['searched'] || searched === true
          ? 'done'
          : searched === false
            ? 'never'
            : 'waiting',
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
      candidates: lists.get(tipKey(neuronId, endUid)) ?? [],
    })
  }
  return out
}

/** One neuron in the queue, as the card's picker lists it. */
export interface QueueNeuron {
  /** The seed: the neuron being grown, whichever of its pieces a tip is on. */
  readonly neuronId: string
  readonly tips: number
  /**
   * Pairs with a verdict among this neuron's tips, each once — counted over the candidates the
   * queue holds, so it agrees with the rows the `Verdicts` output publishes for this neuron.
   */
  readonly judged: number
}

/**
 * Every neuron in the queue, in the order `Tips` first lists it.
 *
 * Table order rather than any ranking because it is the order the search runs in —
 * `seam:suggestMerges` takes a table sorted by neuron in the order a reader sees it — so the first
 * neuron is the first one ready.
 */
export function neuronsOf(queue: readonly QueueTip[], verdicts: Verdicts): QueueNeuron[] {
  const counts = new Map<string, { tips: number; judged: Set<string> }>()
  const judged = piecesByNeuron(verdicts, () => true)
  for (const tip of queue) {
    let held = counts.get(tip.seed)
    if (!held) counts.set(tip.seed, (held = { tips: 0, judged: new Set() }))
    held.tips += 1
    const said = judged.get(tip.neuronId)
    if (!said) continue
    // A pair once however many tips list it: one verdict, one judgement. By the pair, since the
    // same piece can be judged on the neuron and again on a piece of it.
    for (const candidate of tip.candidates) {
      if (said.has(candidate.candidateId)) {
        held.judged.add(verdictKey(tip.neuronId, candidate.candidateId))
      }
    }
  }
  return [...counts].map(([neuronId, held]) => ({
    neuronId,
    tips: held.tips,
    judged: held.judged.size,
  }))
}

/**
 * The neuron the node is on: the stored root id where the queue holds it, else the first.
 *
 * **Never "every neuron"** — the node reviews one neuron at a time, and an empty choice means the
 * first rather than all of them.
 *
 * **A stored id the queue does not hold falls back to the first, quietly** (user, 2026-11-15),
 * which is the opposite of what a column picker does, for a reason that does not apply to a
 * column picker. A picker keeps a missing column because the schema has usually not *arrived*
 * yet. Here the neurons are rows of `Tips`, and every producer publishes all of them at once —
 * `seam:suggestMerges` lists every tip from its first partial, with `searched` null until it is
 * reached — so a root id that is absent is gone (edited, or a different set upstream), not late.
 * Nothing is written by the fallback, so the stored id comes back if the neuron does.
 */
export function pickedNeuron(queue: readonly QueueTip[], stored: string): string | undefined {
  const want = stored.trim()
  if (want && queue.some((tip) => tip.seed === want)) return want
  return queue[0]?.seed
}

/** The picked neuron's tips — its own and its pieces' — in queue order. Empty where none is. */
export function tipsOf(queue: readonly QueueTip[], neuronId: string | undefined): QueueTip[] {
  return neuronId === undefined ? [] : queue.filter((tip) => tip.seed === neuronId)
}

/**
 * A tip's identity: `end_uid` is a run's counter, so two runs stacked into one table share one —
 * and so do a neuron and every piece it was extended with. Also the cursor, as `current` holds it.
 */
export const tipKey = (neuronId: string, endUid: number) => `${neuronId}|${endUid}`

/** Every tip's candidates, in rank order, by `tipKey`: a row naming no neuron is no tip's. */
function candidateLists(table: TableValue | undefined): Map<string, Candidate[]> {
  const lists = new Map<string, Candidate[]>()
  if (!table) return lists
  for (let i = 0; i < table.length; i++) {
    const endUid = numberAt(table, 'end_uid', i)
    const neuronId = text(table, ID_COLUMN_NAME, i)
    const candidateId = text(table, 'candidateId', i)
    if (endUid === undefined || !neuronId || !candidateId) continue
    const key = tipKey(neuronId, endUid)
    const held = lists.get(key) ?? []
    held.push({
      candidateId,
      rank: numberAt(table, 'rank', i) ?? held.length + 1,
      geoRank: numberAt(table, 'geo_rank', i),
      volumeUm3: numberAt(table, 'vol_um3', i),
      l2Chunks: numberAt(table, 'n_l2', i),
      minDistUm: numberAt(table, 'min_dist_um', i),
      contactNm: pointAt(table, ['contact_x', 'contact_y', 'contact_z'], i),
      pCand: numberAt(table, 'p_cand', i),
      conf: numberAt(table, 'conf', i),
      shown: wasShown(table, i),
    })
    lists.set(key, held)
  }
  // Rank order, because the file's row order is nobody's promise and rank 1 is the suggestion.
  for (const list of lists.values()) list.sort((a, b) => a.rank - b.rank)
  return lists
}

/**
 * How many of these tips the run still has to search, or `undefined` where the table does not
 * say.
 *
 * Counts the tips still waiting in `searched`, which is `seam:suggestMerges`' three-state
 * statement about its own run (`searchTips.ts`): `true` searched, `false` never going to be,
 * `null` not yet. So the number is exact and reaches zero — a count of "rows with no answer"
 * would stall at whatever the node could not reach and read as a run that stopped early.
 *
 * **Absent means finished**, which is why this is `undefined` rather than 0: a `seam:suggestions`
 * table is a published set, complete by definition, and it carries no such column. Reported as a
 * number, a set with nothing left to search and a table that cannot say would print the same.
 *
 * **Over the tips that are listed** (`tipsOf` over `liveQueue`), not the table's rows: a piece
 * that is no longer extended keeps its rows in the table until the search next runs, and counted
 * there the foot would go on saying they are to come.
 */
export function stillToSearch(
  table: TableValue | undefined,
  listed: readonly QueueTip[],
): number | undefined {
  if (!table?.data['searched']) return undefined
  let waiting = 0
  for (const tip of listed) if (tip.search === 'waiting') waiting += 1
  return waiting
}

/** A candidate's size, and which quantity it is — the two have different units. */
export interface CandidateSize {
  readonly value: number
  /** `chunks` is the object's level-2 chunk count; `um3` its volume inside the search box. */
  readonly of: 'chunks' | 'um3'
}

/**
 * How big this candidate is, by the best measure the table carries.
 *
 * **Two quantities, and the card says which it is showing**, because they are not comparable: a
 * chunk count is of the whole object and a volume is of the part inside the search box, and the
 * numbers differ by orders of magnitude. `seam:suggestMerges` publishes `n_l2` and that is what
 * "size" means; a `seam:suggestions` set carries no chunk count — SEAM's own
 * `candidates.parquet` does not publish one — and falls back to the volume rather than losing
 * the control entirely.
 *
 * One table is one producer, so within a queue every row answers in the same unit and a sort is
 * never comparing the two. What a *reader* must not do is carry a number from one to the other,
 * which is why every row prints its unit.
 */
export function sizeOf(candidate: Candidate | undefined): CandidateSize | undefined {
  if (!candidate) return undefined
  if (candidate.l2Chunks !== undefined) return { value: candidate.l2Chunks, of: 'chunks' }
  if (candidate.volumeUm3 !== undefined) return { value: candidate.volumeUm3, of: 'um3' }
  return undefined
}

/**
 * A candidate's size as a row prints it, unit and all — the card's queue and Submit's overlay
 * alike, so one candidate never reads two ways.
 *
 * **Never a bare number.** `seam:suggestMerges` publishes a level-2 chunk count, which is of the
 * whole object; a published set carries only `vol_um3`, which is the part inside the search box.
 * The two differ by orders of magnitude and answer different questions, so a row that printed
 * `14` would be the one place a reader could confuse them — including when typing a number into
 * `Min size`, which reads whichever the table has.
 */
export function sizeLabel(size: CandidateSize | undefined): string {
  if (!size) return ''
  return size.of === 'chunks'
    ? plural(size.value, 'L2 chunk')
    : `${formatNumber(size.value)} µm³`
}

/** How far apart the search measured the two pieces, as a row prints it; empty where unmeasured. */
export function gapLabel(minDistUm: number | undefined): string {
  return minDistUm === undefined ? '' : `${minDistUm.toFixed(3)} µm apart`
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
  /**
   * Keep tips whose **first** candidate is at least this big, in whatever `sizeOf` answers in —
   * level-2 chunks where the table carries them, µm³ on a published set that does not.
   */
  readonly minSize: number | undefined
  /** Keep only the tips SEAM shows — its own absolute cutoff, never one invented here. */
  readonly shownOnly: boolean
  readonly sortBy: SortBy
  readonly mode: QueueMode
}

export const DEFAULT_FILTERS: QueueFilters = {
  minConfidence: undefined,
  minSize: undefined,
  shownOnly: false,
  sortBy: 'confidence',
  mode: 'tip',
}

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
export function arrangeRows(
  queue: readonly QueueTip[],
  filters: QueueFilters,
  /** Rows listed whatever the filters say — `arrangeTree`'s, for a row others hang beneath. */
  always: (row: QueueRow) => boolean = () => false,
): QueueRow[] {
  const rows: QueueRow[] =
    filters.mode === 'candidate'
      ? queue.flatMap((tip) =>
          tip.candidates.map((candidate) => ({ tip, candidate, score: candidate.conf })),
        )
      : queue.map((tip) => ({ tip, candidate: tip.candidates[0], score: tip.r }))

  const kept = rows.filter((row) => {
    if (always(row)) return true
    const shown = filters.mode === 'candidate' ? row.candidate?.shown : row.tip.shown
    if (filters.shownOnly && !shown) return false
    if (filters.minConfidence !== undefined && (row.score ?? 0) < filters.minConfidence) {
      return false
    }
    if (filters.minSize !== undefined) {
      const size = sizeOf(row.candidate)
      if (size === undefined || size.value < filters.minSize) return false
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
    if (filters.sortBy === 'size')
      return sizeOf(row.candidate)?.value ?? Number.NEGATIVE_INFINITY
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

/** A row of the list as it is drawn: under the row its piece was accepted on, and indented. */
export interface TreeRow extends QueueRow {
  /** How many accepted pieces lie between the neuron and this row's tip. */
  readonly depth: number
  /**
   * Per tip only: the extended piece whose ends hang beneath this row, as this tip lists it. The
   * row shows it rather than the tip's first candidate, or the rows beneath would be about a
   * piece the row above them does not name.
   */
  readonly hosted: Candidate | undefined
  /** The row's piece has no row above to hang beneath, so the row has to name it itself. */
  readonly adrift: boolean
}

/**
 * One neuron's rows in the order the card draws them: its own tips, and **beneath the row a
 * piece was accepted on, that piece's tips** — a level deeper for every piece, each level
 * narrowed and sorted on its own (`arrangeRows`) (user, 2026-11-16).
 *
 * - **Which row a piece hangs beneath** is the parent's tip that lists it at the smallest gap —
 *   the contact Suggest Merges takes the joining end from (`pieceContacts`), so the two agree on
 *   where a piece is attached. A piece touching the neuron in two places is listed under one.
 * - **That row is listed whatever the filters say.** Filtered out, the rows beneath it would
 *   hang from nothing, and it is a row the reader accepted and asked to have extended.
 * - **A piece none of its parent's tips lists** — its parent has no rows yet, or was searched
 *   by another run — goes after the parent's rows, a level in, and says which piece it is
 *   (`adrift`).
 *
 * `tips` is the neuron's (`tipsOf` over `liveQueue`) and `pieces` the tree (`liveTree`).
 */
export function arrangeTree(
  tips: readonly QueueTip[],
  seed: string | undefined,
  pieces: readonly Piece[],
  filters: QueueFilters,
): TreeRow[] {
  if (seed === undefined) return []
  const byRoot = groupBy(tips, (tip) => tip.neuronId)
  /*
   * Where each piece is listed nearest, found in **one walk of each parent's tips** for all of
   * its pieces together. Asked a piece at a time it was every candidate of the parent per
   * piece: 79 ms of a 104 ms list at two hundred pieces on a neuron of two thousand tips, on
   * every publish of a streaming search (measured 2026-11-16).
   */
  const own = pieces.filter((piece) => piece.seed === seed)
  const nearest = new Map<string, { tip: QueueTip; candidate: Candidate }>()
  for (const [parent, wanted] of groupBy(own, (piece) => piece.parent)) {
    const ids = new Set(wanted.map((piece) => piece.id))
    for (const tip of byRoot.get(parent) ?? []) {
      for (const candidate of tip.candidates) {
        // No contact point is no place to be joined at: the search takes none from it either.
        if (!ids.has(candidate.candidateId) || !candidate.contactNm) continue
        const best = nearest.get(candidate.candidateId)
        // Strictly nearer, so the first listing keeps a tie — as `pieceContacts` keeps it.
        if (!best || gapOf(candidate) < gapOf(best.candidate)) {
          nearest.set(candidate.candidateId, { tip, candidate })
        }
      }
    }
  }
  /** The pieces accepted at each tip, in tree order. */
  const hostedAt = new Map<QueueTip, Hosted[]>()
  for (const piece of own) {
    const host = nearest.get(piece.id)
    if (!host) continue
    const held = hostedAt.get(host.tip) ?? []
    held.push({ piece: piece.id, candidate: host.candidate })
    hostedAt.set(host.tip, held)
  }
  /** Those with no tip to be under, by parent. */
  const adrift = groupBy(
    own.filter((piece) => !nearest.has(piece.id)),
    (piece) => piece.parent,
  )
  // Per candidate the row beneath which a piece hangs is the piece's own; per tip, its tip's.
  const hostedBy = (row: QueueRow): readonly Hosted[] => {
    const here = hostedAt.get(row.tip)
    if (!here) return NONE_HOSTED
    return filters.mode === 'candidate'
      ? here.filter((one) => one.candidate === row.candidate)
      : here
  }
  const always = (row: QueueRow) => hostedBy(row).length > 0
  const out: TreeRow[] = []
  const list = (root: string, depth: number, lost: boolean) => {
    const rows = arrangeRows(byRoot.get(root) ?? [], filters, always)
    for (const row of rows) {
      const hosted = hostedBy(row)
      /*
       * Written onto the row `arrangeRows` just made, which is this function's own: a second
       * object per row was a quarter to a half again on top of the sort where a row is a
       * candidate and a neuron has three hundred thousand of them.
       */
      const made = row as QueueRow & {
        depth: number
        hosted: Candidate | undefined
        adrift: boolean
      }
      made.depth = depth
      made.hosted = filters.mode === 'tip' ? hosted[0]?.candidate : undefined
      made.adrift = lost
      out.push(made)
      /*
       * Per tip the row names one piece — the first accepted there. A second piece accepted on
       * the same tip hangs beneath it too, and its rows say which piece they are on, or a
       * reader would take them for ends of the piece the row above names.
       */
      for (const [at, one] of hosted.entries()) {
        list(one.piece, depth + 1, filters.mode === 'tip' && at > 0)
      }
    }
    for (const piece of adrift.get(root) ?? []) list(piece.id, depth + 1, true)
  }
  list(seed, 0, false)
  return out
}

/** A piece as one tip lists it, for the rows that hang beneath that tip's row. */
interface Hosted {
  readonly piece: string
  readonly candidate: Candidate
}
const NONE_HOSTED: readonly Hosted[] = []

/** How far a candidate is from the neuron where the search measured it; unmeasured is last. */
const gapOf = (candidate: Candidate) => candidate.minDistUm ?? Number.POSITIVE_INFINITY

/** The tip and candidate a card is on, where both still exist. */
export interface CurrentItem {
  readonly tip: QueueTip
  readonly candidate: Candidate
}

/**
 * Resolve the cursor.
 *
 * By the tip's key (`tipKey`) rather than by position, so a filter narrowing the list cannot move
 * the cursor to a different tip — which would have a reader judge the row above the one they were
 * looking at. **Not by `end_uid` alone**: a neuron and each of its pieces number their tips from
 * the same start. A cursor saved as a bare number, before pieces, resolves to nothing.
 *
 * A rank past the end of a tip's list falls back to its first candidate rather than to nothing:
 * paging past the end is a gesture, not an error.
 */
export function currentOfQueue(
  queue: readonly QueueTip[],
  current: string,
  rank: number,
): CurrentItem | undefined {
  const key = String(current).trim()
  // `tipKey`, taken apart once rather than built again for every tip on every render.
  const at = key.lastIndexOf('|')
  if (at <= 0) return undefined
  const neuronId = key.slice(0, at)
  const number = key.slice(at + 1)
  // `Number('')` is 0, and tip 0 is a real tip: a cursor cut short is on nothing.
  if (!/^\d+$/.test(number)) return undefined
  const endUid = Number(number)
  const tip = queue.find((item) => item.endUid === endUid && item.neuronId === neuronId)
  if (!tip || tip.candidates.length === 0) return undefined
  const candidate = tip.candidates.find((item) => item.rank === rank) ?? tip.candidates[0]
  return candidate ? { tip, candidate } : undefined
}

/**
 * What a piece in the scene is, which decides its colour (`controlPartColor` downstream).
 *
 * `neuron` and `candidate` are the pair under the cursor; `accepted` is a piece the reader already
 * said belongs, shown so the scene is the neuron as it will look once the merges are made.
 */
export type ScenePart = 'neuron' | 'candidate' | 'accepted'

export interface ScenePiece {
  readonly id: string
  readonly part: ScenePart
}

/**
 * The segments to show, in order: the pair under the cursor, then every accepted piece.
 *
 * **Accepted is a fact about the piece, not the pair.** A piece accepted on any of the neuron's
 * tips is going to be merged, so it is green wherever it appears — including as the candidate
 * under the cursor, which is what makes pressing Accept visibly land.
 *
 * With no cursor and `showAccepted` on, the neuron still leads: accepted pieces mean nothing
 * floating on their own. With no cursor and it off, there is nothing to show, as before.
 *
 * Every id once, the first row deciding — which is also how the Neuroglancer node reads it.
 * `tips` is the picked neuron's, so nothing here can reach another neuron's pieces.
 *
 * **Once Submit has merged into the neuron** (`merged`, `mergedSoFar` over the record), the neuron
 * is shown at its root now, and a piece merged — into it, or into another reviewed neuron — is not
 * shown as itself: it is part of that neuron's root (`stillToMerge`).
 */
export function scenePieces(
  tips: readonly QueueTip[],
  neuronId: string | undefined,
  here: CurrentItem | undefined,
  verdicts: Verdicts,
  showAccepted: boolean,
  merged?: MergedSoFar,
  accepted: ReadonlyMap<string, readonly AcceptedRow[]> = acceptedPieces(tips, verdicts),
): ScenePiece[] {
  const toMerge = showAccepted ? stillToMerge(accepted, merged) : []
  const isAccepted = new Set(toMerge)
  const out: ScenePiece[] = []
  const seen = new Set<string>()
  const add = (id: string | undefined, part: ScenePart) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push({ id, part })
  }
  // `here` is one of `tips`, all of them `neuronId`'s, so the neuron is the same either way.
  // A neuron this workflow merged into another is drawn as that one: its own root is retired.
  if (here || showAccepted) {
    add(merged?.absorbedInto ?? merged?.currentRoot ?? neuronId, 'neuron')
  }
  /*
   * The piece the tip under the cursor is on, where that is not the neuron itself. It is an
   * accepted piece — that is how its tips came to be listed — and it is shown whatever `Show
   * accepted` says: a candidate beside a neuron, with the piece it would be merged onto not
   * drawn between them, is a pair nobody can judge.
   */
  const on = here?.tip.neuronId
  if (on !== undefined && on !== here?.tip.seed && mergedAs(merged, on) === undefined) {
    add(on, 'accepted')
  }
  const id = here?.candidate.candidateId
  if (id !== undefined && mergedAs(merged, id) === undefined) {
    add(id, isAccepted.has(id) ? 'accepted' : 'candidate')
  }
  for (const id of toMerge) add(id, 'accepted')
  return out
}

/** One accepted row: the tip the piece was accepted at, and the piece as the queue holds it. */
export interface AcceptedRow {
  /**
   * The root the tip is on: the neuron itself, or the piece of it the candidate was accepted on
   * — which is what a merge of it has to be made onto (`mergePlan.ts`).
   */
  readonly neuronId: string
  readonly endUid: number
  readonly candidate: Candidate
}

/**
 * Every accepted piece among these tips, one per candidate root, in the order the reader met them;
 * each with its rows nearest gap first (an unmeasured gap last), then by rank.
 *
 * **The one rule for "accepted"**: the piece's verdict for the tip's own neuron (`verdictKey`) —
 * one per pair, so every row of the piece says the same. The scene's green pieces (`scenePieces`)
 * and Submit's plan (`mergePlan.ts`) both read it here, so the neuron shown "as it will look once
 * you make the merges" is the one the merges make. `tips` is the picked neuron's (`tipsOf`).
 */
export function acceptedPieces(
  tips: readonly QueueTip[],
  verdicts: Verdicts,
): Map<string, AcceptedRow[]> {
  const pieces = new Map<string, AcceptedRow[]>()
  /*
   * The accepted pieces by neuron first, so a tip of a neuron with none is skipped whole and a
   * candidate is a set lookup, with no key built: a neuron is thousands of tips of ten candidates,
   * a reader accepts a handful, and this runs on every render of the card (0.3 ms against 2.7 ms
   * for a key per candidate at 3,000 tips, measured 2026-11-16).
   */
  const accepted = piecesByNeuron(verdicts, (verdict) => verdict === 'accept')
  for (const tip of tips) {
    const mine = accepted.get(tip.neuronId)
    if (!mine) continue
    for (const candidate of tip.candidates) {
      if (!mine.has(candidate.candidateId)) continue
      const rows = pieces.get(candidate.candidateId) ?? []
      rows.push({ neuronId: tip.neuronId, endUid: tip.endUid, candidate })
      pieces.set(candidate.candidateId, rows)
    }
  }
  for (const rows of pieces.values()) {
    rows.sort(
      (a, b) => gapOf(a.candidate) - gapOf(b.candidate) || a.candidate.rank - b.candidate.rank,
    )
  }
  return pieces
}

/**
 * The accepted pieces Submit has still to merge, in the reader's order: those not already in the
 * neuron or in another reviewed neuron by this workflow's record. **The one rule** for the green
 * pieces, the card's Submit count and its rows.
 */
export function stillToMerge(
  accepted: ReadonlyMap<string, readonly AcceptedRow[]>,
  merged: MergedSoFar | undefined,
): string[] {
  return [...accepted.keys()].filter((id) => mergedAs(merged, id) === undefined)
}

/** Where Submit has put a piece, by the record: into the neuron, into another one, or nowhere. */
export function mergedAs(
  merged: MergedSoFar | undefined,
  id: string,
): 'merged' | 'elsewhere' | undefined {
  if (merged?.pieces.has(id)) return 'merged'
  return merged?.elsewhere.has(id) ? 'elsewhere' : undefined
}

/**
 * A verdict, keyed on the neuron and the piece (the header says why not the tip).
 *
 * Text rather than a nested object because this is a param: it is saved with the workflow, it is
 * in the provenance key, and a flat string is something a reader can see in the inspector and a
 * diff can show. Both ids are digits, so neither can hold the separators.
 *
 * **A key of the old shape, `${endUid}:${candidateId}`, is kept and never read** (user,
 * 2026-11-16): it stays in the param, so nothing a reader said is deleted, but its tip number may
 * name another tip by now, so it is no verdict on anything. `/` rather than `:` so no old key can
 * be read as a new one.
 */
export type Verdicts = ReadonlyMap<string, Verdict>

export const verdictKey = (neuronId: string, candidateId: string): string =>
  `${neuronId}/${candidateId}`

/** A key's two ids, or undefined for one of the old shape (or a hand edit). */
export function verdictPair(
  key: string,
): { neuronId: string; candidateId: string } | undefined {
  const at = key.indexOf('/')
  if (at <= 0 || at === key.length - 1) return undefined
  return { neuronId: key.slice(0, at), candidateId: key.slice(at + 1) }
}

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

/** The pieces with a verdict `keep` takes, by neuron; a key of the old shape is none. */
function piecesByNeuron(
  verdicts: Verdicts,
  keep: (verdict: Verdict) => boolean,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [key, verdict] of verdicts) {
    const pair = keep(verdict) ? verdictPair(key) : undefined
    if (!pair) continue
    let held = out.get(pair.neuronId)
    if (!held) out.set(pair.neuronId, (held = new Set()))
    held.add(pair.candidateId)
  }
  return out
}

/** The verdict on one pair, where there is one. */
export function verdictFor(
  verdicts: Verdicts,
  neuronId: string,
  candidateId: string,
): Verdict | undefined {
  return verdicts.get(verdictKey(neuronId, candidateId))
}

/** Set or clear one pair's verdict, returning a new map. Setting the same one again clears it. */
export function withVerdict(
  verdicts: Verdicts,
  neuronId: string,
  candidateId: string,
  verdict: Verdict,
): Map<string, Verdict> {
  const out = new Map(verdicts)
  const key = verdictKey(neuronId, candidateId)
  if (out.get(key) === verdict) out.delete(key)
  else out.set(key, verdict)
  return out
}

/**
 * The pieces the reader asked to have extended, as the `extend` param holds them: verdict keys —
 * `parent/piece` — joined and sorted the way the verdicts are, and for `encodeVerdicts`' reason.
 *
 * **Pairs, not piece ids**, so the tree can be read from the params alone: that is what lets
 * Suggest Merges be handed it through a reference wire, before this card has ever run.
 */
export function decodeExtend(raw: unknown): Set<string> {
  const out = new Set<string>()
  for (const entry of String(raw ?? '').split(';')) {
    const key = entry.trim()
    if (verdictPair(key)) out.add(key)
  }
  return out
}

export function encodeExtend(keys: Iterable<string>): string {
  return [...new Set(keys)].sort().join(';')
}

/** `extend` with one pair added or taken out. */
export function withExtended(raw: unknown, parent: string, piece: string, on: boolean): string {
  const keys = decodeExtend(raw)
  if (on) keys.add(verdictKey(parent, piece))
  else keys.delete(verdictKey(parent, piece))
  return encodeExtend(keys)
}

/**
 * What is extended: a pair in `extend` whose verdict is still `accept` — **the one rule**, read by
 * the `Extended` output, by the reference Suggest Merges holds to this card, and by the card.
 *
 * Whether a pair can be *reached* from a neuron is not asked here: that takes the neurons, which
 * are rows of a table, and this must answer from the params alone. `piecesOf` asks it, on both
 * sides, of these same pairs.
 */
export function extendedPairs(extend: unknown, verdicts: Verdicts): ExtendPair[] {
  return pairsOf(extendedKeys(extend, verdicts))
}

/**
 * `extendedPairs` as the keys the param holds, sorted. For a reader that wants to know whether
 * the set *moved*: joined, it is a string, and a string compares by value where a fresh array of
 * pairs never does — the card memoises on it, so a verdict that extends nothing re-sorts nothing.
 */
export function extendedKeys(extend: unknown, verdicts: Verdicts): string[] {
  return [...decodeExtend(extend)].filter((key) => verdicts.get(key) === 'accept').sort()
}

/** Keys as pairs, in the order given. */
export function pairsOf(keys: Iterable<string>): ExtendPair[] {
  const out: ExtendPair[] = []
  for (const key of keys) {
    const pair = verdictPair(key)
    if (pair) out.push({ parent: pair.neuronId, piece: pair.candidateId })
  }
  return out
}

/**
 * The pieces each neuron of the queue is extended with — the tree, by `piecesOf`, which is the
 * derivation Suggest Merges searches by. The neurons are the queue's seeds in table order.
 */
export function liveTree(queue: readonly QueueTip[], pairs: readonly ExtendPair[]): Piece[] {
  return piecesOf(pairs, [...new Set(queue.map((tip) => tip.seed))])
}

/**
 * The tips there are to review: each neuron's own, and those of the pieces in its tree.
 *
 * Two kinds of row are left out. **A tip of a piece that is not in the tree** — un-accepted, or
 * no longer extended, with the search not yet run again to drop it; the verdicts made on it stay
 * in the param, unread, and count again if the piece comes back. And **a junction**, the end a
 * piece joins the neuron by, which was never searched and is no open end.
 */
export function liveQueue(queue: readonly QueueTip[], pieces: readonly Piece[]): QueueTip[] {
  const seedOf = new Map(pieces.map((piece) => [piece.id, piece.seed]))
  return queue.filter(
    (tip) =>
      !tip.junction && (tip.neuronId === tip.seed || seedOf.get(tip.neuronId) === tip.seed),
  )
}

/** How many pieces were extended beyond this one, and so go with it if it goes. */
function piecesBeyond(pieces: readonly Piece[], id: string): number {
  return pieces.filter((piece) => piece.id !== id && piece.path.includes(id)).length
}

/**
 * What a press on a verdict button does: what it writes, and whether a search is to be started.
 *
 * **The verdict, and the pair kept in step with it in `extend`, in one edit.** After the press
 * the pair is extended where it is accepted and either was extended already or `Auto-extend`
 * asks for it:
 *
 * - a pair no longer accepted is taken out. Left in, accepting the piece again would start its
 *   search without anybody pressing Extend. The pieces beyond it keep their own entries: they
 *   are unreachable until this one is extended again, and back when it is;
 * - with `Auto-extend` on (user, 2026-11-16), a press that accepts a piece puts the pair in —
 *   **unless the piece cannot be extended** (`blocked`, `extendBlocked`'s answer) **or is
 *   large** (`isLargePiece`), which is left to its button.
 *
 * `search` is true where the press extended the piece, so the card runs the search it would
 * have run for a press on Extend. Decided here rather than on the card: these are the rules a
 * reader's click is held to, and a component is where a rule goes untested.
 */
export function judgedParams(
  /** The card's params: `verdicts`, `extend` and `autoExtend` are read. */
  params: Readonly<Record<string, unknown>>,
  neuronId: string,
  candidate: Candidate,
  verdict: Verdict,
  /** Why the piece cannot be extended, where it cannot. */
  blocked: string | undefined,
): { write: { verdicts: string; extend?: string }; search: boolean } {
  const { candidateId } = candidate
  const next = withVerdict(decodeVerdicts(params['verdicts']), neuronId, candidateId, verdict)
  const verdicts = encodeVerdicts(next)
  const key = verdictKey(neuronId, candidateId)
  const extended = decodeExtend(params['extend'])
  const has = extended.has(key)
  const auto =
    params['autoExtend'] === true && blocked === undefined && !isLargePiece(candidate)
  const want = next.get(key) === 'accept' && (has || auto)
  if (want === has) return { write: { verdicts }, search: false }
  if (want) extended.add(key)
  else extended.delete(key)
  return { write: { verdicts, extend: encodeExtend(extended) }, search: want }
}

/**
 * From this many level-2 chunks a piece is large: the Extend button says so, and `Auto-extend`
 * leaves it to the button (user, 2026-11-16).
 *
 * Measured, not chosen (`docs/seam-extend-plan.md`, phase 0): below it a piece's open ends were
 * found in under 2 s and it had a handful of them; from 41 chunks the median was 6 s and 73 tips,
 * 21 s at 496 chunks and 150 s at 2,704 — before any end is searched. Said, never refused
 * (`docs/limits.md`): one press still extends it.
 */
export const LARGE_PIECE_CHUNKS = 41

/** Whether a piece is large by its chunk count; a size in µm³ (a published set) never is. */
export function isLargePiece(candidate: Candidate | undefined): boolean {
  const size = sizeOf(candidate)
  return size?.of === 'chunks' && size.value >= LARGE_PIECE_CHUNKS
}

/** What the Extend button's title says of a large piece (`LARGE_PIECE_CHUNKS`). */
const LARGE_PIECE_NOTE =
  'That is large: finding the open ends of a piece this size took 6 s or more when it was ' +
  'measured, and minutes for a piece of thousands of chunks, before any of them is searched.'

/** Why a piece cannot be extended, or `undefined` where it can. */
export function extendBlocked(at: {
  /** Whether the card's `Extended` output is wired back to a node that searches. */
  wired: boolean
  /** Where Submit has put the piece (`mergedAs`). */
  done: 'merged' | 'elsewhere' | undefined
  /** Edited since it was suggested (`rootCurrency`). */
  outdated: boolean
}): string | undefined {
  if (!at.wired) {
    return (
      'Wire this card’s `Extended` output into the `Review` input of the Suggest Merges node ' +
      'these suggestions come from. Suggestions read from a published set cannot be extended.'
    )
  }
  if (at.done === 'merged') {
    return (
      'Merged by Submit, so it is part of the neuron now. Run the search again on the ' +
      'neuron’s new root to go on from here.'
    )
  }
  if (at.done === 'elsewhere') return 'Merged into another neuron by Submit.'
  if (at.outdated) {
    return 'This piece has been edited since it was suggested, so its ends are not these any more.'
  }
  return undefined
}

/**
 * What stops being listed when an extended piece stops being extended, as the end of a sentence:
 * its own ends, and every piece that was extended beyond it. Said before the click that does it.
 */
export function leavesWith(pieces: readonly Piece[], piece: string): string {
  const beyond = piecesBeyond(pieces, piece)
  return beyond === 0
    ? 'takes its ends off the list'
    : `takes its ends, and those of the ${plural(beyond, 'piece')} extended beyond it, off the list`
}

/**
 * The Extend button of an accepted row: what it reads, what its title says, and whether it can
 * be pressed. One function, as `submitPress` is for Submit, so the three cannot disagree.
 *
 * Extended, it says how far the search has got, and a press stops extending — always allowed,
 * whatever would stand in the way of starting. Not extended, it is off with the reason where
 * the piece cannot be extended, and otherwise says how big the piece is before the press.
 */
export function extendPress(at: {
  candidate: Candidate
  /** How far the search has got; `undefined` where the piece is not extended. */
  progress: ExtendProgress | undefined
  /** `extendBlocked`'s answer. */
  blocked: string | undefined
  autoExtend: boolean
  /** `leavesWith`'s answer, for a piece that is extended. */
  goesWith: string
}): { label: string; title: string; disabled: boolean } {
  if (at.progress) {
    return {
      label: extendLabel(at.progress),
      title:
        'This piece’s own open ends are searched and listed with the neuron’s. Press to stop ' +
        `extending it, which ${at.goesWith}.`,
      disabled: false,
    }
  }
  const large = isLargePiece(at.candidate)
  const label = large ? 'Extend (large)' : 'Extend'
  if (at.blocked !== undefined) return { label, title: at.blocked, disabled: true }
  const size = sizeOf(at.candidate)
  return {
    label,
    title: [
      'Search this piece’s own open ends for what continues it.',
      size ? `It is ${sizeLabel(size)}.` : '',
      large ? LARGE_PIECE_NOTE : '',
      large && at.autoExtend ? 'Auto-extend leaves a piece this size to this button.' : '',
    ]
      .filter(Boolean)
      .join(' '),
    disabled: false,
  }
}

/**
 * Whether a piece is in the neuron already by another road: accepted on some other piece of it,
 * and not on this row's. A second accept would be a second merge of one piece, so the row's
 * verdict is fixed. Submit's plan leans on this: it places a piece the way `piecesOf` does
 * (`acceptedTree`), which is the card's tree for as long as a piece is accepted on one root.
 */
export function acceptedElsewhere(
  /** The neuron's accepted pieces (`acceptedPieces`). */
  accepted: ReadonlyMap<string, unknown>,
  /** This row's own verdict on the piece. */
  said: Verdict | undefined,
  candidateId: string,
): boolean {
  return said !== 'accept' && accepted.has(candidateId)
}

/** Said on the chip and on the verdict buttons of a piece `acceptedElsewhere`. */
export const IN_NEURON_NOTE = 'Accepted already, on another piece of this neuron.'

const VERDICT_HELP: Record<Verdict, string> = {
  accept: 'This piece belongs to the neuron. Submit merges the accepted pieces.',
  reject: 'This piece does not belong.',
  unsure: 'Cannot tell. Left out of any calibration, rather than counted as wrong.',
}

/**
 * A verdict button: what its title says and whether it can be pressed — the third of the row's
 * buttons to have its rule here (`extendPress`, `submitPress`).
 *
 * A verdict is fixed once Submit has merged the piece, and where the piece is in the neuron
 * already by another road. On an extended piece the title says what a change takes with it.
 */
export function verdictPress(at: {
  verdict: Verdict
  /** Where Submit has put the piece (`mergedAs`). */
  done: 'merged' | 'elsewhere' | undefined
  /** `acceptedElsewhere`'s answer. */
  inNeuron: boolean
  /** `leavesWith`'s answer for an extended piece; empty otherwise. */
  goesWith: string
}): { title: string; disabled: boolean } {
  if (at.done) return { title: 'Merged by Submit.', disabled: true }
  if (at.inNeuron) return { title: IN_NEURON_NOTE, disabled: true }
  const help = VERDICT_HELP[at.verdict]
  return {
    title: at.goesWith
      ? `${help} This piece is extended: changing its verdict ${at.goesWith}.`
      : help,
    disabled: false,
  }
}

/**
 * How far the search of an extended piece has got, read off the rows it has published.
 *
 * There is no table of piece states (`docs/seam-extend-plan.md`, Decisions), so this is all the
 * card can know: a piece with no rows once the search has finished had nothing to search, or
 * failed — and the reason for a failure is a warning on the Suggest Merges card.
 */
export type ExtendProgress =
  /** Asked for, the search under way, and none of its tips published yet. */
  | { readonly state: 'waiting' }
  | { readonly state: 'searching' | 'stopped'; readonly done: number; readonly of: number }
  | { readonly state: 'searched'; readonly ends: number }
  /** Tips, and none of them an open end to search: the joining end, or outside the volume. */
  | { readonly state: 'no ends' }
  /** No rows from a search that finished. */
  | { readonly state: 'nothing' }
  /** No rows, and no search that could have produced any. */
  | { readonly state: 'not run' }
  /** No rows, and the search ended in an error: the reason is on the node that searches. */
  | { readonly state: 'failed' }

export function extendProgress(
  /** The whole queue as the tables hold it — junctions included, which `liveQueue` drops. */
  queue: readonly QueueTip[],
  seed: string,
  piece: string,
  search: {
    readonly running: boolean
    readonly finished: boolean
    /** The search ended in an error — a run that could not score at all, say. */
    readonly failed?: boolean
  },
): ExtendProgress {
  const rows = queue.filter((tip) => tip.seed === seed && tip.neuronId === piece)
  if (rows.length === 0) {
    if (search.running) return { state: 'waiting' }
    if (search.finished) return { state: 'nothing' }
    return { state: search.failed ? 'failed' : 'not run' }
  }
  const open = rows.filter((tip) => !tip.junction && tip.search !== 'never')
  if (open.length === 0) return { state: 'no ends' }
  const done = open.filter((tip) => tip.search === 'done').length
  if (done === open.length) return { state: 'searched', ends: done }
  return { state: search.running ? 'searching' : 'stopped', done, of: open.length }
}

/** `ExtendProgress` as the Extend button says it. */
export function extendLabel(progress: ExtendProgress): string {
  switch (progress.state) {
    case 'waiting':
      return 'waiting…'
    case 'searching':
      return `searching ${formatNumber(progress.done)} of ${formatNumber(progress.of)}`
    case 'stopped':
      return `${formatNumber(progress.done)} of ${plural(progress.of, 'end')} searched`
    case 'searched':
      return `${plural(progress.ends, 'end')} searched`
    case 'no ends':
      return 'no open ends'
    case 'nothing':
      return 'nothing to search'
    case 'not run':
      return 'not searched yet'
    case 'failed':
      return 'search failed'
  }
}

function text(table: TableValue, name: string, row: number): string | undefined {
  const cell: CellValue | undefined = table.data[name]?.[row]
  return typeof cell === 'string' && cell ? cell : undefined
}
