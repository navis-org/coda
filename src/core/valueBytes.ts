/**
 * What a value costs to hold, estimated from its shape — the memory readout's breakdown.
 *
 * ## Why an estimate, when Chrome measures
 *
 * Chrome's `performance.memory` is a real measurement and the readout shows it where it exists,
 * but it is one number for the whole page. It cannot say *which workflow* or *which kind of
 * result* the bytes belong to, which is the question somebody near the ceiling is asking — and
 * Firefox and Safari give no number at all. This answers both from the values themselves.
 *
 * ## The costs, measured
 *
 * Every constant below was measured in Chrome (V8 with pointer compression) as a heap delta over a
 * million cells arriving through `JSON.parse`, which is how every backend's rows arrive — see
 * `scripts/probe-memory.mjs`:
 *
 * | Column                          | Measured    | Model                           |
 * | ------------------------------- | ----------- | ------------------------------- |
 * | integers below 2^30             | 4.0 B/cell  | one slot (a Smi)                |
 * | doubles                         | 8.0 B/cell  | unboxed in a double array       |
 * | doubles with one null in four   | 13.0 B/cell | slot + a 12-byte boxed number   |
 * | 18-digit ids as text            | 36.0 B/cell | slot + `align8(12 + length)`    |
 * | three type names, repeated      | 3.1–4 B/cell| slot; the strings are shared    |
 *
 * The last row is the one worth knowing: `JSON.parse` hands back **one** string for every
 * repeat of a value, so a `type` column costs a slot per row and its distinct names once. A
 * string column is therefore charged for its distinct values, which is exact below
 * `EXACT_DISTINCT` string cells and sampled above it.
 *
 * Typed arrays are not estimated at all: a buffer's `byteLength` is the answer.
 *
 * ## Why a ledger
 *
 * Results share their arrays far more than they copy them — a passthrough hands its input on by
 * identity, a Select keeps the columns it keeps, a duplicated workflow adopts its original's cache
 * whole, and the geometry cache holds the very buffers a scene is drawing. Summed naively, the
 * same bytes are counted once per holder. `ByteLedger` claims each column array and each
 * `ArrayBuffer` once, so a total is a total, and a holder that shares everything reads as zero —
 * which is also the true answer to "what would dropping this free".
 *
 * Headless (invariant 1), and pure over the values it is handed.
 */

import type { ColumnData, TableValue, Value } from './values'

/** How results are grouped in the readout, in display order, with what the readout calls each. */
export const MEMORY_CATEGORIES = [
  { id: 'tables', label: 'Tables' },
  { id: 'matrices', label: 'Matrices' },
  { id: 'networks', label: 'Networks' },
  { id: 'skeletons', label: 'Skeletons' },
  { id: 'meshes', label: 'Meshes' },
  { id: 'points', label: 'Points' },
  { id: 'other', label: 'Other' },
] as const

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]['id']

export function valueCategory(value: Value): MemoryCategory {
  switch (value.kind) {
    case 'table':
    case 'neurons':
    case 'dataset':
      return 'tables'
    case 'matrix':
      return 'matrices'
    case 'network':
      return 'networks'
    case 'skeletons':
      return 'skeletons'
    case 'meshes':
      return 'meshes'
    case 'points':
      return 'points'
    default:
      return 'other'
  }
}

/** A pointer or a small integer, with pointer compression. */
const SLOT = 4
/** A double held unboxed, in an array that holds nothing else. */
const DOUBLE = 8
/** A double boxed as a heap number, in an array that also holds something that is not one. */
const HEAP_NUMBER = 12
/** A string's header, before its one-byte characters. */
const STRING_HEADER = 12
/** Smis are 31-bit with pointer compression. */
const SMI_MAX = 2 ** 30

/** At or below this many string cells a column's distinct values are counted exactly. */
const EXACT_DISTINCT = 65_536
/** How many string cells a larger column's distinct share is read off. */
const SAMPLE = 4_096

function stringBytes(text: string): number {
  return Math.ceil((STRING_HEADER + text.length) / 8) * 8
}

/**
 * Memoised on the array's identity. Columns are immutable (see `values.ts`), so an estimate is a
 * pure function of the array — and the readout polls, so a million-row table is walked once per
 * result rather than once per tick.
 */
const COLUMN_BYTES = new WeakMap<readonly unknown[], number>()

/** Bytes of one column array. Exported for the tests, which pin the model against the table above. */
export function columnBytes(column: readonly unknown[]): number {
  const hit = COLUMN_BYTES.get(column)
  if (hit !== undefined) return hit

  let numeric = true
  let smi = true
  let boxed = 0
  let strings = 0
  for (const cell of column) {
    if (typeof cell === 'number') {
      if (!(Number.isInteger(cell) && cell >= -SMI_MAX && cell < SMI_MAX)) {
        smi = false
        boxed += 1
      }
    } else {
      numeric = false
      if (typeof cell === 'string') strings += 1
    }
  }

  const bytes = numeric
    ? column.length * (smi ? SLOT : DOUBLE)
    : column.length * SLOT + boxed * HEAP_NUMBER + distinctStringBytes(column, strings)
  COLUMN_BYTES.set(column, bytes)
  return bytes
}

/**
 * The column's strings, each distinct value charged once — `JSON.parse`'s sharing, above.
 *
 * Sampled above `EXACT_DISTINCT`: a set over a million strings is tens of milliseconds, paid on the
 * main thread per column, and a readout that stalls the canvas to report on it has its priorities
 * backwards. The sample's distinct share scales its average size up to the whole column, which is
 * right at both ends that matter — an id column (every value new) and a type column (a handful) —
 * and between them overstates, since a value seen twice in the column is usually seen once in a
 * sample. An overstatement is the safe direction for a readout about a ceiling.
 */
function distinctStringBytes(column: readonly unknown[], strings: number): number {
  // Every cell at or below the threshold, where `sampled === strings` makes the scaling exact.
  const step = strings <= EXACT_DISTINCT ? 1 : Math.max(1, Math.floor(column.length / SAMPLE))
  const seen = new Set<string>()
  let sampled = 0
  let bytes = 0
  for (let i = 0; i < column.length; i += step) {
    const cell = column[i]
    if (typeof cell !== 'string') continue
    sampled += 1
    if (seen.has(cell)) continue
    seen.add(cell)
    bytes += stringBytes(cell)
  }
  // `bytes / sampled` is the sample's payload per string cell, repeats costing nothing.
  return sampled === 0 ? 0 : Math.round((bytes / sampled) * strings)
}

/**
 * Charges each array and each buffer once, however many values hold it — see the header.
 *
 * One ledger per total: two readouts sharing one would credit the second with nothing.
 */
export class ByteLedger {
  private seen = new WeakSet<object>()
  private bufferBytes = 0
  private totalBytes = 0

  /** Everything this ledger has counted. */
  get total(): number {
    return this.totalBytes
  }

  /**
   * How much of what was counted is typed-array storage.
   *
   * Asked separately because it is held to a different ceiling: measured in Chrome, typed arrays
   * count towards `usedJSHeapSize` but not against `jsHeapSizeLimit` — 6 GiB of them allocated
   * without complaint against a 4 GiB limit. What the limit binds is ordinary objects, which is
   * the part a readout about a ceiling has to isolate.
   */
  get buffers(): number {
    return this.bufferBytes
  }

  /** Bytes of `value` that this ledger has not already counted. */
  add(value: Value): number {
    const bytes = this.charge(value)
    this.totalBytes += bytes
    return bytes
  }

  private charge(value: Value): number {
    switch (value.kind) {
      case 'table':
      case 'neurons':
        return this.table(value)
      case 'dataset':
        return value.annotations ? this.table(value.annotations.table) : 0
      case 'matrix':
        return (
          this.buffer(value.values) + this.array(value.rowLabels) + this.array(value.colLabels)
        )
      case 'network':
        return this.table(value.nodes) + this.table(value.edges)
      case 'skeletons': {
        let bytes = this.table(value.attributes) + this.items(value.items)
        for (const item of value.items) {
          bytes +=
            this.buffer(item.positions) + this.buffer(item.radii) + this.buffer(item.parents)
        }
        return bytes
      }
      case 'meshes': {
        let bytes = this.table(value.attributes) + this.items(value.items)
        for (const item of value.items)
          bytes += this.buffer(item.positions) + this.buffer(item.indices)
        return bytes
      }
      case 'points':
        return this.buffer(value.positions) + this.table(value.attributes)
      case 'linkage':
        return (
          this.buffer(value.merges) +
          this.buffer(value.order) +
          (value.clusters ? this.buffer(value.clusters) : 0) +
          this.array(value.labels)
        )
      case 'transform':
        return this.buffer(value.source) + this.buffer(value.target)
      case 'layout':
        return this.claim(value) ? layoutBytes(value.positions) : 0
      case 'layers':
        return this.claim(value) ? jsonBytes(value.items) : 0
      case 'string':
        return stringBytes(String(value.value))
      default:
        return 0
    }
  }

  /**
   * Bytes of something the geometry cache holds, with the charge it recorded as a fallback.
   *
   * Walked for its typed arrays, one level down — a skeleton or a mesh is a record of them — so a
   * buffer a live scene already claimed is not charged twice. Something holding none (a manifest)
   * is charged what the cache charged it, once.
   */
  addLoose(item: unknown, fallback: number): number {
    const bytes = this.chargeLoose(item, fallback)
    this.totalBytes += bytes
    return bytes
  }

  private chargeLoose(item: unknown, fallback: number): number {
    if (typeof item !== 'object' || item === null) return 0
    if (ArrayBuffer.isView(item)) return this.buffer(item)
    let views = false
    let bytes = 0
    for (const field of Object.values(item)) {
      if (!ArrayBuffer.isView(field)) continue
      views = true
      bytes += this.buffer(field)
    }
    if (views) return bytes
    return this.claim(item) ? fallback : 0
  }

  private claim(thing: object): boolean {
    if (this.seen.has(thing)) return false
    this.seen.add(thing)
    return true
  }

  /** The whole backing store, not the view: a `subarray` keeps all of it alive. */
  private buffer(view: ArrayBufferView): number {
    if (!this.claim(view.buffer)) return 0
    this.bufferBytes += view.buffer.byteLength
    return view.buffer.byteLength
  }

  private array(column: readonly unknown[]): number {
    return this.claim(column) ? columnBytes(column) : 0
  }

  /** An `items` array itself: one slot per geometry record. */
  private items(items: readonly unknown[]): number {
    return this.claim(items) ? items.length * SLOT : 0
  }

  private table(table: TableValue): number {
    let bytes = 0
    for (const column of Object.values(table.data) as ColumnData[]) bytes += this.array(column)
    return bytes
  }
}

/**
 * A layout's record of `{x, y}`: roughly a key, a slot, and a small object of two boxed doubles
 * each. Rough on purpose — layouts are the smallest thing a graph holds and not what anybody near
 * a ceiling is looking for.
 */
function layoutBytes(positions: Readonly<Record<string, unknown>>): number {
  let bytes = 0
  for (const key in positions) bytes += stringBytes(key) + SLOT + 16 + 2 * HEAP_NUMBER
  return bytes
}

/** Opaque layer JSON, by the length of its text: close enough for a few kilobytes of state. */
function jsonBytes(items: unknown): number {
  try {
    return JSON.stringify(items)?.length ?? 0
  } catch {
    return 0
  }
}
