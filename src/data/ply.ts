/**
 * Reading PLY — the Stanford polygon format, and the one of the three that describes itself.
 *
 * A PLY carries a text header listing its *elements* in order, each with its properties and their
 * types, and then the rows in exactly that order. So unlike OBJ and STL nothing here is guessed:
 * the header says whether the body is text or binary, which way round the bytes go, and how wide
 * every field is.
 *
 * ## The header has to be walked even for what is not read
 *
 * Only the `vertex` element's `x`/`y`/`z` and the `face` element's index list are wanted. But a
 * PLY commonly carries colours, normals, confidences and whole extra elements (`edge`,
 * `material`), and in the binary arm a field that is skipped still has to be *stepped over* by
 * its declared width. A reader that looked only for the properties it wanted would read a
 * colour byte as the start of the next vertex and produce a mesh whose every coordinate is
 * plausible and wrong. That is why the property table is built in full and the cursor is moved
 * by `widthOf` rather than by the three fields anybody cares about.
 *
 * ## Both byte orders, because the flag is free
 *
 * `DataView` takes a little-endian boolean per read, so `binary_big_endian` costs one variable
 * rather than a second reader. Big-endian files are rare and are what a few older scanners
 * produce; refusing them would be a refusal written on purpose for no saving.
 *
 * Never throws — `parseObj`'s rule. A file that is not a PLY, or one whose header ends where the
 * body should start, parses to zero vertices and the caller says so.
 */

import type { ParsedMesh } from './parsedMesh'
import { EMPTY_MESH } from './parsedMesh'

/**
 * A scalar type, as a small integer rather than a name.
 *
 * The header parses names; the *body* reads one of these twelve million times for a million-vertex
 * file, and a string union costs a dictionary lookup per width and a string `switch` per value.
 * Resolving the name once, in the header, took a 53 MB binary PLY from **343 ms to 146 ms** — and
 * the `read` closure itself from 182 ms to 43 ms, which is where nearly all of a binary parse goes.
 *
 * **`INT8` is 0, so every test for "is there a type here" must be `!== undefined`.** A falsy check
 * reads `property list char int vertex_indices` as a plain scalar and the file parses to no faces —
 * a plausible mesh rather than an error, which is the class of failure this module's header is
 * about.
 */
const INT8 = 0
const UINT8 = 1
const INT16 = 2
const UINT16 = 3
const INT32 = 4
const UINT32 = 5
const FLOAT32 = 6
const FLOAT64 = 7
type Scalar = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

interface Property {
  name: string
  /** The value's type — for a list, the type of each entry. */
  type: Scalar
  /** Present on a list property: the type of the leading count. */
  countType?: Scalar
}

interface Element {
  name: string
  count: number
  properties: Property[]
}

/** Every spelling the format allows, mapped onto the one this reads in. */
const SCALARS: Record<string, Scalar> = {
  char: INT8,
  int8: INT8,
  uchar: UINT8,
  uint8: UINT8,
  short: INT16,
  int16: INT16,
  ushort: UINT16,
  uint16: UINT16,
  int: INT32,
  int32: INT32,
  uint: UINT32,
  uint32: UINT32,
  float: FLOAT32,
  float32: FLOAT32,
  double: FLOAT64,
  float64: FLOAT64,
}

/** Indexed by `Scalar`, so a width is an array read rather than a string-keyed lookup. */
const WIDTHS = [1, 1, 2, 2, 4, 4, 4, 8]

/** Parse a PLY into flat typed arrays. */
export function parsePly(bytes: Uint8Array): ParsedMesh {
  const header = readHeader(bytes)
  if (!header) return EMPTY_MESH
  const { elements, format, bodyAt } = header
  return format === 'ascii'
    ? readAscii(new TextDecoder().decode(bytes.subarray(bodyAt)), elements)
    : readBinary(bytes, elements, bodyAt, format === 'binary_little_endian')
}

/**
 * The header, and where the body starts.
 *
 * Found by scanning the raw bytes for `end_header` rather than by decoding the whole file as
 * text: a binary PLY's body is not valid UTF-8, and `TextDecoder` replaces what it cannot read —
 * which changes the byte length and so moves the body offset, silently, only for files with
 * certain bytes in them.
 */
function readHeader(
  bytes: Uint8Array,
): { elements: Element[]; format: string; bodyAt: number } | undefined {
  const END = 'end_header'
  const limit = Math.min(bytes.byteLength, 1 << 20)
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, limit))
  if (!head.toLowerCase().startsWith('ply')) return undefined
  const at = head.indexOf(END)
  if (at === -1) return undefined

  // Past the newline that ends the `end_header` line, and past a `\r` before it. Counted in
  // *bytes*: the header is ASCII by the format's own rule, so the two counts agree here and
  // nowhere else in the file.
  let bodyAt = at + END.length
  if (head[bodyAt] === '\r') bodyAt++
  if (head[bodyAt] === '\n') bodyAt++

  const elements: Element[] = []
  let format = 'ascii'
  for (const rawLine of head.slice(0, at).split('\n')) {
    const parts = rawLine.trim().split(/\s+/)
    const keyword = parts[0]?.toLowerCase()
    if (keyword === 'format') {
      format = (parts[1] ?? 'ascii').toLowerCase()
    } else if (keyword === 'element') {
      elements.push({
        name: (parts[1] ?? '').toLowerCase(),
        count: Number(parts[2]) || 0,
        properties: [],
      })
    } else if (keyword === 'property') {
      const element = elements[elements.length - 1]
      // A property before any element is a malformed header; skipping it is what keeps this from
      // throwing, and the missing vertices are what the caller reports.
      if (!element) continue
      if (parts[1]?.toLowerCase() === 'list') {
        const countType = SCALARS[parts[2]?.toLowerCase() ?? '']
        const type = SCALARS[parts[3]?.toLowerCase() ?? '']
        // `!== undefined`, not truthiness: `INT8` is 0. See `Scalar`.
        if (countType !== undefined && type !== undefined) {
          element.properties.push({ name: (parts[4] ?? '').toLowerCase(), type, countType })
        }
      } else {
        const type = SCALARS[parts[1]?.toLowerCase() ?? '']
        if (type !== undefined)
          element.properties.push({ name: (parts[2] ?? '').toLowerCase(), type })
      }
    }
  }
  return { elements, format, bodyAt }
}

/**
 * Walk the elements in header order, reading each row through `read`.
 *
 * **One walk, not one per encoding.** The ASCII and binary arms differ in exactly two things —
 * how a scalar is obtained, and whether running off the end of the buffer ends the walk — so they
 * were written twice and had to agree about the x/y/z scan, the list arm, the fan and the exit.
 * They are a reader function and a predicate now, which is also what makes the module note above
 * about stepping over unread properties describe one loop rather than two.
 *
 * `positions` is allocated from the header's own vertex count rather than grown: a `number[]`
 * holds float32 values as 8-byte doubles, reallocates as it grows, and then `Float32Array.from`
 * allocates the result beside it — measured at 17 ms and ~96 MB for a million vertices against
 * 3 ms and 12 MB for the typed array. Face indices *are* grown, because a polygon fans into an
 * unknown number of triangles.
 */
function readRows(
  elements: Element[],
  read: (type: Scalar) => number,
  exhausted: () => boolean = () => false,
): ParsedMesh {
  const declared = elements.find((element) => element.name === 'vertex')?.count ?? 0
  const positions = new Float32Array(declared * 3)
  /*
   * Sized from the header's face count too. It said it could not be — "a polygon fans into an
   * unknown number of triangles" — but three per face is exact for the triangle-only files every
   * exporter writes, and a fan only ever needs *more*, which `push` covers. Measured at 94 ms and
   * 26 MB against 133 ms and 80 MB for a growable `number[]` over two million faces.
   */
  const faces = elements.find((element) => element.name === 'face')?.count ?? 0
  let indices = new Uint32Array(faces * 3)
  let written = 0
  /**
   * Grown only by a **fan**, which is the one thing the header cannot predict: it declares how
   * many face *rows* there are and the row loop reads exactly that many, but a quadrilateral row
   * is two triangles and nothing short of reading the body twice knows how many there will be.
   * The common path — a triangle mesh — never reaches the branch.
   */
  const push = (a: number, b: number, c: number): void => {
    if (written + 3 > indices.length) {
      const wider = new Uint32Array(Math.max(indices.length * 2, written + 3))
      wider.set(indices)
      indices = wider
    }
    indices[written] = a
    indices[written + 1] = b
    indices[written + 2] = c
    written += 3
  }
  let vertices = 0
  let polygons = 0
  let dropped = 0

  /**
   * Fan a face's corners into triangles.
   *
   * `parseObj`'s rule and the same fan: correct for any convex face, wrong only for a
   * self-overlapping polygon no exporter emits. A fresh array per face rather than one scratch
   * reused across them — measured at 73 ms against 203 ms for three million rows, `length = 0`
   * reuse being the slower of the two in V8.
   */
  const pushFace = (corners: number[]): void => {
    const valid: number[] = []
    for (const corner of corners) {
      if (Number.isFinite(corner) && corner >= 0 && corner < vertices) valid.push(corner)
      else dropped++
    }
    if (valid.length < 3) return
    if (valid.length > 3) polygons++
    for (let i = 1; i + 1 < valid.length; i++) {
      push(valid[0]!, valid[i]!, valid[i + 1]!)
    }
  }

  for (const element of elements) {
    /*
     * Hoisted out of the inner loop, where they were one string comparison **per property per
     * row** — a million-vertex file with normals and colours asks the same constant question
     * twelve million times. A pure loop-invariant lift, and it is worth 25–29% of the whole
     * binary parse: 237 ms to 174 on a 53 MB file. Decomposed against the alternatives, this is
     * the entire win — avoiding the per-row `corners` allocation contributes nothing (V8 scalar-
     * replaces it) and resolving property names to slots up front is a pessimisation.
     */
    const isVertex = element.name === 'vertex'
    const isFace = element.name === 'face'
    for (let row = 0; row < element.count; row++) {
      if (exhausted()) break
      let x = 0
      let y = 0
      let z = 0
      const corners: number[] = []
      for (const property of element.properties) {
        // `!== undefined`, not truthiness: `INT8` is 0. See `Scalar`.
        if (property.countType !== undefined) {
          const n = read(property.countType)
          for (let i = 0; i < n; i++) {
            const value = read(property.type)
            if (isFace && corners.length < n) corners.push(value)
          }
          continue
        }
        const value = read(property.type)
        if (!isVertex) continue
        if (property.name === 'x') x = value
        else if (property.name === 'y') y = value
        else if (property.name === 'z') z = value
      }
      if (isVertex) {
        // The guard is against a header with **two** `element vertex` lines, whose rows would
        // otherwise run past the allocation the first one sized. A single well-formed header
        // cannot reach it: the row loop reads exactly the count it declared.
        if (vertices < declared) {
          positions[vertices * 3] = x
          positions[vertices * 3 + 1] = y
          positions[vertices * 3 + 2] = z
          vertices++
        }
      } else if (isFace) pushFace(corners)
    }
  }

  /*
   * A file with vertices and no faces keeps its vertices — `parseObj`'s rule, and here it is the
   * ordinary state of a point cloud rather than a symptom, which is what `meshFileProblem` says.
   * Sliced when the body ran out early, so the tail is not a block of zeroes at the origin.
   */
  if (vertices === 0) return { ...EMPTY_MESH, polygons, dropped }
  return {
    /*
     * `slice`, not `subarray` — a view keeps its whole backing buffer alive, and the structured
     * clone IndexedDB stores serialises the entire buffer rather than the view's range. See
     * `stl.ts`' `weld`, where the ratio is 6:1; here it only fires on a truncated file, but it is
     * the same trap and the same one word.
     */
    positions: vertices * 3 === positions.length ? positions : positions.slice(0, vertices * 3),
    indices: written === indices.length ? indices : indices.slice(0, written),
    polygons,
    dropped,
  }
}

/**
 * The ASCII body, scanned in place.
 *
 * **Not `body.split(/\s+/)`**, which materialises every token in the file and holds them all for
 * the length of the parse: measured at 456 ms and **+512 MB of retained heap** for an 81 MB body,
 * on top of the decoded string it was split from — so an ASCII PLY anywhere near the upload
 * ceiling will not fit in a tab. An index scanner costs the same time (both arms are dominated by
 * `Number`) and retains nothing. It is still a token stream rather than a line reader, which is
 * what the format needs: a row may be broken across lines, and several exporters break a long
 * face list.
 */
function readAscii(body: string, elements: Element[]): ParsedMesh {
  let at = 0
  const next = (): number => {
    while (at < body.length && body.charCodeAt(at) <= 32) at++
    const start = at
    while (at < body.length && body.charCodeAt(at) > 32) at++
    return start === at ? NaN : Number(body.slice(start, at))
  }
  return readRows(elements, next)
}

function readBinary(
  bytes: Uint8Array,
  elements: Element[],
  bodyAt: number,
  littleEndian: boolean,
): ParsedMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = bodyAt

  const read = (type: Scalar): number => {
    const width = WIDTHS[type]!
    // Past the end is a truncated file: answer 0 and let the row counts run out, rather than
    // letting `DataView` throw through a parser whose contract is that it does not.
    if (at + width > bytes.byteLength) {
      at += width
      return 0
    }
    const value = scalarAt(view, at, type, littleEndian)
    at += width
    return value
  }

  return readRows(elements, read, () => at >= bytes.byteLength)
}

function scalarAt(view: DataView, at: number, type: Scalar, littleEndian: boolean): number {
  switch (type) {
    case INT8:
      return view.getInt8(at)
    case UINT8:
      return view.getUint8(at)
    case INT16:
      return view.getInt16(at, littleEndian)
    case UINT16:
      return view.getUint16(at, littleEndian)
    case INT32:
      return view.getInt32(at, littleEndian)
    case UINT32:
      return view.getUint32(at, littleEndian)
    case FLOAT32:
      return view.getFloat32(at, littleEndian)
    default:
      return view.getFloat64(at, littleEndian)
  }
}
