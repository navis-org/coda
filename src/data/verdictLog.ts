/**
 * The verdict log: a reader's verdicts sent to the lab's server for calibration
 * (`docs/seam-verdict-log-plan.md`). The server is `transform_service`'s `/verdicts` (its README,
 * "Review verdicts").
 *
 * **This is the sending machinery, and it does not look inside a record.** What a record holds,
 * and which records are worth sending, is the SEAM pack's (`src/packs/seam/verdictRecord.ts`), as
 * `mergeBatch.ts` decides a merge and `cave/edits.ts` only sends it.
 *
 * ## What a reader agrees to, and where it is kept
 *
 * Nothing is queued unless the reader turned **sharing** on, in this browser (`readSharing`). It
 * is checked here, where the record is queued, so no caller can skip it. It is not a param and
 * never in a workflow: a workflow is shared, and opening somebody's workflow must not send your
 * verdicts. The name and email are optional and are what the reader typed.
 *
 * ## The reader's CAVE token never leaves for the server
 *
 * The server asks a question only somebody the chunkedgraph lets in can answer — supervoxel S's
 * root at moment T, both of its choosing — and Coda answers it the way it reads any root, through
 * the reader's own token (`rootsForSupervoxels`). A right answer buys a session for that datastack,
 * kept here until it lapses.
 *
 * ## Append-only, and a click is never lost to a bad moment
 *
 * Each verdict is a record with an id minted here, queued in this browser and sent in batches, so
 * the server keeps a retried post once. What cannot be sent now — no network, the server busy, a
 * session to renew — waits, and goes with the next flush. What the server refuses outright (a
 * record it cannot read, a datastack it does not collect) is dropped and counted, never retried.
 * Other tabs share the queue through `localStorage`; their changes reach this one's state through
 * the `storage` event.
 *
 * ## Tests never reach the server
 *
 * `src/test/writeGuard.ts` refuses every request to `VERDICT_SERVER` and fails the test that made
 * one, as it does for chunkedgraph edits. A test stubs `fetch`.
 */

import { groupBy } from '../core/collections'
import { errorMessage } from '../core/errors'
import { channel } from './channel'
import { rootsForSupervoxels } from './cave/rootIds'
import { NotFoundError, StatusError, fetchText } from './fetchText'
import { readStorage, writeStorage } from './localStore'
import { memoPromise } from './memoPromise'
import { VERDICT_SERVER } from './verdictServer'

/** A record's own fields, as its caller describes it. Opaque here: it is sent as it is. */
export type VerdictFields = object

/** A record as it is sent: the caller's fields, with what this module stamps on every one. */
type VerdictRecord = VerdictFields & {
  readonly id: string
  readonly at: string
  readonly name: string | null
  readonly email: string | null
}

/** Which chunkedgraph a record's challenge is answered through, and the datastack it is filed under. */
export interface VerdictTarget {
  readonly deployment: string
  readonly datastack: string
}

// ---------------------------------------------------------------------------
// Sharing: the reader's say, per browser
// ---------------------------------------------------------------------------

export interface VerdictSharing {
  readonly on: boolean
  readonly name: string
  readonly email: string
}

const SHARING_KEY = 'coda.verdictSharing'
const QUEUE_KEY = 'coda.verdictQueue'
const SESSIONS_KEY = 'coda.verdictSessions'

export function readSharing(): VerdictSharing {
  const held = parse<Partial<VerdictSharing>>(readStorage(SHARING_KEY)) ?? {}
  return {
    on: held.on === true,
    name: typeof held.name === 'string' ? held.name : '',
    email: typeof held.email === 'string' ? held.email : '',
  }
}

export function writeSharing(next: VerdictSharing): void {
  writeStorage(SHARING_KEY, JSON.stringify(next))
  changed()
}

// ---------------------------------------------------------------------------
// What the server collects
// ---------------------------------------------------------------------------

const asked = new Map<'datastacks', Promise<ReadonlySet<string>>>()
/** The server's answer, once it has come: what `enqueueVerdict` refuses by, without waiting. */
let collectedNow: { readonly datastacks: ReadonlySet<string>; readonly at: number } | undefined

/**
 * How long the server's list is trusted. A datastack it starts collecting is picked up within
 * this, without a reload; and a refusal never rests on an answer older than it.
 */
export const COLLECTED_FOR_MS = 10 * 60 * 1000

/** The list as last answered, where that answer is still fresh. */
function freshlyCollected(): ReadonlySet<string> | undefined {
  return collectedNow && Date.now() - collectedNow.at < COLLECTED_FOR_MS
    ? collectedNow.datastacks
    : undefined
}

/**
 * The datastacks the server collects verdicts for — an empty set where it is not collecting at all.
 * Asked once per page; a failure is not remembered, so the next caller asks again.
 */
export function collectedDatastacks(): Promise<ReadonlySet<string>> {
  // An answer gone stale is asked again; the memo would otherwise keep it for the page.
  if (collectedNow && !freshlyCollected()) asked.clear()
  return memoPromise(
    asked,
    'datastacks',
    async () => {
      const reply = parse<{ collecting?: unknown; datastacks?: unknown }>(
        await fetchText(`${VERDICT_SERVER}/datastacks`),
      )
      const names = Array.isArray(reply?.datastacks) ? reply.datastacks : []
      const datastacks = new Set(reply?.collecting === true ? names.filter(isText) : [])
      collectedNow = { datastacks, at: Date.now() }
      return datastacks
    },
    { keep: 'resolved' },
  )
}

// ---------------------------------------------------------------------------
// The state the card shows
// ---------------------------------------------------------------------------

/** What the card shows beside the switch. */
export interface VerdictLogState {
  readonly sharing: VerdictSharing
  /** Sent and kept by the server, since this page was opened. */
  readonly sent: number
  readonly waiting: number
  /** Refused by the server, or dropped from a full queue, since this page was opened. */
  readonly dropped: number
  /** Why the last attempt stopped or a record was dropped — cleared by the next send that lands. */
  readonly problem: string | undefined
  readonly sending: boolean
}

type Counts = Pick<VerdictLogState, 'sent' | 'dropped' | 'problem' | 'sending'>

const START: Counts = { sent: 0, dropped: 0, problem: undefined, sending: false }
let counts = START
/** The queue's length, kept so the state never parses the queue just to count it. */
let waiting: number | undefined
let snapshot: VerdictLogState | undefined
const change = channel()

/** For `useSyncExternalStore`: the same object until something changes (invariant 7). */
export function verdictLogState(): VerdictLogState {
  snapshot ??= { ...counts, sharing: readSharing(), waiting: (waiting ??= readQueue().length) }
  return snapshot
}

export const subscribeVerdictLog = change.subscribe

function changed(next: Partial<Counts> = {}): void {
  counts = { ...counts, ...next }
  snapshot = undefined
  change.notify()
}

// Another tab queued, sent or changed the settings: the state is stale, so say so.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === QUEUE_KEY || event.key === null) waiting = undefined
    if (event.key === null || [QUEUE_KEY, SHARING_KEY].includes(event.key)) changed()
  })
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** One record waiting, with where it goes. */
interface Waiting {
  readonly target: VerdictTarget
  readonly record: VerdictRecord
}

/**
 * The most the queue may take of this origin's storage, in characters of its JSON — about 1 MiB
 * as the browser stores it (UTF-16), a fifth of the 5 MiB quota the open document's own slot
 * shares (`docs/persistence.md`). A record is about 620 characters, so roughly 800 clicks: past
 * it the oldest are dropped and counted. A busy reader makes a few hundred a day.
 */
export const MAX_QUEUE_CHARS = 512 * 1024

/** Records per post — the server's own ceiling. */
const BATCH = 500

/** Why a record was not queued. */
export type NotEnqueued = 'sharing off' | 'not collected' | 'storage full'

/**
 * Queue one record, stamped with an id, the moment and the reader's name and email — or, with
 * sharing off or the browser's storage refusing it, nothing, and say which. Not sent here: the
 * caller flushes (`flushVerdicts`), so a burst of clicks goes as one post.
 */
export function enqueueVerdict(
  target: VerdictTarget,
  fields: VerdictFields,
): NotEnqueued | undefined {
  const sharing = readSharing()
  if (!sharing.on) return 'sharing off'
  // Where the server has said it does not collect this datastack; unknown is no refusal.
  if (freshlyCollected()?.has(target.datastack) === false) return 'not collected'
  const record: VerdictRecord = {
    ...fields,
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    name: sharing.name.trim() || null,
    email: sharing.email.trim() || null,
  }
  const queue = [...readQueue(), { target, record }]
  let text = JSON.stringify(queue)
  let over = 0
  while (text.length > MAX_QUEUE_CHARS && over < queue.length - 1) {
    // Drop by the average record's size, then measure again: one stringify per step, not per record.
    over += Math.max(
      1,
      Math.ceil(((text.length - MAX_QUEUE_CHARS) * queue.length) / text.length),
    )
    over = Math.min(over, queue.length - 1)
    text = JSON.stringify(queue.slice(over))
  }
  if (!writeStorage(QUEUE_KEY, text)) {
    // The only copy is the one that did not land: the click is lost, and the card says so.
    changed({
      dropped: counts.dropped + 1,
      problem: 'This browser’s storage is full, so the verdict was not kept.',
    })
    return 'storage full'
  }
  waiting = queue.length - over
  changed({ dropped: counts.dropped + over })
  return undefined
}

/**
 * Send everything waiting, a datastack at a time. One flush at a time: a call made while one runs
 * joins it, and the running one picks up whatever was queued meanwhile before it stops.
 */
export function flushVerdicts(): Promise<void> {
  return memoPromise(flushes, 'flush', flushAll, { keep: 'inflight' })
}

const flushes = new Map<'flush', Promise<void>>()

async function flushAll(): Promise<void> {
  // A problem is about the attempt that met it, so each flush starts without one.
  changed({ sending: true, problem: undefined })
  try {
    // Pass after pass until one settles nothing: records queued during a post go with the next.
    while (true) {
      const queue = readQueue()
      if (queue.length === 0) return
      const before = counts.sent + counts.dropped
      for (const group of groupBy(queue, (one) => one.target.datastack).values()) {
        await flushGroup(group)
      }
      if (counts.sent + counts.dropped === before) return
    }
  } finally {
    changed({ sending: false })
  }
}

/** Send one datastack's records, until they are gone or something stops them. */
async function flushGroup(group: readonly Waiting[]): Promise<void> {
  const target = group[0]!.target
  let pending = group.map((one) => one.record)
  let size = BATCH
  let renew = false
  let renewed = false
  while (pending.length > 0) {
    const batch = pending.slice(0, size)
    let token: string
    try {
      token = await sessionFor(target, renew)
      renew = false
    } catch (error) {
      if (await notCollected(error, target.datastack)) settle(pending, detailOf(error))
      else changed({ problem: detailOf(error) })
      return
    }
    try {
      await fetchText(VERDICT_SERVER, {
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ records: batch }),
        },
      })
      settle(batch)
      pending = pending.slice(batch.length)
      renewed = false
    } catch (error) {
      const status = error instanceof StatusError ? error.status : undefined
      if (status === 401 && !renewed) {
        // The session lapsed or the server's key changed: one new challenge, then the same post.
        renew = renewed = true
        continue
      }
      if (status !== 422) {
        changed({ problem: detailOf(error) })
        return
      }
      // A record the server cannot read refuses the batch, and names it: drop that one.
      const bad = refusedIndex((error as StatusError).body)
      if (bad !== undefined && batch[bad]) {
        settle([batch[bad]], detailOf(error))
        pending = pending.filter((one) => one !== batch[bad])
      } else if (batch.length > 1) {
        // Refused as a whole, naming no record: try halves before giving any up.
        size = Math.ceil(batch.length / 2)
      } else {
        settle(batch, detailOf(error))
        pending = pending.slice(1)
      }
    }
  }
}

/**
 * Whether a failure means the server does not collect this datastack — nothing waiting for it can
 * ever go. Only where the server itself says so (its list lacks the datastack): a 404 from a proxy
 * or a moved route is no such answer, and the records wait.
 */
async function notCollected(error: unknown, datastack: string): Promise<boolean> {
  if (!(error instanceof NotFoundError)) return false
  const collected = await collectedDatastacks().catch(() => undefined)
  return collected !== undefined && !collected.has(datastack)
}

/**
 * Take records off the queue — sent, or dropped with the reason. The queue is read again first,
 * since another tab may have added to it.
 */
function settle(records: readonly VerdictRecord[], dropped?: string): void {
  const gone = new Set(records.map((one) => one.id))
  writeQueue(readQueue().filter((one) => !gone.has(one.record.id)))
  if (dropped === undefined) changed({ sent: counts.sent + records.length })
  else changed({ dropped: counts.dropped + records.length, problem: dropped })
}

/** The queue, less any entry not in the shape this build writes — an older build's, or a hand edit. */
function readQueue(): Waiting[] {
  const held = parse<unknown>(readStorage(QUEUE_KEY))
  return Array.isArray(held) ? held.filter(isWaiting) : []
}

function isWaiting(one: unknown): one is Waiting {
  const { target, record } = (one ?? {}) as {
    target?: Partial<VerdictTarget>
    record?: { id?: unknown }
  }
  return isText(target?.deployment) && isText(target?.datastack) && isText(record?.id)
}

function writeQueue(queue: readonly Waiting[]): void {
  writeStorage(QUEUE_KEY, queue.length > 0 ? JSON.stringify(queue) : undefined)
  waiting = queue.length
}

// ---------------------------------------------------------------------------
// Sessions and the challenge
// ---------------------------------------------------------------------------

interface Session {
  readonly token: string
  /** Epoch ms. */
  readonly expires: number
}

/** A session is renewed this long before the server says it lapses, so a post does not race it. */
const SESSION_MARGIN_MS = 5 * 60 * 1000

/**
 * How long a datastack rests after a challenge failed. Every answer costs the server a chunkedgraph
 * call from a shared budget (30 a minute per worker), so a reader whose answers keep failing must
 * not spend it on every click; the verdicts wait.
 */
export const CHALLENGE_REST_MS = 60 * 1000

/** Per datastack: until when no challenge is asked, and why. */
const resting = new Map<string, { readonly until: number; readonly why: unknown }>()

/** This datastack's session, answering a new challenge where there is none or `fresh` asks for one. */
async function sessionFor(target: VerdictTarget, fresh: boolean): Promise<string> {
  const held = readSessions()[target.datastack]
  if (!fresh && held && held.expires - SESSION_MARGIN_MS > Date.now()) return held.token
  const rest = resting.get(target.datastack)
  if (rest && rest.until > Date.now()) throw rest.why
  try {
    const session = await answerChallenge(target)
    resting.delete(target.datastack)
    writeSessions({ ...readSessions(), [target.datastack]: session })
    return session.token
  } catch (error) {
    resting.set(target.datastack, { until: Date.now() + CHALLENGE_REST_MS, why: error })
    throw error
  }
}

/**
 * Ask the server for a challenge and answer it through the reader's own CAVE access.
 *
 * The moment is the server's, in whole seconds, and is asked about as `now` — a moment nobody
 * asks about twice, so its answer is kept nowhere (`RootsAt`).
 */
async function answerChallenge(target: VerdictTarget): Promise<Session> {
  const challenge = parse<{ challenge?: unknown; supervoxel?: unknown; at?: unknown }>(
    await fetchText(
      `${VERDICT_SERVER}/challenge?datastack=${encodeURIComponent(target.datastack)}`,
    ),
  )
  const at = typeof challenge?.at === 'string' ? Date.parse(challenge.at) : NaN
  if (!isText(challenge?.challenge) || !isText(challenge?.supervoxel) || !Number.isFinite(at)) {
    throw new Error(`${VERDICT_SERVER} sent a challenge Coda cannot read.`)
  }
  const roots = await rootsForSupervoxels(
    target.datastack,
    { now: at },
    [challenge.supervoxel],
    {
      deployment: target.deployment,
    },
  )
  const root = roots.get(challenge.supervoxel)
  if (!root) {
    throw new Error(
      `Could not look up supervoxel ${challenge.supervoxel} in ${target.datastack}'s ` +
        'chunkedgraph to answer the verdict server. Are you signed in to it?',
    )
  }
  const reply = parse<{ session?: unknown; expires?: unknown }>(
    await fetchText(`${VERDICT_SERVER}/session`, {
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: challenge.challenge, root }),
      },
    }),
  )
  const expires = typeof reply?.expires === 'string' ? Date.parse(reply.expires) : NaN
  if (!isText(reply?.session) || !Number.isFinite(expires)) {
    throw new Error(`${VERDICT_SERVER} sent a session Coda cannot read.`)
  }
  return { token: reply.session, expires }
}

function readSessions(): Record<string, Session> {
  const held = parse<Record<string, Session>>(readStorage(SESSIONS_KEY))
  return held && typeof held === 'object' ? held : {}
}

function writeSessions(sessions: Record<string, Session>): void {
  writeStorage(SESSIONS_KEY, JSON.stringify(sessions))
}

// ---------------------------------------------------------------------------

function parse<T>(text: string | undefined): T | undefined {
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** The server's own sentence (FastAPI's `detail`) where it sent one, else the error's message. */
function detailOf(error: unknown): string {
  if (!(error instanceof StatusError)) return errorMessage(error)
  const detail = parse<{ detail?: unknown }>(error.body)?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as { loc?: unknown; msg?: unknown }
    const where = Array.isArray(first.loc) ? first.loc.slice(-1).join('') : ''
    if (typeof first.msg === 'string') return where ? `${where}: ${first.msg}` : first.msg
  }
  return error.message
}

/** Which record of a batch a 422 names, from its `loc` (`["body", "records", 3, "q"]`). */
function refusedIndex(body: string): number | undefined {
  const detail = parse<{ detail?: unknown }>(body)?.detail
  if (!Array.isArray(detail)) return undefined
  for (const one of detail as { loc?: unknown }[]) {
    const loc = Array.isArray(one.loc) ? one.loc : []
    if (loc[0] === 'body' && loc[1] === 'records' && typeof loc[2] === 'number') return loc[2]
  }
  return undefined
}

/** For tests: forget this page's counts, the cached count and the memos. Storage is the test's. */
export function resetVerdictLog(): void {
  asked.clear()
  collectedNow = undefined
  flushes.clear()
  resting.clear()
  waiting = undefined
  counts = START
  changed()
}
