/**
 * Reading somebody else's OBJ.
 *
 * The test that earns this file is the face-form one. neuPrint's own datasets disagree —
 * hemibrain writes `f 1 2 3` with no normals, male-CNS and MANC write `f 1//1 2//2 3//3` — and
 * a parser that assumes the bare form reads a *normal* index as a vertex index on three
 * datasets out of four. The counts still line up, so nothing fails: it builds the right number
 * of triangles between the wrong points and the result looks like a broken renderer.
 */

import { describe, expect, it } from 'vitest'

import { objProblem, parseObj } from './obj'

/** A tetrahedron, in whichever face form the caller wants. */
function tetra(face: (a: number, b: number, c: number) => string): string {
  return [
    '# a comment',
    'v 0 0 0',
    'v 1 0 0',
    'v 0 1 0',
    'v 0 0 1',
    'vn 0 0 -1',
    'vn 0 -1 0',
    'vn -1 0 0',
    'vn 0.577 0.577 0.577',
    face(1, 2, 3),
    face(1, 2, 4),
    face(1, 3, 4),
    face(2, 3, 4),
  ].join('\n')
}

describe('parseObj', () => {
  it('reads the bare face form hemibrain writes', () => {
    const mesh = parseObj(tetra((a, b, c) => `f ${a} ${b} ${c}`))
    expect(mesh.positions).toHaveLength(12)
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3])
    expect(mesh.dropped).toBe(0)
  })

  it('reads the vertex//normal form male-CNS and MANC write', () => {
    // The whole point: the normal indices must not be mistaken for vertices.
    const mesh = parseObj(tetra((a, b, c) => `f ${a}//${a} ${b}//${b} ${c}//${c}`))
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3])
  })

  it('reads the vertex/texture/normal form too', () => {
    const mesh = parseObj(tetra((a, b, c) => `f ${a}/9/${a} ${b}/9/${b} ${c}/9/${c}`))
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3])
  })

  it('agrees across every face form, which is the property that matters', () => {
    const bare = parseObj(tetra((a, b, c) => `f ${a} ${b} ${c}`))
    const normals = parseObj(tetra((a, b, c) => `f ${a}//${a} ${b}//${b} ${c}//${c}`))
    const full = parseObj(tetra((a, b, c) => `f ${a}/1/${a} ${b}/1/${b} ${c}/1/${c}`))
    expect(Array.from(normals.indices)).toEqual(Array.from(bare.indices))
    expect(Array.from(full.indices)).toEqual(Array.from(bare.indices))
  })

  it('drops normals and texture coordinates rather than carrying them', () => {
    // Nothing shades a region mesh, and a normal per vertex doubles the memory of a 51,000
    // vertex neuropil for data nobody reads.
    const mesh = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nf 1 2 3')
    expect(mesh.positions).toHaveLength(9)
  })

  it('fans a polygon into triangles and says it did', () => {
    const quad = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4'
    const mesh = parseObj(quad)
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3])
    expect(mesh.polygons).toBe(1)
  })

  it('reads a negative index as counting back from the vertices so far', () => {
    const mesh = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1')
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2])
  })

  it('survives CRLF, which turns the last number of every line into NaN if it does not', () => {
    const mesh = parseObj('v 0 0 0\r\nv 1 0 0\r\nv 0 1 0\r\nf 1 2 3\r\n')
    expect(mesh.positions[2]).toBe(0)
    expect(mesh.positions[8]).toBe(0)
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2])
  })

  it('keeps only the first three components of a vertex line', () => {
    // Some exporters append a weight, others append vertex colours.
    const mesh = parseObj('v 1 2 3 1.0 0.5 0.25\nv 4 5 6\nv 7 8 9\nf 1 2 3')
    expect(Array.from(mesh.positions.slice(0, 3))).toEqual([1, 2, 3])
    expect(Array.from(mesh.positions.slice(3, 6))).toEqual([4, 5, 6])
  })

  it('drops a corner naming a vertex the file never declared, and counts it', () => {
    const mesh = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99')
    expect(mesh.indices).toHaveLength(0)
    expect(mesh.dropped).toBe(1)
  })

  it('ignores groups, objects and materials rather than choking on them', () => {
    const mesh = parseObj(
      [
        'mtllib thing.mtl',
        'o region',
        'g shell',
        'usemtl grey',
        's off',
        'v 0 0 0',
        'v 1 0 0',
        'v 0 1 0',
        'f 1 2 3',
      ].join('\n'),
    )
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2])
  })

  it('never throws on something that is not an OBJ at all', () => {
    // The usual failure: a login page or an error page served with a 200.
    const html = '<!doctype html><html><body>Not authorised</body></html>'
    const mesh = parseObj(html)
    expect(mesh.positions).toHaveLength(0)
    expect(mesh.indices).toHaveLength(0)
    expect(parseObj('')).toBeTruthy()
  })
})

describe('objProblem', () => {
  it('says nothing when the mesh is fine', () => {
    const mesh = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3')
    expect(objProblem(mesh, 'x', 'ME(R)')).toBeUndefined()
  })

  it('quotes what arrived, because "no vertices" alone sends nobody anywhere', () => {
    const html = '<!doctype html><html><body>Please sign in</body></html>'
    const message = objProblem(parseObj(html), html, 'The mesh for ME(R)')
    expect(message).toContain('ME(R)')
    expect(message).toContain('Please sign in')
  })

  it('distinguishes an empty response from a bad one', () => {
    expect(objProblem(parseObj(''), '', 'The mesh for LO(R)')).toContain('came back empty')
  })

  it('reports vertices without faces as its own case', () => {
    const cloud = 'v 0 0 0\nv 1 0 0\nv 0 1 0'
    expect(objProblem(parseObj(cloud), cloud, 'The mesh')).toContain('no faces')
  })
})
