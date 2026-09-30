/**
 * Where a table file's bytes come from: a file this tab holds, or a URL answering Range requests.
 *
 * A reader asks for byte ranges and nothing else — the footer, then only the blocks it needs — and
 * this is the one seam between it and the two places those ranges can come from. Both are small
 * on purpose: the value of reading lazily is lost the moment either answers with the whole file.
 *
 * ## A server that ignores Range is refused, not tolerated
 *
 * An HTTP server may answer a ranged GET with `200` and the *entire* object. For a four-kilobyte
 * footer that is merely wasteful; for a five-gigabyte synapse table it is the browser tab. So each
 * read is capped at the length it asked for (`fetchBytes`' `maxBytes`, which stops the stream
 * rather than buffering it) and checked against it afterwards — the second half is `readRange`'s
 * rule in `zapbench/traces.ts`, which is the other reader of a released file by range. `hyparquet`'s
 * own `asyncBufferFromUrl` does the opposite, caching the whole body, which is why it is not used.
 *
 * The one exception falls out of the same check rather than being carved into it: a read that
 * asks for the whole file — a file smaller than `TAIL_READ`, read whole on opening — is answered
 * correctly by a `200` carrying all of it, so such a server is not refused there.
 */

import { unreachable } from '../fetchText'
import { PrecomputedFetchError, fetchBytes, objectStoreUrl } from '../precomputed/transport'

/**
 * A file rewritten since its Link Table read it — `requireFingerprint`'s sentence, and a local
 * snapshot's that the browser will no longer read (`blobBytes`).
 */
export const FILE_CHANGED =
  'The file has changed since it was opened, so its columns may no longer be the ones this ' +
  'graph was set up against. Press ⟳ on the Link Table card to read it again.'

export interface ByteSource {
  readonly size: number
  /**
   * What names this copy of the file beyond its bytes, where anything does — a local file's name
   * and modification time, a URL's `Last-Modified`. Part of the fingerprint (`footerFingerprint`),
   * which is therefore the one detector of a file rewritten since its Link Table read it.
   */
  readonly identity?: string
  /** Bytes `[start, end)`. */
  read(start: number, end: number): Promise<Uint8Array>
}

/** A local file, read by slicing — the browser reads only the slice, however large the file. */
export function blobBytes(blob: Blob): ByteSource {
  return {
    size: blob.size,
    ...(blob instanceof File ? { identity: `${blob.name}:${blob.lastModified}` } : {}),
    read: async (start, end) => {
      try {
        return new Uint8Array(await blob.slice(start, end).arrayBuffer())
      } catch (error) {
        // Chromium's answer for a picked file that has changed on disk since, in words.
        if (error instanceof DOMException && error.name === 'NotReadableError') {
          throw new Error(FILE_CHANGED)
        }
        throw error
      }
    },
  }
}

/**
 * The URL a browser actually fetches: `gs://` and `s3://` mapped to their HTTP hosts, anything
 * else as written. One place, so the size probe and every range read agree.
 */
function httpUrl(url: string): string {
  const trimmed = url.trim()
  return objectStoreUrl(trimmed) ?? trimmed
}

/**
 * A URL's size, which lazy reading needs before its first read: both formats keep their footer at
 * the *end*. `Content-Length` on a HEAD, which is CORS-safelisted, so any host that allows the
 * range reads allows this; a host that sends none is refused by name rather than guessed at.
 * `Last-Modified`, safelisted too, is the copy's identity where the host sends one.
 */
export async function urlHead(url: string): Promise<{ size: number; modified?: string }> {
  // Unsignalled: the HEAD is shared (`fileSpec`), and each reader stops waiting on its own Cancel.
  let response: Response
  try {
    response = await fetch(httpUrl(url), { method: 'HEAD' })
  } catch {
    throw unreachable(url)
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const length = Number(response.headers.get('content-length'))
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error(
      `${url} does not report its size, which reading a file in pieces needs. Download it and ` +
        `open it as a local file instead.`,
    )
  }
  const modified = response.headers.get('last-modified')
  return modified ? { size: length, modified } : { size: length }
}

/**
 * A URL of known size, read by Range request — each read capped at the length it asked for. Its
 * `Last-Modified` is its identity.
 */
function urlBytes(
  { url, size, modified }: Extract<FileSpec, { kind: 'url' }>,
  signal?: AbortSignal,
): ByteSource {
  const target = httpUrl(url)
  return {
    size,
    ...(modified === undefined ? {} : { identity: modified }),
    read: async (start, end) => {
      const expected = end - start
      let buffer: ArrayBuffer
      try {
        buffer = await fetchBytes(target, {
          range: [start, end - 1],
          maxBytes: expected,
          // Chrome's HTTP cache takes a lock per URL, so ranged reads of one file through it run
          // one at a time whatever the number of workers asking: measured, a lookup over a
          // 250 ms link took 110.9 s through the cache and 19.2 s past it, the same rows.
          cache: 'no-store',
          ...(signal ? { signal } : {}),
        })
      } catch (error) {
        // Over the cap means the server sent more than was asked — the whole object, most likely.
        if (error instanceof PrecomputedFetchError && error.status === 413)
          throw ignoresRange(url)
        throw error
      }
      if (buffer.byteLength !== expected) throw ignoresRange(url)
      return new Uint8Array(buffer)
    },
  }
}

function ignoresRange(url: string): Error {
  return new Error(
    `${url} does not answer range requests, so reading part of it would mean downloading all ` +
      `of it. Download the file and open it locally instead.`,
  )
}

/**
 * What `openTableFile` reads first, and what Parquet's own first footer read asks for: the two must
 * agree, or the library's read starts outside the held tail and costs another round trip.
 */
export const TAIL_READ = 1 << 16

/** The largest tail kept: a footer past this is read again rather than held. */
const TAIL_BYTES = 4 << 20

/**
 * The same bytes, with the file's tail kept and served again.
 *
 * Opening a file reads its footer several times over — the format library's footer walk, then the
 * fingerprint's two reads — all inside the tail `openTableFile` reads first. Over a URL each is a
 * round trip; held, they are free. A read ending where the held tail begins joins it, which is how
 * a Parquet footer larger than the first read (a file of many row groups) is still fetched once.
 */
export function withTail(bytes: ByteSource): ByteSource {
  let tail: { start: number; data: Uint8Array } | undefined
  return {
    size: bytes.size,
    ...(bytes.identity === undefined ? {} : { identity: bytes.identity }),
    async read(start, end) {
      if (tail && start >= tail.start && end <= bytes.size) {
        return tail.data.subarray(start - tail.start, end - tail.start)
      }
      const data = await bytes.read(start, end)
      if (bytes.size - start <= TAIL_BYTES) {
        // A miss ending at the file's end is always wider than the tail held, if any.
        if (end === bytes.size) {
          tail = { start, data }
        } else if (tail && end === tail.start) {
          const joined = new Uint8Array(data.byteLength + tail.data.byteLength)
          joined.set(data)
          joined.set(tail.data, data.byteLength)
          tail = { start, data: joined }
        }
      }
      return data
    },
  }
}

/**
 * Where to read from, as something a worker can be handed: a `Blob` (a `File` is one) crosses
 * `postMessage` as a reference to the same bytes, and a URL is plain fields — its size and, where
 * the host sends one, its `Last-Modified`.
 */
export type FileSpec =
  | { readonly kind: 'blob'; readonly blob: Blob }
  | {
      readonly kind: 'url'
      readonly url: string
      readonly size: number
      readonly modified?: string
    }

export function bytesOf(spec: FileSpec, signal?: AbortSignal): ByteSource {
  return spec.kind === 'blob' ? blobBytes(spec.blob) : urlBytes(spec, signal)
}
