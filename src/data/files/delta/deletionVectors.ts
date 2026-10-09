/**
 * A Delta deletion vector: the rows of one data file a writer has marked deleted without rewriting
 * the file, and the two encodings the log names it by.
 *
 * Spark writes one on a `DELETE` or `UPDATE` where it would otherwise rewrite a whole Parquet file,
 * and a reader that ignored it would return the deleted rows — real rows, plausible, and wrong. So
 * the format is read exactly, and anything it does not recognise is refused rather than skipped.
 *
 * The format (Delta protocol, "Deletion Vector Format"): a **RoaringBitmapArray** — magic
 * 1681511377, a count, then per 32-bit high key one bitmap in the portable roaring serialisation —
 * stored either **inline** in the log (Z85 text) or in a **file** beside the table, at an offset
 * where a big-endian length precedes it. A file's name carries a UUID, Z85-encoded in the log.
 */

/** A deletion vector as the log describes one (`add.deletionVector`). */
export interface DeletionVectorDescriptor {
  /** `u`: a file named by a UUID, `i`: inline, `p`: a file at an absolute path. */
  readonly storageType: 'u' | 'i' | 'p'
  readonly pathOrInlineDv: string
  /** Where in the file the vector starts; absent for an inline one. */
  readonly offset?: number
  readonly sizeInBytes: number
  /** How many rows it deletes. */
  readonly cardinality: number
}

const Z85 =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#'
const Z85_VALUE = new Map([...Z85].map((c, i) => [c, i]))

/** Z85 text as bytes: every five characters are four bytes, big-endian in base 85. */
export function z85Decode(text: string): Uint8Array {
  if (text.length % 5 !== 0)
    throw new Error('A deletion vector’s Z85 text is not a whole number of groups.')
  const out = new Uint8Array((text.length / 5) * 4)
  const view = new DataView(out.buffer)
  for (let group = 0; group < text.length / 5; group++) {
    let value = 0
    for (let i = 0; i < 5; i++) {
      const digit = Z85_VALUE.get(text[group * 5 + i]!)
      if (digit === undefined)
        throw new Error('A deletion vector’s Z85 text holds a character Z85 has no digit for.')
      value = value * 85 + digit
    }
    view.setUint32(group * 4, value)
  }
  return out
}

/**
 * Where a vector stored in a file lives, relative to the table root, for a `u` descriptor: an
 * optional directory prefix, then the file named by the UUID the last twenty characters encode.
 */
export function deletionVectorFile(dv: DeletionVectorDescriptor): string {
  const text = dv.pathOrInlineDv
  const prefix = text.slice(0, -20)
  const bytes = z85Decode(text.slice(-20))
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return `${prefix ? `${prefix}/` : ''}deletion_vector_${uuid}.bin`
}

/** The byte range of a stored vector's file to read: its length prefix and the bitmap after it. */
export function vectorRange(dv: DeletionVectorDescriptor): [number, number] {
  const at = dv.offset ?? 1
  return [at, at + 4 + dv.sizeInBytes]
}

/**
 * The bytes a stored vector's bitmap is in, handed `vectorRange` of its file: past the big-endian
 * length that prefixes it there. An inline vector's are its Z85 text, decoded.
 */
export function vectorBytes(dv: DeletionVectorDescriptor, range: Uint8Array): Uint8Array {
  const length = new DataView(range.buffer, range.byteOffset, range.byteLength).getUint32(0)
  if (length !== dv.sizeInBytes) {
    throw new Error(
      `A deletion vector says it is ${dv.sizeInBytes} bytes and its file ${length}.`,
    )
  }
  return range.subarray(4, 4 + length)
}

const ARRAY_MAGIC = 1681511377
const NO_RUNS = 12346
const WITH_RUNS = 12347

/**
 * The deleted rows, ascending: a RoaringBitmapArray read whole, checked against the cardinality the
 * log states — a count that disagrees is a vector read wrongly, and the rows it keeps would be too.
 */
export function deletedRows(bitmap: Uint8Array, cardinality: number): Float64Array {
  const view = new DataView(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength)
  let at = 0
  if (view.getUint32(at, true) !== ARRAY_MAGIC)
    throw new Error('A deletion vector is not in the format Delta writes.')
  at += 4
  const bitmaps = Number(view.getBigUint64(at, true))
  at += 8
  const rows = new Float64Array(cardinality)
  let count = 0
  for (let b = 0; b < bitmaps; b++) {
    const high = view.getUint32(at, true) * 2 ** 32
    at += 4
    at = readRoaring(view, at, (low) => {
      if (count < cardinality) rows[count] = high + low
      count++
    })
  }
  if (count !== cardinality) {
    throw new Error(`A deletion vector holds ${count} rows where the log says ${cardinality}.`)
  }
  return rows.sort()
}

/** One portable 32-bit roaring bitmap from `at`, each value handed to `visit`; the offset past it. */
function readRoaring(view: DataView, start: number, visit: (value: number) => void): number {
  let at = start
  const cookie = view.getUint32(at, true)
  at += 4
  let size: number
  let runs: Uint8Array | undefined
  if ((cookie & 0xffff) === WITH_RUNS) {
    size = (cookie >>> 16) + 1
    runs = new Uint8Array(view.buffer, view.byteOffset + at, Math.ceil(size / 8))
    at += runs.byteLength
  } else if (cookie === NO_RUNS) {
    size = view.getUint32(at, true)
    at += 4
  } else {
    throw new Error('A deletion vector holds a bitmap in a format this reader does not know.')
  }
  const keys: number[] = []
  const counts: number[] = []
  for (let i = 0; i < size; i++) {
    keys.push(view.getUint16(at, true))
    counts.push(view.getUint16(at + 2, true) + 1)
    at += 4
  }
  // Offsets to each container: always without runs, and with them only from four containers up.
  if (!runs || size >= 4) at += 4 * size
  for (let i = 0; i < size; i++) {
    const high = keys[i]! << 16
    const isRun = runs ? (runs[i >>> 3]! >>> (i & 7)) & 1 : 0
    if (isRun) {
      const count = view.getUint16(at, true)
      at += 2
      for (let r = 0; r < count; r++) {
        const from = view.getUint16(at, true)
        const length = view.getUint16(at + 2, true)
        at += 4
        for (let v = from; v <= from + length; v++) visit((high | v) >>> 0)
      }
    } else if (counts[i]! <= 4096) {
      for (let k = 0; k < counts[i]!; k++)
        visit((high | view.getUint16(at + 2 * k, true)) >>> 0)
      at += 2 * counts[i]!
    } else {
      // 65,536 bits, read as 32-bit words: a `bigint` per bit is most of decoding a dense vector.
      for (let word = 0; word < 2048; word++) {
        let bits = view.getUint32(at + 4 * word, true)
        for (let bit = 0; bits !== 0; bit++, bits >>>= 1) {
          if (bits & 1) visit((high | (word * 32 + bit)) >>> 0)
        }
      }
      at += 8192
    }
  }
  return at
}
