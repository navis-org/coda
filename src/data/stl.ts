/**
 * Reading STL — the format a segmentation editor or a CAD tool writes by default.
 *
 * Two dialects under one extension and, unusually, **no reliable marker separating them**. An
 * ASCII file starts `solid <name>`; a binary file starts with 80 bytes of free text that several
 * exporters fill with the word `solid` and a name. So the dialect is decided by arithmetic —
 * `isBinaryStl`, shared with the sniff in `meshFile.ts` — and never by the prefix. Getting that
 * backwards does not fail: the ASCII reader finds no `vertex` lines in binary bytes and reports
 * an empty mesh, which reads as a corrupt file.
 *
 * ## Every triangle carries its own three corners, and that is why this welds
 *
 * STL has no index list. A closed shell is written as N independent triangles, so a shape an OBJ
 * stores in V vertices arrives here as 3N — six times as many for a typical closed surface. Left
 * alone that costs the memory, and it costs the *picture*: the viewer calls
 * `computeVertexNormals`, which on unshared corners produces flat shading, so an uploaded STL
 * neuropil renders visibly faceted beside an OBJ of the same shape. So corners at identical
 * coordinates are merged on read.
 *
 * The merge is **exact**, on the float32 values as written, never on a tolerance: a tolerance is
 * a decimation, and this is somebody's own data rather than a display surface a server published.
 * Two corners a hair apart stay two corners, which is the honest answer and the one a file
 * written by a single exporter never actually needs — STL's whole redundancy is byte-identical
 * repeats of one vertex.
 *
 * Paid once, at upload, because `Upload Mesh` stores what this returns.
 *
 * ## What is dropped
 *
 * The per-facet normal and the two-byte attribute word. Nothing here shades from a file's own
 * normals, and the attribute word is a colour convention no two exporters agree on.
 */

import type { ParsedMesh } from './parsedMesh'
import { EMPTY_MESH } from './parsedMesh'

/**
 * Whether these bytes are a binary STL, by the only test that works.
 *
 * 80 bytes of free-text header, a `uint32` triangle count, then exactly 50 bytes per triangle —
 * twelve floats and a two-byte attribute word. A file whose length is that number to the byte is
 * a binary STL and nothing else plausibly is. Exported because `meshFile.ts`'s sniff asks the
 * same question, and two spellings of one arithmetic is how a sniff and a parse come to disagree
 * about one file.
 */
export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 84) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const triangles = view.getUint32(80, true)
  return 84 + triangles * 50 === bytes.byteLength
}

/**
 * Parse an STL into flat typed arrays. Never throws — see `parseObj`'s note, whose rule this is.
 */
export function parseStl(bytes: Uint8Array): ParsedMesh {
  if (bytes.byteLength === 0) return EMPTY_MESH
  const corners = isBinaryStl(bytes) ? binaryCorners(bytes) : asciiCorners(bytes)
  return weld(corners)
}

/**
 * Every triangle corner in order, as xyz triples — the shape both dialects reduce to.
 *
 * The binary arm allocates from the header's own triangle count. It said it could not, which was
 * true of the *ASCII* dialect and never of this one — and this is the arm the large files come
 * down: measured at 21 ms and 148 MB of heap as a `number[]` against 8 ms and 57 MB as a typed
 * array for half a million triangles, because a `number[]` holds float32 values as 8-byte doubles,
 * reallocates as it grows, and is then copied into the result beside itself. `weld` takes an
 * `ArrayLike<number>` so the ASCII arm keeps its growable array and nothing else branches.
 */
function binaryCorners(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const triangles = view.getUint32(80, true)
  const out = new Float32Array(triangles * 9)
  for (let t = 0; t < triangles; t++) {
    // 80 header + 4 count, then per triangle: 3 floats of normal, 9 of position, 2 attribute
    // bytes. The normal is skipped rather than read and discarded.
    const at = 84 + t * 50 + 12
    for (let c = 0; c < 9; c++) out[t * 9 + c] = view.getFloat32(at + c * 4, true)
  }
  return out
}

function asciiCorners(bytes: Uint8Array): number[] {
  const out: number[] = []
  for (const rawLine of new TextDecoder().decode(bytes).split('\n')) {
    // `\r` survives a file written on Windows and turns the last number of every line into NaN.
    const line = rawLine.trim()
    // `vertex` and not `v`: `facet normal` also carries three numbers, and an exporter that
    // writes `outer loop` on the same line as the first vertex does not exist.
    if (!line.startsWith('vertex ') && !line.startsWith('VERTEX ')) continue
    const parts = line.slice(7).trim().split(/\s+/)
    out.push(Number(parts[0]), Number(parts[1]), Number(parts[2]))
  }
  // A trailing partial triangle is a truncated file; keeping it would index past the positions.
  out.length -= out.length % 9
  return out
}

/**
 * Merge corners that are the same point, and build the index list.
 *
 * **Keyed on the float32 bits, not on their text.** A template-literal key is the obvious form and
 * it is what this cost: building and hashing one string per corner measured at 610 ms and +262 MB
 * of heap for a 25 MB binary STL — half the warn threshold — against a tenth of that here, so
 * roughly six times the time and twenty times the transient memory, which at the 200 MB ceiling is
 * the difference between a freeze somebody was warned about and a tab that dies.
 *
 * The three coordinates are written into a scratch `Float32Array` and read back as int32s, which
 * is an *exact* identity on the values as written — and the comparison stays on those words rather
 * than on the floats, which is not fussiness: `-0` and `NaN` are the two values where bitwise and
 * `===` disagree, `String(-0)` was `"0"` so the text key merged the zeroes, and `String(NaN)` was
 * `"NaN"` so it merged those too. `+ 0` normalises the first (`-0 + 0` is `0`) and the int32
 * compare keeps the second, so a garbage ASCII file still collapses rather than minting a vertex
 * per corner.
 *
 * **An open-addressed table rather than a `Map` of buckets**: 89 ms against 215 ms on 4.85 M
 * corners, and no per-vertex array. Two things about it are load-bearing and both were measured
 * wrong first. The raw FNV hash must go through a **finalizer** before it is masked — FNV-1a's low
 * bits barely avalanche and `& mask` takes exactly those, which is 5–12× *slower* than the `Map`
 * (2,664 ms at load 0.125) rather than faster. And the table is sized past `2n`, so a mesh with no
 * shared corners at all cannot fill it and spin the probe loop forever.
 */
function weld(corners: ArrayLike<number>): ParsedMesh {
  if (corners.length < 9) return EMPTY_MESH
  const positions = new Float32Array(corners.length)
  const indices = new Uint32Array(corners.length / 3)
  /*
   * The output array read as int32s, which is the whole of the bit trick: a *store* into
   * `positions` rounds to float32, and the matching read out of `kept` is that value's bits. The
   * candidate is written into the slot it would occupy if it turns out to be new — always in
   * range, since `positions` is sized for every corner — so there is no scratch cell to copy out
   * of and the rounding happens exactly once.
   */
  const kept = new Int32Array(positions.buffer)

  /*
   * A doubling table rather than one sized from the corner count. STL's whole redundancy is that
   * corners weld — about 6:1 on a closed shell — so `2 × corners` sizes for a mesh that cannot
   * exist: at the 200 MB ceiling that is a **134 MB** `Int32Array` beside a 144 MB `positions` and
   * a 144 MB `corners`, where the mesh welds into a 17 MB table. Free at that size (656 ms against
   * 659 ms), 29% faster at a million triangles because the small table stays in cache, and 16%
   * slower only on a file with no shared corners at all — which is not a file a mesher produces.
   *
   * Growing at half full keeps the documented invariant by construction: the table can never fill,
   * so the probe below always terminates.
   */
  let capacity = 1024
  let mask = capacity - 1
  let table = new Int32Array(capacity)
  let vertices = 0

  /** Where a corner's three words hash to, for the table as it stands. */
  const slotFor = (base: number): number => {
    // FNV-1a's step over the three words, then murmur3's finalizer to spread the low bits the
    // mask is about to take.
    let hash = 0x811c9dc5
    for (let w = 0; w < 3; w++) hash = Math.imul(hash ^ kept[base + w]!, 0x01000193)
    hash ^= hash >>> 16
    hash = Math.imul(hash, 0x85ebca6b)
    hash ^= hash >>> 13
    hash = Math.imul(hash, 0xc2b2ae35)
    hash ^= hash >>> 16
    return hash & mask
  }

  for (let i = 0; i < corners.length; i += 3) {
    const base = vertices * 3
    // `+ 0` normalises `-0` away, which is what keeps this merging the zeroes the text key merged.
    positions[base] = corners[i]! + 0
    positions[base + 1] = corners[i + 1]! + 0
    positions[base + 2] = corners[i + 2]! + 0

    let slot = slotFor(base)
    let at = -1
    for (;;) {
      const held = table[slot]!
      if (held === 0) break
      const n = (held - 1) * 3
      if (
        kept[n] === kept[base] &&
        kept[n + 1] === kept[base + 1] &&
        kept[n + 2] === kept[base + 2]
      ) {
        at = held - 1
        break
      }
      slot = (slot + 1) & mask
    }
    if (at === -1) {
      at = vertices++
      table[slot] = at + 1
      if (vertices >= capacity >> 1) {
        capacity <<= 1
        mask = capacity - 1
        table = new Int32Array(capacity)
        for (let v = 0; v < vertices; v++) {
          let re = slotFor(v * 3)
          while (table[re] !== 0) re = (re + 1) & mask
          table[re] = v + 1
        }
      }
    }
    indices[i / 3] = at
  }

  return {
    /*
     * `slice`, not `subarray`. A view keeps its whole backing buffer alive *and* the structured
     * clone IndexedDB stores serialises the entire buffer rather than the view's range — so a
     * shell welded 6:1 wrote and re-read six times its own size for the life of the upload, on
     * disk. Measured at 17.9 MB held and written where 3.0 MB was needed; the copy costs 0.2 ms.
     */
    positions: positions.slice(0, vertices * 3),
    indices,
    // An STL is triangles by construction, and a corner it names is one it carries — so neither
    // counter can ever be anything but zero here. Reported anyway, because the field belongs to
    // `ParsedMesh` and a caller reading it should not have to know which reader answered.

    polygons: 0,
    dropped: 0,
  }
}
