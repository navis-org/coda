/**
 * What a verdict on one of SEAM's suggestions holds, and which ones are worth sending — the SEAM
 * half of the verdict log. `src/data/verdictLog.ts` queues and sends; this decides what. The
 * fields are the server's `Record` (`transform_service/app/verdicts.py`), less what the log stamps
 * (id, moment, name, email) and what the server stamps (datastack, session, arrival).
 */

import type { NotEnqueued, VerdictTarget } from '../../data/verdictLog'
import { enqueueVerdict } from '../../data/verdictLog'
import type { Candidate, QueueTip, Verdict } from './reviewQueue'
import { MODEL_SOURCE_PREFIX, SET_SOURCE_PREFIX } from './suggestionTables'

/**
 * What a record says about one candidate: a press on the review card, `cleared` for a verdict
 * taken back — or `auto-accepted`, which is no press: a piece Auto-extend accepted on SEAM's own
 * cutoff and Submit merged without the reader judging it (user, 2026-11-18). Its own word, never
 * `accept`, so SEAM never takes its own pick for a reader's verdict.
 */
export type VerdictWord = Verdict | 'cleared' | 'auto-accepted'

/** One verdict, as the card describes it. Ids are text throughout (invariant 8). */
export interface VerdictInput {
  /** Which `q`, cutoff and `r` these numbers are: the tip's `source` column. */
  readonly source: string
  /** The neuron the tip belongs to — its `seed`. */
  readonly neuron: string
  /** The root the tip is on: the neuron itself, or a piece accepted onto it. */
  readonly piece: string
  readonly end_uid: number
  readonly kind: string | null
  readonly x: number
  readonly y: number
  readonly z: number
  readonly candidate: string
  readonly rank: number
  readonly q: number | null
  readonly r: number | null
  readonly p_tip: number | null
  readonly conf: number | null
  readonly shown: boolean | null
  readonly organelle: boolean | null
  readonly verdict: VerdictWord
  /** The moment the candidate ids belong to, ISO 8601, where the card knows it. */
  readonly searched_at: string | null
  /** Coda's version. */
  readonly coda: string | null
}

/**
 * A row's verdict as a record: the tip's numbers (`q`, `r` and `p_tip` describe its first
 * candidate, whichever is judged), the judged candidate's own (`rank`, `conf`, `shown`, the
 * organelle flag), and the word. `searched_at` is not known on the card and is left empty: the
 * candidate ids and the moment of the press say which segmentation they were.
 */
export function verdictInput(
  tip: QueueTip,
  candidate: Candidate,
  verdict: VerdictWord,
  coda: string | null,
): VerdictInput {
  return {
    // No source for a hand pick, so `queueVerdict` never sends one: SEAM suggested nothing there
    // to judge (user, 2026-11-19), whichever press or merge it comes from.
    source: candidate.hand ? '' : (tip.source ?? ''),
    neuron: tip.seed,
    piece: tip.neuronId,
    end_uid: tip.endUid,
    kind: tip.kind,
    x: tip.tipNm[0],
    y: tip.tipNm[1],
    z: tip.tipNm[2],
    candidate: candidate.candidateId,
    rank: candidate.rank,
    q: tip.q ?? null,
    r: tip.r ?? null,
    p_tip: tip.pTip ?? null,
    conf: candidate.conf ?? null,
    shown: candidate.shown,
    // `Candidate.organelle` is only ever an explicit flag: absent is "not known", not "no".
    organelle: candidate.organelle === true ? true : null,
    verdict,
    searched_at: null,
    coda,
  }
}

/**
 * Whether a `source` is one a published set or a run of Find Merge Candidates wrote. `source` is a common
 * column name, and a table a reader folded onto the tips may carry its own, which Find Merge Candidates
 * keeps on the rows it did not search (`docs/seam-verdict-log-plan.md`).
 */
export function isSeamSource(source: unknown): source is string {
  return (
    typeof source === 'string' &&
    [SET_SOURCE_PREFIX, MODEL_SOURCE_PREFIX].some(
      (prefix) => source.startsWith(prefix) && LABEL.test(source.slice(prefix.length)),
    )
  )
}

/** What may follow the prefix: the server's own rule (`Record.source`), so it never refuses one. */
const LABEL = /^\S{1,200}$/

/** Why a verdict was not queued, where it was not. */
export type NotQueued = NotEnqueued | 'no source'

/** Queue one verdict for the log, or say why not. */
export function queueVerdict(
  target: VerdictTarget,
  input: VerdictInput,
): NotQueued | undefined {
  if (!isSeamSource(input.source)) return 'no source'
  return enqueueVerdict(target, input)
}
