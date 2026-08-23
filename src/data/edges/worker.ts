/**
 * Parsing an edge list off the main thread.
 *
 * Measured, ten million edges: 821 ms to accumulate and 1,104 ms to compress. Done on the main
 * thread that is three seconds of frozen tab — and, worse, three seconds during which the
 * progress bar reporting on it cannot repaint, so the one control telling somebody the import is
 * alive is the one thing the import stops.
 *
 * The **file** crosses rather than a stream: a `File` is structured-cloneable everywhere, where
 * a transferable `ReadableStream` is not, and the worker can open it itself. The encoded arrays
 * come back **transferred**, so the hundred megabytes is a pointer handoff rather than a copy.
 *
 * Nothing here touches IndexedDB. The worker parses and the main thread stores, which keeps
 * `store.ts`'s module-level catalogue the single copy — a worker writing directly would leave
 * the page's catalogue describing a shelf it is not on.
 */

import { errorMessage } from '../../core/errors'
import type { EncodedEdges } from './encode'
import type { EdgeFormat } from './formats'
import type { EdgeColumnChoice, ReadEdgesOptions } from './read'
import { readEdges } from './read'

export interface EdgeImportRequest {
  /** One or the other. A URL is fetched by the worker, so the page never holds the body. */
  file?: File
  url?: string
  format: EdgeFormat
  columns: EdgeColumnChoice
  /** Delimited only: what the preview settled on. Ignored by the binary readers. */
  text?: Pick<ReadEdgesOptions, 'delimiter' | 'hasHeader'>
}

export type EdgeImportMessage =
  | { type: 'progress'; fraction: number; note?: string }
  | { type: 'done'; encoded: EncodedEdges }
  | { type: 'error'; message: string }

/** Every buffer in an encoded set, for `postMessage`'s transfer list. */
export function edgeTransferables(encoded: EncodedEdges): Transferable[] {
  return [encoded.out, encoded.in].flatMap((csr) => [
    csr.offsets.buffer,
    csr.targets.buffer,
    csr.weights.buffer,
  ]) as Transferable[]
}

/**
 * Read a request in whichever shape it is.
 *
 * Shared by the worker and the no-worker fallback, so the two cannot answer differently — and it
 * is where the **lazy import** lives: a delimited file must not pull `apache-arrow` and
 * `hyparquet` into the worker's chunk, which between them are 70 kB gzipped against a CSV path
 * that costs nothing.
 */
export async function readRequest(
  request: EdgeImportRequest,
  options: { onProgress?: (fraction: number, note?: string) => void; signal?: AbortSignal },
): Promise<EncodedEdges> {
  if (request.format !== 'delimited') {
    const { readBinary } = await import('./binary')
    return readBinary(
      request.format,
      {
        ...(request.file ? { file: request.file } : {}),
        ...(request.url ? { url: request.url } : {}),
      },
      request.columns,
      options,
    )
  }
  const { stream, totalBytes } = await openEdgeStream(request)
  return readEdges(stream, {
    delimiter: request.text?.delimiter ?? ',',
    hasHeader: request.text?.hasHeader ?? true,
    columns: request.columns,
    ...(totalBytes ? { totalBytes } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

/** Open whichever source the request named. Shared with the no-worker fallback. */
export async function openEdgeStream(
  request: Pick<EdgeImportRequest, 'file' | 'url'>,
): Promise<{ stream: ReadableStream<Uint8Array>; totalBytes?: number }> {
  if (request.file) return { stream: request.file.stream(), totalBytes: request.file.size }
  if (!request.url) throw new Error('Nothing to read: name a file or a URL')
  const response = await fetch(request.url)
  if (!response.ok) throw new Error(`${request.url} answered ${response.status}`)
  if (!response.body) throw new Error(`${request.url} returned no body`)
  const declared = Number(response.headers.get('content-length') ?? '')
  return {
    stream: response.body,
    // A chunked response declares nothing, and a fraction built from a missing length is worse
    // than none — the reader falls back to reporting rows.
    ...(Number.isFinite(declared) && declared > 0 ? { totalBytes: declared } : {}),
  }
}

// The module is imported by the main thread for its types and its two helpers, so the listener
// has to be behind a check rather than at the top level — `self.onmessage` in a window context
// would make every page a message target.
if (
  typeof self !== 'undefined' &&
  typeof (self as unknown as Window).document === 'undefined'
) {
  self.onmessage = async (event: MessageEvent<EdgeImportRequest>) => {
    const post = (message: EdgeImportMessage, transfer?: Transferable[]) =>
      self.postMessage(message, { transfer: transfer ?? [] })
    try {
      const encoded = await readRequest(event.data, {
        onProgress: (fraction, note) =>
          post({ type: 'progress', fraction, ...(note ? { note } : {}) }),
      })
      post({ type: 'done', encoded }, edgeTransferables(encoded))
    } catch (err) {
      post({ type: 'error', message: errorMessage(err) })
    }
  }
}
