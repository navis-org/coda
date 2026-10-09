/**
 * A keyed read's fast path through one Parquet row group: the key columns matched on their pages
 * as they lie, the other columns decoded only where a key matched.
 *
 * Measured on a 192M-row FlyWire synapse table, a lookup of six neurons spent its time in the
 * library decoding every value of every column it asked for — the three coordinate columns whole,
 * to keep 376 rows of each million. This path decodes what the answer needs, and nothing it
 * cannot read exactly: a flat column of plain integers, floats or text, v1 data pages, PLAIN or
 * dictionary encoded, in a codec `pageLibraries` holds or none. Anything else — a v2 page, a null
 * in a *key* column's page, a date, a decimal, another codec — throws `Unsupported`, and
 * `parquet.ts` hands the block to hyparquet, so a file this path does not understand is slower and
 * never wrong.
 *
 * Four things it does that the library does not, each measured:
 *  - **A key is matched in place.** A 64-bit id on a PLAIN page is tested by its two 32-bit words
 *    (`IdProbe.words`, behind the 16-bit bitmap) off the page's own bytes, never a `bigint`; on a
 *    dictionary page the dictionary is tested once and only the index stream is scanned — and a
 *    page whose dictionary holds none of the ids is never decompressed.
 *  - **Everything else is gathered.** A page with no matched row is skipped undecompressed; on one
 *    with matches, only those rows' values are read — a PLAIN value by its offset, a dictionary
 *    index by its bit position in the run holding it.
 *  - **Only the pages holding a match are fetched**, where the file wrote a page index
 *    (`pagesHolding`): the library reads a chunk whole to keep three rows of it.
 *  - **Snappy is WASM** (`hysnappy`), the library's JavaScript codec having been half its time.
 *
 * Values come out as hyparquet would give them — `bigint` for INT64, a number for INT32 and the
 * floats, text for BYTE_ARRAY — so `decoderFor` reads either route alike.
 */

import type { ColumnChunk, FileMetaData, SchemaElement } from 'hyparquet'
import type { PageLibraries } from '../libraries'

import type { ByteSource } from './bytes'
import { utf8 } from './columns'
import type { IdProbe, Matches } from './reader'
import { pushWordHits, unionRows } from './reader'

/**
 * A page or column this path does not read; the block goes to the library instead. `fileWide`
 * where the reason is how the file was written — a codec, a v2 page, an encoding — so every block
 * would refuse the same way, and `parquet.ts` stops asking rather than fetch each chunk twice. A
 * null in a key's page is per block.
 */
export class Unsupported extends Error {
  readonly fileWide: boolean

  constructor(fileWide = false) {
    super('not a page the fast path reads')
    this.fileWide = fileWide
  }
}

type Physical = 'INT32' | 'INT64' | 'FLOAT' | 'DOUBLE' | 'BYTE_ARRAY'

/** A column this path can read, as its schema says — the same for every row group. */
export interface PlainColumn {
  readonly physical: Physical
  readonly optional: boolean
  /** Its position among each row group's column chunks. */
  readonly chunk: number
}

/**
 * The columns this path can read, by name — flat, and plain integers (signed), floats or text —
 * or undefined for a file with any nested column, which it leaves to the library whole.
 */
export function plainColumns(
  metadata: FileMetaData,
  /** Each column's position among a row group's chunks — `parquet.ts`' own map. */
  chunkIndex: ReadonlyMap<string, number>,
): Map<string, PlainColumn> | undefined {
  const [root, ...elements] = metadata.schema
  if (!root || elements.some((e) => e.num_children)) return undefined
  const out = new Map<string, PlainColumn>()
  for (const element of elements) {
    const physical = physicalOf(element)
    const chunk = chunkIndex.get(element.name)
    if (!physical || chunk === undefined || element.repetition_type === 'REPEATED') continue
    out.set(element.name, { physical, optional: element.repetition_type === 'OPTIONAL', chunk })
  }
  return out
}

/** The physical type, where the column holds it plainly: no date, decimal, unsigned or float16. */
function physicalOf(element: SchemaElement): Physical | undefined {
  const { type, converted_type: converted, logical_type: logical } = element
  if (type === 'BYTE_ARRAY') {
    const text = converted === 'UTF8' || logical?.type === 'STRING'
    return text || (!converted && !logical) ? type : undefined
  }
  if (type !== 'INT32' && type !== 'INT64' && type !== 'FLOAT' && type !== 'DOUBLE')
    return undefined
  const signed = !converted || /^INT_(8|16|32|64)$/.test(converted)
  const plain = !logical || (logical.type === 'INTEGER' && logical.isSigned)
  return signed && plain ? type : undefined
}

/**
 * The rows of row group `group` where a `keys` column holds a probed id, and the `outputs`
 * columns' values at them. Throws `Unsupported` for anything this path does not read.
 */
export async function readMatches(
  library: PageLibraries,
  bytes: ByteSource,
  metadata: FileMetaData,
  columns: ReadonlyMap<string, PlainColumn>,
  group: number,
  keys: readonly string[],
  probe: IdProbe,
  outputs: readonly string[],
): Promise<Matches> {
  const rowGroup = metadata.row_groups[group]
  if (!rowGroup) throw new Unsupported()
  const rowCount = Number(rowGroup.num_rows)
  const located = (name: string): Located => {
    const column = columns.get(name)
    const chunk = column && rowGroup.columns[column.chunk]
    const meta = chunk?.meta_data
    if (!column || !meta || meta.path_in_schema.join('.') !== name) throw new Unsupported(true)
    const inflate = meta.codec === 'UNCOMPRESSED' ? undefined : library.codecs[meta.codec]
    if (meta.codec !== 'UNCOMPRESSED' && !inflate) throw new Unsupported(true)
    return { column, chunk, meta, inflate }
  }
  // Everything the footer can refuse is refused here, before a byte is read: a refusal found
  // after the key chunks were fetched has the library fetch them again.
  const keyed = keys.map(located)
  for (const { column, meta } of keyed) {
    if (column.physical !== 'INT64' && column.physical !== 'INT32') throw new Unsupported(true)
    // A null in a key column is a page the scan does not read (`matchRows`).
    if (meta.statistics?.null_count) throw new Unsupported()
  }
  const others = outputs.filter((name) => !keys.includes(name)).map(located)

  const whole = async ({ column, meta, inflate }: Located): Promise<Chunk> => {
    // `||`, as hyparquet reads it: a writer's 0 means no dictionary page, not one at byte 0.
    const start = Number(meta.dictionary_page_offset || meta.data_page_offset)
    const raw = await bytes.read(start, start + Number(meta.total_compressed_size))
    return new Chunk(library, [{ bytes: raw, firstRow: 0 }], column, inflate, rowCount)
  }

  const keyChunks = await Promise.all(keyed.map(whole))
  const hits = keyChunks.map((chunk) => chunk.matchRows(probe))
  const rows = unionRows(hits)
  if (rows.length === 0)
    return { rows, values: Object.fromEntries(outputs.map((n) => [n, []])) }

  // A key column that is also an output is gathered from its own chunk, already decompressed.
  // Every other is read where the matches are: only the pages holding them, through its offset
  // index, or whole where the file wrote none.
  const indexes = await offsetIndexes(
    bytes,
    others.map((other) => other.chunk),
  )
  const otherChunks = await Promise.all(
    others.map(async (other, i) => {
      const index = indexes[i]
      const pages =
        index && (await pagesHolding(library, bytes, other.meta, index, rows, rowCount))
      return pages ? new Chunk(library, pages, other.column, other.inflate) : whole(other)
    }),
  )
  const byName = new Map<string, Chunk>()
  keys.forEach((name, i) => byName.set(name, keyChunks[i]!))
  others.forEach((other, i) => byName.set(other.meta.path_in_schema.join('.'), otherChunks[i]!))
  const values: Record<string, unknown[]> = {}
  for (const name of outputs) values[name] = byName.get(name)!.gather(rows)
  return { rows, values }
}

/** A column's chunk in one row group, as the footer describes it, and its codec where compressed. */
interface Located {
  readonly column: PlainColumn
  readonly chunk: ColumnChunk
  readonly meta: NonNullable<ColumnChunk['meta_data']>
  readonly inflate: PageLibraries['codecs'][string] | undefined
}

/** Pages read together: the bytes of one or more consecutive pages, and the row the first begins at. */
interface Segment {
  readonly bytes: Uint8Array
  readonly firstRow: number
}

/** Pages this far apart are read as one request, the gap with them. */
const PAGE_GAP = 64 << 10

/**
 * Each chunk's offset index, or undefined where the file wrote none. A row group's are written
 * side by side, so the ones wanted are one read and the little between them, not one each.
 */
async function offsetIndexes(
  bytes: ByteSource,
  chunks: readonly ColumnChunk[],
): Promise<(Uint8Array | undefined)[]> {
  const spans = chunks.map((chunk) => {
    const from = chunk.offset_index_offset
    const length = chunk.offset_index_length
    return from === undefined || !length
      ? undefined
      : { from: Number(from), to: Number(from) + length }
  })
  const held = spans.flatMap((span) => (span ? [span] : []))
  if (held.length === 0) return spans.map(() => undefined)
  const from = Math.min(...held.map((span) => span.from))
  const raw = await bytes.read(from, Math.max(...held.map((span) => span.to)))
  return spans.map((span) => span && raw.subarray(span.from - from, span.to - from))
}

/**
 * The dictionary page and the data pages holding `rows`, read through the chunk's offset index —
 * or undefined where the pages wanted are most of the chunk and one read of the whole is fewer
 * requests for nearly the same bytes. On a table of million-row groups, gathering a few hundred
 * rows is a page or two per column of a chunk tens of megabytes long: the difference between a
 * lookup that downloads the table and one that does not.
 */
async function pagesHolding(
  library: PageLibraries,
  bytes: ByteSource,
  meta: NonNullable<ColumnChunk['meta_data']>,
  index: Uint8Array,
  rows: readonly number[],
  rowCount: number,
): Promise<Segment[] | undefined> {
  const locations = library.readOffsetIndex({
    view: new DataView(index.buffer, index.byteOffset, index.byteLength),
    offset: 0,
  }).page_locations
  const ranges: { from: number; to: number; firstRow: number }[] = []
  // The dictionary page first, which every data page read needs; a first data page near it joins.
  const dictionary = Number(meta.dictionary_page_offset || 0)
  if (dictionary && locations[0]) {
    ranges.push({ from: dictionary, to: Number(locations[0].offset), firstRow: 0 })
  }
  let r = 0
  locations.forEach((page, i) => {
    const start = Number(page.first_row_index)
    const end = Number(locations[i + 1]?.first_row_index ?? rowCount)
    if (r >= rows.length || rows[r]! >= end) return
    while (r < rows.length && rows[r]! < end) r++
    const from = Number(page.offset)
    const to = from + page.compressed_page_size
    const last = ranges.at(-1)
    if (last && from - last.to <= PAGE_GAP) last.to = to
    else ranges.push({ from, to, firstRow: start })
  })
  const wanted = ranges.reduce((n, range) => n + range.to - range.from, 0)
  if (wanted > Number(meta.total_compressed_size) / 2) return undefined
  return Promise.all(
    ranges.map(async ({ from, to, firstRow }) => ({
      bytes: await bytes.read(from, to),
      firstRow,
    })),
  )
}

// ---------------------------------------------------------------------------
// One column chunk
// ---------------------------------------------------------------------------

interface PageRef {
  readonly start: number
  readonly count: number
  readonly dictionary: boolean
  readonly body: Uint8Array
  readonly size: number
  /** From the page's own statistics; undefined where it kept none. */
  readonly nulls: number | undefined
}

/** A dictionary page's values by index, typed as hyparquet types them. */
interface Dictionary {
  readonly length: number
  at(index: number): unknown
}

/** A page decompressed: its bytes, and where its values begin. */
interface Decoded {
  readonly bytes: Uint8Array
  readonly view: DataView
  readonly at: number
  /** Bit width of a dictionary page's indices; 0 on a PLAIN page. */
  readonly width: number
  /**
   * Where a page holding nulls has them: each row's place among the values the page stores, or -1
   * for a null. Absent where every row has a value, which is every page of a non-null column.
   */
  readonly slots: Int32Array | undefined
}

class Chunk {
  private readonly column: PlainColumn
  /** The chunk's codec, where it is compressed. */
  private readonly codec: PageLibraries['codecs'][string] | undefined
  private readonly pages: PageRef[] = []
  private readonly decoded: (Decoded | undefined)[] = []
  private dictionary: Dictionary | undefined
  private dictionaryWords: Uint32Array | undefined

  /**
   * From the chunk's pages, read as segments: the whole chunk as one starting at row 0 with `rows`
   * its row count, or only some of its pages, each segment saying the row it starts at — and then
   * no count to check them against, since the pages between were never read.
   */
  constructor(
    library: PageLibraries,
    segments: readonly Segment[],
    column: PlainColumn,
    codec: PageLibraries['codecs'][string] | undefined,
    rows?: number,
  ) {
    this.column = column
    this.codec = codec
    let row = 0
    for (const segment of segments) row = this.readSegment(library, segment)
    // Flat, so a value is a row; anything else is a chunk this path has misread.
    if (rows !== undefined && row !== rows) throw new Unsupported()
  }

  /** A segment's pages, noted where they lie; the row its last one ends at. */
  private readSegment(library: PageLibraries, { bytes: raw, firstRow }: Segment): number {
    const { Encodings, PageTypes, deserializeTCompactProtocol } = library
    const { column } = this
    let row = firstRow
    const reader = { view: new DataView(raw.buffer, raw.byteOffset, raw.byteLength), offset: 0 }
    while (reader.offset < raw.byteLength) {
      const header = deserializeTCompactProtocol(reader)
      const type = PageTypes[header.field_1 as number]
      const size = header.field_2 as number
      const body = raw.subarray(reader.offset, reader.offset + (header.field_3 as number))
      reader.offset += body.byteLength
      if (type === 'DICTIONARY_PAGE') {
        const count = header.field_7?.field_1 as number
        this.readDictionary(this.inflate(body, size), count)
      } else if (type === 'DATA_PAGE') {
        const page = header.field_5
        const encoding = Encodings[page.field_2 as number]
        const dictionary = encoding === 'RLE_DICTIONARY' || encoding === 'PLAIN_DICTIONARY'
        if (!dictionary && encoding !== 'PLAIN') throw new Unsupported(true)
        if (column.optional && Encodings[page.field_3 as number] !== 'RLE') {
          throw new Unsupported(true)
        }
        const nulls = page.field_5?.field_3
        const count = page.field_1 as number
        this.pages.push({
          start: row,
          count,
          dictionary,
          body,
          size,
          nulls: nulls === undefined ? undefined : Number(nulls),
        })
        row += count
      } else if (type !== 'INDEX_PAGE') {
        // A v2 data page: how the file was written.
        throw new Unsupported(true)
      }
    }
    return row
  }

  /** The rows holding a probed id, ascending. Only an INT64 or INT32 column can be a key here. */
  matchRows(probe: IdProbe): number[] {
    const { physical } = this.column
    if (physical !== 'INT64' && physical !== 'INT32') throw new Unsupported(true)
    const ints = physical === 'INT32' ? int32Ids(probe) : undefined
    // Which dictionary entries are probed ids — tested once for every page that indexes them.
    const flags = this.dictionary && this.dictionaryFlags(probe, ints)
    const anyFlag = flags?.includes(1) ?? false
    const rows: number[] = []
    this.pages.forEach((page, i) => {
      // A page indexing a dictionary this chunk never held is a chunk this path has misread.
      if (page.dictionary && !this.dictionary) throw new Unsupported()
      // A dictionary page whose dictionary holds none of the ids cannot match: never decompressed.
      if (page.dictionary && !anyFlag) return
      const d = this.page(i)
      // A key page with nulls in it: the scan below reads one value per row.
      if (d.slots) throw new Unsupported()
      const before = rows.length
      if (page.dictionary) {
        const indices = new Hybrid(d.bytes, d.at, d.bytes.byteLength, d.width)
        indices.flagged(page.count, flags!, page.start, rows)
      } else if (ints) {
        for (let k = 0; k < page.count; k++) {
          if (ints.has(d.view.getInt32(d.at + 4 * k, true))) rows.push(page.start + k)
        }
      } else {
        pushWordHits(
          alignedWords(d.bytes, d.at, page.count * 2),
          page.count,
          page.start,
          probe,
          rows,
        )
      }
      // A page with no match is not gathered from — unless another key matched there, when it is
      // decompressed again; cheaper than holding every key page through the other columns' reads.
      if (rows.length === before) this.decoded[i] = undefined
    })
    return rows
  }

  /** Which dictionary entries are probed ids, as 0/1 flags by index. */
  private dictionaryFlags(probe: IdProbe, ints: ReadonlySet<number> | undefined): Uint8Array {
    const dictionary = this.dictionary!
    const flags = new Uint8Array(dictionary.length)
    if (ints) {
      for (let i = 0; i < dictionary.length; i++)
        flags[i] = ints.has(dictionary.at(i) as number) ? 1 : 0
    } else {
      const hits: number[] = []
      pushWordHits(this.dictionaryWords!, dictionary.length, 0, probe, hits)
      for (const i of hits) flags[i] = 1
    }
    return flags
  }

  /** This column's values at `rows` (ascending), decompressing only the pages that hold one. */
  gather(rows: readonly number[]): unknown[] {
    const out = new Array<unknown>(rows.length)
    let r = 0
    this.pages.forEach((page, i) => {
      const end = page.start + page.count
      if (r >= rows.length || rows[r]! >= end) return
      // A row before this page is in a page that was not read: never a value read from elsewhere.
      if (rows[r]! < page.start) throw new Unsupported()
      const d = this.page(i)
      const at = valueReader(d, page, this.column.physical, this.dictionary)
      const { slots } = d
      for (; r < rows.length && rows[r]! < end; r++) {
        const k = rows[r]! - page.start
        if (!slots) out[r] = at(k)
        else out[r] = slots[k]! < 0 ? null : at(slots[k]!)
      }
    })
    return out
  }

  private page(i: number): Decoded {
    const held = this.decoded[i]
    if (held) return held
    const page = this.pages[i]!
    const bytes = this.inflate(page.body, page.size)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let at = 0
    let slots: Int32Array | undefined
    if (this.column.optional) {
      // v1 definition levels: a 4-byte length and an RLE/bit-packed run of 1-bit levels. A page
      // whose statistics say no nulls is taken at its word; any other is read, and where it holds
      // a null each row is given its place among the values — they are stored for rows with one.
      const length = view.getUint32(0, true)
      if (page.nulls !== 0) slots = valueSlots(bytes, 4, 4 + length, page.count)
      at = 4 + length
    }
    const width = page.dictionary ? bytes[at++]! : 0
    if (page.dictionary && !this.dictionary) throw new Unsupported()
    const decoded = { bytes, view, at, width, slots }
    this.decoded[i] = decoded
    return decoded
  }

  private inflate(body: Uint8Array, size: number): Uint8Array {
    return this.codec ? this.codec(body, size) : body
  }

  /** A PLAIN dictionary page's values, typed as hyparquet types them. */
  private readDictionary(bytes: Uint8Array, count: number): void {
    const { physical } = this.column
    if (physical === 'BYTE_ARRAY') {
      this.dictionary = textDictionary(bytes, count)
      return
    }
    // A fresh copy, so the typed view is aligned whatever offset the page began at.
    const width = physical === 'INT64' || physical === 'DOUBLE' ? 8 : 4
    const buffer = bytes.slice(0, count * width).buffer
    const values =
      physical === 'INT64'
        ? new BigInt64Array(buffer)
        : physical === 'INT32'
          ? new Int32Array(buffer)
          : physical === 'FLOAT'
            ? new Float32Array(buffer)
            : new Float64Array(buffer)
    this.dictionary = { length: count, at: (i) => values[i] }
    if (physical === 'INT64') this.dictionaryWords = new Uint32Array(buffer)
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * A reader of one decompressed page's values by position within it, positions asked ascending —
 * which is what lets a dictionary page's run cursor and a text page's walk only move forward.
 */
function valueReader(
  d: Decoded,
  page: PageRef,
  physical: Physical,
  dictionary: Dictionary | undefined,
): (k: number) => unknown {
  if (page.dictionary) {
    const indices = new Hybrid(d.bytes, d.at, d.bytes.byteLength, d.width)
    return (k) => dictionary!.at(indices.at(k))
  }
  const { view, at } = d
  switch (physical) {
    case 'INT64':
      return (k) => view.getBigInt64(at + 8 * k, true)
    case 'INT32':
      return (k) => view.getInt32(at + 4 * k, true)
    case 'FLOAT':
      return (k) => view.getFloat32(at + 4 * k, true)
    case 'DOUBLE':
      return (k) => view.getFloat64(at + 8 * k, true)
    case 'BYTE_ARRAY': {
      // Lengths precede values, so a position is reached by walking: forward only.
      let index = 0
      let offset = at
      return (k) => {
        for (; index < k; index++) offset += 4 + view.getUint32(offset, true)
        const length = view.getUint32(offset, true)
        return utf8.decode(d.bytes.subarray(offset + 4, offset + 4 + length))
      }
    }
  }
}

/** `count` 32-bit words from `at`, as a view on the page where aligned and a copy where not. */
function alignedWords(bytes: Uint8Array, at: number, count: number): Uint32Array {
  const offset = bytes.byteOffset + at
  if (offset % 4 === 0) return new Uint32Array(bytes.buffer, offset, count)
  return new Uint32Array(bytes.slice(at, at + 4 * count).buffer)
}

// ---------------------------------------------------------------------------
// Probing and text
// ---------------------------------------------------------------------------

/** The probed ids that fit in 32 bits, for an INT32 key. */
function int32Ids(probe: IdProbe): Set<number> {
  return new Set(
    probe.integers.filter((id) => id >= -(2n ** 31n) && id < 2n ** 31n).map(Number),
  )
}

/**
 * A text dictionary, each entry decoded the first time it is read: an output column gathers a few
 * hundred rows of a dictionary that can hold a hundred thousand entries.
 */
function textDictionary(bytes: Uint8Array, count: number): Dictionary {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offsets = new Int32Array(count)
  let at = 0
  for (let i = 0; i < count; i++) {
    offsets[i] = at
    at += 4 + view.getUint32(at, true)
  }
  const decoded = new Map<number, string>()
  const entry = (i: number): string => {
    let text = decoded.get(i)
    if (text === undefined) {
      const start = offsets[i]!
      text = utf8.decode(bytes.subarray(start + 4, start + 4 + view.getUint32(start, true)))
      decoded.set(i, text)
    }
    return text
  }
  return { length: count, at: entry }
}

// ---------------------------------------------------------------------------
// The RLE / bit-packed hybrid
// ---------------------------------------------------------------------------

/**
 * A cursor over an RLE / bit-packed hybrid stream: runs are walked forward only, and a value in a
 * bit-packed run is read at its bit position without unpacking the run around it.
 */
class Hybrid {
  private readonly bytes: Uint8Array
  private readonly end: number
  private readonly width: number
  private pos: number
  private runStart = 0
  private runEnd = 0
  private rle = false
  private value = 0
  private packed = 0

  constructor(bytes: Uint8Array, pos: number, end: number, width: number) {
    this.bytes = bytes
    this.pos = pos
    this.end = end
    this.width = width
  }

  /** The value at position `k` — ascending across calls. */
  at(k: number): number {
    while (k >= this.runEnd) this.next()
    return this.rle
      ? this.value
      : unpack(this.bytes, this.packed, (k - this.runStart) * this.width, this.width)
  }

  /**
   * Push `start + k` for each of the first `count` positions whose value is flagged — no call per
   * value, this being the key scan's every row.
   */
  flagged(count: number, flags: Uint8Array, start: number, into: number[]): void {
    let k = 0
    while (k < count) {
      if (k >= this.runEnd) this.next()
      const stop = Math.min(this.runEnd, count)
      if (this.rle) {
        if (flags[this.value]) for (; k < stop; k++) into.push(start + k)
        else k = stop
      } else {
        const { bytes, packed, width } = this
        let bit = (k - this.runStart) * width
        for (; k < stop; k++, bit += width) {
          if (flags[unpack(bytes, packed, bit, width)]) into.push(start + k)
        }
      }
    }
  }

  private next(): void {
    if (this.pos >= this.end) throw new Unsupported()
    let header = 0
    let shift = 0
    let byte: number
    do {
      byte = this.bytes[this.pos++]!
      header += (byte & 0x7f) * 2 ** shift
      shift += 7
    } while (byte & 0x80)
    this.runStart = this.runEnd
    if (header % 2 === 1) {
      const groups = Math.floor(header / 2)
      this.rle = false
      this.packed = this.pos
      this.pos += groups * this.width
      this.runEnd = this.runStart + groups * 8
    } else {
      this.rle = true
      this.value = 0
      for (let i = 0; i < Math.ceil(this.width / 8); i++)
        this.value += this.bytes[this.pos++]! * 2 ** (8 * i)
      this.runEnd = this.runStart + header / 2
    }
  }
}

/** `width` bits at bit `bit` of the bit-packed bytes from `start`, least significant first. */
function unpack(bytes: Uint8Array, start: number, bit: number, width: number): number {
  const at = start + (bit >>> 3)
  const shift = bit & 7
  if (width + shift <= 32) {
    // Past the end reads `undefined`, which the shifts treat as 0 — the run is padded anyway.
    const window =
      bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)
    return width === 32 ? window >>> shift : (window >>> shift) & ((1 << width) - 1)
  }
  let value = 0
  let got = 0
  let pos = at
  let skip = shift
  while (got < width) {
    const take = Math.min(8 - skip, width - got)
    value += ((bytes[pos]! >>> skip) & ((1 << take) - 1)) * 2 ** got
    got += take
    skip = 0
    pos++
  }
  return value
}

/**
 * Each row's place among a page's stored values, -1 for a null — or undefined where no row is null.
 * Levels this path cannot read are a page it has misread.
 */
function valueSlots(
  bytes: Uint8Array,
  start: number,
  end: number,
  count: number,
): Int32Array | undefined {
  const levels = new Hybrid(bytes, start, end, 1)
  // Most pages of a nullable column hold no null, so nothing is allocated until one is met: up to
  // there a row's place is its own number.
  let slots: Int32Array | undefined
  let stored = 0
  try {
    for (let k = 0; k < count; k++) {
      if (levels.at(k) === 1) {
        if (slots) slots[k] = stored
        stored++
      } else {
        slots ??= Int32Array.from({ length: count }, (_, i) => i)
        slots[k] = -1
      }
    }
  } catch {
    throw new Unsupported()
  }
  return slots
}
