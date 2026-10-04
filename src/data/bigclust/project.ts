/**
 * A BigClust project, read: where its files are, what its `info` and its `meta` footer say
 * (peeked synchronously, for inference), and the reads a run makes.
 *
 * ## Every file is an ordinary table file
 *
 * A project file becomes a `TableFileRef` — a URL joined onto the project's address, or a file of
 * a held folder handed to the table-file registry as a local file — so footers, range reads and
 * the reading worker are Link Table's. What is BigClust's own is only the alignment: every file is
 * matched to `meta` **by row**, not joined on an id, which is what BigClust itself does; and the
 * two wide files are made long in a worker of their own (`long.ts`).
 *
 * ## The peek
 *
 * Inference may not await, and the node's output schema needs `meta`'s columns and the
 * embeddings' names, so a project's `info` and `meta` footer are kept here and announced through
 * `reportUploadLearned` — the channel Link Table's footers use. The peek starts the read it cannot
 * answer, once per project and refresh nonce (CLAUDE.md's peek rule); a project is public data or
 * a local folder, so there is no credential to gate it on.
 */

import { errorMessage } from '../../core/errors'
import { idText } from '../../core/ids'
import type { CellValue, TableFileRef } from '../../core/values'
import { fetchText } from '../fetchText'
import { memoPromise, untilAborted } from '../memoPromise'
import { reportUploadLearned } from '../uploads'
import { httpUrl } from '../files/bytes'
import { readTableFileRows } from '../files/client'
import type { FileSummary } from '../files/columns'
import { fileTableSchema, textColumnsFor } from '../files/columns'
import type { OutputColumn } from '../files/read'
import { fileSpec, holdLocalFile, readTableFileSummary } from '../files/registry'
import { runWorkerJob } from '../workerJob'
import type { JobRunOptions } from '../workerJob'
import { folderFile, folderProblem, restoreFolder } from './folders'
import type { ProjectInfo } from './info'
import { parseInfo } from './info'
import type { LongJob, LongResult } from './long'

/** Where a project is: an address, or a folder this browser holds. */
export type ProjectRef =
  | { readonly kind: 'url'; readonly base: string }
  | { readonly kind: 'local'; readonly id: string; readonly name: string }

/**
 * A project's address as its folder: the trailing `/info` and slashes taken off, since somebody
 * pasting the `info` file's own address means the project it describes.
 */
export function projectBase(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/info$/, '')
}

/**
 * A path as BigClust resolves it: an address as written, anything else below the project — and so
 * also whether a neuroglancer source is one a link can carry (`scene.ts`).
 */
export function isAddress(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
}

/** Where one of a project's files is, as the table-file registry names it. */
async function projectFileRef(project: ProjectRef, path: string): Promise<TableFileRef> {
  if (isAddress(path)) return { kind: 'url', url: path }
  if (project.kind === 'url')
    return { kind: 'url', url: `${project.base}/${path.replace(/^\.?\//, '')}` }
  const file = await folderFile(project.id, path, project.name)
  return { kind: 'local', id: holdLocalFile(file), name: file.name }
}

/** Unsignalled: the summary read is shared, and each caller stops waiting on its own. */
async function readInfoText(project: ProjectRef): Promise<string> {
  if (project.kind === 'local')
    return (await folderFile(project.id, 'info', project.name)).text()
  return fetchText(httpUrl(`${project.base}/info`), {
    notFound:
      `There is no project at ${project.base}: its info file was not found. Point at the ` +
      `folder holding info, meta.parquet and the embeddings.`,
  })
}

/** What a project's `info` and `meta` footer say — all inference needs. */
export interface ProjectSummary {
  readonly info: ProjectInfo
  readonly meta: FileSummary
  readonly metaRef: TableFileRef
}

type Entry = { readonly refresh: number } & (
  | { readonly summary: ProjectSummary; readonly error?: undefined }
  | { readonly error: string; readonly summary?: undefined }
)

const entries = new Map<string, Entry>()
const pending = new Map<string, Promise<ProjectSummary>>()

/** A project's identity: its address, or the id of the folder this browser holds. */
export function projectKey(project: ProjectRef): string {
  return project.kind === 'url' ? `url:${project.base}` : `local:${project.id}`
}

/**
 * What is known about a project, synchronously — and, where nobody has read it under this nonce,
 * the read started. A local folder still being looked for is left to its own restore, which
 * announces itself and brings the peek back.
 */
export function peekProject(project: ProjectRef, refresh = 0): Entry | undefined {
  const entry = entries.get(projectKey(project))
  if (entry?.refresh === refresh) return entry
  const readable =
    project.kind === 'url' || folderProblem(project.id, project.name) === undefined
  if (readable) void readProjectSummary(project, { refresh }).catch(() => {})
  return entry
}

/**
 * A project's `info` and `meta` footer: the ones already read under this nonce, or a fresh read
 * that is remembered — success or failure — and announced. Shared while in flight, and carrying
 * nobody's signal, for the table-file registry's reason: each caller stops waiting on its own.
 */
export function readProjectSummary(
  project: ProjectRef,
  options: { refresh?: number; signal?: AbortSignal } = {},
): Promise<ProjectSummary> {
  const refresh = options.refresh ?? 0
  const key = projectKey(project)
  const kept = entries.get(key)
  if (kept?.summary && kept.refresh === refresh) return Promise.resolve(kept.summary)
  const shared = memoPromise(
    pending,
    `${key}#${refresh}`,
    async () => {
      try {
        if (project.kind === 'local') await restoreFolder(project.id)
        const info = parseInfo(await readInfoText(project))
        const { ref: metaRef, summary: meta } = await projectFile(project, info.meta, refresh)
        if (!meta.columns.some((c) => c.name === 'id')) {
          throw new Error(
            `The project’s meta table (${info.meta}) has no id column, which BigClust requires.`,
          )
        }
        const summary = { info, meta, metaRef }
        entries.set(key, { summary, refresh })
        return summary
      } catch (error) {
        entries.set(key, { error: errorMessage(error), refresh })
        throw error
      } finally {
        reportUploadLearned()
      }
    },
    { keep: 'inflight' },
  )
  return untilAborted(shared, options.signal)
}

/**
 * Every column of a file, typed as Link Table types it on its defaults: a 64-bit id column as text.
 * The one statement for the schema the node publishes and the rows it reads.
 */
export function columnsOf(summary: FileSummary): OutputColumn[] {
  const schema = fileTableSchema(summary, textColumnsFor(summary, true, []))
  return summary.columns.map((column, i) => ({ column, dtype: schema.columns[i]!.dtype }))
}

/** A whole file's rows, as cells by column, through the table-file worker. */
export async function readWholeFile(
  ref: TableFileRef,
  summary: FileSummary,
  columns: readonly OutputColumn[],
  options: JobRunOptions = {},
): Promise<Record<string, CellValue[]>> {
  const spec = await fileSpec(ref, options.signal)
  const result = await readTableFileRows(
    spec,
    {
      fingerprint: summary.fingerprint,
      columns,
      limit: summary.rows ?? Number.MAX_SAFE_INTEGER,
    },
    options,
  )
  return result.data
}

/**
 * Meta read: its cells by column, and its ids as text in row order. Shared by every node on the
 * project, which is safe on the rule every node keeps — columns are never mutated, only rebuilt.
 */
interface MetaRead {
  readonly cells: Readonly<Record<string, CellValue[]>>
  readonly ids: string[]
}

/**
 * Each project's meta by project and refresh nonce: the read while it is in flight, so nodes
 * running together share it, and then only a **weak** reference to its ids — the one array every
 * node output built from it holds (`neuronId` on Neurons and Embedding). Held strongly, a decoded
 * meta (~100 MB at fish2) would outlive every node that read it, one per project opened in the
 * session; held weakly it lives exactly as long as some output does. The cells hang off the ids
 * (`cellsOf`), the record holding them being something no output keeps.
 */
const metas = new Map<string, Promise<MetaRead> | WeakRef<string[]>>()
const cellsOf = new WeakMap<string[], Readonly<Record<string, CellValue[]>>>()

/**
 * A project's meta, decoded once for every node reading it: several nodes on one project, an
 * embedding each and joined, would otherwise decode the same 46 columns of 129,325 rows apiece and
 * hold a copy each. Carrying nobody's signal (each caller stops waiting on its own), as
 * `readProjectSummary` does.
 */
export function readMeta(
  project: ProjectRef,
  summary: ProjectSummary,
  refresh: number,
  signal?: AbortSignal,
): Promise<MetaRead> {
  const key = `${projectKey(project)}#${refresh}`
  const kept = metas.get(key)
  if (kept instanceof WeakRef) {
    const ids = kept.deref()
    const cells = ids && cellsOf.get(ids)
    if (ids && cells) return Promise.resolve({ ids, cells })
  } else if (kept) {
    return untilAborted(kept, signal)
  }
  const read = readWholeFile(summary.metaRef, summary.meta, columnsOf(summary.meta)).then(
    (cells): MetaRead => ({
      cells,
      ids: (cells.id ?? []).map((cell, row) => {
        const id = idText(cell)
        if (id === null) {
          throw new Error(
            `Meta row ${(row + 1).toLocaleString()} has no id, which BigClust requires.`,
          )
        }
        return id
      }),
    }),
  )
  metas.set(key, read)
  // Kept weakly once read; a failure is not kept, so the next run tries again. Only while this
  // read is still the entry, a ⟳ meanwhile having started another.
  read.then(
    ({ ids, cells }) => {
      if (metas.get(key) !== read) return
      cellsOf.set(ids, cells)
      metas.set(key, new WeakRef(ids))
    },
    () => metas.get(key) === read && metas.delete(key),
  )
  return untilAborted(read, signal)
}

/**
 * One of a project's files and its footer, read under the node's refresh nonce.
 *
 * **A file at a URL is downloaded whole, in one request** (`whole`): every file the node opens it
 * reads in full — meta's every column, the k-NN graph, the features — so reading by range buys
 * nothing and costs a request per column chunk, about 8,400 for the example project's 60 MB
 * features file, where one dropped connection failed the whole read. It also serves a server that
 * will not hand over part of a file (nginx gzipping on the fly), which Link Table refuses. A full
 * distance matrix, the one file that could be gigabytes, is never opened (`matrixNote`). The
 * download is the registry's, so the reference stays the URL; a held folder is read as it is.
 */
export async function projectFile(
  project: ProjectRef,
  path: string,
  refresh: number,
  signal?: AbortSignal,
): Promise<{ ref: TableFileRef; summary: FileSummary }> {
  const ref = await projectFileRef(project, path)
  const summary = await readTableFileSummary(ref, {
    refresh,
    whole: true,
    ...(signal ? { signal } : {}),
  })
  return { ref, summary }
}

/** One of a project's wide files made long in the BigClust worker (`long.ts`). */
export async function readLong<K extends LongJob['kind']>(
  ref: TableFileRef,
  kind: K,
  rows: number,
  options: JobRunOptions = {},
): Promise<Extract<LongResult, { kind: K }>> {
  const spec = await fileSpec(ref, options.signal)
  const result = await runWorkerJob<LongJob, LongResult>(
    // Written out here, where vite can see it — see `workerJob.ts`.
    () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    { kind, spec, rows },
    {
      signal: options.signal,
      onProgress: options.onProgress,
      label: 'BigClust reader',
      here: async (j, o) => (await import('./long')).longJob(j, o),
    },
  )
  return result as Extract<LongResult, { kind: K }>
}

/** Test seam: forget every project read. */
export function resetProjects(): void {
  entries.clear()
  pending.clear()
  metas.clear()
}
