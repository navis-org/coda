/**
 * What a table-file reader is, and the pieces both formats share.
 *
 * Kept apart from `read.ts`, which imports both format modules, so neither format module imports
 * the other through it.
 */

import { hashBytes } from '../../core/hash'
import { idText, isNeuronId } from '../../core/ids'
import { lowerBound } from '../../core/stats'
import type { ByteSource } from './bytes'
import { TAIL_READ } from './bytes'
import type { FileSummary } from './columns'
import { utf8 } from './columns'

/**
 * One block's raw cells, per column, read in place: a getter per column rather than a copied
 * array, so a lookup that keeps three rows of a million touches three — the library's own decoded
 * arrays (Parquet) or vectors (Arrow) stay where they are.
 */
export interface RawBlock {
  readonly rows: number
  readonly columns: Readonly<Record<string, (row: number) => unknown>>
  /**
   * The same cells as the arrays the library decoded, where a format hands them over — what a
   * whole-column scan walks instead of calling a getter per row (`matchingRows`).
   */
  readonly runs?: Readonly<Record<string, readonly ColumnRun[]>>
}

/**
 * A stretch of one column's rows as decoded, from row `start` — ascending, not overlapping. A
 * 64-bit run is a `BigInt64Array`, and reading one element by element makes a `bigint` per row:
 * measured on a 192M-row synapse table, that allocation was most of a scan's time once the
 * decoding itself was fast. So the scans read such a run's two 32-bit words (`int64Words`).
 */
export interface ColumnRun {
  readonly start: number
  readonly values: ArrayLike<unknown>
}

/**
 * A 64-bit integer run's buffer as 32-bit words — low word at `2i`, high at `2i + 1`, every engine
 * this runs in being little-endian — or undefined for any other run. `signed` where the high word
 * is two's complement (`int64`, not `uint64`); `joinWords` is the one place that reads it back.
 */
export function int64Words(
  values: ArrayLike<unknown>,
): { words: Uint32Array; signed: boolean } | undefined {
  if (!(values instanceof BigInt64Array || values instanceof BigUint64Array)) return undefined
  return {
    words: new Uint32Array(values.buffer, values.byteOffset, values.length * 2),
    signed: values instanceof BigInt64Array,
  }
}

/** A value from its two unsigned 32-bit words — `int64Words`' inverse. */
export function joinWords(high: number, low: number, signed: boolean): bigint {
  return (BigInt(signed ? high | 0 : high) << 32n) + BigInt(low)
}

/** An integer's 64-bit pattern as unsigned 32-bit words, high then low. */
export function splitWords(value: bigint): [number, number] {
  const bits = BigInt.asUintN(64, value)
  return [Number(bits >> 32n), Number(bits & 0xffffffffn)]
}

/**
 * One column of a block as a getter over its runs, never a copy — a lookup keeping three rows of a
 * million touches three. A cursor on the last run hit (every reader here walks rows in ascending
 * order), and a binary search when it misses; a row no run covers reads as null.
 */
export function runGetter(runs: readonly ColumnRun[], rows: number): (row: number) => unknown {
  let at = 0
  return (row) => {
    if (row < 0 || row >= rows) return null
    let run = runs[at]
    if (!run || row < run.start || row >= run.start + run.values.length) {
      let lo = 0
      let hi = runs.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1
        if (runs[mid]!.start <= row) lo = mid
        else hi = mid - 1
      }
      at = lo
      run = runs[lo]
      if (!run || row < run.start || row >= run.start + run.values.length) return null
    }
    return run.values[row - run.start] ?? null
  }
}

export interface TableFileReader {
  readonly summary: FileSummary
  /**
   * Whether `block` could hold any of `probe`'s ids in `column` — `false` only when the block's own
   * statistics rule every one of them out. Always `true` where there are no statistics.
   */
  mayHold(block: number, column: string, probe: IdProbe): boolean
  /**
   * One block's cells for the named columns. Blocks are read one at a time by design.
   *
   * `head` is a caller that will keep no more than that many of the block's leading rows: a reader
   * whose block is more than one read (`delta/reader.ts`, a file of row groups) may stop once it
   * has them, and the block it hands back is then that long or longer, never the block cut short
   * of `head`.
   */
  readBlock(block: number, columns: readonly string[], head?: number): Promise<RawBlock>
  /**
   * A keyed read of one block in one step, where the format has a path faster than reading its
   * columns whole (`pages.ts`): the rows where a `keys` column holds a probed id, and each
   * `outputs` column's values at them. Undefined where it cannot read this block that way, and the
   * caller reads it through `readBlock`.
   */
  readMatches?(
    block: number,
    keys: readonly string[],
    probe: IdProbe,
    outputs: readonly string[],
  ): Promise<Matches | undefined>
}

/** A block's matches: its rows, ascending, and each output column's raw values at them. */
export interface Matches {
  readonly rows: readonly number[]
  readonly values: Readonly<Record<string, readonly unknown[]>>
}

/**
 * A block's matches read through its columns, where the format has no keyed path or declines the
 * block: the key columns **alone** first, and the other columns only where a key matched — which
 * in Parquet is bytes never fetched, and everywhere is cells never decoded. A key that is also an
 * output is taken from the key read rather than read again.
 */
export async function matchesByColumns(
  reader: TableFileReader,
  block: number,
  keys: readonly string[],
  probe: IdProbe,
  outputs: readonly string[],
): Promise<Matches> {
  const keyed = await reader.readBlock(block, keys)
  const rows = unionRows(keys.map((key) => matchingRows(keyed, key, probe)))
  const others = outputs.filter((name) => !keys.includes(name))
  const rest = rows.length && others.length ? await reader.readBlock(block, others) : undefined
  const values = Object.fromEntries(
    outputs.map((name) => {
      const get = keyed.columns[name] ?? rest?.columns[name]
      return [name, rows.map((row) => get?.(row) ?? null)]
    }),
  )
  return { rows, values }
}

/** The ids a lookup asks about, prepared once for every block's range test and every row's. */
export interface IdProbe {
  readonly texts: ReadonlySet<string>
  /**
   * The integer ids as `bigint` — what a 64-bit key cell is tested against, by value, so the hot
   * loop over a full scan never spells a cell as eighteen digits of text to look it up.
   */
  readonly bigints: ReadonlySet<bigint>
  /** The same, ascending — what an integer column's statistics are compared to. */
  readonly integers: readonly bigint[]
  /** Every id as text, ascending — what a string column's statistics are compared to. */
  readonly strings: readonly string[]
  /**
   * The integer ids as 64-bit patterns split into 32-bit words, low word to its high words — what a
   * `BigInt64Array` run is matched against without a `bigint` per cell (`matchingRows`).
   */
  readonly words: ReadonlyMap<number, readonly number[]>
  /**
   * Which low 16 bits any probed id has — one typed-array read turns away nearly every row of a
   * scan before the Map, whose keys past 2^30 are heap numbers V8 hashes.
   */
  readonly lows: Uint8Array
}

export function idProbe(ids: readonly string[]): IdProbe {
  const texts = new Set(ids)
  const integers = [...texts]
    .filter(isNeuronId)
    .map((id) => BigInt(id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const words = new Map<number, number[]>()
  const lows = new Uint8Array(65_536)
  for (const id of integers) {
    // Past int64 a pattern's words are some negative number's: `probeHas` would not match it, so
    // neither may the word test — the fast and slow routes answer one question.
    if (id >= 2n ** 63n) continue
    const [high, low] = splitWords(id)
    const highs = words.get(low)
    if (highs) highs.push(high)
    else words.set(low, [high])
    lows[low & 0xffff] = 1
  }
  return {
    texts,
    bigints: new Set(integers),
    integers,
    strings: [...texts].sort(),
    words,
    lows,
  }
}

/**
 * The rows of `block` whose `name` cell is one of the probed ids, ascending — over the decoded runs
 * where the format handed them over, a 64-bit run by its 32-bit words, and through the getter
 * otherwise.
 */
export function matchingRows(block: RawBlock, name: string, probe: IdProbe): number[] {
  const rows: number[] = []
  const runs = block.runs?.[name]
  if (!runs) {
    const get = block.columns[name]
    for (let row = 0; get && row < block.rows; row++) {
      if (probeHas(probe, get(row))) rows.push(row)
    }
    return rows
  }
  for (const { start, values } of runs) {
    const int64 = int64Words(values)
    if (int64) {
      pushWordHits(int64.words, values.length, start, probe, rows)
    } else {
      for (let i = 0; i < values.length; i++)
        if (probeHas(probe, values[i])) rows.push(start + i)
    }
  }
  return rows
}

/**
 * Push `start + k` for each of `count` 64-bit values — as 32-bit words, low at `2k` — that is a
 * probed id: the 16-bit bitmap first, then the words. The one test for a 64-bit key, on the
 * decoded runs (`matchingRows`) and on the raw pages (`pages.ts`) alike.
 */
export function pushWordHits(
  words: Uint32Array,
  count: number,
  start: number,
  probe: IdProbe,
  into: number[],
): void {
  const { lows, words: probed } = probe
  for (let k = 0; k < count; k++) {
    const low = words[2 * k]!
    if (lows[low & 0xffff] && probed.get(low)?.includes(words[2 * k + 1]!)) into.push(start + k)
  }
}

/** Ascending row lists as one ascending list, a row in several listed once. */
export function unionRows(lists: readonly (readonly number[])[]): readonly number[] {
  return lists.length === 1 ? lists[0]! : [...new Set(lists.flat())].sort((a, b) => a - b)
}

/**
 * Whether `block` could hold a probed id in any of `names` — the one rule for which blocks a keyed
 * read visits, asked by the read (`readRows`) and by the page sizing the split over them.
 */
export function blockMayHold(
  reader: TableFileReader,
  names: readonly string[],
  probe: IdProbe,
  block: number,
): boolean {
  return names.some((name) => reader.mayHold(block, name, probe))
}

/**
 * Whether a raw key cell is one of the probed ids — exact whatever the column's type: a `bigint`
 * by value, anything else as `idText` spells it, which is the one rule for an id's text.
 */
function probeHas(probe: IdProbe, raw: unknown): boolean {
  if (typeof raw === 'bigint') return probe.bigints.has(raw)
  if (typeof raw !== 'string' && typeof raw !== 'number') return false
  const text = idText(raw)
  return text !== null && probe.texts.has(text)
}

/** A run of consecutive blocks, `to` exclusive — one part of a read split across workers. */
export interface BlockRange {
  readonly from: number
  readonly to: number
}

/** One end of a block's range: an integer id as `bigint`, a text id as text, `null` for none. */
export type Bound = bigint | string | null

/**
 * Each block's smallest and largest value in one column — the statistics Parquet keeps in its
 * footer, built by a lookup for a file that keeps none (Feather) and stored beside it
 * (`store.ts`). `null` for a block with no value in the column at all.
 */
export interface BlockIndex {
  readonly mins: readonly Bound[]
  readonly maxs: readonly Bound[]
}

/** Whether an indexed block could hold any probed id: an empty block holds none. */
export function indexMayHold(index: BlockIndex, block: number, probe: IdProbe): boolean {
  const min = index.mins[block]
  const max = index.maxs[block]
  if (min === null || max === null) return false
  return mayHoldRange(min, max, probe)
}

/**
 * Whether any probed id falls within `[min, max]`, compared the way the column holds them.
 *
 * Integer statistics compare against the integer ids exactly (as `bigint`, so an eighteen-digit
 * id is not rounded into a neighbour's range); text statistics compare as text, which is Parquet's
 * own byte order for UTF-8. Anything else — a float bound, a date, missing statistics — cannot
 * rule a block out, so it answers `true`.
 */
export function mayHoldRange(min: unknown, max: unknown, probe: IdProbe): boolean {
  const low = integerBound(min)
  const high = integerBound(max)
  if (low !== undefined && high !== undefined) {
    const id = probe.integers[lowerBound(probe.integers, low)]
    return id !== undefined && id <= high
  }
  const lowText = textBound(min)
  const highText = textBound(max)
  if (lowText !== undefined && highText !== undefined) {
    const id = probe.strings[lowerBound(probe.strings, lowText)]
    return id !== undefined && id <= highText
  }
  return true
}

function integerBound(bound: unknown): bigint | undefined {
  if (typeof bound === 'bigint') return bound
  if (typeof bound === 'number' && Number.isInteger(bound)) return BigInt(bound)
  return undefined
}

function textBound(bound: unknown): string | undefined {
  if (typeof bound === 'string') return bound
  if (bound instanceof Uint8Array) return utf8.decode(bound)
  return undefined
}

/**
 * The file's size, its footer and the last `TAIL_READ` bytes, hashed, with its identity where the
 * bytes have one — what a read checks it is still reading, and what a saved block index is keyed
 * by.
 *
 * Both formats end with the footer, its length and a magic string. A Parquet footer carries each
 * group's statistics, but **an Arrow footer carries only the schema and each batch's offsets**, so
 * two Feather files of one shape and row count — an edge list re-exported with new ids, polars
 * writing it uncompressed — had one fingerprint, and a lookup in the second took the first's block
 * index and skipped the blocks holding its answer. Hence the tail window, which ends inside the
 * last batch's data, and the identity — a local file's name and modification time, a URL's
 * `Last-Modified` — which makes this the one detector of a rewrite. Opened through `withTail`, all three
 * reads are served from the tail `openTableFile` has already fetched.
 */
export async function footerFingerprint(
  bytes: ByteSource,
  format: 'parquet' | 'feather',
): Promise<string> {
  // Parquet: `<footer> <int32 length> PAR1`. Arrow file: `<footer> <int32 length> ARROW1`.
  const end = bytes.size - (format === 'parquet' ? 8 : 10)
  const tail = await bytes.read(Math.max(0, end), bytes.size)
  const length = new DataView(tail.buffer, tail.byteOffset, tail.byteLength).getInt32(0, true)
  const start = Math.max(0, end - Math.max(0, length))
  const footer = await bytes.read(start, end)
  const window = await bytes.read(Math.max(0, bytes.size - TAIL_READ), bytes.size)
  const identity = new TextEncoder().encode(bytes.identity ?? '')
  return `${format}:${bytes.size}:${hashBytes([footer, window, identity])}`
}
