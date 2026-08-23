// @vitest-environment jsdom

/**
 * Writing a value out as files.
 *
 * Under jsdom for one reason: the GraphML block asserts against a *parsed* document, and node
 * has no `DOMParser`. The writers themselves stay pure — `networkToGraphml` builds strings
 * precisely so a 20,000-node document never becomes a DOM — and the parse is the test's own
 * tool, which is what makes it an independent check rather than a snapshot of the output
 * agreeing with itself.
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
import { EMPTY_BOUNDS, makeLinkage, makeMatrix, tableFromRows } from '../core/values'
import {
  MAX_MORPHOLOGY_FILES,
  defaultFormat,
  formatsFor,
  linkageToNewick,
  meshToObj,
  networkToGraphml,
  planExport,
  skeletonToSwc,
  valueToJson,
  xmlText,
} from './exportValue'

const NEURONS = tableSchema(column('neuronId', 'i64'), column('type', 'str'))
const table = () =>
  tableFromRows(NEURONS, [
    { neuronId: 1, type: 'LC4' },
    { neuronId: 2, type: 'LC6' },
  ])

/** A three-point skeleton: a root and two children, the second hanging off the first child. */
function skeleton(id = '101') {
  return {
    id,
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 20, 5, 0]),
    radii: new Float32Array([3, 2, 1]),
    parents: new Int32Array([-1, 0, 1]),
  }
}

function skeletons(count = 1): SkeletonsValue {
  const items = Array.from({ length: count }, (_, i) => skeleton(String(100 + i)))
  return {
    kind: 'skeletons',
    items,
    attributes: tableFromRows(
      tableSchema(column('neuronId', 'i64')),
      items.map((s) => ({ neuronId: Number(s.id) })),
    ),
    bounds: EMPTY_BOUNDS,
  }
}

function meshes(count = 1): MeshesValue {
  const items = Array.from({ length: count }, (_, i) => ({
    id: String(200 + i),
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  }))
  return {
    kind: 'meshes',
    items,
    attributes: tableFromRows(
      tableSchema(column('neuronId', 'i64')),
      items.map((m) => ({ neuronId: Number(m.id) })),
    ),
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
    const rows = skeletonToSwc(skeleton())
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('#'))
    const parents = rows.map((r) => Number(r.split(' ')[6]))
    // Coda's parents are [-1, 0, 1] — array indices. Written unshifted, point 2 would claim a
    // parent of 0, which no SWC reader accepts and several silently reparent to nothing.
    expect(parents).toEqual([-1, 1, 2])
    expect(rows.map((r) => Number(r.split(' ')[0]))).toEqual([1, 2, 3])
  })

  it('says what the numbers mean, since the format itself does not', () => {
    const header = skeletonToSwc(skeleton())
      .split('\n')
      .filter((l) => l.startsWith('#'))
    expect(header.join(' ')).toContain('nanometres')
    expect(header.join(' ')).toContain('101')
  })

  it('writes the structure identifier as 0 rather than guessing one', () => {
    // neuPrint publishes no soma/axon/dendrite labelling, and marking the root as soma would
    // be a claim about anatomy that nothing in the data supports.
    const rows = skeletonToSwc(skeleton())
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('#'))
    expect(rows.every((r) => r.split(' ')[1] === '0')).toBe(true)
  })
})

describe('OBJ', () => {
  it('writes vertices then faces, with 1-based indices', () => {
    const text = meshToObj(meshes().items[0]!)
    const lines = text
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('#'))
    expect(lines).toContain('v 0 0 0')
    expect(lines).toContain('v 1 0 0')
    // The single thing every hand-written OBJ writer gets wrong. `f 0 1 2` loads as one corrupt
    // triangle and a stray vertex at the origin, which reads as a renderer bug.
    expect(lines).toContain('f 1 2 3')
    expect(lines).not.toContain('f 0 1 2')
  })

  it('names the object by neuron id', () => {
    expect(meshToObj(meshes().items[0]!)).toContain('o 200')
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
    expect(parsed.data['neuronId']).toEqual([1, 2])
  })
})

// ---------------------------------------------------------------------------
// GraphML
// ---------------------------------------------------------------------------

/**
 * Parse the writer's output as XML and hand back the document.
 *
 * The load-bearing choice in this block: everything is asserted against a *parsed* document
 * rather than against the string. A snapshot of well-formed-looking XML is exactly what a file
 * with an unescaped `&` in a region name looks like — and the readers this format exists for do
 * not read leniently, so a document that does not parse is a download that fails silently on
 * somebody else's machine rather than here.
 */
function parseGraphml(network: NetworkValue): Document {
  const text = networkToGraphml(network).join('')
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const failure = doc.querySelector('parsererror')
  if (failure) throw new Error(`not well-formed XML: ${failure.textContent}`)
  return doc
}

/** Attribute name → value for one `<node>`/`<edge>`, resolved through the `<key>` table. */
function attrs(doc: Document, element: Element): Record<string, string> {
  const out: Record<string, string> = {}
  for (const data of [...element.querySelectorAll('data')]) {
    const key = doc.querySelector(`key[id="${data.getAttribute('key')}"]`)
    out[key?.getAttribute('attr.name') ?? '?'] = data.textContent ?? ''
  }
  return out
}

/** A two-node network exercising every dtype, a null, and a name full of XML metacharacters. */
function graph(): NetworkValue {
  return {
    kind: 'network',
    directed: true,
    nodes: tableFromRows(
      tableSchema(
        column('id', 'str'),
        column('type', 'str'),
        column('degreeOut', 'i64'),
        column('weightOut', 'f64'),
        column('cropped', 'bool'),
      ),
      [
        { id: 'LC4', type: 'LC4', degreeOut: 1, weightOut: 312.5, cropped: false },
        { id: "a'L(R) & <x>", type: null, degreeOut: 0, weightOut: 0, cropped: true },
      ],
    ),
    edges: tableFromRows(
      tableSchema(
        column('source', 'str'),
        column('target', 'str'),
        column('weight', 'f64'),
        column('roi', 'str'),
      ),
      [{ source: 'LC4', target: "a'L(R) & <x>", weight: 40, roi: null }],
    ),
  }
}

describe('GraphML', () => {
  it('is well-formed XML in the GraphML namespace', () => {
    const doc = parseGraphml(graph())
    expect(doc.documentElement.tagName).toBe('graphml')
    expect(doc.documentElement.namespaceURI).toBe('http://graphml.graphdrawing.org/xmlns')
  })

  it('declares a type per column, which is the reason this format was chosen over GML', () => {
    const doc = parseGraphml(graph())
    const declared = [...doc.querySelectorAll('key')].map(
      (k) =>
        `${k.getAttribute('for')}:${k.getAttribute('attr.name')}:${k.getAttribute('attr.type')}`,
    )
    expect(declared).toEqual([
      'node:type:string',
      'node:degreeOut:long',
      'node:weightOut:double',
      'node:cropped:boolean',
      'edge:weight:double',
      'edge:roi:string',
    ])
  })

  it('never repeats the columns the structure already carries', () => {
    // `id`, `source` and `target` become the element's own attributes; writing them again
    // would land in Cytoscape as a redundant column beside the one it keyed on.
    const names = [...parseGraphml(graph()).querySelectorAll('key')].map((k) =>
      k.getAttribute('attr.name'),
    )
    expect(names).not.toContain('id')
    expect(names).not.toContain('source')
    expect(names).not.toContain('target')
  })

  it('escapes a node id full of XML metacharacters, in the id and on the edge alike', () => {
    // Region and type names carry quotes, ampersands and parens on real datasets. An id
    // escaped on the node and not on the edge is a file that parses and joins nothing.
    const doc = parseGraphml(graph())
    const ids = [...doc.querySelectorAll('node')].map((n) => n.getAttribute('id'))
    expect(ids).toEqual(['LC4', "a'L(R) & <x>"])
    expect(doc.querySelector('edge')?.getAttribute('target')).toBe("a'L(R) & <x>")
  })

  it('omits a null rather than writing a zero or an empty string', () => {
    // The trap `numeric()` exists for, one step downstream: a written `0` is a reading.
    const doc = parseGraphml(graph())
    const second = [...doc.querySelectorAll('node')][1]!
    expect(attrs(doc, second)).toEqual({ degreeOut: '0', weightOut: '0', cropped: 'true' })
    expect(attrs(doc, doc.querySelector('edge')!)).toEqual({ weight: '40' })
  })

  it('writes a real zero, so absence and zero stay distinguishable', () => {
    const doc = parseGraphml(graph())
    expect(attrs(doc, [...doc.querySelectorAll('node')][1]!)['weightOut']).toBe('0')
  })

  it('carries the direction, which decides how every reader treats the edges', () => {
    expect(parseGraphml(graph()).querySelector('graph')?.getAttribute('edgedefault')).toBe(
      'directed',
    )
    expect(
      parseGraphml({ ...graph(), directed: false })
        .querySelector('graph')
        ?.getAttribute('edgedefault'),
    ).toBe('undirected')
  })

  it('strips the control characters XML cannot carry at all', () => {
    // There is no escape for these — `&#1;` is as illegal as the byte — so a document holding
    // one is rejected outright. Losing the byte beats losing the file.
    expect(xmlText('a\u0001b\u001fc')).toBe('abc')
    // Tab, newline and carriage return are legal and must survive.
    expect(xmlText('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })

  it('parses even when a name arrives with one in it', () => {
    const dirty = graph()
    const doc = parseGraphml({
      ...dirty,
      nodes: tableFromRows(dirty.nodes.schema, [
        { id: 'LC\u00014', type: null, degreeOut: 0, weightOut: 0, cropped: false },
      ]),
      edges: tableFromRows(dirty.edges.schema, []),
    })
    expect(doc.querySelector('node')?.getAttribute('id')).toBe('LC4')
  })

  it('chunks the document rather than building one huge string', () => {
    // `parts` goes straight into a Blob; a 20,000-node network as one string is the thing
    // `tableToCsvParts` chunks for, and this writes considerably more per row than it does.
    const rows = Array.from({ length: 4100 }, (_, i) => ({ id: `n${i}` }))
    const big: NetworkValue = {
      kind: 'network',
      directed: true,
      nodes: tableFromRows(tableSchema(column('id', 'str')), rows),
      edges: tableFromRows(tableSchema(column('source', 'str'), column('target', 'str')), []),
    }
    // head + two full chunks + the remainder + the closing tags.
    expect(networkToGraphml(big).length).toBe(5)
  })

  it('is offered for a network and for nothing else', () => {
    expect(formatsFor(graph())).toEqual(['csv', 'graphml', 'json'])
    // CSV stays the `auto` answer: GraphML is the better file for Cytoscape, and a spreadsheet
    // cannot open it at all.
    expect(defaultFormat(graph())).toBe('csv')
    expect(formatsFor(table())).toEqual(['csv', 'json'])
    expect(formatsFor(skeletons())).not.toContain('graphml')
  })

  it('is one file, where CSV is two', () => {
    const plan = planExport(graph(), 'graphml', 'out')
    expect(plan.files.map((f) => f.name)).toEqual(['out.graphml'])
    expect(plan.files[0]!.mime).toBe('application/graphml+xml')
  })

  it('refuses a value that is not a network, rather than falling back to JSON', () => {
    // An explicit format the value cannot be written as plans nothing and is reported; a
    // silent fallback would hide that the choice did not apply.
    expect(planExport(table(), 'graphml', 'out').files).toEqual([])
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
    expect(plan.files[0]!.parts.join('')).toContain('neuronId,type')
  })

  it('writes a network as two CSVs, nodes and links', () => {
    // One file cannot hold both without inventing a shape nothing reads.
    const network: NetworkValue = {
      kind: 'network',
      directed: true,
      nodes: tableFromRows(tableSchema(column('id', 'str')), [{ id: 'a' }]),
      edges: tableFromRows(tableSchema(column('source', 'str'), column('target', 'str')), [
        { source: 'a', target: 'a' },
      ]),
    }
    expect(planExport(network, 'auto', base).files.map((f) => f.name)).toEqual([
      'out-nodes.csv',
      'out-links.csv',
    ])
  })

  it('writes one file per neuron for skeletons, named by neuron id', () => {
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
    expect(plan.truncated).toEqual({
      kept: MAX_MORPHOLOGY_FILES,
      total: MAX_MORPHOLOGY_FILES + 5,
    })
  })

  it('keeps a point cloud’s positions with its attributes', () => {
    // Splitting them would lose the row-for-row correspondence that makes it a point cloud.
    const points: PointsValue = {
      kind: 'points',
      positions: new Float32Array([1, 2, 3, 4, 5, 6]),
      attributes: tableFromRows(tableSchema(column('kind', 'str')), [
        { kind: 'pre' },
        { kind: 'post' },
      ]),
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
    expect(planExport(skeletons(), 'json', 'out').files.map((f) => f.name)).toEqual([
      'out.json',
    ])
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

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/**
 * The tree used below, and the numbers every assertion turns on.
 *
 *   a ─┐ 0.1
 *   b ─┴────┐
 *   c ─┐    ├── 0.8
 *   d ─┴────┘ 0.2
 */
function tree() {
  return makeLinkage(
    Float64Array.from([0, 1, 0.1, 2, 2, 3, 0.2, 2, 4, 5, 0.8, 4]),
    ['a', 'b', 'c', 'd'],
    Int32Array.from([0, 1, 2, 3]),
    { method: 'average' },
  )
}

describe('linkageToNewick', () => {
  it('writes branch lengths as differences, not heights', () => {
    // The one that produces a file which parses, draws, and is wrong. A Newick branch is the
    // edge *below* a node: a and b hang 0.1 off their merge, and that merge hangs 0.7 below
    // the root at 0.8. Verified against a real parser rather than by eye — biopython reads
    // this back with every root-to-leaf distance equal to 0.8, i.e. ultrametric as a
    // clustering tree must be, and each pair's path distance twice its merge height.
    expect(linkageToNewick(tree())).toBe('((a:0.1,b:0.1):0.7,(c:0.2,d:0.2):0.6);')
  })

  it('quotes a label carrying Newick punctuation, and doubles an internal quote', () => {
    // `SMP001(a)` would otherwise close a clade in the middle of a name.
    const named = makeLinkage(
      Float64Array.from([0, 1, 0.5, 2]),
      ['SMP001(a)', "o'brien"],
      Int32Array.from([0, 1]),
    )
    expect(linkageToNewick(named)).toBe("('SMP001(a)':0.5,'o''brien':0.5);")
  })

  it('leaves an ordinary label alone, including one with a hyphen', () => {
    const named = makeLinkage(
      Float64Array.from([0, 1, 0.25, 2]),
      ['5-HT', 'LC4'],
      Int32Array.from([0, 1]),
    )
    expect(linkageToNewick(named)).toBe('(5-HT:0.25,LC4:0.25);')
  })

  it('never writes an exponent, which parsers disagree about', () => {
    const tiny = makeLinkage(
      Float64Array.from([0, 1, 0.0000001, 2]),
      ['a', 'b'],
      Int32Array.from([0, 1]),
    )
    expect(linkageToNewick(tiny)).not.toMatch(/e-/)
  })

  it('writes a single leaf and an empty tree without inventing a clade', () => {
    expect(
      linkageToNewick(makeLinkage(new Float64Array(0), ['only'], Int32Array.from([0]))),
    ).toBe('only;')
    expect(linkageToNewick(makeLinkage(new Float64Array(0), [], new Int32Array(0)))).toBe(';')
  })
})

describe('exporting a tree', () => {
  it('writes Newick unprompted, because that is the file somebody can open', () => {
    expect(defaultFormat(tree())).toBe('newick')
    const plan = planExport(tree(), 'auto', 'clusters')
    expect(plan.files.map((f) => f.name)).toEqual(['clusters.nwk'])
  })

  it('also offers the linkage matrix itself, for going back into SciPy or R', () => {
    expect(formatsFor(tree())).toEqual(['newick', 'csv', 'json'])
    const csv = planExport(tree(), 'csv', 'clusters').files[0]!
    expect(csv.name).toBe('clusters.csv')
    expect(csv.parts.join('')).toBe(
      'cluster1,cluster2,distance,size\n0,1,0.1,2\n2,3,0.2,2\n4,5,0.8,4\n',
    )
  })
})
