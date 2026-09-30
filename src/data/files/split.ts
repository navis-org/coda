/**
 * A keyed read split across workers: which blocks each part reads, and the parts put back together.
 *
 * A lookup in a file its key does not sort is a scan of every block, and decoding is the cost —
 * measured on a 192M-row synapse table, 184 row groups in one worker took 20 s where polars took
 * half a second across fourteen cores. The blocks are independent, so the scan divides. Only a
 * **keyed** read is split: an unkeyed one stops at its row cap after the first blocks, and split
 * it would read a cap's worth in every part.
 *
 * Pure and free of the format libraries, so `client.ts` can import it on the page and a test can
 * pin the merge without a worker.
 */

import type { CellValue } from '../../core/values'
import type { ReadRowsResult } from './read'
import type { BlockIndex, BlockRange } from './reader'

/** Workers per read at most: past this a worker's start-up and memory outweigh its share. */
const MAX_PARTS = 16

/** Fewer blocks than this per part and a worker's start-up and footer read outweigh its share. */
const MIN_BLOCKS_PER_PART = 4

/**
 * How many parts a read of `blocks` blocks — the ones it can still find anything in (`client.ts`),
 * never the file's count — splits into: every core but the page's own, within
 * `MAX_PARTS` and never below `MIN_BLOCKS_PER_PART` blocks each. A synapse question is one read
 * (both ends in one pass), so nothing else is splitting the cores at the same time.
 */
export function partCount(blocks: number, cores: number): number {
  return Math.max(1, Math.min(MAX_PARTS, cores - 1, Math.floor(blocks / MIN_BLOCKS_PER_PART)))
}

/**
 * `blocks` — the ones a read can still find anything in, ascending — as `parts` consecutive ranges
 * holding as even a share of them as whole blocks allow. A block inside a range that is not in the
 * list is ruled out again by the part that reads it, at the cost of a statistics test.
 */
export function splitBlocks(blocks: readonly number[], parts: number): BlockRange[] {
  const ranges: BlockRange[] = []
  for (let i = 0; i < parts; i++) {
    const first = blocks[Math.floor((i * blocks.length) / parts)]
    const last = blocks[Math.floor(((i + 1) * blocks.length) / parts) - 1]
    if (first !== undefined && last !== undefined) ranges.push({ from: first, to: last + 1 })
  }
  return ranges
}

/**
 * The parts of one read as the read it replaces: rows in block order, the row cap applied to the
 * whole, the counts summed. Each part stopped at the cap on its own, so the first `limit` rows of
 * the parts in order are the first `limit` rows a single pass would have kept, and "rows were left"
 * is any part saying so or more rows than the cap between them. Under the cap — always, for a
 * lookup with none — each column is the parts' arrays joined, not a copy cell by cell.
 *
 * `built` joins, column by column, the ranges every part built — a part saw only its own blocks,
 * so none could save. What happened to the indexes is the page's to say (`client.ts`).
 */
export function mergeParts(
  parts: readonly ReadRowsResult[],
  ranges: readonly BlockRange[],
  limit: number,
  /** The file's block count: an index is joined only where the ranges cover every one. */
  blocks: number,
): ReadRowsResult {
  const rows = parts.reduce((n, part) => n + part.rows, 0)
  const data: Record<string, CellValue[]> = {}
  for (const name of Object.keys(parts[0]?.data ?? {})) {
    const joined = ([] as CellValue[]).concat(...parts.map((part) => part.data[name] ?? []))
    data[name] = rows > limit ? joined.slice(0, limit) : joined
  }
  const built = joinedIndexes(parts, ranges, blocks)
  return {
    data,
    rows: Math.min(rows, limit),
    blocksRead: parts.reduce((n, part) => n + part.blocksRead, 0),
    blocksSkipped: parts.reduce((n, part) => n + part.blocksSkipped, 0),
    truncated: rows > limit || parts.some((part) => part.truncated),
    ...(built ? { built } : {}),
  }
}

/** Each column's builds over the parts' ranges, joined — for the columns every part built. */
function joinedIndexes(
  parts: readonly ReadRowsResult[],
  ranges: readonly BlockRange[],
  blocks: number,
): Record<string, BlockIndex> | undefined {
  // Only ranges running from the first block to the last with no gap: a split sized on the live
  // blocks (`client.ts`) leaves the blocks statistics ruled out in no part, and joining around
  // them shifts every later entry onto the wrong block — lookups then skipping blocks that hold
  // their ids, which a review reproduced as a lookup answering nothing.
  const covering =
    ranges[0]?.from === 0 &&
    ranges.at(-1)?.to === blocks &&
    ranges.every((range, i) => i === 0 || range.from === ranges[i - 1]!.to)
  if (!covering) return undefined
  const names = Object.keys(parts[0]?.built ?? {}).filter((name) =>
    parts.every((part) => part.built?.[name]),
  )
  if (!names.length) return undefined
  // Each part's own slice, in order, is the whole index.
  const joined: Record<string, BlockIndex> = {}
  for (const name of names) {
    const own = (i: number) => parts[i]!.built![name]!
    joined[name] = {
      mins: ranges.flatMap(({ from, to }, i) => own(i).mins.slice(from, to)),
      maxs: ranges.flatMap(({ from, to }, i) => own(i).maxs.slice(from, to)),
    }
  }
  return joined
}
