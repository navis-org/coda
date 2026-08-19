/**
 * Writing a value out as files.
 *
 * The two morphology formats are where this earns its tests, because both have a failure mode
 * that produces a *valid file that is wrong*:
 *
 *  - **SWC ids are 1-based and a root's parent is `-1`.** Coda stores parents as array indices,
 *    so every one has to shift. A 0-based file parses without complaint in every tool and hangs
 *    the first point off nothing.
 *  - **OBJ face indices are 1-based.** A 0-based file loads with one corrupt triangle and a
 *    vertex at the origin, which reads as a rendering artefact rather than a bad export.
 *
 * And one that produces a file nobody can open: `JSON.stringify` renders a `Float32Array` as an
 * object keyed by index, which is valid JSON, several times larger, and understood by nothing.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../core/types'
import type { MeshesValue, NetworkValue, PointsValue, SkeletonsValue } from '../core/values'
import { EMPTY_BOUNDS, makeMatrix, tableFromRows } from '../core/values'
import {
  MAX_MORPHOLOGY_FILES,
  defaultFormat,
  meshToObj,
  planExport,
  skeletonToSwc,
  valueToJson,
} from './exportValue'

const NEURONS = tableSchema(column('bodyId', 'i64'), column('type', 'str'))
const table = () =>
  tableFromRows(NEURONS, [
    { bodyId: 1, type: 'LC4' },
    { bodyId: 2, type: 'LC6' },
  ])

/** A three-point skeleton: a root and two children, the second hanging off the first child. */
function skeleton(bodyId = 101) {
  return {
    bodyId,
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 20, 5, 0]),
    radii: new Float32Array([3, 2, 1]),
    parents: new Int32Array([-1, 0, 1]),
  }
}

function skeletons(count = 1): SkeletonsValue {
  const items = Array.from({ length: count }, (_, i) => skeleton(100 + i))
  return {
    kind: 'skeletons',
    items,
    attributes: tableFromRows(tableSchema(column('bodyId', 'i64')), items.map((s) => ({ bodyId: s.bodyId }))),
    bounds: EMPTY_BOUNDS,
  }
}

function meshes(count = 1): MeshesValue {
  const items = Array.from({ length: count }, (_, i) => ({
    bodyId: 200 + i,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  }))
  return {
    kind: 'meshes',
    items,
    attributes: tableFromRows(tableSchema(column('bodyId', 'i64')), items.map((m) => ({ bodyId: m.bodyId }))),
    bounds: EMPTY_BOUNDS,
  }
}

describe('SWC', () => {
  it('writes one line per point, in the format’s fixed column order', () => {
    const lines = skeletonToSwc(skeleton()).trim().split('\n')
    const rows = lines.filter((l) => !l.startsWith('#'))
    expect(rows).toHaveLength(3)
    // id type x y z radius parent
    expect(rows[0]).toBe('1 0 0 0 0 3 -1')
    expect(rows[1]).toBe('2 0 10 0 0 2 1')
    expect(rows[2]).toBe('3 0 20 5 0 1 2')
  })

  it('shifts every id and parent to 1-based, keeping a root at -1', () => {
    const rows = skeletonToSwc(skeleton()).trim().split('\n').filter((l) => !l.startsWith('#'))
    const parents = rows.map((r) => Number(r.split(' ')[6]))
    // Coda's parents are [-1, 0, 1] — array indices. Written unshifted, point 2 would claim a
    // parent of 0, which no SWC reader accepts and several silently reparent to nothing.
    expect(parents).toEqual([-1, 1, 2])
    expect(rows.map((r) => Number(r.split(' ')[0]))).toEqual([1, 2, 3])
  })

  it('says what the numbers mean, since the format itself does not', () => {
    const header = skeletonToSwc(skeleton()).split('\n').filter((l) => l.startsWith('#'))
    expect(header.join(' ')).toContain('nanometres')
    expect(header.join(' ')).toContain('101')
  })

  it('writes the structure identifier as 0 rather than guessing one', () => {
    // neuPrint publishes no soma/axon/dendrite labelling, and marking the root as soma would
    // be a claim about anatomy that nothing in the data supports.
    const rows = skeletonToSwc(skeleton()).trim().split('\n').filter((l) => !l.startsWith('#'))
    expect(rows.every((r) => r.split(' ')[1] === '0')).toBe(true)
  })
})

describe('OBJ', () => {
  it('writes vertices then faces, with 1-based indices', () => {
    const text = meshToObj(meshes().items[0]!)
    const lines = text.trim().split('\n').filter((l) => !l.startsWith('#'))
    expect(lines).toContain('v 0 0 0')
    expect(lines).toContain('v 1 0 0')
    // The single thing every hand-written OBJ writer gets wrong. `f 0 1 2` loads as one corrupt
    // triangle and a stray vertex at the origin, which reads as a renderer bug.
    expect(lines).toContain('f 1 2 3')
    expect(lines).not.toContain('f 0 1 2')
  })

  it('names the object by body id', () => {
    expect(meshToObj(meshes().items[0]!)).toContain('o body_200')
  })
})

describe('JSON', () => {
  it('unpacks typed arrays into plain ones', () => {
    // `JSON.stringify` renders a Float32Array as `{"0":0,"1":0}` — valid, unreadable, and
    // several times bigger than the array. Every geometry value here is built out of them.
    const text = valueToJson(skeletons())
    expect(text).toContain('"positions": [')
    expect(text).not.toContain('"0":')
    const parsed = JSON.parse(text) as { items: Array<{ positions: number[] }> }
    expect(Array.isArray(parsed.items[0]?.positions)).toBe(true)
    expect(parsed.items[0]?.positions).toHaveLength(9)
  })

  it('round-trips a plain table unchanged', () => {
    const parsed = JSON.parse(valueToJson(table())) as { data: Record<string, unknown[]> }
    expect(parsed.data['bodyId']).toEqual([1, 2])
  })
})

describe('planExport — auto', () => {
  const base = 'out'

  it('picks CSV for the tabular kinds and the geometry formats for morphology', () => {
    expect(defaultFormat(table())).toBe('csv')
    expect(defaultFormat(makeMatrix(['a'], ['b'], new Float64Array([1])))).toBe('csv')
    expect(defaultFormat(skeletons())).toBe('swc')
    expect(defaultFormat(meshes())).toBe('obj')
    // Nothing is refused for want of a format; a layout has no text form and gets JSON.
    expect(defaultFormat({ kind: 'layout', positions: {} })).toBe('json')
  })

  it('writes a table as one CSV', () => {
    const plan = planExport(table(), 'auto', base)
    expect(plan.files.map((f) => f.name)).toEqual(['out.csv'])
    expect(plan.files[0]!.parts.join('')).toContain('bodyId,type')
  })

  it('writes a network as two CSVs, nodes and links', () => {
    // One file cannot hold both without inventing a shape nothing reads.
    const network: NetworkValue = {
      kind: 'network',
      directed: true,
      nodes: tableFromRows(tableSchema(column('id', 'str')), [{ id: 'a' }]),
      edges: tableFromRows(
        tableSchema(column('source', 'str'), column('target', 'str')),
        [{ source: 'a', target: 'a' }],
      ),
    }
    expect(planExport(network, 'auto', base).files.map((f) => f.name)).toEqual([
      'out-nodes.csv',
      'out-links.csv',
    ])
  })

  it('writes one file per neuron for skeletons, named by body id', () => {
    // A concatenated SWC has repeating ids and parses as one impossible tree.
    expect(planExport(skeletons(3), 'auto', base).files.map((f) => f.name)).toEqual([
      'out-100.swc',
      'out-101.swc',
      'out-102.swc',
    ])
    expect(planExport(meshes(2), 'auto', base).files.map((f) => f.name)).toEqual([
      'out-200.obj',
      'out-201.obj',
    ])
  })

  it('caps a morphology set and reports the cap rather than swallowing it', () => {
    // A browser stops honouring downloads somewhere past this many, with no error — which
    // reads as the export having half-worked.
    const plan = planExport(skeletons(MAX_MORPHOLOGY_FILES + 5), 'auto', base)
    expect(plan.files).toHaveLength(MAX_MORPHOLOGY_FILES)
    expect(plan.truncated).toEqual({ kept: MAX_MORPHOLOGY_FILES, total: MAX_MORPHOLOGY_FILES + 5 })
  })

  it('keeps a point cloud’s positions with its attributes', () => {
    // Splitting them would lose the row-for-row correspondence that makes it a point cloud.
    const points: PointsValue = {
      kind: 'points',
      positions: new Float32Array([1, 2, 3, 4, 5, 6]),
      attributes: tableFromRows(tableSchema(column('kind', 'str')), [{ kind: 'pre' }, { kind: 'post' }]),
      bounds: EMPTY_BOUNDS,
    }
    const text = planExport(points, 'auto', base).files[0]!.parts.join('')
    expect(text).toContain('x,y,z,kind')
    expect(text).toContain('1,2,3,pre')
    expect(text).toContain('4,5,6,post')
  })
})

describe('planExport — an explicit format', () => {
  it('honours JSON for anything', () => {
    expect(planExport(table(), 'json', 'out').files.map((f) => f.name)).toEqual(['out.json'])
    expect(planExport(skeletons(), 'json', 'out').files.map((f) => f.name)).toEqual(['out.json'])
  })

  it('plans nothing for a format the value cannot be written as', () => {
    // Silently falling back to JSON would hide that the chosen format did not apply; the
    // caller reports the empty plan instead.
    expect(planExport(table(), 'swc', 'out').files).toEqual([])
    expect(planExport(skeletons(), 'csv', 'out').files).toEqual([])
  })

  it('plans nothing at all with no value', () => {
    expect(planExport(undefined, 'auto', 'out').files).toEqual([])
  })
})
