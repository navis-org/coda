/**
 * What Submit did, kept with the workflow (`docs/seam-merge-plan.md`, phase 5). **Reads only** —
 * the batch that appends to it is `mergeBatch.ts`; this module is what the plan, the node's
 * `Merges` table and the card read, none of which may reach the writer.
 *
 * ## Why a param, unrecorded
 *
 * The record is the `seam:review` param `merges`, written with no undo step (`unrecorded`). An
 * undoable record would let Ctrl+Z erase the note of a merge the server still holds, and the next
 * Submit would plan it again. It is not what stops a merge being sent twice, though: a piece
 * merged already maps to the neuron's root, which the batch's per-merge check reads at the
 * server's now, and an old record (a file saved before the merges) leaves the neuron's recorded
 * root outdated, which refuses the whole neuron before anything is sent. The record is what lets
 * the *next* Submit on the same neuron start from its new root.
 *
 * ## One entry per decision the batch made about a confirmed merge
 *
 * Sent or not: a merge the per-merge check refused is recorded too (`not-sent`), so `Merges` reads
 * as the log of every Submit. A merge the reader stopped before, or that a failed read never let
 * the batch decide about, is not.
 *
 * ## Read for one chunkedgraph
 *
 * Every entry names the deployment and datastack it was made on, and the record is read for one
 * (`RecordScope`), the card's wired Dataset. A sandbox table is a copy of a production one, so the
 * same root ids are current in both until one side is edited, and testing on the sandbox before
 * pointing the card at production is the natural order of work: read for every chunkedgraph, a
 * sandbox merge would move the neuron's root, and take its pieces, on production too (audit of
 * 77c0625, 2026-11-16). An entry naming none — written before entries did — is kept and shown in
 * `Merges`, and read for no chunkedgraph.
 *
 * ## Short entries, for neurons no longer kept in full
 *
 * The record keeps its full entries for the last `RECORD_KEPT_NEURONS` neurons it names (user,
 * 2026-11-19, `appendRecorded`), as the card keeps its verdicts for the neurons last worked on
 * (`reviewEviction.ts`). An older neuron keeps, of its record, what `mergedSoFar` reads and no more
 * (`ShortEntry`, `shortenedRecord`): which pieces went in, what was refused, and the roots the
 * merges made. That is all the next Submit needs, so shortening is lossless for every merge to
 * come; only `Merges` loses the detail of those rows. Written as a list, never an object, so a reader that cannot read one
 * skips it and keeps it, as `appendEntry` keeps any entry it cannot read.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import { caveServerOfSource } from '../../data/cave/deployments'
import { column, tableSchema } from '../../core/types'
import type { TableSchema } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { isNodeId } from '../../data/cave/graphLayout'
import type { MergeEnd } from '../../data/cave/merge'
import { isMergeEnd } from '../../data/cave/merge'
import { splitDatasetId } from '../../data/cave/spec'
import type { DatasetIdentity } from '../../nodes/lib/caveParams'

/** Which chunkedgraph an entry was made on, and the record is read for. */
export interface RecordScope {
  readonly deployment: string
  readonly datastack: string
}

/**
 * The scope of a wired Dataset: a CAVE one's deployment and datastack, or undefined for anything
 * else — never `caveTarget`'s fallback to the default deployment, which takes any source.
 */
export function recordScopeOf(dataset: DatasetIdentity | undefined): RecordScope | undefined {
  const deployment = caveServerOfSource(dataset?.sourceId)
  const parsed = dataset?.datasetId ? splitDatasetId(dataset.datasetId) : undefined
  return deployment && parsed ? { deployment, datastack: parsed.datastack } : undefined
}

const inScope = (entry: RecordEntry, scope: RecordScope | undefined): boolean =>
  scope !== undefined &&
  entry.deployment === scope.deployment &&
  entry.datastack === scope.datastack

/** What became of one confirmed merge. */
export type RecordOutcome =
  /** Made: the server answered with the new root, or a lost reply's roots showed it. */
  | 'merged'
  /** The piece was in the neuron already when its turn came; nothing was sent. */
  | 'already-merged'
  /** Sent, and refused by the server: nothing was written. */
  | 'failed'
  /** The per-merge check refused it; nothing was sent. */
  | 'not-sent'
  /**
   * Sent, and whether it was made is not known. The next plan asks the roots (`mergedSoFar`'s
   * `unsettled`), and its caller records what they said (`settledEntry`).
   */
  | 'unknown'

/**
 * Where one merge has got to while a batch runs — the overlay's per-row state. A decided merge's
 * state is its recorded outcome. Here rather than beside the batch, so the overlay can show it
 * without naming a module that writes.
 */
export interface MergeProgress {
  readonly state: 'waiting' | 'sending' | RecordOutcome
  readonly message?: string | undefined
}

/** What every entry says, whatever became of its merge. */
export interface EntryBase {
  /** The chunkedgraph it was made on (`RecordScope`); absent on entries from before 2026-11-16. */
  readonly deployment?: string | undefined
  readonly datastack?: string | undefined
  /** The neuron as the queue names it — the record is read per reviewed neuron. */
  readonly reviewedRoot: string
  readonly candidateRoot: string
  /** The tip whose contact the merge was made at. */
  readonly endUid: number
  /**
   * The accepted piece that tip is on, where it is not the neuron itself: the merge was of a
   * piece accepted on a piece (`docs/seam-extend-plan.md`). **The tip's root, whatever became
   * of that piece** — in the neuron already or not — so it says whose tip `endUid` numbers; it
   * is not `PlannedMerge.parent`, which is about what this plan still has to merge. Absent on
   * the neuron's own tips, and on every entry from before 2026-11-17.
   */
  readonly parentRoot?: string | undefined
  /**
   * The neuron's root the merge was checked against: the reviewed one, or the last merge's. On
   * a merge not sent because a piece it waits for did not land, **the root it would have been
   * checked against** — no check was made, and its neuron end may be on that piece, not here.
   */
  readonly neuronRoot: string
  readonly neuron: MergeEnd
  readonly candidate: MergeEnd
  /** When the batch decided, ISO 8601. */
  readonly at: string
  /** Why, in a sentence, where the outcome alone does not say. */
  readonly message?: string | undefined
}

/** The outcome half of an entry: what the batch decides, apart from the merge it decided about. */
export type EntryOutcome =
  | {
      readonly outcome: 'merged'
      /** The neuron's root after this merge. */
      readonly newRoot: string
      /** Absent where the reply was lost and the roots showed the merge. */
      readonly operationId?: string | undefined
    }
  | { readonly outcome: 'already-merged' | 'not-sent' }
  | {
      readonly outcome: 'unknown'
      /** Where the server answered with one but the roots did not show the merge. */
      readonly operationId?: string | undefined
    }
  | { readonly outcome: 'failed'; readonly status?: number | undefined }

export type MergeRecordEntry = EntryBase & EntryOutcome

/**
 * A merge of a neuron the record no longer keeps in full (the header): what `mergedSoFar` reads of
 * it — the scope, the two roots, the outcome, and the root a merge made. A refusal is kept too,
 * since its neuron is still a reviewed one (`otherRoots`); only a settled `unknown` is dropped.
 */
export type ShortEntry = {
  readonly short: true
  readonly deployment?: string | undefined
  readonly datastack?: string | undefined
  readonly reviewedRoot: string
  readonly candidateRoot: string
} & (
  | { readonly outcome: 'merged'; readonly newRoot: string }
  | { readonly outcome: 'already-merged' | 'failed' | 'not-sent' }
)

/** An entry as the record is read: in full, or short. */
export type RecordEntry = MergeRecordEntry | ShortEntry

export type MergeRecord = readonly RecordEntry[]

/** Whether the entry's piece is part of its neuron now, by this workflow's account. */
const inNeuron = (entry: RecordEntry): boolean =>
  entry.outcome === 'merged' || entry.outcome === 'already-merged'

export interface MergedSoFar {
  /** The neuron's root now: the last merge's new root, or the reviewed one. */
  readonly currentRoot: string
  /** Every root the neuron has had under this workflow, the reviewed one first. */
  readonly roots: readonly string[]
  /** The pieces in the neuron by this workflow's account: merged, or found merged. */
  readonly pieces: ReadonlySet<string>
  /** Every root another reviewed neuron in the record has had. */
  readonly otherRoots: ReadonlySet<string>
  /** The pieces this workflow put in another reviewed neuron: part of that one now. */
  readonly elsewhere: ReadonlySet<string>
  /**
   * The neuron's `unknown` entries since its last `merged` one: merges whose reply was lost, which
   * nothing has settled. Any of them may have landed since — even after a later batch's check — and
   * then the neuron's root is not `currentRoot`. The plan asks the roots (`mergePlan.ts`).
   */
  readonly unsettled: readonly MergeRecordEntry[]
  /**
   * Where this neuron was merged, as a piece, into another reviewed neuron: that neuron's root now.
   * Its own reviewed root is retired then, so this is what to draw it as.
   */
  readonly absorbedInto: string | undefined
}

/**
 * One reviewed neuron's state, read off the record — **the one reading of it**: the plan, the
 * batch's caller, the scene and the card's count all ask this, so none of them can disagree about
 * which root is current or which pieces are taken. Only `merged` moves a root; `merged` and
 * `already-merged` put a piece in a neuron. Only entries made on `scope` are read (the header);
 * with none, nothing is.
 */
export function mergedSoFar(
  record: MergeRecord,
  reviewedRoot: string,
  scope: RecordScope | undefined,
): MergedSoFar {
  const roots = [reviewedRoot]
  const pieces = new Set<string>()
  const otherRoots = new Set<string>()
  const elsewhere = new Set<string>()
  let unsettled: MergeRecordEntry[] = []
  // Each reviewed neuron's root now, and which reviewed neuron took each one in, if any did.
  const latest = new Map<string, string>()
  const takenBy = new Map<string, string>()
  for (const entry of record) {
    if (!inScope(entry, scope)) continue
    if (entry.outcome === 'merged') latest.set(entry.reviewedRoot, entry.newRoot)
    if (inNeuron(entry)) takenBy.set(entry.candidateRoot, entry.reviewedRoot)
    const mine = entry.reviewedRoot === reviewedRoot
    if (!mine) otherRoots.add(entry.reviewedRoot)
    else if (entry.outcome === 'unknown') unsettled.push(entry)
    else if (entry.outcome === 'merged') unsettled = []
    // A short entry's neuron has nothing unsettled (`shortenedRecord`), so it settles nothing.
    else if (entry.outcome === 'failed' && !('short' in entry)) {
      // The server's refusal of the same pair at the same root: nothing was written, so a late
      // answer to a merge recorded `unknown` settles it as not made.
      unsettled = unsettled.filter(
        (open) =>
          open.candidateRoot !== entry.candidateRoot || open.neuronRoot !== entry.neuronRoot,
      )
    }
    if (!inNeuron(entry)) continue
    ;(mine ? pieces : elsewhere).add(entry.candidateRoot)
    if (entry.outcome !== 'merged') continue
    if (mine) roots.push(entry.newRoot)
    else otherRoots.add(entry.newRoot)
  }
  // Followed to the end — A into B, then B into C, is C — and never round a loop.
  let absorbedBy: string | undefined
  for (let at = takenBy.get(reviewedRoot), seen = new Set([reviewedRoot]); at;) {
    if (seen.has(at)) break
    seen.add(at)
    absorbedBy = at
    at = takenBy.get(at)
  }
  const absorbedInto =
    absorbedBy === undefined ? undefined : (latest.get(absorbedBy) ?? absorbedBy)
  return {
    currentRoot: roots.at(-1)!,
    roots,
    pieces,
    otherRoots,
    elsewhere,
    unsettled,
    absorbedInto,
  }
}

/**
 * The root a merge made, read off its two ends' roots afterwards: both under one root that is a
 * real object and not the neuron's root before it. The first half of the plan's rule for a write
 * whose reply was lost (`settle`); on its own it is no evidence the merge was this one.
 */
export function sharedNewRoot(
  roots: readonly (string | undefined)[],
  before: string,
): string | undefined {
  const [neuron, piece] = roots
  return neuron !== undefined && neuron === piece && neuron !== before && isNodeId(neuron)
    ? neuron
    : undefined
}

/**
 * An `unknown` entry settled as made: the same merge, `merged` into `newRoot`, which the roots
 * showed both its supervoxels under. Appended, never written over the entry it settles.
 */
export function settledEntry(
  entry: MergeRecordEntry,
  newRoot: string,
  at: string,
): MergeRecordEntry {
  return {
    deployment: entry.deployment,
    datastack: entry.datastack,
    reviewedRoot: entry.reviewedRoot,
    candidateRoot: entry.candidateRoot,
    endUid: entry.endUid,
    ...(entry.parentRoot === undefined ? {} : { parentRoot: entry.parentRoot }),
    neuronRoot: entry.neuronRoot,
    neuron: entry.neuron,
    candidate: entry.candidate,
    at,
    outcome: 'merged',
    newRoot,
    // The server's own id, where it answered with one: the settlement keeps the audit trail.
    ...(entry.outcome === 'unknown' && entry.operationId
      ? { operationId: entry.operationId }
      : {}),
    message:
      entry.outcome === 'unknown' && entry.operationId
        ? `The server answered merged (operation ${entry.operationId}) before the roots showed ` +
          'it; read again, they show the merge was made.'
        : 'The reply was lost; the roots, read again, show the merge was made.',
  }
}

/**
 * The param with one entry appended. **Entries this cannot read are kept** — a file from a later
 * Coda, a hand edit — since the record is the log of every Submit; only reading filters them
 * (`decodeRecord`). Text that is no list at all was never a readable record and starts afresh.
 */
export function appendEntry(raw: unknown, entry: MergeRecordEntry): string {
  const held = parsedList(raw) ?? []
  return JSON.stringify([...held, entry])
}

/** How many neurons the record keeps in full: the last this many it names (user, 2026-11-19). */
export const RECORD_KEPT_NEURONS = 10

/**
 * `appendEntry`, with every neuron but **the last `RECORD_KEPT_NEURONS` the record names** — the
 * entry's own among them — shortened (the header). The record's own recency, not the card's
 * `recent`: the record grows only at a Submit, so the neurons last submitted are the ones whose
 * detail is still being read, and a Start over, which clears `recent`, leaves it alone. Shortened
 * where the record grows, inside the hold the append already has, so it is one write and never
 * races a batch.
 */
export function appendRecorded(raw: unknown, entry: MergeRecordEntry): string {
  const next = appendEntry(raw, entry)
  const kept = new Set<string>()
  const record = decodeRecord(next)
  for (let at = record.length - 1; at >= 0 && kept.size < RECORD_KEPT_NEURONS; at--) {
    kept.add(record[at]!.reviewedRoot)
  }
  return shortenedRecord(next, kept) ?? next
}

/**
 * The record from the param. An entry that is not one — a hand edit, a file from a later Coda — is
 * skipped rather than guessed at; what it said is still true on the server, which the plan and the
 * batch ask before anything is sent.
 */
export function decodeRecord(raw: unknown): RecordEntry[] {
  const out: RecordEntry[] = []
  for (const value of parsedList(raw) ?? []) {
    const entry = isEntry(value) ? value : shortOf(value)
    if (entry) out.push(entry)
  }
  return out
}

/**
 * The record with every neuron not in `kept` shortened (the header), or undefined where there is
 * nothing to shorten. **A neuron with a merge still unsettled in any chunkedgraph is left whole**
 * — settling it reads the supervoxels of its entries (`mergePlan`'s `settle`), and a `failed` entry
 * can be what settles another. With none, every `unknown` was settled by an entry after it, so
 * dropping the unknowns with the failures leaves `mergedSoFar`'s answer as it was. Entries this
 * cannot read are kept, as `appendEntry` keeps them, and the order is kept: it is what makes the
 * last merge's root the current one.
 */
export function shortenedRecord(raw: unknown, kept: ReadonlySet<string>): string | undefined {
  const held = parsedList(raw)
  if (!held) return undefined
  const entries = held.map((value) => (isEntry(value) ? value : undefined))
  const full = entries.filter((entry) => entry !== undefined)
  // Only an `unknown` can be unsettled, and only in the chunkedgraph it was made on.
  const open = new Set<string>()
  for (const { reviewedRoot: root, outcome, deployment, datastack } of full) {
    if (outcome !== 'unknown' || kept.has(root) || open.has(root)) continue
    if (deployment === undefined || datastack === undefined) continue
    if (mergedSoFar(full, root, { deployment, datastack }).unsettled.length > 0) open.add(root)
  }
  let changed = false
  const out: unknown[] = []
  held.forEach((value, at) => {
    const entry = entries[at]
    if (!entry || kept.has(entry.reviewedRoot) || open.has(entry.reviewedRoot)) {
      out.push(value)
      return
    }
    changed = true
    if (entry.outcome !== 'unknown') out.push(shortText(entry))
  })
  return changed ? JSON.stringify(out) : undefined
}

/**
 * A short entry as the param holds it: `[outcome, deployment, datastack, reviewed, candidate]`,
 * and the new root after a `merged` one. Absent scope is `null`, as JSON has no undefined.
 */
function shortText(entry: Exclude<MergeRecordEntry, { outcome: 'unknown' }>): unknown[] {
  const head = [
    entry.outcome,
    entry.deployment ?? null,
    entry.datastack ?? null,
    entry.reviewedRoot,
    entry.candidateRoot,
  ]
  return entry.outcome === 'merged' ? [...head, entry.newRoot] : head
}

function shortOf(value: unknown): ShortEntry | undefined {
  if (!Array.isArray(value)) return undefined
  const [outcome, deployment, datastack, reviewedRoot, candidateRoot, newRoot] =
    value as unknown[]
  const scope = (v: unknown) => v === null || typeof v === 'string'
  const id = (v: unknown): v is string => typeof v === 'string' && isNodeId(v)
  if (!scope(deployment) || !scope(datastack) || !id(reviewedRoot) || !id(candidateRoot)) {
    return undefined
  }
  const base = {
    short: true as const,
    ...(typeof deployment === 'string' ? { deployment } : {}),
    ...(typeof datastack === 'string' ? { datastack } : {}),
    reviewedRoot,
    candidateRoot,
  }
  if (
    (outcome === 'already-merged' || outcome === 'failed' || outcome === 'not-sent') &&
    value.length === 5
  ) {
    return { ...base, outcome }
  }
  if (outcome === 'merged' && value.length === 6 && id(newRoot)) {
    return { ...base, outcome: 'merged', newRoot }
  }
  return undefined
}

function parsedList(raw: unknown): unknown[] | undefined {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const OUTCOMES: ReadonlySet<string> = new Set<RecordOutcome>([
  'merged',
  'already-merged',
  'failed',
  'not-sent',
  'unknown',
])

function isEntry(value: unknown): value is MergeRecordEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  const id = (key: string) => typeof entry[key] === 'string' && isNodeId(entry[key])
  if (!id('reviewedRoot') || !id('candidateRoot') || !id('neuronRoot')) return false
  if (!Number.isSafeInteger(entry['endUid']) || typeof entry['at'] !== 'string') return false
  if (!isMergeEnd(entry['neuron']) || !isMergeEnd(entry['candidate'])) return false
  if (typeof entry['outcome'] !== 'string' || !OUTCOMES.has(entry['outcome'])) return false
  // What `Merges` writes into its text and integer columns, so the table keeps its schema.
  const absentOr = (key: string, ok: (value: unknown) => boolean) =>
    entry[key] === undefined || ok(entry[key])
  if (!absentOr('message', (v) => typeof v === 'string')) return false
  if (!absentOr('deployment', (v) => typeof v === 'string')) return false
  if (!absentOr('datastack', (v) => typeof v === 'string')) return false
  if (!absentOr('parentRoot', (v) => typeof v === 'string' && isNodeId(v))) return false
  // An operation id is a counter from 1 — the writer's own `isOperationId`, which is `isNodeId`'s.
  if (!absentOr('operationId', (v) => typeof v === 'string' && isNodeId(v))) return false
  if (!absentOr('status', Number.isSafeInteger)) return false
  return entry['outcome'] !== 'merged' || id('newRoot')
}

/** `Merges`' columns: one row per entry, ids as text (invariant 8). */
export function mergesSchema(): TableSchema {
  return tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column('candidateId', 'str'),
    column('datastack', 'str'),
    column('deployment', 'str'),
    column('end_uid', 'i64'),
    // The root that tip is on, where it is a piece and not the neuron: a tip's number is its
    // root's own, so without this the row names another root's tip.
    column('accepted_on', 'str'),
    column('outcome', 'str'),
    column('neuron_root', 'str'),
    column('new_root', 'str'),
    column('operation_id', 'str'),
    column('neuron_supervoxel', 'str'),
    column('candidate_supervoxel', 'str'),
    column('neuron_x', 'f64', 'nm'),
    column('neuron_y', 'f64', 'nm'),
    column('neuron_z', 'f64', 'nm'),
    column('candidate_x', 'f64', 'nm'),
    column('candidate_y', 'f64', 'nm'),
    column('candidate_z', 'f64', 'nm'),
    column('at', 'str'),
    column('message', 'str'),
  )
}

/** The record as a table, in the order it was written. */
export function mergesTable(record: MergeRecord): TableValue {
  const cells = (read: (entry: RecordEntry) => CellValue) => record.map(read)
  // What a short entry no longer holds is null (the header).
  const full = (read: (entry: MergeRecordEntry) => CellValue) =>
    cells((e) => ('short' in e ? null : read(e)))
  return makeTable(mergesSchema(), {
    [ID_COLUMN_NAME]: cells((e) => e.reviewedRoot),
    candidateId: cells((e) => e.candidateRoot),
    datastack: cells((e) => e.datastack ?? null),
    deployment: cells((e) => e.deployment ?? null),
    end_uid: full((e) => e.endUid),
    accepted_on: full((e) => e.parentRoot ?? null),
    outcome: cells((e) => e.outcome),
    neuron_root: full((e) => e.neuronRoot),
    new_root: cells((e) => (e.outcome === 'merged' ? e.newRoot : null)),
    operation_id: full((e) =>
      e.outcome === 'merged' || e.outcome === 'unknown' ? (e.operationId ?? null) : null,
    ),
    neuron_supervoxel: full((e) => e.neuron.supervoxel),
    candidate_supervoxel: full((e) => e.candidate.supervoxel),
    neuron_x: full((e) => e.neuron.positionNm[0]),
    neuron_y: full((e) => e.neuron.positionNm[1]),
    neuron_z: full((e) => e.neuron.positionNm[2]),
    candidate_x: full((e) => e.candidate.positionNm[0]),
    candidate_y: full((e) => e.candidate.positionNm[1]),
    candidate_z: full((e) => e.candidate.positionNm[2]),
    at: full((e) => e.at),
    message: full((e) => e.message ?? null),
  })
}
