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

import type {
  MatrixValue,
  MeshesValue,
  NetworkValue,
  PointsValue,
  SkeletonGeometry,
  SkeletonsValue,
  TableValue,
  Value,
} from '../core/values'
import { getRow } from '../core/values'
import { matrixToCsv, tableToCsvParts } from './export'

/** One file a download will write. `parts` goes straight into a `Blob`. */
export interface ExportFile {
  /** Full name including extension. */
  name: string
  parts: BlobPart[]
  mime: string
}

export type ExportFormat = 'auto' | 'csv' | 'json' | 'svg' | 'png' | 'swc' | 'obj'

const TEXT = 'text/plain;charset=utf-8'
const CSV = 'text/csv;charset=utf-8'
const JSON_MIME = 'application/json'

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
    `# Coda export — bodyId ${skeleton.bodyId}`,
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
export function meshToObj(mesh: {
  bodyId: number
  label?: string
  positions: Float32Array
  indices: Uint32Array
}): string {
  // A region mesh has a name and no body id; a neuron has the reverse. Naming the object after
  // whichever it actually has is the difference between `o ME(R)` and `o body_3`.
  const name = mesh.label ?? `body_${mesh.bodyId}`
  const lines: string[] = [
    `# Coda export — ${mesh.label ?? `bodyId ${mesh.bodyId}`}`,
    '# Coordinates are in nanometres.',
    `o ${name.replace(/\s+/g, '_')}`,
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
  if (value.kind === 'skeletons') out.push('swc')
  if (value.kind === 'meshes') out.push('obj')
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

/**
 * One file per neuron, named by body id.
 *
 * SWC and OBJ both describe a single object, so a set of twenty neurons is twenty files rather
 * than one concatenation — a concatenated SWC has repeating ids and parses as one impossible
 * tree. `MAX_MORPHOLOGY_FILES` is the guard rail on that: a browser asked for six hundred
 * downloads at once stops honouring them somewhere in the middle, with no error, which reads as
 * the export having half-worked.
 */
export const MAX_MORPHOLOGY_FILES = 50

function skeletonFiles(value: SkeletonsValue, base: string): ExportFile[] {
  return value.items
    .slice(0, MAX_MORPHOLOGY_FILES)
    .map((item) => ({ name: `${base}-${item.bodyId}.swc`, parts: [skeletonToSwc(item)], mime: TEXT }))
}

function meshFiles(value: MeshesValue, base: string): ExportFile[] {
  return value.items
    .slice(0, MAX_MORPHOLOGY_FILES)
    .map((item) => ({
      name: `${base}-${meshFileStem(item)}.obj`,
      parts: [meshToObj(item)],
      mime: TEXT,
    }))
}

/**
 * What one mesh's file is called.
 *
 * A region's name is the useful stem and is also somebody else's string: `a'L(R)` and `ME(R)`
 * carry a quote, parens and a slash on other datasets, none of which belong in a filename on
 * every platform this runs on. Anything outside the safe set becomes an underscore rather than
 * being dropped, so two regions cannot collapse to one filename and silently overwrite.
 */
function meshFileStem(item: { bodyId: number; label?: string }): string {
  if (!item.label) return String(item.bodyId)
  return item.label.replace(/[^A-Za-z0-9._-]+/g, '_')
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

  if (resolved === 'json') return { files: [{ name: `${base}.json`, parts: [valueToJson(value)], mime: JSON_MIME }] }

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
