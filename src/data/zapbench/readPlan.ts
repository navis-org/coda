import type { TraceWindow } from './traces'

/**
 * Which of the two published layouts to read, and exactly which bytes.
 *
 * The release holds the same numbers twice, in transposed layouts, and **neither is better than
 * the other** — which is the whole reason this module exists rather than a constant naming a
 * winner:
 *
 * - `traces` is row-major: a timestep is 512 adjacent neurons in 2,048 contiguous bytes, and a
 *   neuron is 512 values 2,048 bytes apart. Reading *any* of a chunk row costs all 512 neurons.
 * - `traces_rastermap_sorted/s0` carries a `transpose` codec: a neuron is 512 **contiguous**
 *   values, and a timestep is strided. Reading one neuron costs 2 kB a chunk.
 *
 * So the sorted copy wins by orders of magnitude on a **few neurons over a wide time window**
 * (the ordinary case: 1.1 MiB against 576 MiB, measured, on 36 scattered neurons over the whole
 * recording) and *loses* on a **narrow window over many neurons**, where row-major is exactly
 * the right shape and the transposed read would bridge hundreds of unwanted neurons to collect a
 * few timesteps each. A node offering this as a setting would be asking the reader to know that;
 * both plans are costed here instead and the cheaper one is taken.
 *
 * Pure over numbers, no I/O, so the arithmetic that decides it is testable without a network.
 */

/**
 * The array's geometry, exported because `traces.ts` addresses the same chunks and the test stub
 * builds them. Declared here, in the leaf, rather than in both: a chunk shape spelled twice —
 * once as `ROW_BYTES` and once as `BYTES_PER_ROW` — is two places to find and two chances
 * to half-finish a change, with nothing linking them.
 */
export const CHUNK_T = 512
export const CHUNK_F = 512
export const BYTES_PER_VALUE = 4
/** One timestep of one chunk, all 512 neurons — the row-major stride. */
export const ROW_BYTES = CHUNK_F * BYTES_PER_VALUE
/** One neuron of one chunk, all 512 timesteps — the transposed stride. */
export const COLUMN_BYTES = CHUNK_T * BYTES_PER_VALUE

/**
 * What one request is worth in bytes, for deciding whether to bridge a gap or spend a request.
 *
 * **Measured, not chosen.** At concurrency 6 against the bucket: 576 ranged requests of 2 kB took
 * 18.5 s, and 576 of 1 MiB took 60.5 s. So a request costs ~32 ms of wall clock whatever its
 * size, and the marginal bandwidth is (576 − 1.1) MiB / (60.5 − 18.5) s ≈ 13.7 MiB/s — which puts
 * one request at about 450 kB of equivalent time.
 *
 * That number is why bridging is usually right: skipping over an unwanted neuron in the sorted
 * layout costs 2 kB, so a request pays for bridging ~220 of them. It is also why the two plans
 * are compared in these units rather than by byte count alone — a plan with a tenth of the bytes
 * and ten times the requests is not obviously better, and on this store it is usually worse.
 */
export const REQUEST_BYTES_EQUIVALENT = 450 * 1024

export type TraceLayout = 'plain' | 'sorted'

/**
 * Where one wanted column's values sit inside one read.
 *
 * `start`/`stride` rather than a byte offset, because the two layouts differ only in these two
 * numbers — row-major is `stride: 512`, transposed is `stride: 1` — so extraction is one loop
 * for both instead of a branch per layout at the point where a mistake is invisible.
 */
export interface TracePick {
  /** The original `traces` column, whichever layout is being read. */
  column: number
  /** Index of this column's first value within the read, in float32s. */
  start: number
  stride: number
}

export interface TraceRead {
  chunkRow: number
  chunkCol: number
  /** Inclusive byte range, as `fetchBytes` takes it. */
  from: number
  to: number
  /** Global timestep of the first value each pick carries. */
  rowStart: number
  /** Timesteps each pick carries. */
  steps: number
  picks: TracePick[]
}

export interface TracePlan {
  layout: TraceLayout
  reads: TraceRead[]
  /** Distinct 512-neuron blocks this plan touches — what the node's cost sentence names. */
  blocks: number
  bytes: number
  /** Bytes plus requests priced in bytes — what the two layouts are compared on. */
  cost: number
}

/** The chunk rows a window touches, with the local row span of each. */
function rowSpans(window: TraceWindow): Array<{ chunkRow: number; lo: number; hi: number }> {
  const spans: Array<{ chunkRow: number; lo: number; hi: number }> = []
  const first = Math.floor(window.start / CHUNK_T)
  const last = Math.floor((window.end - 1) / CHUNK_T)
  for (let chunkRow = first; chunkRow <= last; chunkRow++) {
    const base = chunkRow * CHUNK_T
    spans.push({
      chunkRow,
      lo: Math.max(window.start, base) - base,
      hi: Math.min(window.end, base + CHUNK_T) - base,
    })
  }
  return spans
}

function costOf(reads: TraceRead[], blocks: number): Omit<TracePlan, 'layout' | 'reads'> {
  let bytes = 0
  for (const read of reads) bytes += read.to - read.from + 1
  return { blocks, bytes, cost: bytes + reads.length * REQUEST_BYTES_EQUIVALENT }
}

/**
 * Group items by the chunk column they fall in, lowest first.
 *
 * Shared because both planners opened with the same `get / push / else set` and the same sort,
 * and had already drifted on where they de-duplicate — one before grouping, one after, same
 * result spelled twice. The *bodies* stay separate: one emits a whole chunk row at `stride: 512`
 * and the other runs a bridging greedy at `stride: 1`, and collapsing those behind a flag would
 * be worse than the repetition it removed.
 */
function byChunkCol<T>(
  items: readonly T[],
  positionOf: (item: T) => number,
): Array<[number, T[]]> {
  const blocks = new Map<number, T[]>()
  for (const item of items) {
    const block = Math.floor(positionOf(item) / CHUNK_F)
    const held = blocks.get(block)
    if (held) held.push(item)
    else blocks.set(block, [item])
  }
  return [...blocks].sort((a, b) => a[0] - b[0])
}

/**
 * Row-major: one read per (block, chunk row), covering the window's rows and all 512 neurons.
 *
 * There is nothing to choose here — a chunk row cannot be read in part along the neuron axis,
 * so the only question is which blocks are touched.
 */
export function planPlainRead(columns: readonly number[], window: TraceWindow): TracePlan {
  const reads: TraceRead[] = []
  const spans = rowSpans(window)
  const blocks = byChunkCol([...new Set(columns)], (column) => column)
  for (const [chunkCol, wanted] of blocks) {
    /*
     * Built once per block, not once per chunk row: a pick depends only on the column and the
     * block, so rebuilding it inside the span loop allocated `spans` copies of every one — 16×
     * over the whole recording, and a million objects on a whole-dataset selection. The array is
     * shared across that block's reads, which `fetchTraces` only ever reads from.
     */
    const picks = wanted.map((column) => ({
      column,
      start: column - chunkCol * CHUNK_F,
      stride: CHUNK_F,
    }))
    for (const span of spans) {
      reads.push({
        chunkRow: span.chunkRow,
        chunkCol,
        from: span.lo * ROW_BYTES,
        to: span.hi * ROW_BYTES - 1,
        rowStart: span.chunkRow * CHUNK_T + span.lo,
        steps: span.hi - span.lo,
        picks,
      })
    }
  }
  return { layout: 'plain', reads, ...costOf(reads, blocks.length) }
}

/**
 * Transposed: one read per run of nearby neurons, per (block, chunk row).
 *
 * A run from local position `a` to `b` is one contiguous range, because the transpose puts each
 * neuron's timesteps together — the cost of including `b - a` unwanted neurons between two
 * wanted ones is `(b - a) × 2,048` bytes, which `REQUEST_BYTES_EQUIVALENT` says is worth paying
 * up to about 220 of. Hence the greedy below bridges a gap whenever bridging is cheaper than the
 * request it saves, which is the same comparison the plan choice makes one level up.
 */
export function planSortedRead(
  columns: readonly number[],
  sortedOf: (column: number) => number,
  window: TraceWindow,
): TracePlan {
  const placed = [...new Set(columns)].map((column) => ({ column, position: sortedOf(column) }))
  const blocks = byChunkCol(placed, (entry) => entry.position)
  const reads: TraceRead[] = []
  const spans = rowSpans(window)

  for (const [chunkCol, wanted] of blocks) {
    const base = chunkCol * CHUNK_F
    const sorted = [...wanted].sort((a, b) => a.position - b.position)
    // Greedy runs: start a new one when bridging costs more than the request it would save.
    const runs: Array<typeof sorted> = []
    let run: typeof sorted = []
    for (const entry of sorted) {
      const previous = run[run.length - 1]
      if (
        previous &&
        (entry.position - previous.position - 1) * COLUMN_BYTES > REQUEST_BYTES_EQUIVALENT
      ) {
        runs.push(run)
        run = []
      }
      run.push(entry)
    }
    if (run.length > 0) runs.push(run)

    // Once per run rather than once per run per chunk row — see `planPlainRead`.
    const planned = runs.map((group) => {
      const first = group[0]!.position - base
      return {
        first,
        last: group[group.length - 1]!.position - base,
        picks: group.map((entry) => ({
          column: entry.column,
          // Distance from the run's first byte, in float32s. The `span.lo` offset is already in
          // `from`, so it cancels and a pick starts exactly at its own neuron's boundary.
          start: (entry.position - base - first) * CHUNK_T,
          stride: 1,
        })),
      }
    })

    for (const span of spans) {
      for (const group of planned) {
        reads.push({
          chunkRow: span.chunkRow,
          chunkCol,
          from: group.first * COLUMN_BYTES + span.lo * BYTES_PER_VALUE,
          to: group.last * COLUMN_BYTES + span.hi * BYTES_PER_VALUE - 1,
          rowStart: span.chunkRow * CHUNK_T + span.lo,
          steps: span.hi - span.lo,
          picks: group.picks,
        })
      }
    }
  }
  return { layout: 'sorted', reads, ...costOf(reads, blocks.length) }
}

/**
 * The cheaper of the two, in bytes-plus-requests.
 *
 * `sortedOf` absent means the permutation could not be loaded, which is an ordinary state rather
 * than an error — the row-major route is a slower way to the identical answer.
 */
export function chooseTracePlan(
  columns: readonly number[],
  window: TraceWindow,
  sortedOf: ((column: number) => number) | undefined,
): TracePlan {
  const plain = planPlainRead(columns, window)
  if (!sortedOf) return plain
  const sorted = planSortedRead(columns, sortedOf, window)
  return sorted.cost < plain.cost ? sorted : plain
}
