/**
 * Which of the three shapes a file is, from its first bytes.
 *
 * Sniffed rather than asked, because both binary formats say so in their own header and a
 * question the file already answers is a question worth not asking. Extensions are not used:
 * an edge list arrives called `.txt`, `.tsv`, `.gz`, or with no extension at all from a URL.
 *
 * Deliberately holds no imports. Both readers are heavy and lazily loaded — `apache-arrow` is
 * 50.7 kB gzipped — so whatever decides *which* to load must not pull either in.
 */

/** Enough for the longest magic number here, `ARROW1\\0\\0`. */
export const SNIFF_BYTES = 8

export type EdgeFormat = 'delimited' | 'parquet' | 'feather'

/** `PAR1`, at both ends of every Parquet file. */
const PARQUET = [0x50, 0x41, 0x52, 0x31]
/** `ARROW1`, which opens an Arrow IPC file — what `write_feather` produces. */
const FEATHER = [0x41, 0x52, 0x52, 0x4f, 0x57, 0x31]

const startsWith = (bytes: Uint8Array, magic: readonly number[]) =>
  magic.every((byte, i) => bytes[i] === byte)

/**
 * Anything unrecognised is `delimited`, which is the right default rather than a shrug: a text
 * reader on a binary file fails with something a reader can act on, where a binary reader on a
 * text file fails inside a decompressor.
 */
export function sniffEdgeFormat(head: Uint8Array): EdgeFormat {
  if (startsWith(head, PARQUET)) return 'parquet'
  if (startsWith(head, FEATHER)) return 'feather'
  return 'delimited'
}
