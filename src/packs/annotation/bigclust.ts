/**
 * BigClust Project — one embedding of a BigClust2 project, with the tables that go with it.
 *
 * BigClust (github.com/schlegelp/BigClust2) explores embeddings of whole connectomes; a project is
 * a folder with an `info` file, a `meta` table of neurons, and embeddings with the k-NN graphs and
 * feature vectors they were computed from (`data/bigclust/info.ts` reads the format). None of it
 * could be read by wiring existing nodes together, for two reasons that are this node's whole job:
 *
 *  - **Everything aligns with `meta` by row, not by id.** Two of fish2's three embeddings carry no
 *    id column at all, and the k-NN file's neighbours are *row positions*. Coda joins on ids, and
 *    has no row-number join, so the alignment is made here, where BigClust makes it.
 *  - **The features are wide and sparse** — 129,325 × 1,062 at 1.1% non-zero, 137M cells as a
 *    table. They come out long, zeros dropped as they are read (`data/bigclust/long.ts`).
 *
 * ## One embedding, four outputs
 *
 * `Embedding` picks which of the project's embeddings the node reads — the first by default — and
 * the four outputs are the same whatever is picked:
 *
 *  - **Neurons**: `meta`, its `id` as `neuronId` (text, invariant 8). The same for every embedding.
 *  - **Embedding**: `neuronId, x, y` — the picked embedding's coordinates.
 *  - **Neighbours**: its k-NN graph long — `queryId, targetId, rank, distance` — the shape
 *    Embedding's `neighbours` port and Build Network take. Empty where it has none.
 *  - **Features**: its feature vectors, `neuronId, group, feature, value`, non-zeros only. Empty
 *    where it has none.
 *
 * Several embeddings side by side are two of these nodes and a Join on `neuronId` — which is what
 * the fixed outputs buy over a column pair per embedding or an output per embedding: a node type's
 * ports cannot follow the project, and the names below never change with it. Only meta and the
 * picked embedding's files are read. A full square distance matrix is not read — at this scale it
 * does not fit — and the node says so.
 */

import type { NodeHint } from '../../core/graph'
import { idText, ID_COLUMN_NAME } from '../../core/ids'
import type { ParamValues } from '../../core/node'
import { refreshParam } from '../../core/node'
import { packNode } from '../../core/registry'
import type { EnumOption, InferContext } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { T, column, tableSchema } from '../../core/types'
import type {
  CellValue,
  ColumnData,
  DatasetValue,
  TableFileRef,
  TableValue,
} from '../../core/values'
import { makeTable } from '../../core/values'
import type { FileSummary } from '../../data/files/columns'
import { folderProblem, remembersFolders, restoreFolder } from '../../data/bigclust/folders'
import type { EmbeddingEntry, ProjectInfo } from '../../data/bigclust/info'
import { INDEX_COLUMNS, rowMismatch } from '../../data/bigclust/info'
import type { ProjectRef } from '../../data/bigclust/project'
import type { FeaturesLong, KnnLong } from '../../data/bigclust/long'
import { SCENE_DATASET, sceneNotes, sceneSourceFor } from '../../data/bigclust/scene'
import { keptChoice } from '../../nodes/lib/keptChoice'
import {
  columnsOf,
  projectFile,
  readMeta,
  peekProject,
  projectBase,
  readLong,
  readProjectSummary,
  readWholeFile,
} from '../../data/bigclust/project'

/** Where the node's project is, or undefined while it names none. A held folder wins a URL. */
export function projectRef(params: ParamValues): ProjectRef | undefined {
  const id = String(params.folderId).trim()
  if (id) return { kind: 'local', id, name: String(params.folderName) }
  const url = projectBase(String(params.url))
  return url ? { kind: 'url', base: url } : undefined
}

/** What is known of the node's project, synchronously — the one peek every reader of it asks. */
export function peekNodeProject(params: ParamValues) {
  const ref = projectRef(params)
  return { ref, entry: ref && peekProject(ref, Number(params.refresh)) }
}

const NOTHING_CHOSEN =
  'Paste the address of a BigClust project folder (the folder containing its `info` file), or choose the folder on your disk.'

function refProblem(ref: ProjectRef | undefined): string | undefined {
  if (!ref) return NOTHING_CHOSEN
  return ref.kind === 'local' ? folderProblem(ref.id, ref.name) : undefined
}

/**
 * The embedding a node reads: the one named, or the project's first where none is. Undefined where
 * the name is not one of the project's — `validate` says which it does have.
 */
export function chosenEmbedding(
  info: ProjectInfo,
  params: ParamValues,
): EmbeddingEntry | undefined {
  const name = String(params.embedding).trim()
  return name ? info.embeddings.find((e) => e.name === name) : info.embeddings[0]
}

/**
 * The dropdown: the project's embeddings by name, the first standing in for an empty choice and
 * saying which it is — a "First" that does not name one is a question mark on a shared graph. A
 * stored name is kept while the project is unknown, so a reload does not show it as forgotten.
 */
function embeddingOptions(ctx: InferContext): EnumOption[] {
  const names = peekNodeProject(ctx.params).entry?.summary?.info.embeddings.map((e) => e.name)
  return [
    { value: '', label: names ? `First (${names[0] ?? 'none'})` : 'First' },
    ...(names ?? []).map((name) => ({ value: name, label: name })),
    ...keptChoice(String(ctx.params.embedding).trim(), names),
  ]
}

// ---------------------------------------------------------------------------
// The four schemas, each beside the value it describes (invariant 3)
// ---------------------------------------------------------------------------

/** Meta's columns, its `id` first and as `neuronId`. */
function neuronsSchema(meta: FileSummary): TableSchema {
  return tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    ...columnsOf(meta)
      .filter(({ column: c }) => c.name !== 'id')
      .map(({ column: c, dtype }) => column(c.name, dtype)),
  )
}

const EMBEDDING_SCHEMA: TableSchema = tableSchema(
  column(ID_COLUMN_NAME, 'str'),
  column('x', 'f64'),
  column('y', 'f64'),
)

const NEIGHBOURS_SCHEMA: TableSchema = tableSchema(
  column('queryId', 'str'),
  column('targetId', 'str'),
  column('rank', 'i64'),
  column('distance', 'f64'),
)

const FEATURES_SCHEMA: TableSchema = tableSchema(
  column(ID_COLUMN_NAME, 'str'),
  column('group', 'str'),
  column('feature', 'str'),
  column('value', 'f64'),
)

/**
 * A feature column's name as its group and feature: pandas writes a two-level column index as the
 * tuple's text — `('upstream', '(CH-r2)')` — which is BigClust's upstream/downstream split. A
 * plain name is a feature with no group.
 */
export function featureName(name: string): { group: string | null; feature: string } {
  const tuple = /^\(\s*(['"])(.*?)\1\s*,\s*(['"])(.*)\3\s*\)$/.exec(name)
  return tuple ? { group: tuple[2]!, feature: tuple[4]! } : { group: null, feature: name }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A number cell, or null for anything that is not one. */
function numberCell(cell: CellValue | undefined): number | null {
  return typeof cell === 'number' && Number.isFinite(cell) ? cell : null
}

/** An embedding file's two coordinate columns, and its own ids where it carries any. */
interface EmbeddingRead {
  readonly x: CellValue[]
  readonly y: CellValue[]
  readonly ids?: CellValue[]
}

/**
 * An embedding file read: the two non-index numeric columns — BigClust's "exactly two dimensions"
 * — and its index column, if any, for the order check made once meta's ids are in hand.
 */
async function readEmbedding(
  entry: EmbeddingEntry,
  file: { ref: TableFileRef; summary: FileSummary },
  signal: AbortSignal,
): Promise<EmbeddingRead> {
  const columns = columnsOf(file.summary)
  const coordinates = columns.filter(
    ({ column: c, dtype }) =>
      !INDEX_COLUMNS.has(c.name) && (dtype === 'f64' || dtype === 'i64'),
  )
  if (coordinates.length !== 2) {
    throw new Error(
      `Embedding "${entry.name}" (${entry.file}) has ${coordinates.length} coordinate columns ` +
        `(${coordinates.map((c) => c.column.name).join(', ') || 'none'}); it needs exactly two.`,
    )
  }
  const index = columns.find(({ column: c }) => INDEX_COLUMNS.has(c.name))
  const read = await readWholeFile(
    file.ref,
    file.summary,
    index ? [...coordinates, index] : coordinates,
    { signal },
  )
  const [x, y] = coordinates.map((c) => read[c.column.name]!)
  return { x: x!, y: y!, ...(index ? { ids: read[index.column.name]! } : {}) }
}

/**
 * One embedding's coordinates, aligned with meta by row: two meta columns, or a file read — whose
 * own ids, where it has them, are compared with meta's and any disagreement said, the alignment
 * being by row whatever they say, as BigClust's is.
 */
function embeddingCoordinates(
  entry: EmbeddingEntry,
  read: EmbeddingRead | undefined,
  meta: Readonly<Record<string, CellValue[]>>,
  ids: readonly string[],
  warn: (message: string) => void,
): [ColumnData, ColumnData] {
  if (!read) {
    const [x, y] = (entry.columns ?? []).map((name) => {
      const values = meta[name]
      if (!values) {
        throw new Error(
          `Embedding "${entry.name}" uses the meta column "${name}", but the meta table has no such column.`,
        )
      }
      return values.map(numberCell)
    })
    return [x!, y!]
  }
  if (read.x.length !== ids.length)
    throw rowMismatch(`Embedding "${entry.name}"`, read.x.length, ids.length)
  if (read.ids) {
    let differ = 0
    for (let i = 0; i < ids.length; i++) if (idText(read.ids[i]) !== ids[i]) differ++
    if (differ) {
      warn(
        `Embedding "${entry.name}" lists its rows in a different order from meta for ` +
          `${differ.toLocaleString()} of them. They were matched by row position, as BigClust does.`,
      )
    }
  }
  return [read.x.map(numberCell), read.y.map(numberCell)]
}

/**
 * Columns of `length` cells, written by index — the long tables are millions of rows, and growing
 * their arrays a cell at a time was most of their building.
 */
function columnsOfLength(schema: TableSchema, length: number): Record<string, CellValue[]> {
  return Object.fromEntries(schema.columns.map((c) => [c.name, new Array<CellValue>(length)]))
}

/** A k-NN file made long, positions turned into meta's ids; empty where there is none. */
function neighboursTable(
  long: KnnLong | undefined,
  file: string | undefined,
  ids: readonly string[],
  warn: (message: string) => void,
): TableValue {
  const columns = columnsOfLength(NEIGHBOURS_SCHEMA, long?.query.length ?? 0)
  if (long) {
    for (let i = 0; i < long.query.length; i++) {
      columns.queryId![i] = ids[long.query[i]!]!
      columns.targetId![i] = ids[long.target[i]!]!
      columns.rank![i] = long.rank[i]!
      columns.distance![i] = long.distance[i]!
    }
    if (long.isolated) {
      warn(
        `${long.isolated.toLocaleString()} of ${ids.length.toLocaleString()} neurons have no ` +
          `neighbour in ${file}, so they are missing from \`Neighbours\`.`,
      )
    }
  }
  return makeTable(NEIGHBOURS_SCHEMA, columns)
}

/** A features file made long, positions turned into meta's ids; empty where there is none. */
function featuresTable(long: FeaturesLong | undefined, ids: readonly string[]): TableValue {
  const columns = columnsOfLength(FEATURES_SCHEMA, long?.row.length ?? 0)
  if (long) {
    const names = long.names.map(featureName)
    for (let i = 0; i < long.row.length; i++) {
      const name = names[long.column[i]!]!
      columns[ID_COLUMN_NAME]![i] = ids[long.row[i]!]!
      columns.group![i] = name.group
      columns.feature![i] = name.feature
      columns.value![i] = long.value[i]!
    }
  }
  return makeTable(FEATURES_SCHEMA, columns)
}

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

const FORGETS_FOLDERS: readonly NodeHint[] = [
  {
    text:
      'This browser cannot keep a project folder across a reload: after one, choose the folder ' +
      'again. Chrome and Edge remember it, and a URL works in every browser.',
  },
]
const NO_HINTS: readonly NodeHint[] = []

export const projectNode = packNode({
  type: 'annotation:bigclust',
  label: 'BigClust Project',
  category: 'query',
  cardWidth: 300,
  description:
    'Read one embedding of a BigClust project: its neurons, their coordinates, the k-NN ' +
    'graph and the feature vectors.',
  guide:
    'Reads one embedding from a BigClust project, at a URL or on your disk: the neurons, their ' +
    'x/y coordinates and, where the project has them, the k-NN graph and feature vectors. Plot ' +
    'the coordinates with a Scatter Plot, or wire the Scene output into a Neuroglancer node to ' +
    'see the neurons in 3D.',
  cost: 'expensive',
  inputs: [],
  outputs: [
    { id: 'neurons', label: 'Neurons', type: T.neurons() },
    { id: 'embedding', label: 'Embedding', type: T.neurons(EMBEDDING_SCHEMA) },
    { id: 'neighbours', label: 'Neighbours', type: T.table(NEIGHBOURS_SCHEMA) },
    { id: 'features', label: 'Features', type: T.table(FEATURES_SCHEMA) },
    /*
     * The project's neuroglancer block as a scene, for the Neuroglancer node's Dataset socket — a
     * datasource, as Neuroglancer Source's is, whose source publishes a scene and nothing else
     * (`data/bigclust/scene.ts`). Every node on one project shares it.
     */
    { id: 'scene', label: 'Scene', type: T.dataset() },
  ],
  params: [
    {
      id: 'url',
      kind: 'string',
      label: 'URL',
      placeholder: 'https://…/project or gs://…/project',
      // Ignored while a folder is chosen, so neither drawn nor in the key then.
      visibleIf: (params) => !String(params.folderId).trim(),
      help: 'The project folder holding info, meta.parquet and the embeddings. The server must allow cross-origin requests (a public gs:// bucket does).',
      default: '',
    },
    // Written by the card, never typed; in the inspector because it is the only place the folder
    // behind a card can be seen.
    { id: 'folderId', kind: 'string', label: 'Folder', default: '', advanced: true },
    {
      id: 'folderName',
      kind: 'string',
      label: 'Folder name',
      default: '',
      advanced: true,
      // `folderId` decides what is read; the name is for saying which folder to choose again.
      presentational: true,
      browserStored: 'a local project folder',
    },
    {
      id: 'embedding',
      kind: 'enum',
      label: 'Embedding',
      help: 'Which of the project’s embeddings to read. Empty reads the first.',
      default: '',
      options: embeddingOptions,
    },
    refreshParam('Reads the project’s info file, meta and embedding files again.'),
  ],

  readerHints: (params) =>
    projectRef(params)?.kind === 'local' && !remembersFolders() ? FORGETS_FOLDERS : NO_HINTS,

  inferOutputs: (ctx) => {
    const summary = peekNodeProject(ctx.params).entry?.summary
    return {
      neurons: T.neurons(summary && neuronsSchema(summary.meta)),
      embedding: T.neurons(EMBEDDING_SCHEMA),
      neighbours: T.table(NEIGHBOURS_SCHEMA),
      features: T.table(FEATURES_SCHEMA),
      scene: sceneType(ctx.params),
    }
  },

  validate: (ctx) => {
    const { ref, entry } = peekNodeProject(ctx.params)
    const problem = refProblem(ref)
    if (problem) return [problem]
    if (entry?.error) return [entry.error]
    const info = entry?.summary?.info
    if (!info) return []
    if (info.embeddings.length === 0) return ['The project has no embeddings.']
    const chosen = chosenEmbedding(info, ctx.params)
    if (!chosen) return [notAnEmbedding(info, ctx.params)]
    const matrix = matrixNote(chosen)
    return matrix ? [matrix] : []
  },

  evaluate: async (ctx) => {
    const ref = projectRef(ctx.params)
    if (ref?.kind === 'local') await restoreFolder(ref.id)
    const problem = refProblem(ref)
    if (!ref || problem) throw new Error(problem)
    const refresh = Number(ctx.params.refresh)

    ctx.progress(0.02, 'reading info')
    const summary = await readProjectSummary(ref, { refresh, signal: ctx.signal })
    const { info } = summary
    const chosen = chosenEmbedding(info, ctx.params)
    if (!chosen) {
      throw new Error(
        info.embeddings.length
          ? notAnEmbedding(info, ctx.params)
          : 'The project has no embeddings.',
      )
    }
    const matrix = matrixNote(chosen)
    if (matrix) ctx.warn(matrix)
    const rows = summary.meta.rows
    if (rows === undefined) {
      throw new Error('The project’s meta table does not say how many rows it has.')
    }

    // Meta and the chosen embedding's files at once: each is only ever matched to meta's row
    // count, which its footer gave. One failure stops the rest rather than leaving them decoding.
    const failed = new AbortController()
    const signal = AbortSignal.any([ctx.signal, failed.signal])
    const open = (path: string) => projectFile(ref, path, refresh, signal)
    const knnFile = chosen.distances?.knn ? chosen.distances.file : undefined
    const featuresFile = chosen.features?.file
    ctx.progress(0.05, 'reading the project')
    const [meta, embedding, knnLong, featuresLong] = await Promise.all([
      readMeta(ref, summary, refresh, signal),
      chosen.file
        ? open(chosen.file).then((file) => readEmbedding(chosen, file, signal))
        : undefined,
      knnFile ? open(knnFile).then((f) => readLong(f.ref, 'knn', rows, { signal })) : undefined,
      featuresFile
        ? open(featuresFile).then((f) => readLong(f.ref, 'features', rows, { signal }))
        : undefined,
    ]).catch((error: unknown) => {
      failed.abort()
      throw error
    })

    const { ids, cells } = meta
    const warn = ctx.warn.bind(ctx)
    const metaSchema = neuronsSchema(summary.meta)
    const neurons = makeTable(
      metaSchema,
      Object.fromEntries(
        metaSchema.columns.map((c) => [
          c.name,
          c.name === ID_COLUMN_NAME ? ids : cells[c.name]!,
        ]),
      ),
      'neurons',
    )
    const [x, y] = embeddingCoordinates(chosen, embedding, cells, ids, warn)
    const coordinates = makeTable(EMBEDDING_SCHEMA, { [ID_COLUMN_NAME]: ids, x, y }, 'neurons')
    const neighbours = neighboursTable(knnLong, knnFile, ids, warn)
    const features = featuresTable(featuresLong, ids)
    for (const note of sceneNotes(info.neuroglancer)) ctx.warn(note)
    const source = sceneSourceFor(ref, refresh)
    const scene: DatasetValue = {
      kind: 'dataset',
      sourceId: source.id,
      datasetId: SCENE_DATASET,
      label: `${info.name ?? source.label} · scene`,
    }
    return { neurons, embedding: coordinates, neighbours, features, scene }
  },
})

/** The Scene output's type: the project's scene source, once there is a project to name. */
function sceneType(params: ParamValues) {
  const ref = projectRef(params)
  return ref
    ? T.dataset(sceneSourceFor(ref, Number(params.refresh)).id, SCENE_DATASET)
    : T.dataset()
}

/** The refusal for a stored embedding name the project does not have. */
function notAnEmbedding(info: ProjectInfo, params: ParamValues): string {
  return (
    `The project has no embedding "${String(params.embedding)}". It has: ` +
    `${info.embeddings.map((e) => e.name).join(', ')}.`
  )
}

/** The sentence for an embedding whose distances are a full matrix, which is not read. */
function matrixNote(entry: EmbeddingEntry): string | undefined {
  if (!entry.distances || entry.distances.knn) return undefined
  return (
    `${entry.distances.file} is a full distance matrix and is skipped, because for a whole ` +
    `connectome it is too large to load. \`Neighbours\` is filled only from a k-NN graph.`
  )
}
