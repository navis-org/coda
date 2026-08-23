/**
 * Encoding a user-supplied edge list into something a ten-million-edge connectome can be
 * queried from.
 *
 * The shape is forced by a measurement rather than chosen. A Coda `TableValue` holds
 * `ColumnData = CellValue[]`, which costs **8 bytes a cell whatever the kind** — so the
 * five-column connectivity table is 40 bytes a row, and a *string* id column is **72**,
 * because every distinct eighteen-digit id is its own heap string rather than a pointer to a
 * shared one. At ten million edges that is roughly 400 MB on neuPrint and over a gigabyte on
 * CAVE. Neither is a table anybody can hold, and holding it is what a `TableValue` means.
 *
 * So ids are **dictionary-encoded**: every distinct id is stored once, as exact text, and an
 * edge carries two `Int32` indices into that dictionary. An edge list over 140,000 neurons
 * has 140,000 distinct ids however many million edges reference them, so this is where the
 * order of magnitude comes from — and it is also invariant 8 at this seam, since the digits
 * are never parsed into a double and an eighteen-digit root id survives the store unchanged.
 *
 * The edges are held **twice**, as CSR by source and again by target. `fetchConnectivity`
 * asks for one direction or the other, so without the second copy every `inputs` query is a
 * scan of the whole edge set — per hop, and the Connectivity node's whole point is hops. The
 * second copy costs what the first one does; a scan costs the dataset.
 *
 * Nothing here touches IndexedDB or the DOM. Sharding and persistence are `store.ts`'s, so
 * this half is testable at ten million edges in node with no browser at all.
 */

import { isNeuronId } from '../../core/ids'

/** Bumped when the layout changes, so a stored set cannot outlive the code that reads it. */
export const EDGE_FORMAT = 1

/** Neuron indices. `Uint16` under 65,536 neurons, `Uint32` above. */
export type IdArray = Uint16Array | Uint32Array

/** Edge weights, narrowed to the smallest type that holds every merged value exactly. */
export type WeightArray = Uint8Array | Uint16Array | Int32Array | Float64Array

const U16_MAX = 65_535
const U8_MAX = 255
const INT32_MAX = 2_147_483_647

/** The narrowest index array for a dictionary of `neurons` entries. */
function idArray(neurons: number, length: number): IdArray {
  return neurons <= U16_MAX + 1 ? new Uint16Array(length) : new Uint32Array(length)
}

/**
 * Copy `count` weights into the narrowest type that holds every one of them exactly.
 *
 * The ladder is unsigned-first because a synapse count is a count: FlyWire's connection weights
 * are overwhelmingly single digits, so `Uint8` is the common case and is a quarter of `Int32`.
 * A negative weight — a signed score somebody computed — skips both unsigned rungs rather than
 * being clamped, and a fractional one skips all three, because a silently rounded weight is a
 * different connectome.
 */
function narrowWeights(values: Float64Array, count: number): WeightArray {
  let min = 0
  let max = 0
  let integral = true
  for (let i = 0; i < count; i++) {
    const v = values[i]!
    if (v < min) min = v
    if (v > max) max = v
    if (integral && !Number.isSafeInteger(v)) integral = false
  }
  const narrowed: WeightArray = !integral
    ? new Float64Array(count)
    : min >= 0 && max <= U8_MAX
      ? new Uint8Array(count)
      : min >= 0 && max <= U16_MAX
        ? new Uint16Array(count)
        : min >= -INT32_MAX - 1 && max <= INT32_MAX
          ? new Int32Array(count)
          : new Float64Array(count)
  for (let i = 0; i < count; i++) narrowed[i] = values[i]!
  return narrowed
}

/** A second array of the same type, so a transpose cannot silently widen or narrow. */
function likeWeights(sample: WeightArray, length: number): WeightArray {
  return new (sample.constructor as new (n: number) => WeightArray)(length)
}

/** What one encoded set occupies, for the panel and the store to report. */
export function edgeSetBytes(encoded: EncodedEdges): number {
  const csr = (c: EdgeCsr) => c.offsets.byteLength + c.targets.byteLength + c.weights.byteLength
  // The dictionary is stored as text; two bytes a character is the pessimistic reading.
  const ids = encoded.ids.reduce((n, id) => n + id.length * 2, 0)
  return csr(encoded.out) + csr(encoded.in) + ids
}

/**
 * One direction's compressed sparse row.
 *
 * `offsets` has `neurons + 1` entries: neuron `i`'s edges are `targets[offsets[i]]` up to
 * `offsets[i + 1]`, which is what makes a partner lookup O(degree) with no search. Each run is
 * sorted by target, so duplicates are adjacent — which is what let `finish` merge them.
 */
export interface EdgeCsr {
  /** Never negative and bounded by the edge count, so unsigned and 32 bits wide. */
  offsets: Uint32Array
  /**
   * Neuron *indices*, at the narrowest width the dictionary allows.
   *
   * A dataset under 65,536 neurons — hemibrain is about 25,000 — indexes in `Uint16` and halves
   * this array. FlyWire's proofread set is 138,640, so it takes `Uint32`; there is no standard
   * array between the two, and bit-packing the 18 bits it really needs would cost a shift and a
   * mask on every edge read to save a third of one array. Not a trade this makes.
   */
  targets: IdArray
  /**
   * Weights at the narrowest width the *merged* values allow — see `narrowWeights`.
   *
   * Detected rather than declared, and detected **after** merging rather than before: a synapse
   * count is a small integer and `Uint8` quarters this array against `Int32`, but two duplicate
   * rows of 200 sum to 400, and choosing the width from the file's own values would wrap that to
   * 144 with nothing to say so.
   */
  weights: WeightArray
}

export interface EncodedEdges {
  format: number
  /** Every id mentioned, in index order, as the exact text it arrived as. */
  ids: string[]
  /** By source, for `direction: 'outputs'`. */
  out: EdgeCsr
  /** By target, for `direction: 'inputs'`. */
  in: EdgeCsr
  /** Distinct ordered pairs after merging — the row count a caller should report. */
  edges: number
  /** What the read had to say about itself, for the panel to show. */
  report: EdgeReport
}

export interface EdgeReport {
  /** Rows offered to `add`, before any merging or dropping. */
  rowsRead: number
  /** Rows whose weight was not a finite number. Dropped. */
  droppedWeight: number
  /** Rows with a blank id on either end. Dropped. */
  droppedId: number
  /**
   * Rows merged into an earlier one for the same ordered pair, their weights summed.
   *
   * Not a fault: a per-region edge list is one row per (pre, post, region), and summing is what
   * turns it into the connectivity table Coda's schema describes. Counted because a large
   * number here means the file was not what somebody thought it was.
   */
  merged: number
  /**
   * Distinct ids that are not digit strings.
   *
   * Kept rather than dropped, which is `idText`'s documented split — it does not apply the
   * grammar, and callers differ in what they owe about it. What this owes is *saying so*: every
   * backend keys neurons by digits, so an edge list keyed by cell type is well-formed, loads
   * cleanly, and then matches nothing at all. That is the failure worth naming at import rather
   * than leaving somebody to find an empty Connectivity result.
   */
  nonNumericIds: number
  /** Self-edges. Kept — a neuron can synapse onto itself — and counted because it surprises. */
  selfEdges: number
}

/**
 * A growable typed array, since the edge count is not known until the file ends.
 *
 * Generic over the constructor rather than written once per element type: the growth policy is
 * the part worth keeping in one place, and the two hand-written copies this replaced had already
 * drifted — one carried a `view()` nothing ever called and the other did not.
 */
class Growable<T extends Int32Array | Float64Array> {
  private buf: T
  private readonly make: (length: number) => T
  length = 0

  constructor(make: (length: number) => T, capacity = 1024) {
    this.make = make
    this.buf = make(capacity)
  }

  push(value: number): void {
    if (this.length === this.buf.length) {
      const grown = this.make(this.buf.length * 2)
      grown.set(this.buf)
      this.buf = grown
    }
    this.buf[this.length++] = value
  }

  at(i: number): number {
    return this.buf[i]!
  }

  /** Hand the backing store back, so a large import can drop it before allocating the CSR. */
  release(): void {
    this.buf = this.make(0)
    this.length = 0
  }
}

const ints = (): Growable<Int32Array> => new Growable((n) => new Int32Array(n))
const doubles = (): Growable<Float64Array> => new Growable((n) => new Float64Array(n))

/**
 * Accumulate an edge list, then compress it.
 *
 * A builder rather than a function over an array, because the caller is streaming a file it
 * cannot hold: ten million rows as `{pre, post, weight}` objects is several gigabytes before
 * anything is encoded. Each `add` costs two Map lookups and three typed-array writes.
 */
export class EdgeSetBuilder {
  private index = new Map<string, number>()
  private ids: string[] = []
  private pre = ints()
  private post = ints()
  private weight = doubles()
  private report: EdgeReport = {
    rowsRead: 0,
    droppedWeight: 0,
    droppedId: 0,
    merged: 0,
    nonNumericIds: 0,
    selfEdges: 0,
  }

  /** Intern an id, so 140,000 distinct strings back ten million references. */
  private idIndex(raw: string): number {
    const held = this.index.get(raw)
    if (held !== undefined) return held
    const at = this.ids.length
    this.index.set(raw, at)
    this.ids.push(raw)
    if (!isNeuronId(raw)) this.report.nonNumericIds++
    return at
  }

  /**
   * Offer one row. Ids are text and are **not** parsed — see invariant 8.
   *
   * Trimmed, because a CSV field routinely arrives with a space after the comma and
   * `" 720575940628857210"` would otherwise be a second neuron indistinguishable from the first.
   */
  add(preId: string, postId: string, weight: number): void {
    this.report.rowsRead++
    const a = preId.trim()
    const b = postId.trim()
    if (a === '' || b === '') {
      this.report.droppedId++
      return
    }
    if (!Number.isFinite(weight)) {
      this.report.droppedWeight++
      return
    }
    const from = this.idIndex(a)
    const to = this.idIndex(b)
    if (from === to) this.report.selfEdges++
    this.pre.push(from)
    this.post.push(to)
    this.weight.push(weight)
  }

  /** How much has been accepted so far, for a progress readout during a long import. */
  get accepted(): number {
    return this.pre.length
  }

  /**
   * Compress into both directions.
   *
   * Peak memory is what decides the order of operations, so it is deliberate: the raw triples
   * are released the moment the source-major copy exists, and the target-major copy is built
   * from *that* rather than from the raw arrays. Built from the raw ones instead, all three
   * live at once and a ten-million-edge import needs half a gigabyte more than it has to.
   */
  finish(): EncodedEdges {
    const neurons = this.ids.length
    const out = this.build(this.pre, this.post, neurons)
    // Both raw columns are now redundant: the source-major copy holds every edge.
    this.pre.release()
    this.post.release()
    this.weight.release()
    const inward = this.fromCsr(out, neurons)
    return {
      format: EDGE_FORMAT,
      ids: this.ids,
      out,
      in: inward,
      edges: out.targets.length,
      report: { ...this.report },
    }
  }

  /**
   * Counting sort by `keys`, then sort each run by target and merge duplicate pairs.
   *
   * Weights stay `Float64` throughout, and are narrowed only once the merge is done — summing
   * duplicates in the final type is how two rows of 200 become 144 in a `Uint8Array`.
   */
  private build(
    keys: Growable<Int32Array>,
    values: Growable<Int32Array>,
    neurons: number,
  ): EdgeCsr {
    const count = keys.length
    const offsets = new Uint32Array(neurons + 1)
    for (let i = 0; i < count; i++) offsets[keys.at(i) + 1]!++
    for (let i = 0; i < neurons; i++) offsets[i + 1]! += offsets[i]!
    const cursor = Uint32Array.from(offsets.subarray(0, neurons))
    const targets = idArray(neurons, count)
    const weights = new Float64Array(count)
    for (let i = 0; i < count; i++) {
      const at = cursor[keys.at(i)]!++
      targets[at] = values.at(i)
      weights[at] = this.weight.at(i)
    }
    return this.tidy(offsets, targets, weights, neurons)
  }

  /**
   * Sort each neuron's run by target and sum duplicate pairs, compacting in place.
   *
   * The compaction is what makes `edges` a count of *ordered pairs* rather than of file rows,
   * which is what the connectivity schema means by one row per pair. Done per run rather than
   * over the whole array, so it is O(E log d) on the largest hub rather than O(E log E).
   */
  private tidy(
    offsets: Uint32Array,
    targets: IdArray,
    weights: Float64Array,
    neurons: number,
  ): EdgeCsr {
    const outOffsets = new Uint32Array(neurons + 1)

    /*
     * The run is copied out before anything is written back, and that is the whole correctness of
     * this function rather than a tidiness.
     *
     * Compaction moves entries **left**: `write` trails the read cursor and, on the first run,
     * starts exactly at it. Reading through a sort order while writing into the same array
     * therefore overwrites entries the order has not reached yet — so a neuron whose targets
     * happen to arrive out of ascending order silently loses edges and duplicates others, with
     * `merged` still reporting 0. It is a wrong connectome that throws nothing.
     *
     * One scratch pair sized to the widest run, allocated once. That also retires the per-neuron
     * boxed `Array` this used to build: 140,000 of them across a ten-million-edge import.
     */
    let widest = 0
    for (let n = 0; n < neurons; n++) widest = Math.max(widest, offsets[n + 1]! - offsets[n]!)
    const runTargets = idArray(neurons, widest)
    const runWeights = new Float64Array(widest)
    const order = new Uint32Array(widest)

    let write = 0
    for (let n = 0; n < neurons; n++) {
      const start = offsets[n]!
      const end = offsets[n + 1]!
      outOffsets[n] = write
      const length = end - start
      if (length === 0) continue

      runTargets.set(targets.subarray(start, end) as never, 0)
      runWeights.set(weights.subarray(start, end), 0)
      // Sort by target. An index sort, so the paired weight follows its target.
      const run = order.subarray(0, length)
      for (let k = 0; k < length; k++) run[k] = k
      run.sort((x, y) => runTargets[x]! - runTargets[y]!)

      // `-1` is not a neuron index, so the first entry of every run can never merge into the
      // last of the previous one.
      let last = -1
      for (let k = 0; k < length; k++) {
        const at = run[k]!
        const target = runTargets[at]!
        if (target === last) {
          weights[write - 1]! += runWeights[at]!
          this.report.merged++
          continue
        }
        targets[write] = target
        weights[write] = runWeights[at]!
        write++
        last = target
      }
    }
    outOffsets[neurons] = write
    return {
      offsets: outOffsets,
      targets: targets.slice(0, write) as IdArray,
      weights: narrowWeights(weights, write),
    }
  }

  /** The target-major copy, transposed from the source-major one. Same counting sort. */
  private fromCsr(csr: EdgeCsr, neurons: number): EdgeCsr {
    const count = csr.targets.length
    const offsets = new Uint32Array(neurons + 1)
    for (let i = 0; i < count; i++) offsets[csr.targets[i]! + 1]!++
    for (let i = 0; i < neurons; i++) offsets[i + 1]! += offsets[i]!
    const cursor = Uint32Array.from(offsets.subarray(0, neurons))
    const targets = idArray(neurons, count)
    // The same width as the source copy: the values are the same values, and a transpose that
    // re-derived the ladder could disagree with the direction it was built from.
    const weights = likeWeights(csr.weights, count)
    // Walking sources in order means each target's run comes out sorted by source already, so
    // no second sort is needed here — and the pairs are already unique after `tidy`.
    for (let source = 0; source < neurons; source++) {
      for (let i = csr.offsets[source]!; i < csr.offsets[source + 1]!; i++) {
        const at = cursor[csr.targets[i]!]!++
        targets[at] = source
        weights[at] = csr.weights[i]!
      }
    }
    return { offsets, targets, weights }
  }
}
