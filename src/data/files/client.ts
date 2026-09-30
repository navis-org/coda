/**
 * Reading a table file from the main thread's side: its summary here, its rows in a worker.
 *
 * Both halves reach the format libraries only through `import()` or the worker, so importing this
 * module costs the main chunk nothing — the rule `edges/importer.ts` keeps for the same libraries.
 */

import type { JobRunOptions } from '../workerJob'
import { runWorkerJob } from '../workerJob'
import type { FileSpec } from './bytes'
import type { FileSummary } from './columns'
import type { ReadRowsJob, ReadRowsRequest, ReadRowsResult } from './read'
import { mergeParts, partCount, splitBlocks } from './split'
import type { BlockIndex, BlockRange } from './reader'
import { blockMayHold, idProbe } from './reader'
import { indexedReader } from './blockIndex'
import { loadIndex, saveIndex } from './store'

/**
 * What the file's footer says — a few small reads, so it happens on this thread: a worker would
 * cost more to start than the read takes.
 */
export async function readSummary(spec: FileSpec, signal?: AbortSignal): Promise<FileSummary> {
  const { openTableSpec } = await import('./read')
  return (await openTableSpec(spec, signal)).summary
}

/** How a read is run: the job's own options, and how many blocks the file holds. */
export interface ReadRowsOptions extends JobRunOptions {
  /**
   * The file's block count (`TableFileValue.blocks`). Given, a keyed read is split across workers
   * (`split.ts`); absent, one worker reads every block.
   */
  readonly blocks?: number
}

/**
 * The rows a request keeps: in workers where there are any — a keyed read of a many-block file in
 * several at once — and on this thread where there are none.
 *
 * The key columns' block indexes are kept here, on the page, for both routes: loaded once and handed
 * to every part, and a build saved only once it covers every block — which a part of a split read
 * never does alone, so its builds are joined first (`mergeParts`).
 */
export async function readTableFileRows(
  spec: FileSpec,
  request: ReadRowsRequest,
  options: ReadRowsOptions = {},
): Promise<ReadRowsResult> {
  const names = request.key?.indexed ? request.key.names : []
  const stored = await Promise.all(names.map((name) => loadIndex(request.fingerprint, name)))
  const held: Record<string, BlockIndex> = {}
  names.forEach((name, i) => {
    if (stored[i]) held[name] = stored[i]
  })

  const ranges = await splitRanges(spec, request, held, options)
  const { built, ...result } = ranges
    ? await readSplit({ spec, request, held }, ranges, options)
    : await readPart({ spec, request, held }, options)
  if (!names.length) return result
  await Promise.all(
    Object.entries(built ?? {}).map(([name, index]) =>
      saveIndex(request.fingerprint, name, index),
    ),
  )
  const index = names.every((name) => held[name]) ? 'used' : built ? 'built' : undefined
  return index ? { ...result, index } : result
}

/**
 * The block ranges a keyed read splits into across workers, or undefined for one worker.
 *
 * Sized on the blocks the read can still find anything in — what the footer's statistics and the
 * stored indexes leave — never on the file's count: measured on a copy of a synapse table sorted by
 * the id, a lookup survived in a handful of its blocks, and thirteen workers each opening the file
 * to skip theirs took twice as long as one. The footer is read here for that, on the page, only
 * where the file is large enough to split at all.
 */
async function splitRanges(
  spec: FileSpec,
  request: ReadRowsRequest,
  held: Readonly<Record<string, BlockIndex>>,
  options: ReadRowsOptions,
): Promise<BlockRange[] | undefined> {
  const cores = typeof navigator === 'undefined' ? 1 : (navigator.hardwareConcurrency ?? 1)
  const { key } = request
  if (!key || !options.blocks || typeof Worker === 'undefined') return undefined
  if (partCount(options.blocks, cores) === 1) return undefined
  const { openTableSpec } = await import('./read')
  // Wrapped as the workers wrap it, so the blocks counted live are the blocks they will read.
  const { indexed } = indexedReader(await openTableSpec(spec, options.signal), key.names, held)
  const probe = idProbe(key.ids)
  const live: number[] = []
  for (let block = 0; block < indexed.summary.blocks; block++) {
    if (blockMayHold(indexed, key.names, probe, block)) live.push(block)
  }
  const parts = partCount(live.length, cores)
  return parts === 1 ? undefined : splitBlocks(live, parts)
}

/** A read over `ranges`, a worker each, merged as one — progress one bar over every part. */
async function readSplit(
  job: ReadRowsJob,
  ranges: readonly BlockRange[],
  options: ReadRowsOptions,
): Promise<ReadRowsResult> {
  const total = ranges.reduce((n, { from, to }) => n + to - from, 0)
  const fractions = ranges.map(() => 0)
  // One signal for every part, so a part that fails stops its siblings rather than leaving them
  // scanning a multi-gigabyte file for an answer nobody will read.
  const parts = new AbortController()
  const stop = () => parts.abort()
  if (options.signal?.aborted) stop()
  else options.signal?.addEventListener('abort', stop, { once: true })
  const read = Promise.all(
    ranges.map((blocks, i) =>
      readPart(
        { ...job, request: { ...job.request, blocks } },
        {
          signal: parts.signal,
          // The parts' fractions, weighted by their share of the blocks.
          onProgress: (fraction) => {
            fractions[i] = fraction * (blocks.to - blocks.from)
            const done = fractions.reduce((a, b) => a + b, 0)
            options.onProgress?.(done / total, `${Math.round(done)} of ${total} blocks`)
          },
        },
      ),
    ),
  )
  try {
    return mergeParts(await read, ranges, job.request.limit, options.blocks!)
  } catch (error) {
    stop()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', stop)
  }
}

/** One worker's read: a whole request, or one part of a split one. */
function readPart(job: ReadRowsJob, options: JobRunOptions): Promise<ReadRowsResult> {
  return runWorkerJob<ReadRowsJob, ReadRowsResult>(
    // Written out here, where vite can see it — see `workerJob.ts`.
    () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    job,
    {
      signal: options.signal,
      onProgress: options.onProgress,
      label: 'table-file reader',
      // Imported only where it runs here, so a page with a worker never loads the readers itself.
      here: async (job, opts) => (await import('./read')).readRowsJob(job, opts),
    },
  )
}
