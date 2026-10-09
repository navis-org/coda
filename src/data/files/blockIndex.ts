/**
 * A table-file reader that skips blocks by a stored block index, and builds one as it reads.
 *
 * `mayHold` is already the seam that answers "can this block be ruled out" — it is where Parquet's
 * footer statistics are consulted — so a block index is a *reader*: this wraps one, answers
 * `mayHold` from the stored index for its column as well, and records each block's range from the
 * key-column reads made through it. Whoever scans a table file by a key (Read Rows, the Custom
 * Dataset's synapse lookups) gets both halves by wrapping, rather than re-implementing the skip, the
 * build and the rule for when a build is complete. Loading and saving are the page's
 * (`client.ts`): a read split across workers builds in parts, none of which sees every block.
 *
 * **Complete only when every block of its range was read through it**, and every value could be
 * compared: a scan the row cap stopped, a block Parquet's statistics skipped, or a column holding
 * floats leaves nothing half-built — and a build that can no longer be completed is dropped at once,
 * so a lookup that cannot finish one does not keep paying for it. The first lookup pays for the
 * index: it reads every block's key column anyway, there being nothing to skip by, and the build
 * adds one more walk of that column in memory — a few seconds on a few hundred million rows, once
 * per file and column.
 */

import type {
  BlockIndex,
  BlockRange,
  Bound,
  ColumnRun,
  IdProbe,
  RawBlock,
  TableFileReader,
} from './reader'
import { indexMayHold, int64Words, joinWords } from './reader'

export interface IndexedReader extends TableFileReader {
  /**
   * The index built over the read's range, when it is complete — full-length, with the blocks
   * outside the range empty, for the page to join with the other parts'. Undefined where one was
   * held, or the build could not be completed.
   */
  finish(): BlockIndex | undefined
}

export function withBlockIndex(
  reader: TableFileReader,
  column: string,
  /** The column's stored index, where there is one: skipped by, and not built. */
  stored: BlockIndex | undefined,
  /** The blocks this read covers — one part of a split read; the build is complete over these. */
  range: BlockRange = { from: 0, to: reader.summary.blocks },
): IndexedReader {
  // An index is a range per block, so one of another length describes some other file — or was
  // saved wrong — and skipping by it would skip blocks that hold the ids. Built again instead.
  const held = stored?.mins.length === reader.summary.blocks ? stored : undefined
  const blocks = reader.summary.blocks
  // A build is given up the moment it cannot be completed, and then costs nothing further.
  let build: { mins: Bound[]; maxs: Bound[]; seen: Set<number> } | undefined = held
    ? undefined
    : {
        mins: new Array<Bound>(blocks).fill(null),
        maxs: new Array<Bound>(blocks).fill(null),
        seen: new Set(),
      }

  return {
    summary: reader.summary,

    mayHold(block: number, name: string, probe: IdProbe): boolean {
      if (!reader.mayHold(block, name, probe)) {
        // A block ruled out on the key is a block the build will never see.
        if (name === column) build = undefined
        return false
      }
      return !(held && name === column) || indexMayHold(held, block, probe)
    },

    // Whole, whatever `head` a caller passes: a block's range is taken from what is read here,
    // and a block cut short would be indexed by the range of its first rows.
    async readBlock(block: number, columns: readonly string[]): Promise<RawBlock> {
      const raw = await reader.readBlock(block, columns)
      const cell = raw.columns[column]
      if (build && cell && !build.seen.has(block)) {
        const bounds = int64Range(raw.runs?.[column]) ?? rangeOf(cell, raw.rows)
        if (bounds === undefined) build = undefined
        else {
          build.seen.add(block)
          if (bounds) [build.mins[block], build.maxs[block]] = bounds
        }
      }
      return raw
    },

    // The format's keyed path, where it has one. It reads no key column whole to take a block's
    // range from, so a build it answers for is over — which costs a Parquet file nothing, its
    // footer's statistics being the index already; Feather has no such path.
    ...(reader.readMatches && {
      async readMatches(
        block: number,
        keys: readonly string[],
        probe: IdProbe,
        outputs: readonly string[],
      ) {
        const found = await reader.readMatches!(block, keys, probe, outputs)
        if (found && keys.includes(column)) build = undefined
        return found
      },
    }),

    finish() {
      if (!build || build.seen.size < range.to - range.from) return undefined
      return { mins: build.mins, maxs: build.maxs }
    },
  }
}

/**
 * One block's smallest and largest key — `null` for a block holding none, `undefined` for one
 * holding something no range of ids can be tested against (a float, a date, text beside integers).
 *
 * Kept as plain numbers while the cells are numbers and turned into `bigint` once, at the end: a
 * full scan is hundreds of millions of cells, and a `BigInt` per cell is an allocation per cell.
 */
function rangeOf(
  cell: (row: number) => unknown,
  rows: number,
): [Bound, Bound] | null | undefined {
  let lowNumber = Infinity
  let highNumber = -Infinity
  let lowBig: bigint | undefined
  let highBig: bigint | undefined
  let lowText: string | undefined
  let highText: string | undefined
  for (let row = 0; row < rows; row++) {
    const value = cell(row)
    if (value === null || value === undefined) continue
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) return undefined
      if (value < lowNumber) lowNumber = value
      if (value > highNumber) highNumber = value
    } else if (typeof value === 'bigint') {
      if (lowBig === undefined || value < lowBig) lowBig = value
      if (highBig === undefined || value > highBig) highBig = value
    } else if (typeof value === 'string') {
      if (lowText === undefined || value < lowText) lowText = value
      if (highText === undefined || value > highText) highText = value
    } else {
      return undefined
    }
  }
  let low = lowBig
  let high = highBig
  if (lowNumber <= highNumber) {
    const numberLow = BigInt(lowNumber)
    const numberHigh = BigInt(highNumber)
    if (low === undefined || numberLow < low) low = numberLow
    if (high === undefined || numberHigh > high) high = numberHigh
  }
  // Text beside integers has no one order to range over.
  if (lowText !== undefined) return low === undefined ? [lowText, highText!] : undefined
  return low === undefined ? null : [low, high!]
}

/**
 * A block's range read off its 64-bit runs' words, or undefined where the runs are not all 64-bit
 * integers (and `rangeOf` answers instead) — `matchingRows`' reason: a `bigint` per cell was the
 * build's cost on a full scan. Four scalars rather than a pair per new extreme, which on a file
 * sorted by the key is every row.
 */
function int64Range(
  runs: readonly ColumnRun[] | undefined,
): [bigint, bigint] | null | undefined {
  if (!runs?.length) return undefined
  let lowHi = Infinity
  let lowLo = 0
  let highHi = -Infinity
  let highLo = 0
  let signed = false
  for (const { values } of runs) {
    const run = int64Words(values)
    if (!run) return undefined
    const { words } = run
    signed = run.signed
    for (let i = 0; i < values.length; i++) {
      // The high word compared as `int64Words` says to read it; the low one always unsigned.
      const hi = signed ? words[2 * i + 1]! | 0 : words[2 * i + 1]!
      const lo = words[2 * i]!
      if (hi < lowHi || (hi === lowHi && lo < lowLo)) {
        lowHi = hi
        lowLo = lo
      }
      if (hi > highHi || (hi === highHi && lo > highLo)) {
        highHi = hi
        highLo = lo
      }
    }
  }
  if (lowHi === Infinity) return null
  return [joinWords(lowHi >>> 0, lowLo, signed), joinWords(highHi >>> 0, highLo, signed)]
}

/**
 * `reader` wrapped once per key column, each around the last — what a keyed read visits, as the
 * worker reads it (`readRowsJob`) and as the page sizes the split over it (`client.ts`), so the two
 * cannot disagree about which blocks are live. `wrappers` for each column's `finish`, in `names`'
 * order.
 */
export function indexedReader(
  reader: TableFileReader,
  names: readonly string[],
  held: Readonly<Record<string, BlockIndex>> | undefined,
  range?: BlockRange,
): { indexed: TableFileReader; wrappers: IndexedReader[] } {
  let indexed = reader
  const wrappers: IndexedReader[] = []
  for (const name of names) {
    const wrapper = withBlockIndex(indexed, name, held?.[name], range)
    wrappers.push(wrapper)
    indexed = wrapper
  }
  return { indexed, wrappers }
}
