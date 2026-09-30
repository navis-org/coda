/**
 * Driving the edge-list worker from the page — an import, and a table file's whole edge list for a
 * wired Edges socket — in a worker where there is one, on this thread where there is not.
 *
 * The fallback is not a courtesy — it is what makes any of this testable. jsdom has no `Worker`,
 * exactly as it has none for elkjs, so without a direct path nothing in `pnpm test` would
 * execute a line of the reader in the shape the app actually calls it. Same arrangement, same
 * reason, and the same caveat: the *worker wrapper* stays uncovered and what is checked by hand
 * is that it carries nothing IndexedDB-shaped into a context that has its own copy of the store.
 */

import type { JobRunOptions } from '../workerJob'
import { runWorkerJob } from '../workerJob'
import type { Delimiter } from '../csv'
import type { EncodedEdges } from './encode'
import type { EdgeFormat } from './formats'
import { SNIFF_BYTES, sniffEdgeFormat } from './formats'
import type { EdgeColumnChoice } from './read'
import { PREVIEW_BYTES, previewEdges, suggestEdgeColumns } from './read'
import type { EdgeImportRequest, EdgeJob } from './worker'
import { readEdgeJob } from './worker'
import type { FileSpec } from '../files/bytes'
import type { ReadEdgesRequest } from './tableFile'

export interface EdgeSourcePreview {
  format: EdgeFormat
  columns: string[]
  /** The first rows, as text, for the panel to show. */
  rows: string[][]
  suggestion?: EdgeColumnChoice
  /** Binary only: the declared type per column, and the row count the file states. */
  types?: string[]
  rowCount?: number
  /** Delimited only: what has to be handed back to the reader. */
  delimiter?: Delimiter
  hasHeader?: boolean
}

/** The first `count` bytes, without downloading a file to look at its header. */
async function head(source: { file?: File; url?: string }, count: number): Promise<Uint8Array> {
  if (source.file) return new Uint8Array(await source.file.slice(0, count).arrayBuffer())
  if (!source.url) throw new Error('Nothing to read: name a file or a URL')
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`${source.url} answered ${response.status}`)
  if (!response.body) throw new Error(`${source.url} returned no body`)
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  while (size < count) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    size += value.byteLength
  }
  // Cancelled rather than drained: a header is all that was wanted, and a 120 MB body should not
  // be pulled through the network to answer a question its first eight bytes already did.
  await reader.cancel().catch(() => {})
  const joined = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.byteLength
  }
  return joined.subarray(0, count)
}

/**
 * What the panel needs to ask which column is which.
 *
 * Sniffs the format from the file's own first bytes and loads only the reader that shape needs —
 * so opening a CSV never pays for `apache-arrow`. The binary branch is behind `await import` for
 * that reason and no other.
 */
export async function previewEdgeSource(source: {
  file?: File
  url?: string
}): Promise<EdgeSourcePreview> {
  // One read, not two: the sniff needs eight bytes and the text preview needs sixty-four
  // kilobytes, so take the larger and answer both from it.
  const bytes = await head(source, Math.max(SNIFF_BYTES, PREVIEW_BYTES))
  const format = sniffEdgeFormat(bytes)
  if (format === 'delimited') {
    return { format, ...previewEdges(new TextDecoder().decode(bytes)) }
  }
  const { previewBinary } = await import('./binary')
  const preview = await previewBinary(format, source)
  const suggestion = suggestEdgeColumns(preview.columns, true)
  return { format, ...preview, ...(suggestion ? { suggestion } : {}) }
}

export interface ImportEdgesOptions extends EdgeImportRequest, JobRunOptions {}

/** One of this worker's jobs, run where it can be — see the module note. */
function runEdgeJob(job: EdgeJob, options: JobRunOptions): Promise<EncodedEdges> {
  return runWorkerJob<EdgeJob, EncodedEdges>(
    // Written out here, where vite can see it — see `workerJob.ts`.
    () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    job,
    { ...options, label: 'edge-list reader', here: readEdgeJob },
  )
}

/**
 * In a worker where there is one, on this thread where there is not — correct there, and it blocks;
 * see the module note.
 */
export function importEdges(options: ImportEdgesOptions): Promise<EncodedEdges> {
  // The job is the request alone: a callback and a signal cannot cross `postMessage`.
  const { onProgress, signal, ...request } = options
  return runEdgeJob(request, { signal, onProgress })
}

/** A table file's whole edge list, encoded — the same worker, its second job. */
export function readTableFileEdges(
  spec: FileSpec,
  request: ReadEdgesRequest,
  options: JobRunOptions = {},
): Promise<EncodedEdges> {
  return runEdgeJob({ tableFile: { spec, request } }, options)
}
