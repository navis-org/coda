/**
 * Every ZapBench cell at once — the overview a selection of cells is made from.
 *
 * `traces.ts` answers "the traces of these neurons" and is built around reading as little as a
 * selection needs. This answers the question before that one — *which* cells are worth selecting
 * — so it reads everything a window covers, and the only levers are the window and a scale.
 *
 * ## The pyramid, which `traces.ts` refuses and this reads
 *
 * `traces_rastermap_sorted` is an OME-NGFF multiscale: `s1` is `[3940, 35861]` and `s2` is
 * `[1970, 17931]`, both `chunks [512, 512]`, both `transpose` then `bytes` with no compressor, and
 * the downsampling applies to **both axes**. Measured against the bucket rather than read off the
 * metadata:
 *
 * - `s1[0, 0]` is the mean of the 2 × 2 block of `s0` under it to float32 precision (0.1668079
 *   against 0.1668079), and `s2[0, 0]` the mean of the 4 × 4 block.
 * - **`s2` is built from `s1`, not from `s0`.** The two agree wherever a block is whole and part
 *   at a *partial* one. The last `s1` step (t 7878 and a padding step) is the mean of the one real
 *   step rather than half of it — but the last `s2` step is the mean of four `s1` cells, one of
 *   which is that single-step mean, so t 7878 counts double: 0.068819 against 0.067784 for the
 *   plain mean of the three real steps. A partial *row* is exact at both levels, because
 *   71,721 = 4 × 17,930 + 1 puts one real cell in the last `s2` row and `s1` averaged it alone.
 *
 * So a partial **time** bin is dropped (`levelWindow` floors the end) and a partial **row** is
 * kept, naming the one cell it holds.
 *
 * A row at `s1` is two cells and nothing in the value says so, which is why `traces.ts` will not
 * read one for a neuron. Here that is the point, and the identity travels beside the values
 * rather than being lost: `sorting.json` says which cell sits at each sorted position, so `cells`
 * names every member of every row.
 *
 * ## Why both derived products are checked before a reduced scale is used
 *
 * A row's name rests on two claims nobody publishes as a contract: the permutation, and that a
 * level averages the one below it. Either going stale returns real activity under the wrong cell
 * ids — `traces.ts`' failure mode, reached by another road. The permutation is `verifiedSorting`'s;
 * `verifiedLevel` reads two level cells and the blocks under them. Unlike the sorted route in
 * `traces.ts` there is **no slower way to the same answer** — every cell at full scale over the
 * whole recording is four gigabytes — so a failed check refuses and names Full as the remedy.
 *
 * ## Layout
 *
 * Full scale reads the **row-major** copy. Every cell over a window is every block anyway, and
 * row-major costs only the window's rows of each, where the transposed copy bridges nearly a whole
 * chunk to reach them: 179 MB against 423 MB over `flash`. Rows are then placed in activity order
 * through the permutation, falling back to cell order when it cannot be verified — at full scale a
 * row's *label* comes from its column rather than from the permutation, so a stale sort reorders
 * the picture and mislabels nothing. A reduced scale exists only as the transposed copy.
 *
 * No session cache, unlike `traces.ts`: that one's unit is a neuron because a *changed selection*
 * re-reads one, and nothing here changes by one. A re-run is a changed window or scale, which is a
 * different set of chunks, and the scheduler's own cache already answers an unchanged card.
 */

import { errorMessage } from '../../core/errors'
import { mapWithConcurrency } from '../concurrency'
import { memoPromise } from '../memoPromise'
import { BYTES_PER_VALUE, CHUNK_F, CHUNK_T, ROW_BYTES, rowSpans } from './readPlan'
import type { TraceLayout } from './readPlan'
import type { TraceCost, TraceProduct, TraceWindow } from './traces'
import {
  FETCH_CONCURRENCY,
  SORTED_LEVEL,
  TRACE_COLUMNS,
  chunkUrl,
  hasSortedCopy,
  readRange,
  readTicker,
  traceLabel,
  verifiedSorting,
  windowLength,
} from './traces'

/**
 * The pyramid's levels: how many cells — and timesteps — each value averages, the level that holds
 * them, and what the node's picker calls them. One table, so the type, the addressing and the
 * options cannot list different scales.
 */
export const RECORDING_SCALES = [
  { scale: 1, level: SORTED_LEVEL, label: 'Full' },
  { scale: 2, level: 's1', label: 'Half — 2 × 2 averaged' },
  { scale: 4, level: 's2', label: 'Quarter — 4 × 4 averaged' },
] as const

export type RecordingScale = (typeof RECORDING_SCALES)[number]['scale']

/** The node's declared default, and what an unreadable stored value reads as. One spelling. */
export const DEFAULT_SCALE: RecordingScale = 4

function levelOf(scale: RecordingScale): string {
  return RECORDING_SCALES.find((entry) => entry.scale === scale)!.level
}

export function readScale(value: unknown): RecordingScale {
  const scale = Number(value)
  return RECORDING_SCALES.find((entry) => entry.scale === scale)?.scale ?? DEFAULT_SCALE
}

/** Rows at a scale — every bin, the last of them partial. */
export function recordingRows(scale: RecordingScale): number {
  return Math.ceil(TRACE_COLUMNS / scale)
}

/**
 * A window of full-resolution timesteps as the level steps wholly inside it. Floored at the end
 * because a partial time bin is not the mean of what it covers — see the header.
 */
export function levelWindow(window: TraceWindow, scale: RecordingScale): TraceWindow {
  return { start: Math.ceil(window.start / scale), end: Math.floor(window.end / scale) }
}

/** Refused at both stages, so worded once. */
export function noDownsampledCopy(product: TraceProduct): string {
  return `${traceLabel(product)} has no downsampled copy in this release — only Activity does. Set Scale to Full.`
}

export interface RecordingRead {
  chunkRow: number
  chunkCol: number
  /** Inclusive byte range, as `fetchBytes` takes it. */
  from: number
  to: number
  /** The chunk row's local steps `[lo, hi)` this read carries. */
  lo: number
  hi: number
  /** Real rows in this chunk column — fewer than 512 only in the last. */
  cells: number
}

/**
 * Every read a whole-population window needs, and their bytes. Pure, so the ranges are testable
 * without a store.
 *
 * Row-major reads take the window's steps across the chunk, stopping at the last real cell.
 * Transposed reads run from the first wanted step of the first cell to the last wanted step of the
 * last, which is nearly the whole chunk — the reason full scale is row-major.
 */
export function planRecordingRead(
  layout: TraceLayout,
  window: TraceWindow,
  rows: number,
): { reads: RecordingRead[]; bytes: number } {
  const reads: RecordingRead[] = []
  let bytes = 0
  const spans = rowSpans(window)
  for (let chunkCol = 0; chunkCol * CHUNK_F < rows; chunkCol++) {
    const cells = Math.min(CHUNK_F, rows - chunkCol * CHUNK_F)
    for (const { chunkRow, lo, hi } of spans) {
      const from = layout === 'plain' ? lo * ROW_BYTES : lo * BYTES_PER_VALUE
      const to =
        layout === 'plain'
          ? ((hi - 1) * CHUNK_F + cells) * BYTES_PER_VALUE - 1
          : ((cells - 1) * CHUNK_T + hi) * BYTES_PER_VALUE - 1
      reads.push({ chunkRow, chunkCol, from, to, lo, hi, cells })
      bytes += to - from + 1
    }
  }
  return { reads, bytes }
}

/**
 * Where a level is checked, as full-resolution `[timestep, sorted position]`. Multiples of four so
 * one probe serves either level, inside one chunk at every level, and away from the partial bins
 * at the ends — the only place the two ways of building `s2` differ.
 */
const LEVEL_PROBES: ReadonlyArray<readonly [number, number]> = [
  [2000, 20000],
  [6000, 60000],
]

/** A float32 level cell against a float64 mean of float32s: 1.3e-8 apart on the real bucket. */
const LEVEL_TOLERANCE = 1e-5

const levelChecks = new Map<RecordingScale, Promise<boolean>>()

/**
 * Whether a level still averages the full-resolution transposed copy.
 *
 * Checked against `s0` of the *sorted* copy, which `verifiedSorting` has already tied to the
 * published `traces` — so the chain from a level's row to a cell id is checked end to end. Two
 * probes and a non-zero requirement for that function's reason: padding reads as zero, and two
 * zeroes average perfectly well. An abort is rethrown rather than remembered, or a Cancel during
 * the check would refuse every reduced scale for the rest of the session.
 */
export function verifiedLevel(
  scale: Exclude<RecordingScale, 1>,
  options: { signal?: AbortSignal | undefined; refresh?: boolean | undefined } = {},
): Promise<boolean> {
  if (options.refresh) levelChecks.delete(scale)
  /** `count` float32s of the transposed copy at `level`, starting at `(t, position)`. */
  const readSorted = (level: string, t: number, position: number, count: number) => {
    const at = ((position % CHUNK_F) * CHUNK_T + (t % CHUNK_T)) * BYTES_PER_VALUE
    return readRange(
      chunkUrl(
        'traces',
        'sorted',
        Math.floor(t / CHUNK_T),
        Math.floor(position / CHUNK_F),
        level,
      ),
      at,
      at + count * BYTES_PER_VALUE - 1,
      options.signal,
    )
  }
  return memoPromise(
    levelChecks,
    scale,
    async () => {
      try {
        const probes = await Promise.all(
          LEVEL_PROBES.map(async ([t, position]) => {
            // The block under a level cell is one contiguous range of the transposed `s0`:
            // `scale` cells of `scale` steps each, bridged by the steps between.
            const [level, block] = await Promise.all([
              readSorted(levelOf(scale), t / scale, position / scale, 1),
              readSorted(SORTED_LEVEL, t, position, (scale - 1) * CHUNK_T + scale),
            ])
            let sum = 0
            for (let cell = 0; cell < scale; cell++) {
              for (let step = 0; step < scale; step++) sum += block[cell * CHUNK_T + step]!
            }
            return { level: level[0]!, mean: sum / (scale * scale) }
          }),
        )
        return (
          probes.some((probe) => probe.mean !== 0) &&
          probes.every(
            (probe) =>
              Math.abs(probe.level - probe.mean) <=
              LEVEL_TOLERANCE * Math.max(1, Math.abs(probe.mean)),
          )
        )
      } catch (error) {
        if (options.signal?.aborted) throw error
        return false
      }
    },
    { keep: 'resolved' },
  )
}

/** Forget the session's level checks — `resetSortingCheck`'s sibling, for tests. */
export function resetLevelChecks(): void {
  levelChecks.clear()
}

export interface RecordingRequest {
  product: TraceProduct
  scale: RecordingScale
  /** Full-resolution timesteps, as `conditionWindow` returns them. */
  window: TraceWindow
  signal?: AbortSignal | undefined
  onProgress?: ((fraction: number, note?: string) => void) | undefined
  /** What the read will cost, once the checks have passed and before any of it is read. */
  onCost?: ((cost: TraceCost) => void) | undefined
  refresh?: boolean | undefined
}

export interface RecordingResult {
  /** Row-major, `rows × steps`. */
  values: Float64Array
  rows: number
  steps: number
  /** The full-resolution timestep each column begins at. */
  stepStarts: number[]
  /**
   * The 1-based cell ids in each row, `scale` slots a row: row `r` is
   * `cells[r * scale … (r + 1) * scale)`, and a slot past the release's last cell is 0.
   */
  cells: Int32Array
  /** `cell` only at full scale, when the permutation could not be verified. */
  order: 'activity' | 'cell'
}

export async function fetchRecording(request: RecordingRequest): Promise<RecordingResult> {
  const { product, scale, window, signal, onProgress, onCost, refresh } = request
  const level = levelWindow(window, scale)
  const steps = windowLength(level)
  if (steps <= 0) throw new Error('ZapBench recording window is empty at this scale')
  const full = scale === 1
  if (!full && !hasSortedCopy(product)) throw new Error(noDownsampledCopy(product))

  // Concurrent: neither check reads the other's answer, and both are memoised for the session.
  const [sorting, levelHolds] = await Promise.all([
    verifiedSorting({ signal, refresh }),
    full ? true : verifiedLevel(scale, { signal, refresh }),
  ])
  if (!full) {
    if (!sorting) {
      throw new Error(
        'The activity-sorted copy of ZapBench no longer matches its published traces, so a ' +
          'downsampled row cannot be named. Set Scale to Full.',
      )
    }
    if (!levelHolds) {
      throw new Error(
        `ZapBench's ${scale} × ${scale} copy no longer averages its full-resolution one, so ` +
          `its rows would not be the cells their labels name. Set Scale to Full.`,
      )
    }
  }

  const rows = recordingRows(scale)
  const layout: TraceLayout = full ? 'plain' : 'sorted'
  const plan = planRecordingRead(layout, level, rows)
  onCost?.({
    bytes: plan.bytes,
    reads: plan.reads.length,
    blocks: Math.ceil(rows / CHUNK_F),
    layout,
  })

  /*
   * Which cells each row names, and where a stored row lands. At full scale a stored row is a
   * cell column, placed at its sorted position when there is one; at a reduced scale it already is
   * a sorted position. Both come from the one walk over the permutation.
   */
  const cells = new Int32Array(rows * scale)
  for (let column = 0; column < TRACE_COLUMNS; column++) {
    cells[sorting ? sorting[column]! : column] = column + 1
  }
  const placed = full ? sorting : undefined

  const values = new Float64Array(rows * steps)
  const tick = readTicker(plan.reads.length, onProgress)
  onProgress?.(0, `${rows.toLocaleString()} rows in ${plan.reads.length} reads`)

  /*
   * Scattered inside the callback, `fetchTraces`' reason: holding every read until the end made
   * peak residency the whole transfer. The first failure stops any read not yet started — nothing
   * is returned once one chunk is missing, and a whole-population read can be a couple of thousand
   * more requests to throw away — 141 blocks times every chunk row the window spans.
   */
  let failure: { job: RecordingRead; error: unknown } | undefined
  await mapWithConcurrency(plan.reads, FETCH_CONCURRENCY, async (job) => {
    if (failure) return
    let chunk: Float32Array
    try {
      chunk = await readRange(
        chunkUrl(product, layout, job.chunkRow, job.chunkCol, levelOf(scale)),
        job.from,
        job.to,
        signal,
      )
    } catch (error) {
      if (signal?.aborted) throw error
      failure ??= { job, error }
      return
    }
    const width = job.hi - job.lo
    const offset = job.chunkRow * CHUNK_T + job.lo - level.start
    for (let local = 0; local < job.cells; local++) {
      const stored = job.chunkCol * CHUNK_F + local
      const at = (placed ? placed[stored]! : stored) * steps + offset
      if (layout === 'sorted') {
        values.set(chunk.subarray(local * CHUNK_T, local * CHUNK_T + width), at)
        continue
      }
      for (let step = 0; step < width; step++)
        values[at + step] = chunk[step * CHUNK_F + local]!
    }
    tick()
  })

  if (failure) {
    const { job, error } = failure
    throw new Error(
      `ZapBench chunk ${job.chunkRow}/${job.chunkCol} could not be read ` +
        `(${errorMessage(error)}). Leaving it out would put ` +
        `zeroes in the middle of the recording, so nothing is returned.`,
    )
  }

  return {
    values,
    rows,
    steps,
    stepStarts: Array.from({ length: steps }, (_, step) => (level.start + step) * scale),
    cells,
    order: full && !sorting ? 'cell' : 'activity',
  }
}
