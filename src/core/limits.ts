/**
 * Guard rails, and what a guard rail is allowed to do.
 *
 * Every number in this file was once a `throw`. That was the right shape while Coda was a
 * prototype whose worst failure was a locked tab, and the wrong one the moment somebody had a
 * real question about four thousand neurons: a ceiling picked in week two — 100 for NBLAST, 25
 * for meshes, 20 for a CAVE mesh batch — decided which science was possible, and it decided it
 * silently, in a message that read as if the answer did not exist rather than as if this build
 * had declined to compute it.
 *
 * So there are three tiers now, and which one a limit belongs to is a question about
 * consequences rather than about size:
 *
 * - **Silent.** The work is bounded but the result is unaffected — a batch size, a
 *   concurrency cap, a page size. Nothing to say.
 * - **Warn** (`ctx.warn`, via the helpers below). The work is going ahead and it will cost
 *   something: minutes, hundreds of megabytes, a picture with no readable labels on it. This
 *   is where nearly everything that used to refuse now lives. Said *before* the expensive
 *   part, so Cancel is still an option.
 * - **Refuse** (`CRASH_FLOOR_BYTES`). Proceeding would take the tab down and the graph with
 *   it, so there is no result on the other side of it to warn about. An allocation, always —
 *   time is a wait, and a wait is the user's to spend.
 *
 * The floor is deliberately far out. A guard rail at the point where the work gets *slow* is
 * the thing this file exists to stop being; a guard rail at the point where the browser dies is
 * a different statement, and it should be rare enough that hitting one is news.
 */

/**
 * The most one node may try to allocate in a single result before it is refused outright.
 *
 * 512 MB, which is roughly where a desktop Chrome tab starts failing allocations rather than
 * swapping — a 64-bit tab's heap is capped near 4 GB, and a result this size is joined by the
 * inputs it was built from, whatever the viewer uploads to the GPU, and the undo stack. It is
 * not a measurement of when the tab dies; it is the point past which nobody could show that it
 * does not.
 *
 * Sized in bytes rather than in rows or cells so the floor means the same thing to a pivot, a
 * score matrix and a linkage tree, all of which count differently.
 *
 * In `src/core` rather than beside the nodes because both halves of the tree answer to it: a
 * node warns through `EvalContext.warn`, and a source warns through `GeometryRequest.onWarn`,
 * and two copies of this policy would be two policies.
 */
export const CRASH_FLOOR_BYTES = 512 * 1024 * 1024

/**
 * That, in float64 cells — the unit tables and matrices actually allocate in.
 *
 * 67,108,864 of them. Every numeric column in `tableOps` is a `Float64Array` and every matrix
 * is one flat one, so a cell count is the honest common currency between them.
 */
export const CRASH_FLOOR_CELLS = Math.floor(CRASH_FLOOR_BYTES / 8)

/** Anything that can be told about a cost. `EvalContext`, in practice. */
export interface Warner {
  warn(message: string): void
}

/**
 * A warner with nobody at the other end, for a caller that is not a node run.
 *
 * Every one of these checks used to take `ctx?: Warner` instead, which read as "the check is
 * optional" when what was meant is "there is no card to put this on" — and the two guards that
 * spelling forced (`if (ctx && count > threshold)`) put the *audience* and the *threshold* in
 * one condition, so a missing warner silently disabled the check. This says the same thing
 * without that risk, and there is exactly one shape of call rather than three.
 */
export const SILENT: Warner = { warn: () => undefined }

export interface ThresholdWarning {
  /** How many there are. */
  count: number
  /** The threshold it went past — a param value, usually, so the message can name it back. */
  threshold: number
  /** Plural noun for what is being counted: 'neurons', 'regions', 'observations'. */
  unit: string
  /**
   * What went past — the control's label where there is one ("this node's Warn above"), and
   * otherwise what the number means ("the width a pivot is usually meant to have").
   *
   * Required, because the alternative is a message that names a threshold the reader cannot
   * find: the fallback this used to have ("the warning threshold") was never reached by any
   * caller and would have been useless if it had been.
   */
  control: string
  /** One sentence on what actually gets expensive here. Node-specific, and the whole point. */
  cost: string
}

/**
 * The house phrasing for a count past its warn threshold: what, how far past, what it costs,
 * and that it is going ahead anyway.
 *
 * The last clause is load-bearing. These messages were refusals for most of Coda's life and
 * several of them still read like one at a glance, so each says explicitly that there will be a
 * result — otherwise a warning badge on a card that is quietly working is indistinguishable
 * from the error it replaced.
 */
export function warnOverThreshold(ctx: Warner, w: ThresholdWarning): void {
  ctx.warn(
    `${w.count.toLocaleString()} ${w.unit} is past ${w.control} ` +
      `(${w.threshold.toLocaleString()}). ${w.cost} Going ahead anyway — cancel and filter ` +
      `upstream if that is not what you meant.`,
  )
}

/** Roughly how long something will take, in words a status line can hold. */
export function describeDuration(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} seconds`
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} minutes`
  return `about ${(seconds / 3600).toFixed(1)} hours`
}

/**
 * The one refusal left: an allocation past `CRASH_FLOOR_BYTES`.
 *
 * It **makes the comparison itself** rather than taking a caller that has already made it. That
 * is the whole difference between one floor and four: while this only threw, every call site
 * had to restate `bytes > CRASH_FLOOR_BYTES` in its own units, and two of them minted a local
 * name for the floor to do it (`NBLAST_PAIRS_FLOOR`, `MAX_PIVOT_CELLS`) — a second spelling of
 * a constant, which invariant 8 records as how a symbol comes to drift from itself.
 *
 * Named separately from an ordinary `throw` so the message is recognisably a different kind of
 * statement from the old ceilings — it says what would be allocated and what the floor is, and
 * it never suggests raising anything, because there is nothing to raise.
 */
export function refuseIfOverCrashFloor(what: string, bytes: number): void {
  if (bytes <= CRASH_FLOOR_BYTES) return
  throw new Error(
    `${what} would allocate ${formatBytes(bytes)} in one go, past the ${formatBytes(
      CRASH_FLOOR_BYTES,
    )} a browser tab can be expected to survive. This is the one limit Coda still refuses ` +
      `rather than warns about: there is no result on the other side of it. Cut the shape ` +
      `upstream — filter, group, or split the run.`,
  )
}

/**
 * Bytes as a short human string.
 *
 * A second spelling of `ui/format.ts`'s, and the duplication is the boundary rather than an
 * oversight: `src/core` and `src/data` must not import from `src/ui` (invariant 1), and these
 * messages are written by nodes and by backends. The two round differently — `512 MB` here
 * against `512.0 MB` there — because this one appears mid-sentence in prose and that one in a
 * file-size readout.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} kB`
}
