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
 * and the verdicts, `extendedKeys`) — the same pairs Suggest Merges is handed. The rows are what
 * the search has got round to; the params are what the reader asked for. A piece that was
 * un-accepted is gone from the list on that click (`liveQueue`), whether or not the search has
 * run again and dropped its rows.
 *
 * **Except what Auto-extend took** (`docs/seam-auto-extend-plan.md`): the reader presses it on a
 * piece, and the search accepts and extends what clears SEAM's cutoff beyond it. Those pieces are
 * grown from the published rows by the rule the search grew them by (`reviewGrowth`, `growAuto`),
 * and their accepts are never written — `autoJudged` adds them wherever an accept is read.
 *
 * **Every tip is named by its root and its number together** (`tipKey`). Each piece is a run of
 * its own, and every one of them has a tip 0.
 */

import { groupBy } from '../../core/collections'
import { ID_COLUMN_NAME } from '../../core/ids'
import type { CellValue, TableValue } from '../../core/values'
import { formatNumber, plural } from '../../style/format'
import type { MergedSoFar } from './mergeRecord'
import type { AutoGrowth, ExtendPlan, Piece } from './pieces'
import {
  AUTO_DEPTH,
  LARGE_PIECE_CHUNKS,
  autoTakes,
  growAuto,
  nearerClaim,
  pairsOf,
  verdictKey,
  verdictPair,
} from './pieces'
import { SOURCE_COLUMN, numberAt, pointAt } from './suggestionTables'

/**
 * What a reader can say about a piece for a neuron. SEAM's vocabulary, in their words, and one of
 * Coda's: `ends` is a rejection whose reason is that the neuron ends at this tip, where `reject`
 * is a wrong continuation (user, 2026-11-18) — two different mistakes for SEAM to learn from.
 * Only `accept` merges.
 */
export type Verdict = 'accept' | 'reject' | 'ends' | 'unsure'

export const VERDICTS: readonly Verdict[] = ['accept', 'reject', 'ends', 'unsure']

/** The verdicts behind the row's split button (`VerdictButtons.tsx`, user, 2026-11-18). */
export const NOT_ACCEPT: readonly Verdict[] = ['reject', 'ends', 'unsure']

/** The split button's face: the row's own verdict where it is one of `NOT_ACCEPT`, else Reject. */
export function faceOf(said: Verdict | undefined): Verdict {
  return said !== undefined && NOT_ACCEPT.includes(said) ? said : NOT_ACCEPT[0]!
}

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
   * Absent where the table carries none — see `sizeOf`.
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
  /**
   * Whether the search flags it as an organelle (`organelle`, `searchTips.ts`): a piece wrapped
   * inside one cell. Only an explicit `true` — a set that carries no flag flags nothing, and
   * absent reads the same.
   */
  readonly organelle?: boolean
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
  /**
   * SEAM's estimate of how often a first candidate at this tip's `q` is right — a staircase of a
   * few wide steps over `q`, fitted on judged tips (refitted 2026-11-18: 7 steps in production, 9
   * in the single seed, each on at least 20 tips). **A label only** (SEAM, 2026-11-18): never
   * sorted, filtered or summed on (`estimateLabel`).
   */
  readonly r: number | undefined
  /**
   * SEAM's score for the tip's first candidate — what the queue sorts and filters on, and what
   * the cutoff behind `shown` is a value of. `p_tip × p_split`, or `p_tip × p_cand` of the first
   * in the single-seed configuration; each configuration's own, never compared across them.
   */
  readonly q: number | undefined
  /** The chance anything belongs at this tip at all, before which piece. */
  readonly pTip: number | undefined
  readonly shown: boolean
  /**
   * Whether the table says, in so many words, that the first candidate cleared SEAM's cutoff —
   * what Auto-extend takes (`autoTakes`). Not `shown`, which reads a table with no such column
   * (a search with no assessor) as shown throughout.
   */
  readonly cleared: boolean
  /** Which `q`, cutoff and `r` these numbers are (`SOURCE_COLUMN`); what a sent verdict is filed by. */
  readonly source: string | undefined
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
      cleared: tips.data['shown']?.[i] === true,
      source: text(tips, SOURCE_COLUMN, i),
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
  // One unit per table (`sizeOf`): where any row has a chunk count, a row without one has no size.
  const chunked = table.data['n_l2']?.some((count) => typeof count === 'number') === true
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
      volumeUm3: chunked ? undefined : numberAt(table, 'vol_um3', i),
      l2Chunks: numberAt(table, 'n_l2', i),
      minDistUm: numberAt(table, 'min_dist_um', i),
      contactNm: pointAt(table, ['contact_x', 'contact_y', 'contact_z'], i),
      pCand: numberAt(table, 'p_cand', i),
      conf: numberAt(table, 'conf', i),
      shown: wasShown(table, i),
      organelle: table.data['organelle']?.[i] === true,
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
 * numbers differ by orders of magnitude. `n_l2` is what "size" means — `seam:suggestMerges`
 * publishes it, and so does a `seam:suggestions` set from rv4 on; a set made before carries no
 * chunk count and falls back to the volume rather than losing the control entirely.
 *
 * **One unit per table**, decided where the candidates are read (`candidateLists`): a table with
 * any chunk count drops the volume from every row, so a row missing its count has no size rather
 * than one in µm³, and a sort or `Min size` never compares the two. What a *reader* must not do
 * is carry a number from one table to the other, which is why every row prints its unit.
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
 * **Never a bare number.** A level-2 chunk count is of the whole object; `vol_um3`, `sizeOf`'s
 * fallback, is the part inside the search box.
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
  /**
   * Undefined only in `tip` mode: for a tip whose search found nothing within reach, or whose
   * every candidate is an organelle that `Exclude organelles` passed over.
   */
  readonly candidate: Candidate | undefined
  /**
   * `q` per tip, `conf` per candidate — what the row sorts and filters on (SEAM, 2026-11-18: `r`
   * is a staircase over `q`, so sorting on it only adds ties). Undefined where the set does not
   * carry it — and on a row that passed over its first candidate, since SEAM's `q` there is its
   * number for the one passed over.
   */
  readonly score: number | undefined
  /** Per tip, the `r` beside `score`, for its label alone (`QueueTip.r`). */
  readonly estimate?: number
  /** Whether the row clears SEAM's cutoff: the tip's verdict per tip, the candidate's per candidate. */
  readonly shown: boolean
  /**
   * Per tip, with `Exclude organelles` on: the tip's first candidate is an organelle, so the row
   * leads with the next that is not (user, 2026-11-17 — hidden, its second candidate may be the
   * continuation and out of sight), with no `q`, no `r`, and never shown: every calibrated number
   * describes the first candidate, and the next has only its own `conf` (SEAM, 2026-11-18).
   */
  readonly passedOver?: true
}

/**
 * A tip's row: its first candidate, or with organelles excluded the first that is not one.
 *
 * **A row that passes over its first candidate carries no numbers** (user, 2026-11-18, after
 * SEAM's note: "the filter hides; it should not promote"). `q`, the cutoff and `r` all describe
 * the first candidate; the next has only its own `conf`, shown in its facts, which on rv4 reached
 * the cutoff for 1 of 1,548 such tips. Coda's re-scoring of the list without its organelles
 * (2026-11-17) went for the same reason: a number nobody calibrated, under a calibrated name.
 * An organelle further down a list changes nothing about its tip's row.
 */
function tipRow(tip: QueueTip, excludeOrganelles: boolean): QueueRow {
  const first = tip.candidates[0]
  if (!excludeOrganelles || !first?.organelle) {
    return { tip, candidate: first, ...scored(tip.q, tip.r), shown: tip.shown }
  }
  return {
    tip,
    candidate: tip.candidates.find((one) => !one.organelle),
    score: undefined,
    shown: false,
    passedOver: true,
  }
}

/** A tip row's `score` and the `estimate` beside it, the second only where there is one. */
function scored(q: number | undefined, r: number | undefined) {
  return { score: q, ...(r === undefined ? {} : { estimate: r }) }
}

/**
 * `r` as a reader should see it — rounded to tens, an estimate (SEAM, 2026-11-18). Two decimals
 * would claim a precision a staircase of a few steps fitted on a few hundred judged tips does not
 * have, and one step averages very different tips, so the ends are open rather than rounded to
 * 0% or 100%.
 */
export function estimateLabel(r: number): string {
  if (r >= 0.9) return '≥90%'
  if (r < 0.1) return '<10%'
  return `≈${Math.round(r * 10) * 10}%`
}

export interface QueueFilters {
  /**
   * Keep rows whose `score` is at or above this — `q` per tip, `conf` per candidate (user,
   * 2026-11-18, after SEAM's note: never `r`). Undefined keeps every row.
   */
  readonly minConfidence: number | undefined
  /**
   * Keep tips whose **first** candidate is at least this big, in whatever `sizeOf` answers in —
   * level-2 chunks where the table carries them, µm³ on a published set that does not.
   */
  readonly minSize: number | undefined
  /** Leave out a row whose candidate is flagged as an organelle (`Candidate.organelle`). */
  readonly excludeOrganelles: boolean
  readonly sortBy: SortBy
  readonly mode: QueueMode
}

export const DEFAULT_FILTERS: QueueFilters = {
  minConfidence: undefined,
  minSize: undefined,
  // The node's own default (`seam:review`'s `excludeOrganelles`): a set with no flag is unchanged.
  excludeOrganelles: true,
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
          tip.candidates.map((candidate) => ({
            tip,
            candidate,
            score: candidate.conf,
            shown: candidate.shown,
          })),
        )
      : queue.map((tip) => tipRow(tip, filters.excludeOrganelles))

  const kept = rows.filter((row) => {
    if (always(row)) return true
    // Per candidate only: per tip, `tipRow` has already led with a candidate that is not one.
    if (filters.excludeOrganelles && row.candidate?.organelle) return false
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
   * A table with no `q` at all — `seam:suggestMerges` publishes one, its ranking being
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
 * `tips` is the neuron's (`tipsOf` over `liveQueue`) and `pieces` the tree (`reviewGrowth`).
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
 * said belongs, shown so the scene is the neuron as it will look once the merges are made. `focus`
 * is the candidate under the cursor where it is accepted — by the reader or by Auto-extend — in a
 * lighter green, so the piece being looked at stands out in a chain of green ones (user,
 * 2026-11-18).
 */
export type ScenePart = 'neuron' | 'candidate' | 'accepted' | 'focus'

export interface ScenePiece {
  readonly id: string
  readonly part: ScenePart
}

/**
 * The segments to show, in order: the pair under the cursor, then every accepted piece.
 *
 * **Accepted is a fact about the piece, not the pair.** A piece accepted on any of the neuron's
 * tips is going to be merged, so it is green wherever it appears — and as the candidate under the
 * cursor a lighter green (`focus`), which is what makes pressing Accept visibly land and the piece
 * in hand stand out among the others.
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
    add(id, isAccepted.has(id) ? 'focus' : 'candidate')
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
  /** The tip itself, for what describes the row whole (`verdictInput`). */
  readonly tip: QueueTip
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
      rows.push({ neuronId: tip.neuronId, endUid: tip.endUid, candidate, tip })
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

export function decodeVerdicts(raw: unknown): Map<string, Verdict> {
  const out = new Map<string, Verdict>()
  for (const [parent, item] of groupedItems(raw, (old) => {
    // A key of the old shape, `${endUid}:${candidateId}=accept`: kept, never read.
    const at = old.lastIndexOf('=')
    const value = old.slice(at + 1) as Verdict
    if (at > 0 && VERDICTS.includes(value)) out.set(old.slice(0, at).trim(), value)
  })) {
    const at = item.lastIndexOf('=')
    const said = at > 0 ? verdictOfText(item.slice(at + 1).trim()) : undefined
    if (said) out.set(`${parent}/${item.slice(0, at).trim()}`, said)
  }
  return out
}

/**
 * Write the verdicts back, in a stable order, grouped by parent with one letter per verdict:
 * `parent/piece=a,piece=r;parent/piece=u` (user, 2026-11-19, to keep a long campaign inside the
 * browser's storage: 21 characters a verdict rather than 45). `decodeVerdicts` reads the flat
 * form it replaced, `parent/piece=accept;…`, as groups of one.
 *
 * Sorted, because this string is a param and a param is in the provenance key: an unordered
 * encoding would re-key the node — and so re-run everything downstream — every time a map
 * happened to iterate differently.
 */
export function encodeVerdicts(verdicts: Verdicts): string {
  const legacy: string[] = []
  const pairs: string[] = []
  for (const key of verdicts.keys()) (verdictPair(key) ? pairs : legacy).push(key)
  const said = (key: string) => VERDICT_LETTER[verdicts.get(key)!]
  return [
    ...legacy.sort().map((key) => `${key}=${verdicts.get(key)!}`),
    ...groupedPairs(pairs, (key, piece) => `${piece}=${said(key)}`),
  ].join(';')
}

/** One letter per verdict in the param. */
const VERDICT_LETTER: Readonly<Record<Verdict, string>> = {
  accept: 'a',
  reject: 'r',
  ends: 'e',
  unsure: 'u',
}

function verdictOfText(text: string): Verdict | undefined {
  if (VERDICTS.includes(text as Verdict)) return text as Verdict
  return VERDICTS.find((verdict) => VERDICT_LETTER[verdict] === text)
}

/**
 * Pair keys as the params write them: each parent once, `parent/item,item`, parents and their
 * items in sorted order — grouped by the parent read off each key, so the text has one spelling
 * whatever characters an id holds.
 */
function groupedPairs(
  keys: readonly string[],
  item: (key: string, piece: string) => string,
): string[] {
  const byParent = new Map<string, string[]>()
  for (const key of [...keys].sort()) {
    const slash = key.indexOf('/')
    const parent = key.slice(0, slash)
    const items = byParent.get(parent) ?? []
    if (items.length === 0) byParent.set(parent, items)
    items.push(item(key, key.slice(slash + 1)))
  }
  return [...byParent.keys()]
    .sort()
    .map((parent) => `${parent}/${byParent.get(parent)!.join(',')}`)
}

/**
 * `groupedPairs`' text read back: each `(parent, item)`, trimmed, the flat form it replaced being
 * groups of one. A segment with no `/` is not a group; `other` is handed it, where it is wanted.
 */
function* groupedItems(
  raw: unknown,
  other?: (segment: string) => void,
): Generator<readonly [string, string]> {
  for (const segment of String(raw ?? '').split(';')) {
    const slash = segment.indexOf('/')
    if (slash < 0) {
      other?.(segment)
      continue
    }
    const parent = segment.slice(0, slash).trim()
    if (!parent) continue
    for (const item of segment.slice(slash + 1).split(',')) {
      if (item.trim()) yield [parent, item.trim()]
    }
  }
}

/**
 * The parents a pair param names — the head of each segment — without reading its pairs: what
 * `withRecentWork` asks of every press, at a few hundred slices where decoding the verdicts is
 * thousands of pairs.
 */
export function pairParents(raw: unknown): string[] {
  const out: string[] = []
  for (const segment of String(raw ?? '').split(';')) {
    const slash = segment.indexOf('/')
    const parent = slash > 0 ? segment.slice(0, slash).trim() : ''
    if (parent) out.push(parent)
  }
  return out
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
  for (const [parent, piece] of groupedItems(raw)) {
    const key = `${parent}/${piece}`
    if (verdictPair(key)) out.add(key)
  }
  return out
}

/** Grouped by parent as the verdicts are (`encodeVerdicts`): `parent/piece,piece;parent/piece`. */
export function encodeExtend(keys: Iterable<string>): string {
  const pairs = [...new Set(keys)].filter((key) => verdictPair(key))
  return groupedPairs(pairs, (_key, piece) => piece).join(';')
}

/** `extend` with one pair added or taken out. */
export function withExtended(raw: unknown, parent: string, piece: string, on: boolean): string {
  const keys = decodeExtend(raw)
  if (on) keys.add(verdictKey(parent, piece))
  else keys.delete(verdictKey(parent, piece))
  return encodeExtend(keys)
}

/**
 * What is extended: a pair in `extend` whose verdict is still `accept`, or that Auto-extend was
 * pressed on with no verdict at all — which only `Auto-extend listed` writes, accepting on SEAM's
 * word (`PlanTexts.taken`). **The one rule**, read by
 * the `Extended` output, by the reference Suggest Merges holds to this card, and by the card —
 * as the keys the param holds, sorted. Joined, it is a string, and a string compares by value
 * where a fresh array of pairs never does — the card memoises on it, so a verdict that extends
 * nothing re-sorts nothing.
 *
 * Whether a pair can be *reached* from a neuron is not asked here: that takes the neurons, which
 * are rows of a table, and this must answer from the params alone. `piecesOf` asks it, on both
 * sides, of these same pairs.
 */
export function extendedKeys(
  extend: unknown,
  verdicts: Verdicts,
  /** The pairs Auto-extend was pressed on (`autoRoots`). */
  pressed: ReadonlySet<string> = new Set(),
): string[] {
  return [...decodeExtend(extend)]
    .filter((key) => {
      const said = verdicts.get(key)
      return said === 'accept' || (said === undefined && pressed.has(key))
    })
    .sort()
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

/**
 * The plan as three texts of sorted keys, which compare by value — what the card memoises on, so
 * a press that changes none of them rebuilds no tree.
 *
 * - `extend`: the pairs extended (`extendedKeys`);
 * - `autoRoots`: those of them Auto-extend was pressed on;
 * - `refused`: the pairs Auto-extend could take that the reader gave a verdict other than accept
 *   (`autoRefused`, written by the press, `judgedParams`) — **only while an Auto-extend is live**,
 *   and empty otherwise. A reject of a piece Auto-extend took must reach the search, which cannot
 *   be told from the params which pieces those are; so the press, which can, writes it down. A
 *   reject of anything else moves no key: every one would otherwise retire a search in flight
 *   (`docs/seam-auto-extend-plan.md`).
 */
export interface PlanTexts {
  readonly extend: string
  readonly autoRoots: string
  readonly refused: string
  /**
   * The Auto-extend presses the reader has said nothing of: `Auto-extend listed` made them, on
   * SEAM's word (`listedAutoParams`) — no other press is written without an accept. Each is
   * accepted by Auto-extend, not by the reader (`autoJudged`). Not part of the plan the search is
   * told: to it they are presses like any other.
   */
  readonly taken: string
}

export function planTexts(
  params: Readonly<Record<string, unknown>>,
  stored: Verdicts,
): PlanTexts {
  const pressed = decodeExtend(params['autoRoots'])
  const keys = extendedKeys(params['extend'], stored, pressed)
  const live = new Set(keys)
  const roots = [...pressed].filter((key) => live.has(key))
  // A press with no verdict is extended only as one `Auto-extend listed` made (`extendedKeys`).
  const taken = roots.filter((key) => !stored.has(key))
  // The press wrote these (`judgedParams`); one the reader has since accepted or cleared is none.
  const refused =
    roots.length === 0
      ? []
      : [...decodeExtend(params['autoRefused'])].filter((key) => {
          const said = stored.get(key)
          return said !== undefined && said !== 'accept'
        })
  return {
    extend: encodeExtend(keys),
    autoRoots: encodeExtend(roots),
    refused: encodeExtend(refused),
    taken: encodeExtend(taken),
  }
}

/** The plan the texts say. */
export function planOfTexts(texts: Omit<PlanTexts, 'taken'>): ExtendPlan {
  return {
    pairs: pairsOf(decodeExtend(texts.extend)),
    roots: new Set(pairsOf(decodeExtend(texts.autoRoots)).map((pair) => pair.piece)),
    refused: decodeExtend(texts.refused),
  }
}

/**
 * What the card's params tell the search: the pieces extended, which of them Auto-extend was
 * pressed on, and what Auto-extend must not take — **from the params alone**, as a reference
 * requires (`asReference`).
 */
export function extendPlanFrom(
  params: Readonly<Record<string, unknown>>,
  stored: Verdicts,
): ExtendPlan {
  return planOfTexts(planTexts(params, stored))
}

/**
 * The first candidates Auto-extend takes at a piece's ends, **read off the published rows** — the
 * same rule (`autoTakes`) the search applies to the ends it has finished, so the card grows the
 * tree the search grew. Only searched ends of the piece in its own neuron, in its tips' order.
 * The queue is grouped on the first call: with no Auto-extend live there is none.
 */
export function autoFirsts(queue: readonly QueueTip[]): (piece: Piece) => string[] {
  let byPiece: Map<string, QueueTip[]> | undefined
  return (piece) =>
    ((byPiece ??= groupBy(queue, (tip) => tip.neuronId)).get(piece.id) ?? []).flatMap((tip) => {
      const first = tip.seed === piece.seed ? autoFirstOf(tip) : undefined
      return first === undefined ? [] : [first]
    })
}

/** The first candidate Auto-extend would take at a tip, where it would (`autoTakes`). */
function autoFirstOf(tip: QueueTip): string | undefined {
  const first = tip.candidates[0]
  if (tip.junction || tip.search !== 'done' || !first) return undefined
  const takes = autoTakes({
    shown: tip.cleared,
    organelle: first.organelle,
    l2Chunks: first.l2Chunks,
    id: first.candidateId,
  })
  return takes ? first.candidateId : undefined
}

/**
 * Every pair Auto-extend could take anywhere in the queue, as keys — what the card narrows its
 * refusals to. `growAuto` asks a refusal only of such a pair, so a reject of anything else changes
 * no tree, and with this the card rebuilds none for it (100 ms a click at two thousand tips).
 */
export function autoOffered(queue: readonly QueueTip[]): ReadonlySet<string> {
  const out = new Set<string>()
  for (const tip of queue) {
    const first = autoFirstOf(tip)
    if (first !== undefined) out.add(verdictKey(tip.neuronId, first))
  }
  return out
}

/** The tree the card lists: every neuron's pieces, with what Auto-extend took grown on. */
export function reviewGrowth(queue: readonly QueueTip[], plan: ExtendPlan): AutoGrowth {
  // The neurons are the queue's seeds, in table order.
  return growAuto(plan, [...new Set(queue.map((tip) => tip.seed))], autoFirsts(queue))
}

/**
 * The verdicts as everything downstream reads them, and the accepts that are Auto-extend's alone.
 *
 * - `verdicts`: the reader's, and an accept for each pair Auto-extend took that the reader has
 *   said nothing about. Never written to the param — an Auto-extend accept is the search's word,
 *   and a reader's press is the only verdict there is;
 * - `unjudged`: those pairs, each to the piece Auto-extend was pressed on — what the card tags
 *   `auto`, counts in its foot, and Submit's dialog marks.
 */
export function autoJudged(
  stored: Verdicts,
  accepted: ReadonlyMap<string, string>,
  /**
   * The presses `Auto-extend listed` made (`planTexts().taken`): accepted on SEAM's word too, each
   * to itself, being its own press.
   */
  taken: ReadonlySet<string> = new Set(),
): { verdicts: Verdicts; unjudged: ReadonlyMap<string, string> } {
  if (accepted.size === 0 && taken.size === 0) return { verdicts: stored, unjudged: accepted }
  const verdicts = new Map(stored)
  const unjudged = new Map<string, string>()
  const take = (key: string, root: string) => {
    if (verdicts.has(key)) return
    verdicts.set(key, 'accept')
    unjudged.set(key, root)
  }
  for (const [key, root] of accepted) take(key, root)
  for (const key of taken) take(key, verdictPair(key)?.candidateId ?? '')
  return { verdicts, unjudged }
}

/**
 * Everything the card works out of its params and the queue, in one call — **the one derivation**
 * for a reader with no card in hand: `evaluate`, and Submit's plan. The card makes the same calls
 * one memo at a time (`planTexts`, `planOfTexts`, `reviewGrowth`, `autoJudged`).
 */
export function reviewStateOf(
  params: Readonly<Record<string, unknown>>,
  queue: readonly QueueTip[],
): {
  stored: Verdicts
  plan: ExtendPlan
  growth: AutoGrowth
  verdicts: Verdicts
  unjudged: ReadonlyMap<string, string>
} {
  const stored = decodeVerdicts(params['verdicts'])
  const texts = planTexts(params, stored)
  const plan = planOfTexts(texts)
  const growth = reviewGrowth(queue, plan)
  return {
    stored,
    plan,
    growth,
    ...autoJudged(stored, growth.accepted, decodeExtend(texts.taken)),
  }
}

/**
 * How an accepted row's piece is extended: by the reader's own press (`choice`), or by an
 * Auto-extend further up that took and searches it (`held`, `autoFrom`). Read by the Extend
 * button and its menu.
 */
export function rowExtend(
  /** The row's pair; `undefined` for a row with no candidate, which nothing extends. */
  key: string | undefined,
  at: {
    /** The pairs the reader extended (`planTexts().extend`). */
    readonly extended: ReadonlySet<string>
    /** Those of them Auto-extend was pressed on. */
    readonly autoPressed: ReadonlySet<string>
    /** Everything Auto-extend took (`AutoGrowth.accepted`), judged since or not. */
    readonly accepted: ReadonlyMap<string, string>
    /** Those of them the reader has not judged (`autoJudged().unjudged`): the `auto` tag. */
    readonly unjudged: ReadonlyMap<string, string>
    /** The pieces whose ends are searched (`AutoGrowth.searched`), by id. */
    readonly searched: ReadonlySet<string>
  },
): {
  choice: ExtendChoice
  /** The press that took it, while the reader has not judged it: the row's `auto` tag. */
  autoFrom: string | undefined
  /** The press that took it, judged since or not: what the Extend button names. */
  heldBy: string | undefined
  held: boolean
  extended: boolean
} {
  if (key === undefined) {
    return {
      choice: 'off',
      autoFrom: undefined,
      heldBy: undefined,
      held: false,
      extended: false,
    }
  }
  const choice: ExtendChoice = !at.extended.has(key)
    ? 'off'
    : at.autoPressed.has(key)
      ? 'auto'
      : 'extend'
  // An Accept on a piece Auto-extend took makes the verdict the reader's, and the search goes on
  // taking and searching it: it is held all the same.
  const heldBy = at.accepted.get(key)
  const piece = verdictPair(key)?.candidateId
  const held =
    heldBy !== undefined && choice === 'off' && piece !== undefined && at.searched.has(piece)
  return {
    choice,
    autoFrom: at.unjudged.get(key),
    heldBy,
    held,
    extended: choice !== 'off' || held,
  }
}

/** How many pieces were extended beyond this one, and so go with it if it goes. */
function piecesBeyond(pieces: readonly Piece[], id: string): number {
  return pieces.filter((piece) => piece.id !== id && piece.path.includes(id)).length
}

/**
 * What a press on a verdict button does: what it writes, and whether a search is to be started.
 *
 * **The verdict, and the pair kept in step with it in `extend`, in one edit.** After the press
 * the pair is extended where it is accepted and either was extended already or `Extend on accept`
 * asks for it:
 *
 * - a pair no longer accepted is taken out. Left in, accepting the piece again would start its
 *   search without anybody pressing Extend. The pieces beyond it keep their own entries: they
 *   are unreachable until this one is extended again, and back when it is;
 * - with `Extend on accept` on (user, 2026-11-16), a press that accepts a piece puts the pair in —
 *   **unless the piece cannot be extended** (`blocked`, `extendBlocked`'s answer) **or is
 *   large** (`isLargePiece`), which is left to its button.
 *
 * `search` is true where the press extended the piece, so the card runs the search it would
 * have run for a press on Extend. `said` is the pair's verdict after the press — none where it
 * took the verdict back — which is what the card sends (`verdictInput`). Decided here rather than on the card: these are the rules a
 * reader's click is held to, and a component is where a rule goes untested.
 */
export function judgedParams(
  /** The card's params: `verdicts`, `extend`, `autoRoots`, `autoRefused`, `extendOnAccept`. */
  params: Readonly<Record<string, unknown>>,
  neuronId: string,
  candidate: Candidate,
  verdict: Verdict,
  /** Why the piece cannot be extended, where it cannot. */
  blocked: string | undefined,
  /** Whether Auto-extend could take this pair (`autoOffered`): a refusal of it is written down. */
  offered = false,
): {
  write: { verdicts: string; extend?: string; autoRoots?: string; autoRefused?: string }
  search: boolean
  said: Verdict | undefined
} {
  const { candidateId } = candidate
  const next = withVerdict(decodeVerdicts(params['verdicts']), neuronId, candidateId, verdict)
  const verdicts = encodeVerdicts(next)
  const key = verdictKey(neuronId, candidateId)
  const has = decodeExtend(params['extend']).has(key)
  const onAccept =
    params['extendOnAccept'] === true && blocked === undefined && !isLargePiece(candidate)
  const said = next.get(key)
  const want = said === 'accept' && (has || onAccept)
  /*
   * What Auto-extend must not take, kept in step with the verdict: a pair it could take that is
   * now refused goes in, and one accepted or cleared comes out.
   */
  const refusedNow = decodeExtend(params['autoRefused']).has(key)
  const refuse = said !== undefined && said !== 'accept' && (offered || refusedNow)
  const refusal =
    refuse === refusedNow
      ? {}
      : { autoRefused: withExtended(params['autoRefused'], neuronId, candidateId, refuse) }
  if (want === has) return { write: { verdicts, ...refusal }, search: false, said }
  const write: { verdicts: string; extend: string; autoRoots?: string; autoRefused?: string } =
    {
      verdicts,
      extend: withExtended(params['extend'], neuronId, candidateId, want),
      ...refusal,
    }
  // An Auto-extend press goes with the pair it was pressed on: un-accepted, it is gone too.
  if (!want && decodeExtend(params['autoRoots']).has(key)) {
    write.autoRoots = withExtended(params['autoRoots'], neuronId, candidateId, false)
  }
  return { write, search: want, said }
}

/** How a piece is extended by the reader's own press: by hand, by Auto-extend, or not at all. */
export type ExtendChoice = 'extend' | 'auto' | 'off'

/**
 * What choosing Extend, Auto-extend or neither on a row writes — one edit, one undo step. An
 * Auto-extend press is also in `extend`, so everything that asks "is it extended" asks one param.
 *
 * **A piece Auto-extend took is confirmed by the press**: its accept is written as the reader's,
 * since `extend` counts only a pair the reader accepted (`extendedKeys`) — and a reader who
 * chose to extend a piece has judged it.
 */
export function extendParams(
  params: Readonly<Record<string, unknown>>,
  neuronId: string,
  candidateId: string,
  choice: ExtendChoice,
  /** Whether the pair is accepted by Auto-extend alone (`autoJudged().unjudged`). */
  unjudged: boolean,
  /** The pairs Auto-extend could take (`autoOffered`). */
  offered: ReadonlySet<string> = new Set(),
): ExtendWrite {
  const write: ExtendWrite = {
    extend: withExtended(params['extend'], neuronId, candidateId, choice !== 'off'),
    autoRoots: withExtended(params['autoRoots'], neuronId, candidateId, choice === 'auto'),
  }
  const stored = decodeVerdicts(params['verdicts'])
  if (choice !== 'off' && unjudged) {
    write.verdicts = encodeVerdicts(withVerdict(stored, neuronId, candidateId, 'accept'))
  }
  if (choice === 'auto') Object.assign(write, refusalsBefore(params, stored, offered))
  return write
}

/** What an Extend or Auto-extend press writes: one edit, one undo step. */
// A type, not an interface: written as params, it needs an index signature an interface lacks.
type ExtendWrite = {
  extend: string
  autoRoots: string
  verdicts?: string
  autoRefused?: string
}

/**
 * **An Auto-extend press writes down the refusals made before it** that it could now take: a
 * reject given while the pair was not one Auto-extend could take (before an assessor ran, say)
 * was not written down by its press (`judgedParams`), and Auto-extend would take it.
 */
function refusalsBefore(
  params: Readonly<Record<string, unknown>>,
  stored: Verdicts,
  offered: ReadonlySet<string>,
): { autoRefused?: string } {
  const refused = decodeExtend(params['autoRefused'])
  const before = refused.size
  for (const [key, said] of stored) {
    if (said !== 'accept' && offered.has(key)) refused.add(key)
  }
  return refused.size === before ? {} : { autoRefused: encodeExtend(refused) }
}

/**
 * The pairs `Auto-extend listed` presses Auto-extend on (user, 2026-11-19): of the rows listed —
 * as filtered, scrolled into view or not — each showing its tip's first candidate where
 * Auto-extend would take it (`autoOffered`), **unless the reader gave it a verdict other than
 * accept** (the rule Auto-extend keeps further out), or it is in the neuron already by another
 * road (`acceptedElsewhere`) **or extended already** (`rowExtend`: by hand, by its own press, or
 * by one further up) — and only where **the row's own Auto-extend item** (`extendMenu`) would
 * start one, so anything that greys that item out keeps the row out here too. Leaving extended
 * pieces alone also keeps out the one row a filter cannot hide: a row hosting an extended piece.
 *
 * A piece two listed rows offer goes to one parent (`nearerClaim`, `growAuto`'s rule), since
 * accepting it twice would be two merges of one piece. Cheapest test first: per candidate the
 * list is every candidate of every tip, and only a tip's first can be taken.
 */
export function listedAutoPairs(
  rows: readonly TreeRow[],
  at: Parameters<typeof rowExtend>[1] & {
    /** The pairs Auto-extend could take (`autoOffered`). */
    readonly offered: ReadonlySet<string>
    /** The reader's own verdicts. */
    readonly stored: Verdicts
    /** The verdicts everything reads (`autoJudged().verdicts`). */
    readonly verdicts: Verdicts
    /** The neuron's accepted pieces (`acceptedPieces`). */
    readonly acceptedHere: ReadonlyMap<string, unknown>
    /** Why a piece cannot be extended, where it cannot (`extendBlocked`). */
    readonly blocked: (candidateId: string) => string | undefined
  },
): string[] {
  const claims = new Map<string, { key: string; depth: number; id: string }>()
  for (const row of rows) {
    const { tip } = row
    const first = tip.candidates[0]
    if (!first || (row.hosted ?? row.candidate) !== first) continue
    const key = verdictKey(tip.neuronId, first.candidateId)
    if (!at.offered.has(key) || first.candidateId === tip.seed) continue
    const said = at.stored.get(key)
    if (said !== undefined && said !== 'accept') continue
    if (acceptedElsewhere(at.acceptedHere, at.verdicts.get(key), first.candidateId)) continue
    // Extended already — by the reader's own choice, or by a press further up — is left alone:
    // turning a hand Extend into an Auto-extend would override a choice the reader made.
    const { choice, held } = rowExtend(key, at)
    if (choice !== 'off' || held) continue
    const auto = extendMenu({
      choice,
      held,
      blocked: at.blocked(first.candidateId),
      noAuto: undefined,
    }).find((item) => item.value === 'auto')
    if (!auto || auto.disabled || auto.writes !== 'auto') continue
    const claim = { key, depth: row.depth, id: tip.neuronId }
    if (nearerClaim(claim, claims.get(first.candidateId))) claims.set(first.candidateId, claim)
  }
  return [...claims.values()].map((claim) => claim.key)
}

/**
 * What `Auto-extend listed` writes for its pairs (`listedAutoPairs`) — one edit, one undo step:
 * what `extendParams` writes for one Auto-extend press, for each — the pair in `extend` and
 * `autoRoots`, and the refusals it could now take — **except the accept**. One the reader has
 * said nothing of stays without a verdict, and a press with none is read as accepted on SEAM's
 * word (`planTexts().taken`, user, 2026-11-19): tagged `auto`, and sent to SEAM as
 * `auto-accepted` if Submit merges it.
 */
export function listedAutoParams(
  params: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  /** The pairs Auto-extend could take (`autoOffered`). */
  offered: ReadonlySet<string>,
): ExtendWrite {
  const extend = decodeExtend(params['extend'])
  const roots = decodeExtend(params['autoRoots'])
  for (const key of keys) {
    extend.add(key)
    roots.add(key)
  }
  return {
    extend: encodeExtend(extend),
    autoRoots: encodeExtend(roots),
    ...refusalsBefore(params, decodeVerdicts(params['verdicts']), offered),
  }
}

/** Whether a piece is large by its chunk count; a size in µm³ (`sizeOf`'s fallback) never is. */
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
  extendOnAccept: boolean
  /** `leavesWith`'s answer, for a piece that is extended. */
  goesWith: string
  /** How the reader extended it (`rowExtend`). */
  choice: ExtendChoice
  /** Taken and searched by an Auto-extend further up, not by a press of its own (`rowExtend`). */
  held: boolean
  /** The piece that Auto-extend was pressed on, where it took this one (`rowExtend().autoFrom`). */
  heldBy: string | undefined
  /** For an Auto-extend press: how many pieces it has taken so far. */
  took: number
}): { label: string; title: string; disabled: boolean; writes: ExtendChoice } {
  // A press on the face extends by hand, or stops extending what the reader extended.
  const writes: ExtendChoice = at.choice === 'off' ? 'extend' : 'off'
  // Searched by an Auto-extend further up. A piece on its last layer is not held, and is offered
  // Extend like any other below.
  if (at.held && at.progress) {
    return {
      label: extendLabel(at.progress),
      title: `Accepted and extended by the Auto-extend on ${at.heldBy}. ${AUTO_REJECT_NOTE}`,
      disabled: true,
      writes,
    }
  }
  if (at.progress) {
    const auto = at.choice === 'auto'
    return {
      label: auto ? `auto · ${extendLabel(at.progress)}` : extendLabel(at.progress),
      title: [
        'This piece’s own open ends are searched and listed with the neuron’s.',
        auto ? `${AUTO_EXTEND_RULE} ${plural(at.took, 'piece')} so far.` : '',
        `Press to stop extending it, which ${at.goesWith}.`,
      ]
        .filter(Boolean)
        .join(' '),
      disabled: false,
      writes,
    }
  }
  const large = isLargePiece(at.candidate)
  const label = large ? 'Extend (large)' : 'Extend'
  if (at.blocked !== undefined) return { label, title: at.blocked, disabled: true, writes }
  const size = sizeOf(at.candidate)
  return {
    label,
    title: [
      'Search this piece’s own open ends for what continues it.',
      size ? `It is ${sizeLabel(size)}.` : '',
      large ? LARGE_PIECE_NOTE : '',
      large && at.extendOnAccept
        ? 'Extend on accept leaves a piece this size to this button.'
        : '',
      at.heldBy !== undefined
        ? `Auto-extend on ${at.heldBy} accepted it, on its last layer.`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    disabled: false,
    writes,
  }
}

/** What Auto-extend does, said wherever it is offered or reported. */
const AUTO_EXTEND_RULE =
  'Auto-extend accepts the first candidate of each end that clears SEAM’s cutoff, and extends ' +
  `it in turn, up to ${AUTO_DEPTH} layers out. A candidate of ${LARGE_PIECE_CHUNKS} level-2 ` +
  'chunks or more, or flagged as an organelle, is not taken.'

/** What `Auto-extend listed` does, as its button's title says it. */
export const AUTO_LISTED_HELP =
  'Auto-extend every listed row whose first candidate clears SEAM’s cutoff, as if pressed on ' +
  'each: the rows the filters let through, scrolled into view or not. A row you gave a verdict ' +
  'other than Accept is left out. What it accepts is Auto-extend’s, tagged “auto”, until you ' +
  `judge it. ${AUTO_EXTEND_RULE}`

/**
 * The review work the card holds, as Start over counts it: the reader's verdicts, and the pieces
 * extended — by hand, by Auto-extend or by Auto-extend listed (an Auto-extend press is in
 * `extend` too). `any` is whether there is anything to clear at all, refusals included.
 */
export function storedWork(params: Readonly<Record<string, unknown>>): {
  verdicts: number
  extended: number
  any: boolean
} {
  const verdicts = decodeVerdicts(params['verdicts']).size
  const extended = decodeExtend(params['extend']).size
  const any = verdicts > 0 || PAIR_PARAMS.some((id) => decodeExtend(params[id]).size > 0)
  return { verdicts, extended, any }
}

/**
 * The card's review work beside `verdicts`: pair lists, `parent/piece`. **One list** for Start
 * over, which clears them, and for `withRecentWork`, which keeps or drops a neuron's — a param
 * added to one and not the other would survive the clear, or the eviction, in silence.
 */
export const PAIR_PARAMS = ['extend', 'autoRoots', 'autoRefused'] as const

/**
 * What Start over writes (user, 2026-11-19): every neuron's verdicts, extended pieces,
 * Auto-extend presses and refusals, cleared in one edit — one undo step. **The merge record
 * stays**: those merges are on the server, and the record is what lets the next Submit start from
 * the neuron's new root. The neuron and the cursor stay too, so the card does not jump. Nothing
 * goes to SEAM's verdict log, which records presses, not starting over.
 */
export const START_OVER_WRITE: Readonly<Record<string, string>> = Object.freeze({
  verdicts: '',
  ...Object.fromEntries(PAIR_PARAMS.map((id) => [id, ''])),
  recent: '',
})

export const START_OVER_HELP =
  'Clear every verdict, extended piece and Auto-extend on every neuron of this card, to review ' +
  'from the start. The merge record stays, as do the merges themselves. Ctrl+Z brings it back.'

/** How to undo what Auto-extend took — the tag, the foot, the held button and the menu say it. */
export const AUTO_REJECT_NOTE =
  'Submit merges what Auto-extend accepted; reject a piece to drop it and what was taken beyond it.'

/**
 * What the Extend button's menu offers: Extend and Auto-extend, the reader's own choice ticked —
 * a press on the ticked one stops extending, as a press on the verdict a row has takes it back.
 * Each item says what its press writes (`writes`), so the card decides nothing.
 */
export function extendMenu(at: {
  choice: ExtendChoice
  /** `extendBlocked`'s answer — it stops a start, never a stop. */
  blocked: string | undefined
  /** Held by an Auto-extend further up: nothing to choose (`extendPress`). */
  held: boolean
  /** Why Auto-extend cannot run on this card's tables, where it cannot (`autoUnavailable`). */
  noAuto: string | undefined
}): Array<{
  value: 'extend' | 'auto'
  label: string
  title: string
  disabled: boolean
  writes: ExtendChoice
}> {
  const item = (value: 'extend' | 'auto', label: string, help: string) => {
    if (at.choice === value) {
      return {
        value,
        label,
        title: 'Stop extending this piece.',
        disabled: false,
        writes: 'off' as const,
      }
    }
    const why = at.held
      ? 'Auto-extend further up extends this piece already.'
      : (at.blocked ?? (value === 'auto' ? at.noAuto : undefined))
    return { value, label, title: why ?? help, disabled: why !== undefined, writes: value }
  }
  return [
    item('extend', 'Extend', 'Search this piece’s own open ends for what continues it.'),
    item('auto', 'Auto-extend', `${AUTO_EXTEND_RULE} ${AUTO_REJECT_NOTE}`),
  ]
}

/**
 * Why Auto-extend cannot run on these tables, or `undefined` where it can: it takes SEAM's own
 * cutoff, which only a search with an assessor publishes (`shown`).
 */
export function autoUnavailable(tips: TableValue | undefined): string | undefined {
  if (tips?.data['shown']) return undefined
  return (
    'Auto-extend accepts what clears SEAM’s cutoff, and these suggestions have none: pick an ' +
    'Assessor on Suggest Merges.'
  )
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
  reject: 'This piece does not belong: it is not the continuation.',
  ends: 'This piece does not belong, because the neuron ends here.',
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
  /**
   * Where Auto-extend took the piece: `unjudged` while the accept is its alone, `judged` once
   * the reader's Accept made it theirs. A press on Accept then toggles the reader's own word,
   * and the piece stays accepted either way — only a refusal drops it.
   */
  auto?: 'unjudged' | 'judged' | undefined
}): { title: string; disabled: boolean } {
  if (at.done) return { title: 'Merged by Submit.', disabled: true }
  if (at.inNeuron) return { title: IN_NEURON_NOTE, disabled: true }
  const help =
    at.verdict !== 'accept' || at.auto === undefined
      ? VERDICT_HELP[at.verdict]
      : at.auto === 'unjudged'
        ? 'Accepted by Auto-extend. Press to make the accept your own verdict.'
        : 'Your accept. Press to take it back: Auto-extend still accepts the piece, so to drop ' +
          'it, reject it.'
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
