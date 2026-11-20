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
  /**
   * `joined`: merged onto pieces that are not in the neuron yet; it goes in with them. Recorded
   * `merged`, as it is one.
   */
  readonly state: 'waiting' | 'sending' | 'joined' | RecordOutcome
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
   * The root the merge's neuron end was checked against: the neuron's (the reviewed one, or the
   * last merge's), or, **for a piece merged onto pieces not in the neuron yet** (a batch merges a
   * tree from its tips, `mergeBatch.ts`), the root of those pieces. On a merge not sent because a
   * piece it waits for did not land, **the root it would have been checked against** — no check
   * was made.
   */
  readonly neuronRoot: string
  /**
   * The root the piece's end was checked against, where that was not the piece's own: pieces this
   * workflow had already merged onto it. Absent where it was the piece itself.
   */
  readonly candidateRootAt?: string | undefined
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
      /** The root this merge made: the neuron's, or that of the pieces it joined (`neuronRoot`). */
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
  | {
      readonly outcome: 'merged'
      readonly newRoot: string
      /** Where it was made onto pieces short of the neuron: their root (`neuronRoot`). */
      readonly neuronRoot?: string | undefined
    }
  | { readonly outcome: 'already-merged'; readonly neuronRoot?: string | undefined }
  | { readonly outcome: 'failed' | 'not-sent' }
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
  /**
   * Pieces this workflow merged onto each other and not yet into the neuron — a batch that merges
   * a tree from its tips and stopped part way — each with the root they are under together now.
   * The piece that was merged onto is here too: its own root is gone as well.
   */
  readonly joined: ReadonlyMap<string, string>
  /** Every root another reviewed neuron in the record has had. */
  readonly otherRoots: ReadonlySet<string>
  /** The pieces this workflow put in another reviewed neuron: part of that one now. */
  readonly elsewhere: ReadonlySet<string>
  /**
   * The neuron's `unknown` entries whose two roots no later merge has moved: merges whose reply was
   * lost, which nothing has settled. Any of them may have landed since — even after a later batch's
   * check — and then those roots are not the record's. The plan asks the roots (`mergePlan.ts`).
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
  const groups = new Groups()
  const roots = [reviewedRoot]
  const pieces = new Set<string>()
  const otherRoots = new Set<string>()
  const elsewhere = new Set<string>()
  /** Every root a merge made, which is never a piece. */
  const made = new Set<string>()
  /** The pieces this neuron's merges joined to something, wherever they are now. */
  const mineIn: string[] = []
  let unknowns: MergeRecordEntry[] = []
  // Whether another reviewed neuron took this one in.
  let taken = false
  for (const entry of record) {
    if (!inScope(entry, scope)) continue
    // Made onto its neuron's group, as it stood: a merge short of it gives the neuron no root.
    const ontoNeuron =
      'short' in entry
        ? !('neuronRoot' in entry && entry.neuronRoot !== undefined)
        : groups.find(entry.neuronRoot) === groups.find(entry.reviewedRoot)
    groups.replay(entry)
    if (entry.outcome === 'merged') made.add(entry.newRoot)
    if (inNeuron(entry) && entry.candidateRoot === reviewedRoot) taken = true
    const mine = entry.reviewedRoot === reviewedRoot
    if (!mine) otherRoots.add(entry.reviewedRoot)
    else if (entry.outcome === 'unknown') unknowns.push(entry)
    // A short entry's neuron has nothing unsettled (`shortenedRecord`), so it settles nothing.
    else if (entry.outcome === 'failed' && !('short' in entry)) {
      // The server's refusal of the same pair at the same root: nothing was written, so a late
      // answer to a merge recorded `unknown` settles it as not made.
      unknowns = unknowns.filter(
        (open) =>
          open.candidateRoot !== entry.candidateRoot || open.neuronRoot !== entry.neuronRoot,
      )
    }
    if (!inNeuron(entry)) continue
    if (mine) mineIn.push(entry.candidateRoot)
    else elsewhere.add(entry.candidateRoot)
    if (entry.outcome !== 'merged' || !ontoNeuron) continue
    if (mine) roots.push(entry.newRoot)
    else otherRoots.add(entry.newRoot)
  }
  const currentRoot = groups.find(reviewedRoot)
  // Each group of pieces not in the neuron, every piece in it: the record's own roots are not pieces.
  const joined = new Map<string, string>()
  for (const id of mineIn) {
    const root = groups.find(id)
    if (root === currentRoot) {
      pieces.add(id)
      continue
    }
    if (joined.has(id)) continue
    for (const member of groups.members(id)) {
      if (!made.has(member) && member !== reviewedRoot) joined.set(member, root)
    }
  }
  /*
   * A lost reply is open while both roots it was checked against still stand: a merge recorded
   * after it onto either has moved that root on, and was checked against the root it moved.
   */
  const standing = (id: string) => groups.find(id) === id
  const unsettled = unknowns.filter(
    (entry) =>
      standing(entry.neuronRoot) && standing(entry.candidateRootAt ?? entry.candidateRoot),
  )
  return {
    currentRoot,
    roots,
    pieces,
    joined,
    otherRoots,
    elsewhere,
    unsettled,
    // A neuron another took in is drawn as what it is part of now: its own root is retired.
    absorbedInto: taken ? currentRoot : undefined,
  }
}

/**
 * Which root each id is under by the record's account — pieces, reviewed neurons, and the roots
 * merges made — replayed in the order the entries were written. **A merge joins two groups**: the
 * one its neuron end was checked against and the piece's; an `already-merged` puts the piece's
 * group under the other's root, as nothing new was made. A short entry is of a neuron whose
 * pieces all went into it (`shortenedRecord`), so its neuron end is the neuron's group.
 *
 * **The batch keeps its own account in one of these too** (`mergeBatch.ts`), replaying each entry
 * as it records it, so the run and every later reading of its record cannot disagree.
 */
export class Groups {
  private readonly groupOf = new Map<string, Group>()

  /** The root `id` is under: its own where nothing has joined it. */
  find(id: string): string {
    return this.groupOf.get(id)?.root ?? id
  }

  /** Every id in `id`'s group, the roots merges made among them. */
  members(id: string): readonly string[] {
    return this.groupOf.get(id)?.members ?? [id]
  }

  /** `id` under `root`, as a batch starts from its plan's roots. */
  seed(id: string, root: string): void {
    this.join(root, [id])
  }

  replay(entry: RecordEntry): void {
    if (!inNeuron(entry)) return
    const onto =
      'short' in entry
        ? (('neuronRoot' in entry ? entry.neuronRoot : undefined) ?? entry.reviewedRoot)
        : entry.neuronRoot
    const piece =
      'short' in entry ? entry.candidateRoot : (entry.candidateRootAt ?? entry.candidateRoot)
    const ids = [onto, piece, entry.candidateRoot]
    if (entry.outcome === 'merged') this.join(entry.newRoot, ids)
    else this.join(this.find(onto), ids)
  }

  /** `root` and the groups of `ids`, one group under `root` from now on: the smaller moved. */
  private join(root: string, ids: readonly string[]): void {
    const groups = new Set<Group>()
    for (const id of [root, ...ids]) {
      let group = this.groupOf.get(id)
      if (!group) {
        group = { root: id, members: [id] }
        this.groupOf.set(id, group)
      }
      groups.add(group)
    }
    const into = [...groups].reduce((a, b) => (b.members.length > a.members.length ? b : a))
    for (const group of groups) {
      if (group === into) continue
      for (const member of group.members) {
        into.members.push(member)
        this.groupOf.set(member, into)
      }
    }
    into.root = root
  }
}

interface Group {
  root: string
  readonly members: string[]
}

/** The root a piece is read as: its own, or that of the pieces it was joined to (`joined`). */
export function rootNow(joined: ReadonlyMap<string, string> | undefined, id: string): string {
  return joined?.get(id) ?? id
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
    ...(entry.candidateRootAt === undefined ? {} : { candidateRootAt: entry.candidateRootAt }),
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
 * can be what settles another — **and so is one with pieces joined short of it** (`joined`), whose
 * groups are read off whole entries. A merge made short of the neuron that has since gone in keeps
 * the root it was made onto in its short form, as nothing else would tell it from one into it. With none, every `unknown` was settled by an entry after it, so
 * dropping the unknowns with the failures leaves `mergedSoFar`'s answer as it was. Entries this
 * cannot read are kept, as `appendEntry` keeps them, and the order is kept: it is what makes the
 * last merge's root the current one.
 */
export function shortenedRecord(raw: unknown, kept: ReadonlySet<string>): string | undefined {
  const held = parsedList(raw)
  if (!held) return undefined
  const entries = held.map((value) => (isEntry(value) ? value : undefined))
  const full = entries.filter((entry) => entry !== undefined)
  /*
   * Only an `unknown` can be unsettled, and only a `merged` can join pieces short of the neuron;
   * each in the chunkedgraph it was made on.
   */
  const open = new Set<string>()
  // Each neuron read once per chunkedgraph: a neuron of hundreds of merges is one replay.
  const read = new Map<string, MergedSoFar>()
  const soOf = (entry: MergeRecordEntry): MergedSoFar | undefined => {
    const { reviewedRoot: root, deployment, datastack } = entry
    if (deployment === undefined || datastack === undefined) return undefined
    const key = `${root}|${deployment}|${datastack}`
    let so = read.get(key)
    if (!so) read.set(key, (so = mergedSoFar(full, root, { deployment, datastack })))
    return so
  }
  for (const entry of full) {
    if (entry.outcome !== 'unknown' && entry.outcome !== 'merged') continue
    if (kept.has(entry.reviewedRoot) || open.has(entry.reviewedRoot)) continue
    const so = soOf(entry)
    if (so && (so.unsettled.length > 0 || so.joined.size > 0)) open.add(entry.reviewedRoot)
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
    if (entry.outcome === 'unknown') return
    // A merge made onto pieces short of the neuron keeps their root: it was no neuron root.
    const ontoNeuron = soOf(entry)?.roots.includes(entry.neuronRoot) ?? true
    out.push(shortText(entry, ontoNeuron))
  })
  return changed ? JSON.stringify(out) : undefined
}

/**
 * A short entry as the param holds it: `[outcome, deployment, datastack, reviewed, candidate]`,
 * the new root after a `merged` one, and last, where a `merged` or `already-merged` one was made
 * onto pieces short of the neuron, their root. Absent scope is `null`, as JSON has no undefined.
 */
function shortText(
  entry: Exclude<MergeRecordEntry, { outcome: 'unknown' }>,
  ontoNeuron: boolean,
): unknown[] {
  const head = [
    entry.outcome,
    entry.deployment ?? null,
    entry.datastack ?? null,
    entry.reviewedRoot,
    entry.candidateRoot,
  ]
  const onto = ontoNeuron ? [] : [entry.neuronRoot]
  if (entry.outcome === 'merged') return [...head, entry.newRoot, ...onto]
  return entry.outcome === 'already-merged' ? [...head, ...onto] : head
}

function shortOf(value: unknown): ShortEntry | undefined {
  if (!Array.isArray(value)) return undefined
  const [outcome, deployment, datastack, reviewedRoot, candidateRoot, sixth, seventh] =
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
  if ((outcome === 'failed' || outcome === 'not-sent') && value.length === 5) {
    return { ...base, outcome }
  }
  if (outcome === 'already-merged') {
    if (value.length === 5) return { ...base, outcome }
    if (value.length === 6 && id(sixth)) return { ...base, outcome, neuronRoot: sixth }
  }
  if (outcome === 'merged' && id(sixth)) {
    if (value.length === 6) return { ...base, outcome: 'merged', newRoot: sixth }
    if (value.length === 7 && id(seventh)) {
      return { ...base, outcome: 'merged', newRoot: sixth, neuronRoot: seventh }
    }
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
  if (!absentOr('candidateRootAt', (v) => typeof v === 'string' && isNodeId(v))) return false
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
    // What each end was checked against: `neuron_root` is the neuron's, or the root of pieces
    // merged onto each other short of it; `candidate_root` is empty where it was the piece's own.
    column('neuron_root', 'str'),
    column('candidate_root', 'str'),
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
    candidate_root: full((e) => e.candidateRootAt ?? null),
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
