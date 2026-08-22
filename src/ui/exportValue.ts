/**
 * Turning any Coda value into files, for the Download node.
 *
 * `export.ts` holds the primitives — CSV writing, the anchor-click plumbing, SVG serialisation
 * — and each viewer decides for itself what its own button offers. This decides the same thing
 * for a value arriving on a *wire*, where there is no viewer to ask.
 *
 * The one rule worth stating: **nothing is ever refused for want of a format.** A kind with no
 * natural text form falls back to JSON, because a Download node that will not write what it was
 * wired to is worse than one that writes something inconvenient. `Format: auto` is what picks;
 * an explicit format is honoured or reported as unavailable.
 */

import type { ColumnSchema, DType, TableSchema } from '../core/types'
import type {
  CellValue,
  LinkageValue,
  MatrixValue,
  MeshGeometry,
  MeshesValue,
  NetworkValue,
  PointsValue,
  SkeletonGeometry,
  SkeletonsValue,
  TableValue,
  Value,
} from '../core/values'
import { getColumn, getRow } from '../core/values'
import { matrixToCsv, tableToCsvParts } from './export'

/** One file a download will write. `parts` goes straight into a `Blob`. */
export interface ExportFile {
  /** Full name including extension. */
  name: string
  parts: BlobPart[]
  mime: string
}

export type ExportFormat =
  | 'auto'
  | 'csv'
  | 'graphml'
  | 'json'
  | 'svg'
  | 'png'
  | 'swc'
  | 'obj'
  | 'newick'

const TEXT = 'text/plain;charset=utf-8'
const CSV = 'text/csv;charset=utf-8'
const JSON_MIME = 'application/json'
/** Exported so the viewer's own download button writes the same type the Download node does. */
export const GRAPHML_MIME = 'application/graphml+xml'
const NEWICK_MIME = 'text/x-nh'

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/**
 * A merge tree as Newick, which is what everything that draws trees reads.
 *
 * The alternative — writing the linkage matrix as a CSV — is offered too and is the right
 * file for going *back* into SciPy or R. It is the wrong one for a reader: `[a, b, height,
 * size]` with clusters numbered `n + i` is a machine format, and nothing outside those two
 * ecosystems parses it. Newick is read by iTOL, FigTree, ete3, ape, dendropy and Biopython,
 * carries the labels and the branch lengths, and is a few kilobytes.
 *
 * **Branch lengths are differences, not heights.** A Newick branch is the length of the edge
 * *below* a node, so it is the parent's merge height minus this node's — a leaf hanging off a
 * merge at 0.4 has a branch of 0.4, and a cluster formed at 0.3 under it has 0.1. Writing the
 * absolute height instead produces a tree that parses, draws, and is wrong in a way only a
 * scale bar reveals.
 */
export function linkageToNewick(linkage: LinkageValue): string {
  const n = linkage.labels.length
  const merges = linkage.merges.length / 4
  if (n === 0) return ';'
  if (merges === 0) return `${newickLabel(linkage.labels[0]!)};`

  // Bottom up in row order rather than by recursion: a merge can only reference clusters
  // formed before it, so one pass suffices — and a single-linkage tree of a few thousand
  // leaves is a chain that deep recursion would not survive.
  const text: string[] = linkage.labels.map(newickLabel)
  const height = new Float64Array(n + merges)

  for (let i = 0; i < merges; i++) {
    const a = linkage.merges[i * 4]!
    const b = linkage.merges[i * 4 + 1]!
    const at = linkage.merges[i * 4 + 2]!
    height[n + i] = at
    text[n + i] =
      `(${text[a]}:${branch(at - height[a]!)},${text[b]}:${branch(at - height[b]!)})`
  }
  return `${text[n + merges - 1]};`
}

/** Six significant figures, and never an exponent — Newick parsers vary on `1e-7`. */
function branch(length: number): string {
  const safe = Number.isFinite(length) && length > 0 ? length : 0
  return safe.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

/**
 * Newick reserves `(`, `)`, `,`, `:`, `;` and `[`; a space is read as one too by most parsers.
 * Quoting is the escape, with an internal quote doubled — a cell type called `5-HT` needs
 * none, and one called `SMP001(a)` would otherwise close a clade in the middle of a name.
 */
function newickLabel(label: string): string {
  const clean = label.replace(/[\r\n\t]/g, ' ')
  return /[(),:;[\]'\s]/.test(clean) ? `'${clean.replace(/'/g, "''")}'` : clean
}

/** The linkage matrix itself, in the `[a, b, height, size]` layout SciPy and R both read. */
function linkageToCsv(linkage: LinkageValue): string {
  const rows = [['cluster1', 'cluster2', 'distance', 'size'].join(',')]
  for (let i = 0; i < linkage.merges.length; i += 4) {
    rows.push(
      [
        linkage.merges[i]!,
        linkage.merges[i + 1]!,
        linkage.merges[i + 2]!,
        linkage.merges[i + 3]!,
      ].join(','),
    )
  }
  return `${rows.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Morphology
// ---------------------------------------------------------------------------

/**
 * One neuron as SWC.
 *
 * The columns are fixed by the format: `id type x y z radius parent`, one point per line,
 * whitespace separated, parents referring to ids rather than to line numbers. Coda's skeletons
 * are already SWC-shaped — parallel arrays with a parent index per point — so this is mostly a
 * re-indexing job.
 *
 * **Ids are 1-based and parents are `-1` for a root**, which is the part a reader will actually
 * reject a file over: SWC ids conventionally start at 1, and every tool treats a parent of `-1`
 * as "no parent". Coda stores parents as *array indices*, so every one has to be shifted; a file
 * written with 0-based ids parses without complaint and hangs the first point off nothing.
 *
 * The structure identifier is written as `0` (undefined) throughout rather than guessed. neuPrint
 * publishes no soma/axon/dendrite labelling with its skeletons, and inventing one — marking the
 * root as soma, say — would be a claim about the neuron's anatomy that nothing in the data
 * supports.
 */
export function skeletonToSwc(skeleton: SkeletonGeometry): string {
  const count = skeleton.radii.length
  const lines: string[] = [
    `# Coda export — neuron ${skeleton.id}`,
    '# Coordinates and radii are in nanometres.',
    '# id type x y z radius parent',
  ]
  for (let i = 0; i < count; i++) {
    const parent = skeleton.parents[i] ?? -1
    lines.push(
      [
        i + 1,
        0,
        skeleton.positions[i * 3] ?? 0,
        skeleton.positions[i * 3 + 1] ?? 0,
        skeleton.positions[i * 3 + 2] ?? 0,
        skeleton.radii[i] ?? 0,
        // A root stays -1; everything else shifts with the ids above it.
        parent < 0 ? -1 : parent + 1,
      ].join(' '),
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * One mesh as Wavefront OBJ.
 *
 * **Face indices are 1-based**, which is the single thing every hand-written OBJ writer gets
 * wrong: a 0-based file loads with one corrupt triangle and a vertex at the origin, which looks
 * like a rendering artefact rather than a bad file.
 *
 * No normals and no material: the sources publish neither, and a `vn` computed here would be a
 * guess at smoothing that every viewer recomputes anyway.
 */
export function meshToObj(mesh: MeshGeometry): string {
  // Whitespace only, unlike the *filename* below: an OBJ object name may carry the parens and
  // quote a region name like `a'L(R)` has, and `o ME(R)` is more use than `o ME_R_`.
  const lines: string[] = [
    `# Coda export — ${mesh.id}`,
    '# Coordinates are in nanometres.',
    `o ${mesh.id.replace(/\s+/g, '_')}`,
  ]
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`)
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    lines.push(
      `f ${(mesh.indices[i] ?? 0) + 1} ${(mesh.indices[i + 1] ?? 0) + 1} ${(mesh.indices[i + 2] ?? 0) + 1}`,
    )
  }
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * A value as JSON, with typed arrays unpacked into plain ones.
 *
 * `JSON.stringify` renders a `Float32Array` as an *object* keyed by index — `{"0":1,"1":2}` —
 * which is valid JSON, unreadable by anything, and several times larger than the array it came
 * from. Every geometry value here is built out of typed arrays, so this is the difference
 * between a usable fallback and a file nobody can open.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>)
  }
  return value
}

export function valueToJson(value: Value): string {
  return JSON.stringify(value, jsonReplacer, 2)
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/** A point cloud flattened to `x,y,z` plus its attribute columns, which is what a CSV can hold. */
function pointsToCsv(points: PointsValue): string[] {
  const columns = points.attributes.schema.columns.map((c) => c.name)
  const parts: string[] = [`x,y,z${columns.length ? `,${columns.join(',')}` : ''}\n`]
  for (let i = 0; i < points.attributes.length; i++) {
    const row = getRow(points.attributes, i)
    const cells = columns.map((name) => {
      const cell = row[name]
      if (cell === null || cell === undefined) return ''
      const text = String(cell)
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
    })
    parts.push(
      `${points.positions[i * 3]},${points.positions[i * 3 + 1]},${points.positions[i * 3 + 2]}` +
        `${cells.length ? `,${cells.join(',')}` : ''}\n`,
    )
  }
  return parts
}

// ---------------------------------------------------------------------------
// GraphML
// ---------------------------------------------------------------------------

/**
 * A network as GraphML, for Cytoscape, NetworkX, Gephi, igraph and yEd.
 *
 * Chosen over GML — the other format all five read — for one reason: it is the only one that
 * carries Coda's attribute tables *with their types*. A `<key>` declares `attr.type` up front,
 * so an `i64` arrives as a long and an `f64` as a double rather than as whatever the reader
 * infers from the first literal it meets, and an absent value is an omitted element rather than
 * a zero somebody has to notice. GML implies types by literal syntax and restricts key names to
 * something a column called `sum_neuronId` survives and one called `pt root id` does not.
 *
 * **Attributes only — no positions and no colours.** So the two nodes offering this produce
 * byte-identical files for the same network, and the file says what the data says rather than
 * what one particular viewer happened to be showing. Every reader here lays a graph out on
 * import anyway.
 *
 * Deliberately *not* built through `XMLSerializer`: the whole point of chunking is to avoid
 * materialising a 20,000-node document at once, and a DOM is that document plus an object per
 * element.
 */

/** Coda's dtypes as GraphML's. The reason this format was picked over GML. */
const GRAPHML_TYPE: Record<DType, string> = {
  i64: 'long',
  f64: 'double',
  str: 'string',
  bool: 'boolean',
}

/**
 * Columns each half already represents structurally, and so does not repeat as an attribute.
 *
 * The same subtraction `keptEdgeColumns` makes when it declines to carry the source, target and
 * weight columns onto a link under their original names: an id written twice is not extra
 * information, and on import it becomes a redundant column beside the one the reader keyed on.
 */
const GRAPHML_NODE_OWNED = new Set(['id'])
const GRAPHML_EDGE_OWNED = new Set(['source', 'target'])

/** Rows per string part, matching `tableToCsvParts` — a whole document is one huge string. */
const GRAPHML_CHUNK_ROWS = 2000

interface GraphmlKey {
  /** Generated, never the column name: a `<key>` id is an XML ID and a column name is text. */
  id: string
  column: ColumnSchema
}

function graphmlKeys(schema: TableSchema, owned: Set<string>, prefix: string): GraphmlKey[] {
  return schema.columns
    .filter((c) => !owned.has(c.name))
    .map((column, i) => ({ id: `${prefix}${i}`, column }))
}

/**
 * Written as escapes rather than typed: a raw control character in a source file is invisible
 * to every reader and to `grep`, which is the lesson `uploads.ts` records about its separator.
 *
 * `no-control-regex` is off for this one line because control characters are the *subject*
 * here rather than a slip — the rule exists to catch one that arrived by accident.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

/**
 * XML text, with the characters XML cannot carry **removed** rather than escaped.
 *
 * The five entities are the easy half. The half worth writing down is that XML 1.0 forbids most
 * C0 control characters outright — there is no escape for them, `&#1;` is as illegal as the byte
 * itself, and a document carrying one is *rejected* by every conforming parser rather than read
 * leniently. A neuron type never holds one; a column of somebody's uploaded CSV can, and losing
 * a stray byte beats losing the file. Tab, newline and carriage return are legal and stay.
 *
 * `&` is replaced first, or it would escape the ampersands of the replacements after it. `"` is
 * escaped as well so one function serves both text and attribute values — node ids are user
 * data, and an `a'L(R)`-shaped region name is the ordinary case rather than the hostile one.
 */
export function xmlText(value: string): string {
  return value
    .replace(CONTROL_CHARS, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * One cell as GraphML text, or `undefined` for "write no element at all".
 *
 * Absence is the case that matters. A missing value has no lexical form in a `double`, and
 * writing `0` would make it a reading — the trap `numeric()` in `encoding.ts` exists for, one
 * step further downstream. Omitting the element leaves the attribute simply absent from that
 * node, which is what every reader here treats as "not recorded".
 *
 * A non-finite number goes the same way. XML Schema does spell `NaN` and `INF`, but the readers
 * disagree about them and a number nobody can compare is not worth a parse error.
 *
 * An **empty string is kept**, unlike a null, because this is a serializer rather than an
 * analysis: `<data key="nd0"></data>` reads back as `''`, where omitting it reads back as a
 * missing key and turns a blank cell into a `KeyError` in somebody's script.
 */
function graphmlCell(value: CellValue | undefined, dtype: DType): string | undefined {
  if (value === null || value === undefined) return undefined
  if (dtype === 'i64' || dtype === 'f64') {
    const number = Number(value)
    return Number.isFinite(number) ? String(number) : undefined
  }
  if (dtype === 'bool') {
    // A `bool` column holds booleans; the string forms are what a foreign table can arrive
    // with, and `Boolean('false')` is `true`.
    if (value === 'true' || value === 'false') return value
    return value ? 'true' : 'false'
  }
  return xmlText(String(value))
}

/** The `<data>` children of one node or edge, indented to sit inside it. */
function graphmlData(table: TableValue, keys: GraphmlKey[], row: number): string {
  let out = ''
  for (const { id, column } of keys) {
    const text = graphmlCell(table.data[column.name]?.[row] ?? null, column.dtype)
    if (text === undefined) continue
    out += `      <data key="${id}">${text}</data>\n`
  }
  return out
}

function graphmlKeyElement(key: GraphmlKey, scope: 'node' | 'edge'): string {
  const { name, dtype } = key.column
  return (
    `  <key id="${key.id}" for="${scope}" attr.name="${xmlText(name)}"` +
    ` attr.type="${GRAPHML_TYPE[dtype]}"/>\n`
  )
}

export function networkToGraphml(network: NetworkValue): string[] {
  const nodeKeys = graphmlKeys(network.nodes.schema, GRAPHML_NODE_OWNED, 'nd')
  const edgeKeys = graphmlKeys(network.edges.schema, GRAPHML_EDGE_OWNED, 'ed')

  const head = [
    `<?xml version="1.0" encoding="UTF-8"?>\n`,
    `<graphml xmlns="http://graphml.graphdrawing.org/xmlns"\n`,
    `         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n`,
    `         xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns ` +
      `http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">\n`,
    ...nodeKeys.map((key) => graphmlKeyElement(key, 'node')),
    ...edgeKeys.map((key) => graphmlKeyElement(key, 'edge')),
    `  <graph edgedefault="${network.directed ? 'directed' : 'undirected'}">\n`,
  ]

  const parts: string[] = [head.join('')]
  let chunk: string[] = []
  const flush = () => {
    if (chunk.length === 0) return
    parts.push(chunk.join(''))
    chunk = []
  }

  const ids = getColumn(network.nodes, 'id')
  for (let row = 0; row < network.nodes.length; row++) {
    const id = xmlText(String(ids[row] ?? ''))
    const data = graphmlData(network.nodes, nodeKeys, row)
    chunk.push(data ? `    <node id="${id}">\n${data}    </node>\n` : `    <node id="${id}"/>\n`)
    if (chunk.length >= GRAPHML_CHUNK_ROWS) flush()
  }
  flush()

  const sources = getColumn(network.edges, 'source')
  const targets = getColumn(network.edges, 'target')
  for (let row = 0; row < network.edges.length; row++) {
    const from = xmlText(String(sources[row] ?? ''))
    const to = xmlText(String(targets[row] ?? ''))
    const open = `<edge source="${from}" target="${to}"`
    const data = graphmlData(network.edges, edgeKeys, row)
    chunk.push(data ? `    ${open}>\n${data}    </edge>\n` : `    ${open}/>\n`)
    if (chunk.length >= GRAPHML_CHUNK_ROWS) flush()
  }
  flush()

  parts.push('  </graph>\n</graphml>\n')
  return parts
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** The format `auto` resolves to for a value, and the only one it will pick unprompted. */
export function defaultFormat(value: Value | undefined): ExportFormat {
  switch (value?.kind) {
    case 'table':
    case 'neurons':
    case 'matrix':
    case 'network':
    case 'points':
      return 'csv'
    case 'skeletons':
      return 'swc'
    case 'meshes':
      return 'obj'
    case 'linkage':
      return 'newick'
    default:
      return 'json'
  }
}

/** Formats a value can actually be written as, in menu order. `svg`/`png` are the viewer's. */
export function formatsFor(value: Value | undefined): ExportFormat[] {
  if (!value) return []
  const csv = defaultFormat(value) === 'csv'
  const out: ExportFormat[] = []
  if (csv) out.push('csv')
  // After CSV rather than instead of it, and CSV stays the `auto` answer: GraphML is the
  // better file for Cytoscape and NetworkX, and a spreadsheet cannot open it at all.
  if (value.kind === 'network') out.push('graphml')
  if (value.kind === 'skeletons') out.push('swc')
  if (value.kind === 'meshes') out.push('obj')
  if (value.kind === 'linkage') {
    // Newick first and as the `auto` answer, because it is the file somebody can open. The
    // CSV is the linkage matrix as it stands, for going back into SciPy or R.
    out.push('newick', 'csv')
  }
  out.push('json')
  return out
}

function tableFiles(table: TableValue, base: string): ExportFile[] {
  return [{ name: `${base}.csv`, parts: tableToCsvParts(table), mime: CSV }]
}

function matrixFiles(matrix: MatrixValue, base: string): ExportFile[] {
  return [{ name: `${base}.csv`, parts: [matrixToCsv(matrix)], mime: CSV }]
}

/**
 * A network as **two** files, nodes and links.
 *
 * One file cannot hold both without inventing a shape nothing reads. Two is what the Network
 * viewer's own CSV button gives, what Gephi and Cytoscape import, and what a spreadsheet can
 * open — at the cost of one press producing two files, which the browser will ask about once.
 */
function networkFiles(network: NetworkValue, base: string): ExportFile[] {
  return [
    { name: `${base}-nodes.csv`, parts: tableToCsvParts(network.nodes), mime: CSV },
    { name: `${base}-links.csv`, parts: tableToCsvParts(network.edges), mime: CSV },
  ]
}

/** The same network as one file, with both halves and their types intact. */
function graphmlFiles(network: NetworkValue, base: string): ExportFile[] {
  return [
    { name: `${base}.graphml`, parts: networkToGraphml(network), mime: GRAPHML_MIME },
  ]
}

/**
 * One file per neuron, named by neuron id.
 *
 * SWC and OBJ both describe a single object, so a set of twenty neurons is twenty files rather
 * than one concatenation — a concatenated SWC has repeating ids and parses as one impossible
 * tree. `MAX_MORPHOLOGY_FILES` is the guard rail on that: a browser asked for six hundred
 * downloads at once stops honouring them somewhere in the middle, with no error, which reads as
 * the export having half-worked.
 */
export const MAX_MORPHOLOGY_FILES = 50

function skeletonFiles(value: SkeletonsValue, base: string): ExportFile[] {
  return value.items.slice(0, MAX_MORPHOLOGY_FILES).map((item) => ({
    name: `${base}-${fileStem(item.id)}.swc`,
    parts: [skeletonToSwc(item)],
    mime: TEXT,
  }))
}

function meshFiles(value: MeshesValue, base: string): ExportFile[] {
  return value.items.slice(0, MAX_MORPHOLOGY_FILES).map((item) => ({
    name: `${base}-${fileStem(item.id)}.obj`,
    parts: [meshToObj(item)],
    mime: TEXT,
  }))
}

/**
 * What one geometry item's file is called.
 *
 * A geometry id is a neuron id for a neuron and a region's own name for a shell, and the latter
 * is somebody else's string: `a'L(R)` and `ME(R)` carry a quote, parens and a slash on other
 * datasets, none of which belong in a filename on every platform this runs on. Anything outside
 * the safe set becomes an underscore rather than being dropped, so two regions cannot collapse
 * to one filename and silently overwrite. A neuron's digits pass through untouched.
 */
function fileStem(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '_')
}

export interface ExportPlan {
  files: ExportFile[]
  /** Set when the plan is smaller than the value — the caller must say so, not swallow it. */
  truncated?: { kept: number; total: number }
}

/**
 * What downloading this value in this format would write.
 *
 * Returns a plan rather than downloading, so the same decision can be shown on a card, asserted
 * in a test and performed by a click without three copies of it.
 */
export function planExport(
  value: Value | undefined,
  format: ExportFormat,
  base: string,
): ExportPlan {
  if (!value) return { files: [] }
  const resolved = format === 'auto' ? defaultFormat(value) : format

  if (resolved === 'json')
    return { files: [{ name: `${base}.json`, parts: [valueToJson(value)], mime: JSON_MIME }] }

  switch (value.kind) {
    case 'table':
    case 'neurons':
      if (resolved === 'csv') return { files: tableFiles(value, base) }
      break
    case 'matrix':
      if (resolved === 'csv') return { files: matrixFiles(value, base) }
      break
    case 'network':
      if (resolved === 'csv') return { files: networkFiles(value, base) }
      if (resolved === 'graphml') return { files: graphmlFiles(value, base) }
      break
    case 'points':
      // Positions and attributes in one table, because they are one row each and splitting
      // them would lose the correspondence that makes a point cloud a point cloud.
      if (resolved === 'csv') {
        return { files: [{ name: `${base}.csv`, parts: pointsToCsv(value), mime: CSV }] }
      }
      break
    case 'skeletons':
      if (resolved === 'swc') {
        return {
          files: skeletonFiles(value, base),
          ...(value.items.length > MAX_MORPHOLOGY_FILES
            ? { truncated: { kept: MAX_MORPHOLOGY_FILES, total: value.items.length } }
            : {}),
        }
      }
      break
    case 'linkage':
      if (resolved === 'newick') {
        return {
          files: [{ name: `${base}.nwk`, parts: [linkageToNewick(value)], mime: NEWICK_MIME }],
        }
      }
      if (resolved === 'csv') {
        return { files: [{ name: `${base}.csv`, parts: [linkageToCsv(value)], mime: CSV }] }
      }
      break
    case 'meshes':
      if (resolved === 'obj') {
        return {
          files: meshFiles(value, base),
          ...(value.items.length > MAX_MORPHOLOGY_FILES
            ? { truncated: { kept: MAX_MORPHOLOGY_FILES, total: value.items.length } }
            : {}),
        }
      }
      break
    default:
      break
  }

  // An explicit format the value cannot be written as. JSON is always available, so falling
  // back to it silently would hide the fact that the chosen one did not apply.
  return { files: [] }
}
