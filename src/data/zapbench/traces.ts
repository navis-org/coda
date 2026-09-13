/**
 * ZapBench calcium-imaging traces, read straight out of the released zarr array.
 *
 * The published volume is a **zarr v3 array with no compressor** — `codecs` is `bytes` and
 * nothing else — which is the whole reason this file is short and the whole reason it can be
 * selective. Every byte offset is arithmetic, so a chunk can be read in part with an HTTP
 * range request and there is no codec to run over what comes back.
 *
 * ## The layout, and what it costs
 *
 * `shape [7879, 71721]`, `chunks [512, 512]`, `float32`, labelled `['t', 'f']` by zapbench's
 * own `constants.SPECS` — time down, neurons across. Measured rather than assumed: the axes
 * were told apart by autocorrelation (lag-1 0.54 along axis 0 against 0.25 along axis 1,
 * decaying to 0.12 by lag 20 where axis 1 stays flat) before `input_labels` was found to agree.
 *
 * Neurons are therefore on the **contiguous** axis, and that one fact decides everything here:
 *
 * - A fixed `t` is 512 adjacent neurons in 2,048 contiguous bytes.
 * - A fixed neuron is 512 values strided 2,048 bytes apart.
 *
 * So the cost of a request is **(distinct 512-neuron blocks it touches) × (timesteps asked
 * for) × 2,048 bytes**, and the neuron *count* barely enters into it: one neuron and 512
 * adjacent neurons cost exactly the same. Measured against the bucket at concurrency 6, one
 * block over the whole recording is 16 MiB in ~1.4 s (1.6 MiB/s serial — the concurrency is
 * load-bearing, not a tidy-up).
 *
 * That is why `ZAPBENCH_CONDITIONS` is not a convenience. A time window is the *only* thing
 * that reduces bytes: subsampling does not, because a chunk row already spans 512 timesteps,
 * so asking for every tenth frame reads exactly what asking for all of them reads.
 *
 * ## Why a multi-range request is not an option
 *
 * It would be the obvious win — a single neuron's 512 values inside a chunk are 512 four-byte
 * reads, 2 KiB of useful data inside 1 MiB. GCS refuses it: `Range: bytes=0-163, 2048-2211`
 * comes back **400 InvalidArgument, "Multiple ranges..."**. One range per request is the whole
 * budget, so the unit here is a contiguous *row span* of one chunk, which necessarily carries
 * all 512 of that chunk's neurons.
 *
 * ## Why the cache is here and in memory
 *
 * `geometryCache.ts`' argument transfers without change: the node re-runs whenever anything
 * about its input changes (invariant 4), and what is wasteful is the re-download inside the
 * re-run rather than the re-run. The unit cached is one neuron's windowed trace — 31.5 kB over
 * the whole recording — rather than the 1 MiB chunk it arrived in, because that is the unit a
 * *changed selection* hits on: adding a neuron to a set of fifty re-fetches one block and reads
 * the other forty-nine out of memory.
 *
 * Not IndexedDB, for `geometryCache.ts`' reason and one of its own: a structured clone of
 * hundreds of megabytes of chunk has a cost of its own, and the reported pain is
 * within-session iteration.
 */

import { mapWithConcurrency } from '../concurrency'
import { memoPromise } from '../memoPromise'
import { fetchBytes, objectStoreUrl } from '../precomputed/transport'
import { BYTES_PER_VALUE, CHUNK_F, CHUNK_T, chooseTracePlan } from './readPlan'
import type { TraceLayout } from './readPlan'
import { loadTraceSorting, resetTraceSorting } from './sorting'

/** The released volume group. A dated release, so this is a version rather than a location. */
/** The dated release this build reads. One spelling — the sorting cache keys on it too. */
export const ZAPBENCH_RELEASE_ID = '20240930'
export const ZAPBENCH_RELEASE = `gs://zapbench-release/volumes/${ZAPBENCH_RELEASE_ID}`

/** `shape[0]` — timesteps in the full recording. */
export const TRACE_TIMESTEPS = 7879
/** `shape[1]` — trace columns, one per segmented cell. */
export const TRACE_COLUMNS = 71721

/**
 * In flight at once. Six, measured: 16 MiB of chunk in 1.42 s at 6 against 10.05 s at 1 and
 * 1.45 s at 12 — so this is where the curve flattens, and going higher only spends request
 * slots a shared bucket may want for somebody else.
 */
const FETCH_CONCURRENCY = 6

/**
 * Which array to read.
 *
 * Two products with byte-identical geometry — same shape, same chunking, same missing
 * compressor — so the choice costs one path segment and no branch anywhere below.
 */
export type TraceProduct = 'traces' | 'stimulus_evoked_response'

/**
 * The two products, in the shape the node's `enum` param reads directly.
 *
 * `unit` is here rather than in the node because it is the thing that actually *differs*: a
 * table carrying only a label leaves the node hard-coding `df/f` for both, which is exactly the
 * claim this table exists to own. `live.test.ts` loops its shape and codec assertions over these
 * rows for the same reason — "byte-identical geometry" is the premise the single code path below
 * rests on, so it is checked per product rather than asserted in prose.
 */
export const TRACE_PRODUCTS: ReadonlyArray<{
  value: TraceProduct
  label: string
  unit: string
  /**
   * Whether a transposed copy of this product exists. There is no
   * `stimulus_evoked_response_rastermap_sorted`, so the layout is chosen per product — and this
   * is the third thing that differs per product, which is what this table is for.
   */
  sorted: boolean
}> = [
  { value: 'traces', label: 'Activity (df/f)', unit: 'df/f', sorted: true },
  {
    value: 'stimulus_evoked_response',
    label: 'Stimulus-evoked response',
    unit: 'evoked response',
    sorted: false,
  },
]

/**
 * Per-product facts, keyed. A `find(...) ?? 'df/f'` was a second copy of a default already in the
 * table above, on a branch nothing can reach — the shape invariant 4 names.
 */
const PRODUCTS = new Map(TRACE_PRODUCTS.map((entry) => [entry.value, entry]))

/** The unit a product's numbers are in, for a matrix's `valueLabel`. */
export function traceUnit(product: TraceProduct): string {
  return PRODUCTS.get(product)!.unit
}

/**
 * A stored `enum` value as a product, falling back to the declared default.
 *
 * Beside the union rather than in the node, so a second reader — a probe, an emitter — coerces
 * the same way instead of minting the seventh spelling of this.
 */
export function readProduct(value: unknown): TraceProduct {
  return TRACE_PRODUCTS.some((product) => product.value === value)
    ? (value as TraceProduct)
    : 'traces'
}

/** Half-open, in absolute timesteps of the full recording — `[start, end)`. */
export interface TraceWindow {
  readonly start: number
  readonly end: number
}

export interface ZapBenchCondition {
  /** zapbench's own name, verbatim from `constants.CONDITION_NAMES`. */
  readonly name: string
  readonly window: TraceWindow
}

/**
 * `constants.CONDITION_OFFSETS`, verbatim. Ten boundaries for nine conditions.
 *
 * The last entry is `TRACE_TIMESTEPS`, which is what makes the whole recording the union of
 * the nine and not something slightly shorter.
 */
const CONDITION_OFFSETS = [0, 649, 2422, 3078, 3735, 5047, 5638, 6623, 7279, 7879] as const

const CONDITION_NAMES = [
  'gain',
  'dots',
  'flash',
  'taxis',
  'turning',
  'position',
  'open loop',
  'rotation',
  'dark',
] as const

/**
 * `constants.CONDITION_PADDING`, applied the way `data_utils.get_condition_bounds` applies it:
 * added to the lower bound and subtracted from the upper, giving an
 * `(inclusive_min, exclusive_max)` pair. Trimming both ends is what keeps the transition
 * between two stimuli out of either one's window.
 */
const CONDITION_PADDING = 1

export const ZAPBENCH_CONDITIONS: readonly ZapBenchCondition[] = CONDITION_NAMES.map(
  (name, index) => ({
    name,
    window: {
      start: CONDITION_OFFSETS[index]! + CONDITION_PADDING,
      end: CONDITION_OFFSETS[index + 1]! - CONDITION_PADDING,
    },
  }),
)

/** The whole recording, untrimmed — the union of the nine conditions plus both padded edges. */
export const WHOLE_RECORDING: TraceWindow = { start: 0, end: TRACE_TIMESTEPS }

/**
 * The window a stored param names, or `undefined` for a name no release has.
 *
 * `undefined` rather than a fallback to the whole recording: a condition the array does not
 * have is a graph asking a question this release cannot answer, and quietly widening it to
 * every timestep would answer a different one at 12× the cost.
 */
export function conditionWindow(name: string): TraceWindow | undefined {
  if (name === WHOLE_RECORDING_ID) return WHOLE_RECORDING
  return ZAPBENCH_CONDITIONS.find((condition) => condition.name === name)?.window
}

/** The param value meaning "do not window at all". Not a condition name, so it cannot collide. */
export const WHOLE_RECORDING_ID = 'all'

// ---------------------------------------------------------------------------
// The id mapping
// ---------------------------------------------------------------------------

/**
 * The trace column a `zapbenchId` names, or `undefined` when it names none.
 *
 * **A `zapbenchId` is the 1-based segmentation label, so the column is one lower** — measured,
 * not assumed; `pnpm probe:zapbench` is the record.
 *
 * `segmentation/dataframe.json` was downloaded whole (52 MB) and checked row by row:
 * `label[i] === i + 1` for all 71,721 rows, no exceptions. So the label and the column differ by
 * exactly one everywhere, and **both readings are in range for every id but the two at the
 * ends** — which is why the *range* could not settle it: fish2's 62,178 matched ids run
 * 5…71,720, and the top label being one of the 13% of cells nobody matched is ordinary.
 *
 * Geometry settled it. Every matched fish2 neuron carries a `somaLocation` and the released
 * dataframe carries a centroid per label — two descriptions of one cell in two frames — so an
 * affine was fitted between them and the residual read. Over 20,342 neurons within 5 µm of a
 * registration landmark, `id - 1` gives a median residual of **522 against 1,453 for `id`**, and
 * the **offset sweep is what makes that mean anything**: ±3 around it runs 1,473–1,995, so the
 * minimum is unique and 2.8× sharp rather than a fit that would have flattered any offset. It
 * resolves cleanly because ZapBench labels run roughly in `z`, so a wrong offset names a
 * different cell at a similar depth whose `x`/`y` is anywhere.
 *
 * Getting it wrong would not fail — it returns the *neighbouring cell's* trace, a real trace of
 * a real neuron, entirely plausible on a heatmap. That is why a caller refuses on an id this
 * cannot place rather than clamping: out of range means the wrong column was wired, not an id to
 * repair. A future 0-based release is a one-line edit under this comment, which is why there is
 * no configuration flag — a two-valued type whose second value nothing reads is a setting
 * pretending to be a measurement.
 *
 * Rejects a non-integer as well as an out-of-range one: a value arriving through a float64 cell
 * (`CellValue` is one) that is not whole is not an id that was rounded, it is a column that is
 * not this one.
 */
export function traceColumnOf(id: number): number | undefined {
  if (!Number.isInteger(id)) return undefined
  const column = id - 1
  return column >= 0 && column < TRACE_COLUMNS ? column : undefined
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export function windowLength(window: TraceWindow): number {
  return Math.max(0, window.end - window.start)
}

/**
 * Past this, a read is worth mentioning before it happens — 64 MB, which is four blocks over the
 * whole recording or about fifty over a single condition.
 *
 * Named because the message names it back and `docs/limits.md` carries the row; an inline
 * literal is the one shape a test cannot assert against.
 */
export const TRACE_BYTES_WARN = 64 * 1024 * 1024

// ---------------------------------------------------------------------------
// The session cache
// ---------------------------------------------------------------------------

/**
 * 256 MiB, `geometryCache.ts`' figure and for its reason: a guard rail on the orphaned tail
 * rather than a target. One neuron over the whole recording is 31.5 kB, so this holds about
 * eight thousand of them — comfortably more than any selection somebody is iterating on.
 */
const BUDGET_BYTES = 256 * 1024 * 1024

interface CacheEntry {
  values: Float32Array
  bytes: number
}

/** Insertion-ordered and re-inserted on read, so `Map`'s iteration order is the LRU queue. */
const cache = new Map<string, CacheEntry>()
let held = 0

function cacheKey(product: TraceProduct, window: TraceWindow, column: number): string {
  return `${product}:${window.start}-${window.end}:${column}`
}

function cacheRead(key: string): Float32Array | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  cache.delete(key)
  cache.set(key, entry)
  return entry.values
}

function cacheWrite(key: string, values: Float32Array): void {
  const existing = cache.get(key)
  if (existing) held -= existing.bytes
  cache.delete(key)
  cache.set(key, { values, bytes: values.byteLength })
  held += values.byteLength
  for (const [oldest, entry] of cache) {
    if (held <= BUDGET_BYTES) break
    cache.delete(oldest)
    held -= entry.bytes
  }
}

export function resetTraceCache(): void {
  cache.clear()
  held = 0
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

export interface TraceRequest {
  product: TraceProduct
  /** 0-based trace columns, already through `traceColumnOf`. Order is the result's row order. */
  columns: readonly number[]
  window: TraceWindow
  signal?: AbortSignal | undefined
  onProgress?: ((fraction: number, note?: string) => void) | undefined
  /**
   * What this read is about to cost, once the layout is settled and before any of it is read.
   *
   * A callback rather than a figure the caller computes, because **only this module knows which
   * layout will be used** — and the two differ by up to three orders of magnitude. Priced by the
   * caller instead, the node announced "about 554 MB" for a read that went on to fetch 1.1 MiB
   * by the transposed route: a warning that was true of a plan nobody executed.
   *
   * Raised after the permutation loads (a single small request) and before the data, so it still
   * lands beside a live Cancel, which is what `ctx.warn`'s "at the top" rule is protecting.
   */
  onCost?: ((cost: TraceCost) => void) | undefined
  /** Ignore the session cache for this read — `ctx.refresh`. */
  refresh?: boolean | undefined
}

export interface TraceCost {
  /** Bytes the chosen plan will read, after the cache answered what it could. */
  bytes: number
  /** Requests it will make. */
  reads: number
  /**
   * Distinct 512-neuron blocks it touches — taken from the plan rather than recomputed.
   *
   * The node used to re-derive this from the column list for its message, which meant two cost
   * models for one feature: the plan priced only the *uncached* columns while the node's blocks
   * counted all of them, so the two halves of one sentence described different sets.
   */
  blocks: number
  layout: TraceLayout
}

export interface TraceResult {
  /**
   * Neuron-major: row `i` is `columns[i]`'s trace over the window, `windowLength` long.
   *
   * One flat array rather than an array of arrays because both readers want it flat — a
   * `MatrixValue` is one `Float64Array` and the long table walks it in this order.
   */
  values: Float32Array
  window: TraceWindow
  /** Bytes actually read from the bucket, after the cache answered what it could. */
  bytesRead: number
}

/**
 * Where the transposed copy lives, and which level of it is usable.
 *
 * Owned here rather than in `sorting.ts` because this is *addressing*, which is what `chunkUrl`
 * below does — and because building it there meant importing `ZAPBENCH_RELEASE` across a module
 * cycle, which silently produced `"undefined/traces_rastermap_sorted"`. See that file's header.
 *
 * **`s1` and `s2` are deliberately unused.** The group is a real OME-NGFF pyramid
 * (`multiScale: true`, `downsamplingFactors: [[1,1],[2,2],[4,4]]`), but both factors apply to
 * **both axes** — so one level down averages each neuron with its rastermap neighbours. That
 * destroys exactly the per-neuron identity this node exists to preserve: a "trace" at `s1` is
 * the mean of two different cells and nothing downstream could tell. They are the right input
 * for a whole-population overview picture, which is a different feature. No level of this
 * pyramid answers "the trace of neuron X" more cheaply than `s0` does.
 */
export const SORTED_TRACES = `${ZAPBENCH_RELEASE}/traces_rastermap_sorted`
export const SORTED_LEVEL = 's0'

/**
 * Where a layout's chunk lives. The sorted copy exists for `traces` only — there is no
 * `stimulus_evoked_response_rastermap_sorted` — which is why the layout is chosen per product
 * rather than per session.
 */
function chunkUrl(
  product: TraceProduct,
  layout: TraceLayout,
  chunkRow: number,
  chunkCol: number,
): string {
  const base =
    layout === 'sorted' ? `${SORTED_TRACES}/${SORTED_LEVEL}` : `${ZAPBENCH_RELEASE}/${product}`
  const uri = `${base}/c/${chunkRow}/${chunkCol}`
  const url = objectStoreUrl(uri)
  // `objectStoreUrl` answers undefined only for a scheme it does not know, and this one is a
  // literal above — so this is a compile-time truth stated rather than a case to handle.
  if (!url) throw new Error(`Cannot map ${uri} to an HTTP URL`)
  return url
}

async function readRange(
  url: string,
  from: number,
  to: number,
  signal: AbortSignal | undefined,
): Promise<Float32Array> {
  const buffer = await fetchBytes(url, {
    range: [from, to],
    ...(signal ? { signal } : {}),
  })
  const expected = to - from + 1
  if (buffer.byteLength !== expected) {
    /*
     * A store that ignores `Range` answers 200 with the whole object, which would otherwise be
     * read as the range and silently misaligned — every value from the wrong place. GCS answers
     * 206 here (verified), so this is about the day it does not.
     */
    throw new Error(
      `ZapBench returned ${buffer.byteLength} bytes for a ${expected}-byte range of ${url}. ` +
        `The store may be ignoring Range requests.`,
    )
  }
  return new Float32Array(buffer)
}

/**
 * The permutation, if it loads *and* still describes this release.
 *
 * The check is the point. A re-sorted `traces_rastermap_sorted` would not fail — it would hand
 * back a real neuron's real trace under another neuron's name — so one cell is read both ways
 * and compared before the sorted route is used for anything. Two cells rather than one, and a
 * non-zero requirement, because the array's padding reads as 0 and two zeroes match each other
 * perfectly well.
 *
 * Four small requests, once per session, against a route that saves hundreds of megabytes. A
 * failure of any kind answers `undefined`, which is "read the row-major copy" — a slower route
 * to the identical answer rather than an error.
 */
const PROBE_CELLS: ReadonlyArray<readonly [number, number]> = [
  [0, 4],
  [4000, 50000],
]

const checked = new Map<string, Promise<Int32Array | undefined>>()

export function verifiedSorting(options: {
  signal?: AbortSignal | undefined
  refresh?: boolean | undefined
}): Promise<Int32Array | undefined> {
  if (options.refresh) checked.clear()
  return memoPromise(
    checked,
    'sorting',
    async () => {
      /*
       * Through `objectStoreUrl`, because `SORTED_TRACES` is a `gs://` URI like every other
       * address here and `fetchText` speaks HTTP. Handing it the bare URI failed silently in
       * exactly the way this whole route is designed around: `loadTraceSorting` answers
       * `undefined` for any failure, so the reader fell back to the row-major copy and returned
       * perfectly correct values by the slow path. Only the live test noticed.
       */
      const sortingUrl = objectStoreUrl(`${SORTED_TRACES}/sorting.json`)
      const inverse = sortingUrl
        ? await loadTraceSorting({
            url: sortingUrl,
            release: ZAPBENCH_RELEASE_ID,
            columns: TRACE_COLUMNS,
            ...options,
          })
        : undefined
      if (!inverse) return undefined
      try {
        /*
         * All four reads at once. Their offsets are known the moment `inverse` is in hand and
         * nothing in the pair depends on the other, but they were awaited one at a time — four
         * serial round trips at ~190 ms each, ~770 ms of dead time in front of the first byte of
         * every session's first read, and paid again on every `ctx.refresh`. What it costs is
         * that a mismatching first cell no longer short-circuits the second: two extra 4-byte
         * requests, in the case that means the release was re-sorted.
         */
        const probes = await Promise.all(
          PROBE_CELLS.flatMap(([t, column]) => {
            const position = inverse[column]!
            const plainOffset = ((t % CHUNK_T) * CHUNK_F + (column % CHUNK_F)) * BYTES_PER_VALUE
            const sortedOffset =
              ((position % CHUNK_F) * CHUNK_T + (t % CHUNK_T)) * BYTES_PER_VALUE
            return [
              readRange(
                chunkUrl(
                  'traces',
                  'plain',
                  Math.floor(t / CHUNK_T),
                  Math.floor(column / CHUNK_F),
                ),
                plainOffset,
                plainOffset + 3,
                options.signal,
              ),
              readRange(
                chunkUrl(
                  'traces',
                  'sorted',
                  Math.floor(t / CHUNK_T),
                  Math.floor(position / CHUNK_F),
                ),
                sortedOffset,
                sortedOffset + 3,
                options.signal,
              ),
            ]
          }),
        )
        let anyNonZero = false
        for (let pair = 0; pair < probes.length; pair += 2) {
          const plain = probes[pair]![0]!
          if (plain !== probes[pair + 1]![0]!) return undefined
          if (plain !== 0) anyNonZero = true
        }
        return anyNonZero ? inverse : undefined
      } catch {
        return undefined
      }
    },
    // `resolved` for `loadTraceSorting`'s reason: a session that has established there is no
    // usable sorted copy must not re-probe on every read.
    { keep: 'resolved' },
  )
}

/** Forget the session's verification — `resetTraceCache`'s sibling, for tests. */
export function resetSortingCheck(): void {
  checked.clear()
  resetTraceSorting(ZAPBENCH_RELEASE_ID)
}

/**
 * Read the traces for `columns` over `window`.
 *
 * Fetches only what the cache cannot answer, so a selection that grew by one neuron costs one
 * block — and reads it through whichever of the two published layouts is cheaper for the shape
 * asked for, which `readPlan.ts` decides and argues.
 *
 * **The extraction happens inside the fetch callback**, which is the difference between holding
 * one read per worker and holding the entire download: collecting and scattering afterwards made
 * peak residency the whole transfer — 800 MB on a fifty-block row-major read — to produce a
 * couple of megabytes of output. Consuming as they land bounds it at `FETCH_CONCURRENCY` reads
 * and overlaps the arithmetic with the waits. It is also the house pattern for this helper:
 * `precomputed/skeletons.ts` delivers inside the callback and discards the returned array. Two
 * reads never write the same cell, so there is no interleaving hazard.
 *
 * Throws rather than filling a gap: `mapWithConcurrency` reports a failed item as `undefined`,
 * and a hole left as the array's own `fill_value` would be a run of real-looking zeroes in the
 * middle of a trace.
 */
export async function fetchTraces(request: TraceRequest): Promise<TraceResult> {
  const { product, columns, window, signal, onProgress, onCost, refresh } = request
  const steps = windowLength(window)
  if (steps <= 0) throw new Error('ZapBench trace window is empty')

  const values = new Float32Array(columns.length * steps)

  /*
   * What the cache holds, and where each still-wanted column's values belong. A column may
   * repeat (a neuron table is data, and nothing promises its id column is unique), so the value
   * is a list of output rows rather than one.
   */
  const rowsOfColumn = new Map<number, number[]>()
  columns.forEach((column, row) => {
    const pending = rowsOfColumn.get(column)
    if (pending) {
      pending.push(row)
      return
    }
    const cached = refresh ? undefined : cacheRead(cacheKey(product, window, column))
    if (cached) {
      values.set(cached, row * steps)
      return
    }
    rowsOfColumn.set(column, [row])
  })

  if (rowsOfColumn.size === 0) {
    onProgress?.(1, `${columns.length} traces, cached`)
    return { values, window, bytesRead: 0 }
  }

  const missing = [...rowsOfColumn.keys()]
  const inverse = PRODUCTS.get(product)!.sorted
    ? await verifiedSorting({ signal, refresh })
    : undefined
  const plan = chooseTracePlan(
    missing,
    window,
    inverse ? (column) => inverse[column]! : undefined,
  )

  onCost?.({
    bytes: plan.bytes,
    reads: plan.reads.length,
    blocks: plan.blocks,
    layout: plan.layout,
  })

  /*
   * Throttled to whole percents. `ctx.progress` is not local — it sets state and notifies the
   * host, which walks the graph for observed schemas and re-renders — and a plain row-major plan
   * is up to 141 blocks × 16 chunk rows, so one call per read was ~2,250 full-graph walks inside
   * a single fetch. A percent nobody can read changing more than a hundred times buys nothing.
   */
  let done = 0
  let shown = -1
  onProgress?.(0, `${columns.length} traces in ${plan.reads.length} reads`)

  const read = await mapWithConcurrency(plan.reads, FETCH_CONCURRENCY, async (job) => {
    const chunk = await readRange(
      chunkUrl(product, plan.layout, job.chunkRow, job.chunkCol),
      job.from,
      job.to,
      signal,
    )
    const offset = job.rowStart - window.start
    /*
     * One loop for both layouts: `start` and `stride` are the only things that differ, which is
     * what keeps a transposed read from needing a second copy of this arithmetic.
     */
    for (const pick of job.picks) {
      const rows = rowsOfColumn.get(pick.column)
      if (!rows) continue
      /*
       * The transposed layout's whole point, taken: at `stride: 1` a neuron's window is
       * contiguous in the read *and* contiguous in the output, so the common case is one
       * `set` rather than a bounds-checked step loop — tens of millions of iterations at the
       * ceiling. The general loop stays for the row-major stride and for a repeated id.
       */
      if (pick.stride === 1 && rows.length === 1) {
        values.set(
          chunk.subarray(pick.start, pick.start + job.steps),
          rows[0]! * steps + offset,
        )
        continue
      }
      for (let step = 0; step < job.steps; step++) {
        const value = chunk[pick.start + step * pick.stride]!
        for (const row of rows) values[row * steps + offset + step] = value
      }
    }
    done += 1
    const percent = Math.floor((done * 100) / plan.reads.length)
    if (percent !== shown) {
      shown = percent
      onProgress?.(done / plan.reads.length, `${done}/${plan.reads.length} reads`)
    }
    return chunk.byteLength
  })

  // The guard, separated from the work: a `forEach` aborted by throwing from its callback reads
  // as a loop that cannot complete.
  const failed = read.findIndex((bytes) => bytes === undefined)
  if (failed >= 0) {
    const job = plan.reads[failed]!
    throw new Error(
      `ZapBench chunk ${job.chunkRow}/${job.chunkCol} of ${product} could not be read. ` +
        `Leaving it out would put zeroes in the middle of a trace, so nothing is returned.`,
    )
  }

  /*
   * Cache per neuron, not per chunk — the unit a changed selection hits on. `slice` rather than
   * `subarray` on purpose: a view would retain the whole `columns.length × steps` buffer behind
   * every entry while `held` accounted for one neuron's worth, so the budget would under-count by
   * orders of magnitude. The copy is the price of not retaining the parent.
   */
  for (const [column, rows] of rowsOfColumn) {
    const at = rows[0]! * steps
    cacheWrite(cacheKey(product, window, column), values.slice(at, at + steps))
  }

  return {
    values,
    window,
    // Every entry is a number by here — the guard above returned otherwise — but the array's
    // type still carries the failure case, so the accumulator is named rather than inferred.
    bytesRead: read.reduce<number>((total, bytes) => total + (bytes ?? 0), 0),
  }
}
