/**
 * Driving an edge-list import from the page: a worker where there is one, this thread where
 * there is not.
 *
 * The fallback is not a courtesy — it is what makes any of this testable. jsdom has no `Worker`,
 * exactly as it has none for elkjs, so without a direct path nothing in `pnpm test` would
 * execute a line of the reader in the shape the app actually calls it. Same arrangement, same
 * reason, and the same caveat: the *worker wrapper* stays uncovered and what is checked by hand
 * is that it carries nothing IndexedDB-shaped into a context that has its own copy of the store.
 */

import type { Delimiter } from '../csv'
import type { EncodedEdges } from './encode'
import type { EdgeFormat } from './formats'
import { SNIFF_BYTES, sniffEdgeFormat } from './formats'
import type { EdgeColumnChoice } from './read'
import { PREVIEW_BYTES, previewEdges, suggestEdgeColumns } from './read'
import type { EdgeImportMessage, EdgeImportRequest } from './worker'
import { readRequest } from './worker'

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

export interface ImportEdgesOptions extends EdgeImportRequest {
  onProgress?: (fraction: number, note?: string) => void
  signal?: AbortSignal
}

export function importEdges(options: ImportEdgesOptions): Promise<EncodedEdges> {
  return typeof Worker === 'undefined' ? here(options) : offThread(options)
}

/** No worker: parse on this thread. Correct, and it blocks — see the module note. */
function here(options: ImportEdgesOptions): Promise<EncodedEdges> {
  return readRequest(options, {
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

function offThread(options: ImportEdgesOptions): Promise<EncodedEdges> {
  return new Promise((resolve, reject) => {
    /*
     * `new URL(..., import.meta.url)` rather than a `?worker` import, the form `src/pyodide`
     * settled on: it is what lets vite serve the module directly in dev and emit its own chunk
     * in a build, without the specifier being resolved and inlined.
     */
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    /*
     * Cancel terminates rather than asks. There is no interrupt point inside a tight parse loop
     * that a message could reach — the same conclusion `src/pyodide` came to for Python — and
     * an import has nothing worth salvaging half-done.
     */
    const stop = () => {
      worker.terminate()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    options.signal?.addEventListener('abort', stop, { once: true })

    worker.onmessage = (event: MessageEvent<EdgeImportMessage>) => {
      const message = event.data
      if (message.type === 'progress')
        return options.onProgress?.(message.fraction, message.note)
      options.signal?.removeEventListener('abort', stop)
      worker.terminate()
      if (message.type === 'done') resolve(message.encoded)
      else reject(new Error(message.message))
    }
    worker.onerror = (event) => {
      options.signal?.removeEventListener('abort', stop)
      worker.terminate()
      reject(new Error(event.message || 'The edge-list reader failed to start'))
    }

    const request: EdgeImportRequest = {
      ...(options.file ? { file: options.file } : {}),
      ...(options.url ? { url: options.url } : {}),
      format: options.format,
      columns: options.columns,
      ...(options.text ? { text: options.text } : {}),
    }
    worker.postMessage(request)
  })
}
