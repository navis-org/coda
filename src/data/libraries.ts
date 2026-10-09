/**
 * The table-file libraries — the packages `vite.mcp.config.ts`' `EXTERNAL` list keeps out of the
 * MCP bundle — loaded on first use, never imported at the top of a module.
 *
 * **Why not a plain import:** the MCP bundle (`vite.mcp.config.ts`) keeps these packages external
 * and inlines every dynamic import, and an external that a lazily reached *module* imports at its
 * top is hoisted into a static import of the whole bundle. The bundle then fails to load at all
 * wherever the packages are not installed — which is every deployed MCP server, and nothing in this
 * repository's tests says so. A dynamic `import()` of the package itself stays a dynamic import.
 * The build refuses a static one (`vite.mcp.config.ts`' import check).
 *
 * Each loader is memoised through `memoPromise`, so the second reader to ask pays nothing — and a
 * failed chunk load (a network blip, a deploy that rotated the hashes) is asked again rather than
 * kept, which `slot ??= import(…)` would do for the life of the tab.
 */

import type * as ArrowLibrary from 'apache-arrow'
import type * as HyparquetLibrary from 'hyparquet'
import type * as HyparquetConstants from 'hyparquet/src/constants.js'
import type * as HyparquetThrift from 'hyparquet/src/thrift.js'
import type * as Lz4Library from 'lz4js'

import { memoPromise } from './memoPromise'

// Type-only, and erased: a value import here is exactly what this module exists to avoid.
type Arrow = typeof ArrowLibrary

const loaded = new Map<string, Promise<unknown>>()

/** One module, loaded once per tab — or again, after a load that failed. */
function load<T>(key: string, run: () => Promise<T>): Promise<T> {
  return memoPromise(loaded as Map<string, Promise<T>>, key, run, { keep: 'resolved' })
}

/**
 * `apache-arrow`, with both of Arrow IPC's codecs registered — it ships neither.
 *
 * `write_feather` compresses with **lz4 by default**, and without a codec a default-written
 * Feather file fails outright with "Record batch is compressed but codec not found" — which is
 * the whole reason `lz4js` is a dependency (2.2 kB gzipped, measured). `lz4js` was last published
 * years ago, and only its block decoder is trusted: its frame walk misreads block checksums, so
 * that half is `lz4Frame`. ZSTD is `fzstd`, which polars writes IPC with on request.
 *
 * Both are decode-only: the registry validates an encoder where it is given one, and nothing here
 * writes an Arrow file.
 */
export function arrow(): Promise<Arrow> {
  return load('apache-arrow', async () => {
    const [library, { default: lz4 }, fzstd] = await Promise.all([
      import('apache-arrow'),
      import('lz4js'),
      import('fzstd'),
    ])
    library.compressionRegistry.set(library.CompressionType.LZ4_FRAME, {
      decode: (bytes: Uint8Array) => lz4Frame(lz4, bytes, arrowLength(bytes)),
    })
    library.compressionRegistry.set(library.CompressionType.ZSTD, {
      decode: (bytes: Uint8Array) => {
        const length = arrowLength(bytes)
        return fzstd.decompress(
          bytes,
          length === undefined ? undefined : new Uint8Array(length),
        )
      },
    })
    return library
  })
}

/**
 * The length apache-arrow read for a compressed buffer and did not pass on: `decode` is handed
 * the body just past an int64 prefix holding it (`ipc/reader.mjs`, `_decompressBuffers`), so it
 * is the eight bytes before the view. Undefined where there are none. Should the layout ever
 * change, what is read is not the decoded length, and `lz4Frame` refuses rather than guesses.
 */
function arrowLength(bytes: Uint8Array): number | undefined {
  if (bytes.byteOffset < 8) return undefined
  const length = new DataView(bytes.buffer, bytes.byteOffset - 8, 8).getBigInt64(0, true)
  return length >= 0n && length <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(length) : undefined
}

/** What `lz4Frame` needs of `lz4js`. */
type Lz4Blocks = Pick<typeof Lz4Library, 'decompressBound' | 'decompressBlock'>

const LZ4_MAGIC = 0x184d2204

/**
 * One LZ4 frame, decoded — the frame walked here and only the blocks handed to `lz4js`.
 *
 * **`lz4js`' own `decompressFrame` reads a block checksum from *before* its block** rather than
 * after it (a `TODO` in its source), so a frame carrying block checksums — every lz4 Feather file
 * polars writes, arrow-rs setting the flag — decodes four bytes short per block into plausible
 * garbage: ids that are real numbers and wrong, and no error, apache-arrow never comparing the
 * length it gets against the one the buffer declares. pyarrow sets no block checksums, which is
 * why every fixture read correctly. So the walk is ours, and the length is checked.
 */
export function lz4Frame(lz4: Lz4Blocks, src: Uint8Array, expected?: number): Uint8Array {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength)
  if (view.getUint32(0, true) !== LZ4_MAGIC) throw new Error('Not an LZ4 frame.')
  const flags = src[4]!
  if ((flags & 0xc0) !== 0x40) throw new Error('An LZ4 frame of an unknown version.')
  if (flags & 0x01) throw new Error('An LZ4 frame that needs a dictionary cannot be read.')
  const blockSums = (flags & 0x10) !== 0
  const sized = flags & 0x08
  // The frame's own content size where it declares one — polars' do not — else the caller's.
  const declared = sized ? Number(view.getBigUint64(6, true)) : expected
  // Magic, FLG, BD, the content size where declared, and the header checksum.
  let at = 6 + (sized ? 8 : 0) + 1
  const out = new Uint8Array(declared ?? lz4.decompressBound(src))
  let written = 0
  for (;;) {
    const word = view.getUint32(at, true)
    at += 4
    if (word === 0) break
    const size = word & 0x7fffffff
    if (word & 0x80000000) {
      out.set(src.subarray(at, at + size), written)
      written += size
    } else {
      written = lz4.decompressBlock(src, out, at, size, written)
    }
    at += size + (blockSums ? 4 : 0)
  }
  if (declared !== undefined && written !== declared) {
    throw new Error(`An LZ4 frame decoded to ${written} bytes where it declares ${declared}.`)
  }
  // Only a caller with no length to give reaches the bound, and it is handed a view of it.
  return written === out.length ? out : out.subarray(0, written)
}

export function hyparquet(): Promise<typeof HyparquetLibrary> {
  return load('hyparquet', () => import('hyparquet'))
}

/** What the Parquet fast path (`files/pages.ts`) reads pages with: hyparquet's own parsing pieces. */
export interface PageLibraries {
  readonly Encodings: typeof HyparquetConstants.Encodings
  readonly PageTypes: typeof HyparquetConstants.PageTypes
  readonly deserializeTCompactProtocol: typeof HyparquetThrift.deserializeTCompactProtocol
  /** A column chunk's page locations, where the file wrote a page index. */
  readonly readOffsetIndex: typeof HyparquetLibrary.readOffsetIndex
  /**
   * The compressed codecs a Parquet file may use, by the footer's name for them — Snappy through
   * `hysnappy`'s WASM, ZSTD through `fzstd` — for the fast path and the library's own reads alike.
   * `UNCOMPRESSED` is not in it: nothing to do.
   */
  readonly codecs: Readonly<Record<string, (input: Uint8Array, length: number) => Uint8Array>>
}

/**
 * The names of `PageLibraries.codecs`, which a footer is checked against before that is loaded —
 * static, and held to the codecs themselves by the compiler.
 */
export const PARQUET_CODEC_NAMES = ['SNAPPY', 'ZSTD'] as const

/**
 * Loaded when a block is read, never for a footer: the WASM codec is instantiated on the thread
 * that asks, and a footer peek runs on the page.
 */
export function pageLibraries(): Promise<PageLibraries> {
  return load('pages', async () => {
    const [constants, thrift, { snappyUncompressor }, fzstd, library] = await Promise.all([
      import('hyparquet/src/constants.js'),
      import('hyparquet/src/thrift.js'),
      import('hysnappy'),
      import('fzstd'),
      hyparquet(),
    ])
    return {
      Encodings: constants.Encodings,
      PageTypes: constants.PageTypes,
      deserializeTCompactProtocol: thrift.deserializeTCompactProtocol,
      readOffsetIndex: library.readOffsetIndex,
      codecs: {
        SNAPPY: snappyUncompressor(),
        // Written into a buffer of the page's declared size, so a short frame is a short page.
        ZSTD: (input, length) => fzstd.decompress(input, new Uint8Array(length)),
      } satisfies Record<(typeof PARQUET_CODEC_NAMES)[number], PageLibraries['codecs'][string]>,
    }
  })
}
