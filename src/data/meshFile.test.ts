/**
 * The three mesh readers, held against one shape.
 *
 * The property that earns this file is **agreement**: the same icosphere written five ways —
 * OBJ, ASCII and binary STL, ASCII and binary PLY — has to come back as the same 42 vertices and
 * 80 triangles, because a reader can be wrong in a way that still produces a plausible mesh.
 *
 * The shape is built here rather than checked in, so the encodings are provably one mesh: five
 * recorded files would let four of them drift from the fifth. The numbers they are held to are
 * **not this parser's own output recorded back** — `trimesh.creation.icosphere(subdivisions=1,
 * radius=1000)` is 42 vertices and 80 faces, and every reader was additionally run against real
 * files that library wrote in all five encodings, which is what says the hand-built ones are
 * shaped like the files people will actually pick.
 *
 * Two of the cases are traps rather than formats:
 *
 *  - **A binary STL whose header begins with `solid`.** Several exporters write a name there, so
 *    the prefix every "is this ASCII" test reaches for is worthless. Read as ASCII the file has
 *    no `vertex` lines in it and comes back empty, which reads as corruption.
 *  - **A PLY carrying normals and colours between the coordinates.** A reader that looked for
 *    `x`/`y`/`z` and stepped by twelve bytes would read a colour byte as the next vertex's x,
 *    and every coordinate after the first would be plausible and wrong.
 */

import { describe, expect, it } from 'vitest'

import { MESH_FILE_EXTENSIONS, meshFileProblem, parseMeshFile } from './meshFile'
import { isBinaryStl, parseStl } from './stl'
import { parsePly } from './ply'

const VERTICES = 42
const TRIANGLES = 80
const RADIUS = 1000

/** An icosphere at `subdivisions=1`, as an OBJ — the form the other builders start from. */
function sphere(): { positions: number[][]; faces: number[][] } {
  // Built here rather than checked in, so the five encodings below are provably one shape: a
  // recorded file per format would let four of them drift from the fifth.
  const t = (1 + Math.sqrt(5)) / 2
  const base = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ]
  const faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ]

  // One subdivision: every edge gains a midpoint, so 12 → 42 vertices and 20 → 80 faces.
  const positions = base.map((v) => norm(v))
  const middles = new Map<string, number>()
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? `${a},${b}` : `${b},${a}`
    const held = middles.get(key)
    if (held !== undefined) return held
    const p = positions[a]!
    const q = positions[b]!
    positions.push(norm([p[0]! + q[0]!, p[1]! + q[1]!, p[2]! + q[2]!]))
    middles.set(key, positions.length - 1)
    return positions.length - 1
  }
  const out: number[][] = []
  for (const [a, b, c] of faces) {
    const ab = midpoint(a!, b!)
    const bc = midpoint(b!, c!)
    const ca = midpoint(c!, a!)
    out.push([a!, ab, ca], [b!, bc, ab], [c!, ca, bc], [ab, bc, ca])
  }
  return { positions, faces: out }
}

function norm(v: number[]): number[] {
  const length = Math.hypot(v[0]!, v[1]!, v[2]!)
  return [(v[0]! / length) * RADIUS, (v[1]! / length) * RADIUS, (v[2]! / length) * RADIUS]
}

const SHAPE = sphere()

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function objFile(): Uint8Array {
  const lines = ['# an icosphere', 'o sphere']
  for (const v of SHAPE.positions) lines.push(`v ${v[0]} ${v[1]} ${v[2]}`)
  for (const f of SHAPE.faces) lines.push(`f ${f[0]! + 1} ${f[1]! + 1} ${f[2]! + 1}`)
  return bytes(`${lines.join('\n')}\n`)
}

function asciiStl(): Uint8Array {
  const lines = ['solid sphere']
  for (const f of SHAPE.faces) {
    lines.push('facet normal 0 0 0', '  outer loop')
    for (const i of f) {
      const v = SHAPE.positions[i]!
      lines.push(`    vertex ${v[0]} ${v[1]} ${v[2]}`)
    }
    lines.push('  endloop', 'endfacet')
  }
  lines.push('endsolid sphere')
  return bytes(`${lines.join('\n')}\n`)
}

/** `header` is the 80 bytes an exporter is free to fill — the trap, when it says `solid`. */
function binaryStl(header: string): Uint8Array {
  const out = new Uint8Array(84 + SHAPE.faces.length * 50)
  out.set(bytes(header.padEnd(80, '\0')).subarray(0, 80), 0)
  const view = new DataView(out.buffer)
  view.setUint32(80, SHAPE.faces.length, true)
  SHAPE.faces.forEach((f, n) => {
    let at = 84 + n * 50 + 12
    for (const i of f) {
      for (const value of SHAPE.positions[i]!) {
        view.setFloat32(at, value, true)
        at += 4
      }
    }
  })
  return out
}

function asciiPly(extras: boolean): Uint8Array {
  const lines = [
    'ply',
    'format ascii 1.0',
    'comment written by a test',
    `element vertex ${SHAPE.positions.length}`,
    'property float x',
    'property float y',
    'property float z',
    ...(extras
      ? ['property float nx', 'property float ny', 'property float nz', 'property uchar red']
      : []),
    `element face ${SHAPE.faces.length}`,
    'property list uchar int vertex_indices',
    'end_header',
  ]
  for (const v of SHAPE.positions) {
    lines.push(extras ? `${v[0]} ${v[1]} ${v[2]} 0 1 0 200` : `${v[0]} ${v[1]} ${v[2]}`)
  }
  for (const f of SHAPE.faces) lines.push(`3 ${f[0]} ${f[1]} ${f[2]}`)
  return bytes(`${lines.join('\n')}\n`)
}

/** `extras` interleaves a normal and a colour byte, which is what the width-stepping is for. */
function binaryPly(extras: boolean, littleEndian: boolean): Uint8Array {
  const header = bytes(
    [
      'ply',
      `format ${littleEndian ? 'binary_little_endian' : 'binary_big_endian'} 1.0`,
      `element vertex ${SHAPE.positions.length}`,
      'property float x',
      'property float y',
      'property float z',
      ...(extras ? ['property float nx', 'property uchar red'] : []),
      `element face ${SHAPE.faces.length}`,
      'property list uchar int vertex_indices',
      'end_header\n',
    ].join('\n'),
  )
  const vertexWidth = extras ? 12 + 4 + 1 : 12
  const out = new Uint8Array(
    header.length + SHAPE.positions.length * vertexWidth + SHAPE.faces.length * 13,
  )
  out.set(header, 0)
  const view = new DataView(out.buffer)
  let at = header.length
  for (const v of SHAPE.positions) {
    for (const value of v) {
      view.setFloat32(at, value, littleEndian)
      at += 4
    }
    if (extras) {
      view.setFloat32(at, 1, littleEndian)
      at += 4
      view.setUint8(at, 200)
      at += 1
    }
  }
  for (const f of SHAPE.faces) {
    view.setUint8(at, 3)
    at += 1
    for (const i of f) {
      view.setInt32(at, i, littleEndian)
      at += 4
    }
  }
  return out
}

const FILES: Array<[string, Uint8Array]> = [
  ['sphere.obj', objFile()],
  ['sphere.stl', asciiStl()],
  ['sphere-binary.stl', binaryStl('written by a test')],
  ['sphere-trap.stl', binaryStl('solid sphere exported by something')],
  ['sphere.ply', asciiPly(false)],
  ['sphere-extras.ply', asciiPly(true)],
  ['sphere-binary.ply', binaryPly(false, true)],
  ['sphere-extras-binary.ply', binaryPly(true, true)],
  ['sphere-bigendian.ply', binaryPly(false, false)],
]

/** The largest coordinate, which is the radius for a sphere centred on the origin. */
function extent(positions: Float32Array): number {
  let max = 0
  for (const value of positions) max = Math.max(max, Math.abs(value))
  return max
}

describe('reading a mesh file', () => {
  it.each(FILES)('reads %s as the same 42 vertices and 80 triangles', (name, file) => {
    const mesh = parseMeshFile(name, file)
    expect(mesh.positions.length / 3).toBe(VERTICES)
    expect(mesh.indices.length / 3).toBe(TRIANGLES)
    expect(mesh.dropped).toBe(0)
    // And in the file's own numbers, so nothing here silently rescales.
    expect(extent(mesh.positions)).toBeCloseTo(RADIUS, 1)
    // Every index addresses a vertex that exists — the failure a wrong stride produces without
    // changing a single count.
    for (const index of mesh.indices) expect(index).toBeLessThan(VERTICES)
  })

  it.each(FILES)('reaches the same reader for %s with no extension to go on', (_name, file) => {
    // A file dragged out of an archive, or named `.mesh`. The sniff has to agree with the
    // extension, or one file is two meshes depending on what it was called.
    const named = parseMeshFile(_name, file)
    const sniffed = parseMeshFile('mystery.dat', file)
    expect(sniffed.positions).toEqual(named.positions)
    expect(sniffed.indices).toEqual(named.indices)
  })

  it('does not read a binary STL as ASCII because its header says "solid"', () => {
    // The whole reason `isBinaryStl` is arithmetic. Asked of the predicate directly as well,
    // because the counts above would also pass if the sniff were wrong and the reader forgiving.
    const trap = binaryStl('solid sphere exported by something')
    expect(isBinaryStl(trap)).toBe(true)
    expect(parseStl(trap).positions.length / 3).toBe(VERTICES)
    expect(isBinaryStl(asciiStl())).toBe(false)
  })

  it('still merges negative zero with positive zero, as the text key did', () => {
    /*
     * The one case where the bit key is *stricter* than the string key it replaced: `String(-0)`
     * is `"0"`, so the old form merged the two and a bare bit comparison would not. An exporter
     * writing `-0` on a face that meets the origin would then get a duplicate vertex and a seam.
     */
    const two = [
      'solid s',
      'facet normal 0 0 0',
      ' outer loop',
      '  vertex -0 0 0',
      '  vertex 1 0 0',
      '  vertex 0 1 0',
      ' endloop',
      'endfacet',
      'facet normal 0 0 0',
      ' outer loop',
      '  vertex 0 0 0',
      '  vertex 1 0 0',
      '  vertex 0 1 0',
      ' endloop',
      'endfacet',
      'endsolid s',
    ].join('\n')
    const mesh = parseStl(bytes(two))
    expect(mesh.positions.length / 3).toBe(3)
    expect(mesh.indices.length / 3).toBe(2)
  })

  it('welds an STL back to shared corners, so the shading is not faceted', () => {
    // STL writes every triangle's three corners separately: 240 corners for this shape. Left
    // unwelded the viewer's `computeVertexNormals` shades each face flat, which is visible and
    // reads as a bad export.
    const mesh = parseStl(asciiStl())
    expect(mesh.positions.length / 3).toBe(VERTICES)
    expect(mesh.indices.length).toBe(TRIANGLES * 3)
  })

  it('steps over a PLY property it does not read, rather than through it', () => {
    // Normals and a colour byte between the coordinates. A reader stepping by twelve bytes
    // regardless returns exactly as many vertices, all of them wrong.
    const plain = parsePly(asciiPly(false))
    const extras = parsePly(asciiPly(true))
    expect(extras.positions).toEqual(plain.positions)
    expect(parsePly(binaryPly(true, true)).positions.length / 3).toBe(VERTICES)
  })

  it('reads a big-endian PLY as the same shape as a little-endian one', () => {
    expect(parsePly(binaryPly(false, false)).positions).toEqual(
      parsePly(binaryPly(false, true)).positions,
    )
  })

  it('fans a quadrilateral face and says it did', () => {
    const file = bytes(
      [
        'ply',
        'format ascii 1.0',
        'element vertex 4',
        'property float x',
        'property float y',
        'property float z',
        'element face 1',
        'property list uchar int vertex_indices',
        'end_header',
        '0 0 0',
        '1 0 0',
        '1 1 0',
        '0 1 0',
        '4 0 1 2 3',
      ].join('\n'),
    )
    const mesh = parsePly(file)
    expect(mesh.indices.length / 3).toBe(2)
    expect(mesh.polygons).toBe(1)
  })

  it('reads a list whose count type is `char`, which numbers as zero', () => {
    /*
     * `Scalar` is a small integer so the body's reads are not string-keyed, and `int8` is 0 — so
     * every "is there a type here" test has to ask `!== undefined`. Written as truthiness, this
     * header's face list reads as a plain scalar and the file parses to no faces at all: a
     * plausible mesh rather than an error.
     */
    const file = bytes(
      [
        'ply',
        'format ascii 1.0',
        'element vertex 3',
        'property float x',
        'property float y',
        'property float z',
        'element face 1',
        'property list char int vertex_indices',
        'end_header',
        '0 0 0',
        '1 0 0',
        '1 1 0',
        '3 0 1 2',
      ].join('\n'),
    )
    const mesh = parsePly(file)
    expect(mesh.positions.length / 3).toBe(3)
    expect(mesh.indices.length / 3).toBe(1)
  })

  it('drops a PLY corner naming a vertex the file never declared, and counts it', () => {
    const file = bytes(
      [
        'ply',
        'format ascii 1.0',
        'element vertex 3',
        'property float x',
        'property float y',
        'property float z',
        'element face 2',
        'property list uchar int vertex_indices',
        'end_header',
        '0 0 0',
        '1 0 0',
        '1 1 0',
        '3 0 1 2',
        '3 0 1 9',
      ].join('\n'),
    )
    const mesh = parsePly(file)
    expect(mesh.indices.length / 3).toBe(1)
    expect(mesh.dropped).toBe(1)
  })

  it('never throws on bytes that are not a mesh at all', () => {
    // `parseObj`'s rule, kept for all three: the caller words the refusal, because only it knows
    // what was being asked for.
    for (const junk of ['<html><body>404</body></html>', '', 'ply\nnot a header']) {
      expect(() => parseMeshFile('whatever.obj', bytes(junk))).not.toThrow()
      expect(() => parseMeshFile('whatever.ply', bytes(junk))).not.toThrow()
      expect(() => parseMeshFile('whatever.stl', bytes(junk))).not.toThrow()
    }
  })

  it('tells a point cloud from a wrong file, which are different mistakes', () => {
    const cloud = bytes(
      [
        'ply',
        'format ascii 1.0',
        'element vertex 2',
        'property float x',
        'property float y',
        'property float z',
        'end_header',
        '0 0 0',
        '1 1 1',
      ].join('\n'),
    )
    expect(meshFileProblem(parseMeshFile('cloud.ply', cloud), 'cloud.ply')).toMatch(
      /point cloud/,
    )
    expect(meshFileProblem(parseMeshFile('x.obj', bytes('nonsense')), 'x.obj')).toMatch(
      /no vertices/,
    )
    expect(
      meshFileProblem(parseMeshFile('sphere.obj', objFile()), 'sphere.obj'),
    ).toBeUndefined()
  })

  it('offers the three extensions a file picker can match on', () => {
    // `accept` matches extensions: none of the three has a registered media type, and a browser
    // handed one it does not know hides every file in the dialog.
    expect([...MESH_FILE_EXTENSIONS]).toEqual(['.obj', '.stl', '.ply'])
  })
})
