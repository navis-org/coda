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

const inScope = (entry: MergeRecordEntry, scope: RecordScope | undefined): boolean =>
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

export type MergeRecord = readonly MergeRecordEntry[]

/** Whether the entry's piece is part of its neuron now, by this workflow's account. */
const inNeuron = (entry: MergeRecordEntry): boolean =>
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
    else if (entry.outcome === 'failed') {
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

/**
 * The record from the param. An entry that is not one — a hand edit, a file from a later Coda — is
 * skipped rather than guessed at; what it said is still true on the server, which the plan and the
 * batch ask before anything is sent.
 */
export function decodeRecord(raw: unknown): MergeRecordEntry[] {
  return (parsedList(raw) ?? []).filter(isEntry)
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
  const cells = (read: (entry: MergeRecordEntry) => CellValue) => record.map(read)
  return makeTable(mergesSchema(), {
    [ID_COLUMN_NAME]: cells((e) => e.reviewedRoot),
    candidateId: cells((e) => e.candidateRoot),
    datastack: cells((e) => e.datastack ?? null),
    deployment: cells((e) => e.deployment ?? null),
    end_uid: cells((e) => e.endUid),
    accepted_on: cells((e) => e.parentRoot ?? null),
    outcome: cells((e) => e.outcome),
    neuron_root: cells((e) => e.neuronRoot),
    new_root: cells((e) => (e.outcome === 'merged' ? e.newRoot : null)),
    operation_id: cells((e) =>
      e.outcome === 'merged' || e.outcome === 'unknown' ? (e.operationId ?? null) : null,
    ),
    neuron_supervoxel: cells((e) => e.neuron.supervoxel),
    candidate_supervoxel: cells((e) => e.candidate.supervoxel),
    neuron_x: cells((e) => e.neuron.positionNm[0]),
    neuron_y: cells((e) => e.neuron.positionNm[1]),
    neuron_z: cells((e) => e.neuron.positionNm[2]),
    candidate_x: cells((e) => e.candidate.positionNm[0]),
    candidate_y: cells((e) => e.candidate.positionNm[1]),
    candidate_z: cells((e) => e.candidate.positionNm[2]),
    at: cells((e) => e.at),
    message: cells((e) => e.message ?? null),
  })
}
