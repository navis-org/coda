/**
 * Suggest Merges' memory of the ends it has finished.
 *
 * ## Why a node needs a memory of its own
 *
 * The scheduler's result cache holds **one entry per node**, keyed by provenance (invariant 4).
 * That is right, and it is the wrong grain for this node: an end costs 6 s in Chrome and 11 in
 * Firefox, a run is tens to hundreds of them, and anything that moves the node's key throws all
 * of them away together. A run cancelled at end 180 of 200 kept nothing. And extending a neuron
 * piece by piece (`docs/seam-extend-plan.md`) moves the key on every Extend, by design — the
 * list of pieces is in it — so without this each one would search the seed's ends again.
 *
 * `docs/core.md` has the principle, written for the geometry cache: *the graph is not wrong, so
 * the fix is not in the graph.* Re-running is what a moved key means. What is wasteful is the
 * work inside the re-run, so the memory sits where the unit is an **end** rather than a node:
 * the node still runs, still walks every tip it was given, and is answered from here for the
 * ones it has already done.
 *
 * ## What an end's answer depends on, and what the key holds of it
 *
 * - the forest and the assessor, and how many candidates the assessor was given (`Assess top`);
 * - the segmentation, and the moment it is read at — deployment, datastack, and the neuron's
 *   own moment (`docs/seam-live-plan.md`): `Searched at` moved into its root's life, where it
 *   was a materialization until 2026-11-17;
 * - the neuron the end belongs to — and, for an accepted piece, the roots it is read as one
 *   with (its path back to the neuron being extended);
 * - **every tip of that neuron the run was given**, not only this one: the own-tip rule drops a
 *   candidate nearer some *other* tip, so the same end searched among fewer tips keeps more;
 * - the end's own position, and its `e_tip`, which `p_tip` is fitted on.
 *
 * A key missing one of these serves an answer to a different question, and it would look like a
 * very fast run. `endMemory.test.ts` moves each in turn.
 *
 * **The models are in it by id and digest** (`modelVersion`): an id names a manifest at an
 * address, and the box, the cut, the own-tip radius and the fits all come out of it, so a
 * manifest republished under the same id — as SEAM does when it refits `r` — is another model.
 * By id alone, ends from before and after a refit would land in one table, under one `source`.
 * So the node reads both manifests before it builds the key, and opens the models from that
 * same read.
 *
 * What is **not** in it: `Chunk cache`, which decides how bytes arrive and not what they are —
 * presentational on the node for the same reason — and the tip's row in the table, which is
 * where it happened to be listed. The second is why every end is handed back with its row
 * written by `recalled`, remembered or not.
 *
 * ## What it does not keep
 *
 * **An end that was refused.** A refusal here is a request that failed for this end — the chunk
 * counts, a patch box — and remembering it would make a moment's network trouble the answer for
 * the session. An end whose box holds no voxel of its own neuron (`missingQuery`) *is* kept:
 * that is a fact about the segmentation, and it will be the same next time.
 *
 * ## A data cache like the others, age and all
 *
 * The node declares `dataCache`, so this keeps that contract (`docs/core.md`): a run with
 * `ctx.refresh` **forgets** every end of the run before it measures any (`forgetStale`) — so a
 * Clear Cache run cancelled half way leaves nothing old behind for the ends it never reached —
 * and every end says when it was measured, which the node reports. A first draft reported no age, on the
 * reasoning that a stated moment is fixed and an old end is as true as a new one.
 * True, and beside the point: without an age the card's cache-lifetime menu does nothing at
 * all, and `cached 12m ago` is the only lasting sign that a run of a fifth of a second was
 * answered from here rather than measured.
 *
 * Headless and pure. For the session only, bounded in bytes — the arrays here are copies the
 * published tables do not share, so the memory meter cannot see them.
 */

import { hashValue } from '../../core/hash'
import { ByteLru } from '../../core/lruMap'
import type { PublishedEnd, TipRow } from './searchTips'

/**
 * How much the memory may hold.
 *
 * An end is its ranked list — up to a hundred candidates by a couple of dozen float64 columns —
 * so about 25 kB, and a whole Aedes neuron's 505 ends about 13 MB. 64 MB is five such neurons,
 * which is more than a session reviews at once and small beside a `Chunk cache` of 512.
 */
const END_MEMORY_BYTES = 64 * 1024 * 1024

/** A fixed charge per end, for the objects around its arrays. */
const OVERHEAD_BYTES = 512

/**
 * What holding an end costs: the **buffers** behind its arrays, not the arrays' own lengths.
 *
 * Every array here owns its buffer today (`gather`, `publishedEnd`), and then the two are the
 * same number. But a kept view pins the whole buffer it looks into, so if one ever became a
 * slice of a pool's column this would go on charging what is really held — where the memory
 * meter cannot see it — rather than the hundred rows of it that are read.
 */
function bytesOf(end: PublishedEnd): number {
  let bytes = OVERHEAD_BYTES
  for (const array of [
    end.end.candRoot,
    end.end.repSupervoxel,
    end.order,
    ...Object.values(end.end.columns),
    ...Object.values(end.scores?.columns ?? {}),
  ]) {
    bytes += array.buffer.byteLength
  }
  return bytes
}

/** Whether this end's answer is the segmentation's, rather than a request that failed. */
function settled(end: PublishedEnd): boolean {
  return end.end.refusal === undefined && end.scores?.refusal === undefined
}

/** A finished end, and when it was measured — epoch ms, for the card's age. */
export interface Remembered {
  readonly end: PublishedEnd
  readonly at: number
}

export interface EndMemory {
  /** Whether an end is held, **without** counting as a use of it — for pricing a run. */
  has(key: string): boolean
  /** When a held end was measured, epoch ms — also without counting as a use. */
  ageOf(key: string): number | undefined
  get(key: string): Remembered | undefined
  /** Keeps the end, unless it was refused. Evicts the least recently used past the budget. */
  set(key: string, end: PublishedEnd, at: number): void
  forget(key: string): void
  readonly size: number
  readonly bytes: number
}

/** A memory with a budget of its own. The node uses `sessionEnds`; a test makes one. */
export function endMemory(maxBytes = END_MEMORY_BYTES): EndMemory {
  const held = new ByteLru<string, Remembered>(maxBytes)
  return {
    has: (key) => held.has(key),
    ageOf: (key) => held.peek(key)?.at,
    get: (key) => held.get(key),
    set(key, end, at) {
      // A refusal replaces what was there, rather than leaving an older answer standing.
      if (settled(end)) held.set(key, { end, at }, bytesOf(end))
      else held.delete(key)
    },
    forget: (key) => void held.delete(key),
    get size() {
      return held.size
    },
    get bytes() {
      return held.bytes
    },
  }
}

/** The one memory the node reads: every Suggest Merges card in the session shares it. */
export const sessionEnds = endMemory()

/** What every end of one neuron in a run has in common. */
export interface RunIdentity {
  /** The forest, as `modelVersion` names it: its id and its manifest's digest. */
  readonly ranker: string
  /** The assessor, named the same way, or the node's own word for none. */
  readonly assessor: string
  /** `Assess top`, as the run applies it: 0 where there is no assessor. */
  readonly top: number
  readonly deployment: string
  readonly datastack: string
  /**
   * The moment every supervoxel is read as belonging to a root, epoch ms — **the neuron's**, so
   * this identity is per neuron: two neurons of one run can be read at different moments, one
   * replaced before `Searched at` and one not (`docs/seam-live-plan.md`).
   */
  readonly moment: number
}

/**
 * One neuron's part of the key: the run, the neuron, and **every tip of it the run was given**.
 *
 * Asked once per neuron, since the positions are hashed whole. In the order given, which is the
 * table's: the same tips in another order are another key, and that is a miss where a hit was
 * possible — the cheap direction to be wrong in.
 */
export function neuronKey(
  run: RunIdentity,
  neuronId: string,
  tips: readonly TipRow[],
  /**
   * For an accepted piece: the roots its boxes are read as one with, seed first (`Piece.path`).
   * `tips` is then every tip the own-tip rule measures against — the piece's and its path's.
   */
  path?: readonly string[],
): string {
  // Float64, as `endKey` reads them: `tipPositions` is float32 for the own-tip rule's index,
  // and a key coarser than the positions it stands for is two questions under one answer.
  return hashValue({
    run,
    neuronId,
    tips: Float64Array.from(tips.flatMap((tip) => tip.nm)),
    path: path ?? null,
  })
}

/** One end's key: its neuron's, its own position, and the score `p_tip` is fitted on. */
export function endKey(neuron: string, tip: TipRow): string {
  return `${neuron}|${tip.nm.join(',')}|${tip.eTip ?? ''}`
}

/** One end as a run meets it: remembered, or measured just now. */
export interface RecalledEnd {
  readonly end: PublishedEnd
  /** Measured by this run, rather than answered from the memory. */
  readonly fresh: boolean
  /** When it was measured, epoch ms. */
  readonly at: number
  /**
   * The next end is one the run has to measure, so nothing will arrive for seconds. A caller
   * that has been holding remembered ends back shows them now.
   */
  readonly thenWaits: boolean
}

/**
 * Forget what a run may not answer from, **before it measures anything** — every end of the
 * run, not a neuron's at a time as the loop reaches it.
 *
 * `refresh` (Clear Cache) forgets them all. A chosen lifetime (`EvalContext.maxAgeMs`) forgets
 * the ones measured longer ago than that, which is what keeps the scheduler's backstop from
 * firing: it re-evaluates a node that reports data past its lifetime, whole, and for this node
 * that would be the ends just measured as well as the old ones.
 *
 * Up front, because the flag behind `refresh` is spent when the run starts. Forgotten as the
 * loop came to each neuron, a run cancelled in the first would leave every later neuron's ends
 * answering from before the Clear Cache, on the next run and under no flag at all.
 */
export function forgetStale(
  memory: EndMemory,
  keys: Iterable<string>,
  rule: { refresh: boolean; maxAgeMs?: number | undefined; now?: number },
): void {
  const oldest =
    rule.maxAgeMs === undefined ? undefined : (rule.now ?? Date.now()) - rule.maxAgeMs
  for (const key of keys) {
    const at = memory.ageOf(key)
    if (at === undefined) continue
    if (rule.refresh || (oldest !== undefined && at < oldest)) memory.forget(key)
  }
}

/**
 * What the memory holds of a run, **taken once, before the run measures anything**.
 *
 * The run answers from this and not from the memory as it goes, for two reasons that are both
 * about the memory changing underneath it. The wait is priced, and the assessor opened or not,
 * on what is held at the start — read again later, an end evicted in between would be searched
 * by a run that had decided it needed no assessor. And a run larger than the budget would evict
 * its own later ends as it re-measured its earlier ones, so that a re-run of a run mostly
 * remembered measured nearly all of it. Held here, an end that was there at the start is
 * answered, whatever the run then writes.
 *
 * Reading counts as a use, which is right: these are the ends about to be wanted.
 */
export function heldEnds(memory: EndMemory, keys: Iterable<string>): Map<string, Remembered> {
  const held = new Map<string, Remembered>()
  for (const key of keys) {
    const got = memory.get(key)
    if (got) held.set(key, got)
  }
  return held
}

export interface Recall<E> {
  /** Where a measured end is kept. */
  readonly memory: EndMemory
  /** What was held when the run started — `heldEnds`. */
  readonly held: ReadonlyMap<string, Remembered>
  keyOf(end: E): string
  /**
   * The number the caller keeps this end under — for Suggest Merges, its tip's place among its
   * root's tips (`runBook.ts`, which numbers it into the published table). Written onto every
   * end here, measured or remembered — one place, because a remembered end was at another
   * index when it was measured, and one carried over folds its first candidate onto a
   * different tip.
   */
  rowOf(end: E): number
  /**
   * Measure these ends, yielding each when it is wholly finished, **in the order given**.
   * Handed only the ends the memory does not hold, and not called at all where it holds every one.
   */
  measure(missing: readonly E[]): AsyncIterable<PublishedEnd>
  /** The clock a measured end is stamped with. Here so a test can hold it still. */
  now?: () => number
}

/**
 * A neuron's ends, in the order asked for: the remembered ones at once, the rest as `measure`
 * finishes them.
 *
 * **In the order asked for**, because the tables are built from the ends in the order they
 * arrive: a run answered half from memory has to publish the rows a run answered from none
 * would. So a remembered end waits its turn behind a measured one ahead of it — which costs
 * nothing a reader would see, an end taking seconds and a recall none.
 *
 * **An end is remembered only once `measure` has yielded it**, which the node does only when the
 * end is wholly finished, assessor and all. A run cancelled part way through an end leaves
 * nothing of that end behind.
 */
export async function* recalled<E>(
  ends: readonly E[],
  recall: Recall<E>,
): AsyncGenerator<RecalledEnd> {
  const { memory } = recall
  const now = recall.now ?? Date.now
  const keys = ends.map((end) => recall.keyOf(end))
  const held = keys.map((key) => recall.held.get(key))
  const missing = ends.filter((_, at) => held[at] === undefined)
  // Not started until the first `next()`, so a neuron wholly remembered measures nothing at all.
  const measured =
    missing.length > 0 ? recall.measure(missing)[Symbol.asyncIterator]() : undefined
  try {
    for (const [at, end] of ends.entries()) {
      let got = held[at]
      const fresh = got === undefined
      if (!got) {
        const next = await measured!.next()
        if (next.done) {
          throw new Error(
            'seam end memory: the search finished before every end it was asked for had an answer.',
          )
        }
        got = { end: next.value, at: now() }
        memory.set(keys[at]!, got.end, got.at)
      }
      yield {
        end: { ...got.end, end: { ...got.end.end, tip: recall.rowOf(end) } },
        fresh,
        at: got.at,
        thenWaits: at + 1 < ends.length && held[at + 1] === undefined,
      }
    }
  } finally {
    /*
     * The caller stopped early — a Cancel, or a throw of its own — so the search is told to
     * stop too, and waited for: it holds a volume and a model session the caller is about to
     * close. **Its own failure on the way out is dropped.** A search running one end ahead can
     * well fail while being stopped, and a caller that left by its own choice would be handed
     * that failure as though the run had failed.
     */
    try {
      await measured?.return?.()
    } catch {
      // See above.
    }
  }
}
