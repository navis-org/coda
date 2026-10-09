/**
 * A BigClust project's `info` file, read into what Coda needs from it.
 *
 * BigClust (github.com/schlegelp/BigClust2) keeps a project as a folder: an extension-less JSON
 * `info` naming a `meta` table and the embeddings drawn from it, each optionally paired with the
 * feature vectors or distances it was computed from. This is the reading of that file and nothing
 * else — no bytes are fetched here — mirroring BigClust's own `_normalize_embedding_specs` so a
 * project means the same thing in both:
 *
 *  - a spec is a path string or a `{ file }` object;
 *  - `embeddings` is a list of entries, or the older single entry (an object, or a path);
 *  - an entry's own `features` / `distances` override the top-level ones;
 *  - distances are a k-NN graph when their `type` is `knn` or `<source>:knn`, and a full square
 *    matrix otherwise;
 *  - an entry with `columns` is two of `meta`'s own columns rather than a file.
 *
 * A JSON *list* is BigClust's collection of projects: subdirectory names, each a project of its
 * own. That is refused by naming them, since which one somebody wants is not something to guess.
 */

import { uniqueName } from '../../core/types'

/** One embedding, with the files that go with it already resolved against the top level. */
export interface EmbeddingEntry {
  /** As BigClust shows it — `morphology(nblast)` — and what the node's dropdown stores. */
  readonly name: string
  /** The file holding its two coordinates, or undefined where they are two meta columns. */
  readonly file?: string
  /** The two `meta` columns holding its coordinates, where it has no file. */
  readonly columns?: readonly [string, string]
  readonly distances?: DistancesSpec
  readonly features?: { readonly file: string }
}

export interface DistancesSpec {
  readonly file: string
  /** A wide `nn_idx_k` / `nn_dist_k` table rather than a square matrix. */
  readonly knn: boolean
}

export interface ProjectInfo {
  readonly name?: string
  readonly description?: string
  readonly dataset?: string
  readonly meta: string
  readonly embeddings: readonly EmbeddingEntry[]
  readonly neuroglancer?: NeuroglancerSpec
}

/**
 * The project's `neuroglancer` block: not a scene but what BigClust builds one from (its
 * `set_neuroglancer`). Each of `source` and `color` is BigClust's three spellings — a meta column's
 * name, a `{ dataset: value }` map read through meta's `dataset` column, or one value for every
 * neuron — and which is meant is only decidable against meta's columns, so they are kept as written.
 */
export interface NeuroglancerSpec {
  readonly source?: string | Readonly<Record<string, string>>
  /** As `source`, and a single value may also be an RGB(A) list. */
  readonly color?: string | Readonly<Record<string, unknown>> | readonly number[]
  /** `ids@source` for neuroglancer segments (`1,2,3@…`), otherwise a mesh file BigClust loads itself. */
  readonly neuropilMesh?: string
  /** Landmark warps between datasets' spaces, which a neuroglancer link cannot apply. */
  readonly transforms: boolean
}

/** The index columns pandas writes, which are never a coordinate or a feature. */
export const INDEX_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'index',
  '__index_level_0__',
  'query',
])

/** A file whose rows do not line up with meta's — the one refusal every reader of one gives. */
export function rowMismatch(what: string, got: number, rows: number): Error {
  return new Error(
    `${what} has ${got.toLocaleString()} rows but meta has ${rows.toLocaleString()}; BigClust ` +
      `aligns them row by row.`,
  )
}

/** The text of an `info` file as a project, or a refusal saying what is wrong with it. */
export function parseInfo(text: string): ProjectInfo {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('The project’s info file is not JSON.')
  }
  if (Array.isArray(raw)) {
    const names = raw.filter((x): x is string => typeof x === 'string')
    throw new Error(
      `This is a collection of ${names.length} projects (${names.join(', ')}). Point at one of ` +
        `them: the folder name added to this address.`,
    )
  }
  if (!isRecord(raw)) throw new Error('The project’s info file is not a JSON object.')

  const meta = fileOf(raw.meta, 'meta')
  if (!meta)
    throw new Error('The project’s info names no `meta` table, which BigClust requires.')

  const topFeatures = raw.features ?? undefined
  const topDistances = raw.distances ?? undefined
  const listed = raw.embeddings
  const entries: unknown[] =
    listed === undefined || listed === null ? [] : Array.isArray(listed) ? listed : [listed]

  const names = new Set<string>()
  const embeddings = entries.map((entry, i): EmbeddingEntry => {
    const spec: Record<string, unknown> = isRecord(entry) ? entry : { file: entry }
    // Unique, being what the node's dropdown stores: a repeat is told apart by a number.
    const name = uniqueName(
      names,
      typeof spec.name === 'string' ? spec.name : `embedding ${i + 1}`,
      (n) => ` (${n})`,
    )
    const features = fileOf(spec.features ?? topFeatures, 'features')
    const distances = distancesOf(spec.distances ?? topDistances)
    const common = {
      name,
      ...(features ? { features: { file: features } } : {}),
      ...(distances ? { distances } : {}),
    }
    const columns = spec.columns
    if (Array.isArray(columns)) {
      if (columns.length !== 2 || !columns.every((c) => typeof c === 'string')) {
        throw new Error(
          `Embedding "${name}" names ${columns.length} meta columns; it needs two.`,
        )
      }
      return { ...common, columns: [String(columns[0]), String(columns[1])] as const }
    }
    const file = fileOf(spec, `embedding "${name}"`)
    if (!file) throw new Error(`Embedding "${name}" names neither a file nor two meta columns.`)
    return { ...common, file }
  })

  return {
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(typeof raw.dataset === 'string' ? { dataset: raw.dataset } : {}),
    meta,
    embeddings,
    ...(isRecord(raw.neuroglancer) ? { neuroglancer: neuroglancerOf(raw.neuroglancer) } : {}),
  }
}

/** The `neuroglancer` block, with anything of a shape BigClust would not take left out. */
function neuroglancerOf(raw: Record<string, unknown>): NeuroglancerSpec {
  const { source, color, neuropil_mesh: mesh, transforms } = raw
  const stringMap = (value: unknown): value is Record<string, string> =>
    isRecord(value) && Object.values(value).every((v) => typeof v === 'string')
  const numbers = (value: unknown): value is number[] =>
    Array.isArray(value) && value.every((v) => typeof v === 'number')
  return {
    ...(typeof source === 'string' || stringMap(source) ? { source } : {}),
    ...(typeof color === 'string' || isRecord(color) || numbers(color) ? { color } : {}),
    ...(typeof mesh === 'string' && mesh.trim() ? { neuropilMesh: mesh.trim() } : {}),
    transforms: Array.isArray(transforms) && transforms.length > 0,
  }
}

function distancesOf(value: unknown): DistancesSpec | undefined {
  const file = fileOf(value, 'distances')
  if (!file) return undefined
  const type = isRecord(value) && typeof value.type === 'string' ? value.type : ''
  const t = type.trim().toLowerCase()
  return { file, knn: t === 'knn' || t.endsWith(':knn') }
}

/** A spec's path: the string itself, or an object's `file`. */
function fileOf(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (isRecord(value)) {
    if (typeof value.file === 'string') return value.file
    throw new Error(`The project’s ${what} has no \`file\`.`)
  }
  throw new Error(`The project’s ${what} is neither a path nor an object with a \`file\`.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
