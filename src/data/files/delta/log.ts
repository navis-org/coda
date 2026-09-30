/**
 * A Delta table's state at one version, read out of its transaction log — which data files are
 * live, what each holds, and how its columns are named and typed.
 *
 * A Delta table is a folder of Parquet files and a `_delta_log/` of commits saying which of them
 * make up the table: an `add` puts a file in, a `remove` takes one out, and a delete or a
 * compaction leaves the old files on disk until somebody vacuums. So the files are **never
 * listed** — a listing would count files the table no longer holds — they are *replayed*: the
 * newest checkpoint (a Parquet file of the live actions, every hundred versions or so), then every
 * JSON commit after it, in order.
 *
 * What comes out is plain data (`DeltaSnapshot`), because it is built once on the page and handed
 * to every worker a read splits across: a few kB per live file, where re-reading the log per
 * worker would be a hundred requests each.
 *
 * ## Three things read exactly, or refused
 *
 *  - **Reader features.** A table declares what a reader must understand to read it correctly.
 *    `deletionVectors`, `columnMapping`, `timestampNtz` and `vacuumProtocolCheck` are understood;
 *    anything else is refused by name, since reading such a table as if it were plain would
 *    return wrong rows without a word.
 *  - **Stats.** Each `add` carries its file's row count and per-column min/max as a JSON string,
 *    and CAVE's ids are eighteen digits: `JSON.parse` would round them into other neurons and the
 *    file skipping built on them would skip the file that holds the id. `parseStats` reads every
 *    integer a double cannot hold as text.
 *  - **Column mapping.** Under `delta.columnMapping.mode` a column's name in the files, its stats
 *    and its partition values is a *physical* name, and the table's own name is only in the
 *    schema. Every name in the snapshot's files is physical; `fields` maps between the two.
 */

import { hashValue } from '../../../core/hash'
import { mapWithConcurrency } from '../../concurrency'
import { quoteWideIntegers } from '../../cave/json'
import { hyparquet, pageLibraries } from '../../libraries'
import { exactBuffer } from '../bytes'
import { utf8 } from '../columns'
import type { DeletionVectorDescriptor } from './deletionVectors'

/** A Delta table's column: its name, its name in the files, and its Spark type. */
export interface DeltaField {
  readonly name: string
  readonly physical: string
  /** A primitive Spark type (`long`, `string`, `decimal(20,0)`…), or `nested` for a struct, array or map. */
  readonly type: string
}

/** A min or max from the log: text for an integer too wide for a double, as written otherwise. */
export type DeltaStat = string | number | boolean

/** One live data file. Every column name here is physical. */
export interface DeltaFile {
  /** The path as the log writes it — relative to the root, URL-encoded, or an absolute URI. */
  readonly path: string
  readonly size: number
  readonly partition: Readonly<Record<string, string | null>>
  readonly rows?: number
  readonly min?: Readonly<Record<string, DeltaStat>>
  readonly max?: Readonly<Record<string, DeltaStat>>
  readonly dv?: DeletionVectorDescriptor
}

export interface DeltaSnapshot {
  /** The table's root, as an http(s) URL with no trailing slash. */
  readonly root: string
  readonly version: number
  readonly fields: readonly DeltaField[]
  /** Logical names. */
  readonly partitionColumns: readonly string[]
  readonly files: readonly DeltaFile[]
  /** The table at this version: its root, the version and the live files — what a read checks. */
  readonly fingerprint: string
}

/** Where a table's objects are read from: over HTTP in the app, off disk in a test. */
export interface DeltaStore {
  /** The table's root, for the snapshot. */
  readonly root: string
  /**
   * An object's bytes by its path under the root, or undefined where there is none. `maxBytes`
   * refuses a larger answer rather than reading it.
   */
  read(path: string, maxBytes?: number): Promise<Uint8Array | undefined>
  /**
   * The names in `_delta_log/` from `from` on, ascending — or undefined where this store cannot
   * list, and the commits after a checkpoint are found by asking for each in turn.
   */
  listLog?(from: string): Promise<string[] | undefined>
}

const READER_FEATURES = new Set([
  'deletionVectors',
  'columnMapping',
  'timestampNtz',
  'vacuumProtocolCheck',
])

/** A version as the log names its files: twenty digits. */
const padded = (version: number) => String(version).padStart(20, '0')

/** Commits asked for at once where the store cannot list them. */
const PROBE_BATCH = 8

/** Log files read at once. */
const LOG_READS = 16

export async function readDeltaSnapshot(store: DeltaStore): Promise<DeltaSnapshot> {
  const last = await readJson(store, '_delta_log/_last_checkpoint')
  if (last?.v2Checkpoint) {
    throw new Error('This Delta table uses a v2 checkpoint, which Coda does not read yet.')
  }
  const from = typeof last?.version === 'number' ? last.version : undefined
  const names = await store.listLog?.(`_delta_log/${padded(from ?? 0)}`)
  const { checkpoint, commits } = names
    ? listedLog(names)
    : await probedLog(store, from, last?.parts)

  // Fetched together, replayed in order: a hundred commits after a checkpoint one after another
  // is a hundred round trips, which was most of opening CAVE's tables.
  const [fromCheckpoint, fromCommits] = await Promise.all([
    Promise.all((checkpoint?.parts ?? []).map((part) => checkpointActions(store, part))),
    mapWithConcurrency(commits, LOG_READS, async ({ version, bytes }) => {
      const held = bytes ?? (await store.read(commitPath(version)))
      return held && commitActions(held)
    }),
  ])
  // A commit that could not be read is a table that cannot be read: the replay would skip it.
  const missing = fromCommits.findIndex((actions) => !actions)
  if (missing !== -1) {
    throw new Error(`The Delta log's version ${commits[missing]!.version} could not be read.`)
  }
  const version = commits.at(-1)?.version ?? checkpoint?.version
  if (version === undefined) {
    throw new Error(
      `There is no Delta table at ${store.root}: it has no _delta_log. Link Table reads a ` +
        'Parquet or Feather file, or the folder of a Delta table.',
    )
  }
  return replay(store.root, version, [...fromCheckpoint, ...fromCommits].flat() as Action[])
}

/** An action, as a commit line or a checkpoint row holds one — only the kinds a reader needs. */
interface Action {
  add?: RawFile
  remove?: { path: string; deletionVector?: DeletionVectorDescriptor | null }
  metaData?: {
    schemaString: string
    partitionColumns: string[]
    configuration?: Record<string, string> | null
  }
  protocol?: { minReaderVersion: number; readerFeatures?: string[] | null }
}

interface RawFile {
  path: string
  size: number | bigint
  partitionValues?: Record<string, string | null> | null
  stats?: string | null
  deletionVector?: DeletionVectorDescriptor | null
}

async function readJson(
  store: DeltaStore,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  // A few hundred bytes where it exists; capped, so an address that answers every path with
  // something large is refused rather than downloaded.
  const bytes = await store.read(path, 1 << 16)
  if (!bytes) return undefined
  try {
    return JSON.parse(utf8.decode(bytes)) as Record<string, unknown>
  } catch {
    throw new Error(`${store.root}/${path} is not the JSON a Delta table keeps there.`)
  }
}

const commitPath = (version: number) => `_delta_log/${padded(version)}.json`

/** A commit's actions: one JSON object a line. */
function commitActions(bytes: Uint8Array): Action[] {
  return utf8
    .decode(bytes)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Action)
}

/** The checkpoint to start from and the commits after it, with a commit's bytes where held. */
interface LogFiles {
  checkpoint?: { version: number; parts: string[] }
  commits: { version: number; bytes?: Uint8Array }[]
}

/**
 * The log as a listing names it. The newest checkpoint may be newer than `_last_checkpoint`, which
 * is written after it, so it is taken from the names rather than from that file.
 */
function listedLog(names: readonly string[]): LogFiles {
  const commits = new Set<number>()
  // By version: the parts found, and how many the checkpoint has.
  const checkpoints = new Map<number, { parts: string[]; of: number }>()
  for (const name of names) {
    const commit = /^(\d{20})\.json$/.exec(name)
    if (commit) commits.add(Number(commit[1]))
    const single = /^(\d{20})\.checkpoint\.parquet$/.exec(name)
    if (single) checkpoints.set(Number(single[1]), { parts: [name], of: 1 })
    const part = /^(\d{20})\.checkpoint\.(\d{10})\.(\d{10})\.parquet$/.exec(name)
    if (part) {
      const held = checkpoints.get(Number(part[1])) ?? { parts: [], of: Number(part[3]) }
      held.parts[Number(part[2]) - 1] = name
      checkpoints.set(Number(part[1]), held)
    }
  }
  // Only one with every part there: a partial one is a checkpoint still being written.
  const newest = [...checkpoints]
    .filter(([, { parts, of }]) => parts.length === of && parts.every(Boolean))
    .sort(([a], [b]) => b - a)[0]
  const start = newest?.[0] ?? -1
  return {
    ...(newest
      ? {
          checkpoint: {
            version: newest[0],
            parts: newest[1].parts.map((name) => `_delta_log/${name}`),
          },
        }
      : {}),
    commits: [...commits]
      .filter((version) => version > start)
      .sort((a, b) => a - b)
      .map((version) => ({ version })),
  }
}

/**
 * The log of a store that cannot list: the checkpoint `_last_checkpoint` names, and each commit
 * after it asked for in turn, a batch at a time, to the first that is not there. Asking is
 * reading, so what comes back is kept for the replay rather than fetched again.
 */
async function probedLog(
  store: DeltaStore,
  from: number | undefined,
  parts: unknown,
): Promise<LogFiles> {
  const ten = (n: number) => String(n).padStart(10, '0')
  const stem = `_delta_log/${padded(from ?? 0)}.checkpoint`
  const checkpoint =
    from === undefined
      ? undefined
      : {
          version: from,
          parts:
            typeof parts === 'number' && parts > 1
              ? Array.from(
                  { length: parts },
                  (_, i) => `${stem}.${ten(i + 1)}.${ten(parts)}.parquet`,
                )
              : [`${stem}.parquet`],
        }
  const commits: LogFiles['commits'] = []
  for (let next = (from ?? -1) + 1; ; next += PROBE_BATCH) {
    const batch = await Promise.all(
      Array.from({ length: PROBE_BATCH }, (_, i) => store.read(commitPath(next + i))),
    )
    for (const [i, bytes] of batch.entries()) {
      if (!bytes) return { ...(checkpoint ? { checkpoint } : {}), commits }
      commits.push({ version: next + i, bytes })
    }
  }
}

/** A checkpoint part's actions — the live files, the schema and the protocol, nothing else. */
async function checkpointActions(store: DeltaStore, path: string): Promise<Action[]> {
  const bytes = await store.read(path)
  if (!bytes) throw new Error(`The Delta log's checkpoint ${path} is missing.`)
  const [{ parquetReadObjects }, { codecs }] = await Promise.all([hyparquet(), pageLibraries()])
  const rows = (await parquetReadObjects({
    file: exactBuffer(bytes),
    columns: ['add', 'metaData', 'protocol'],
    // A checkpoint is written in the table's codec, which on a compacted table is ZSTD.
    compressors: codecs,
  })) as Array<Record<string, unknown>>
  return rows.flatMap((row) => {
    const action: Action = {}
    if (row.add) action.add = row.add as RawFile
    if (row.metaData) action.metaData = row.metaData as NonNullable<Action['metaData']>
    if (row.protocol) action.protocol = row.protocol as NonNullable<Action['protocol']>
    return Object.keys(action).length ? [action] : []
  })
}

/** A file action's identity: its path, and its deletion vector where it has one. */
function fileKey(path: string, dv: DeletionVectorDescriptor | null | undefined): string {
  return dv ? `${path}\u0001${dv.storageType}${dv.pathOrInlineDv}@${dv.offset ?? ''}` : path
}

function replay(root: string, version: number, actions: readonly Action[]): DeltaSnapshot {
  const live = new Map<string, RawFile>()
  let metaData: Action['metaData']
  let protocol: Action['protocol']
  for (const action of actions) {
    if (action.add) live.set(fileKey(action.add.path, action.add.deletionVector), action.add)
    if (action.remove) live.delete(fileKey(action.remove.path, action.remove.deletionVector))
    if (action.metaData) metaData = action.metaData
    if (action.protocol) protocol = action.protocol
  }
  if (!metaData || !protocol) throw new Error('The Delta log names no schema or protocol.')
  checkProtocol(protocol)

  const mapped = ['name', 'id'].includes(
    metaData.configuration?.['delta.columnMapping.mode'] ?? '',
  )
  const fields = schemaFields(metaData.schemaString, mapped)
  const files = [...live.values()]
    .map((raw): DeltaFile => {
      const stats = raw.stats ? parseStats(raw.stats) : undefined
      return {
        path: raw.path,
        size: Number(raw.size),
        partition: raw.partitionValues ?? {},
        ...(stats?.numRecords === undefined ? {} : { rows: Number(stats.numRecords) }),
        ...(stats?.minValues ? { min: flatStats(stats.minValues) } : {}),
        ...(stats?.maxValues ? { max: flatStats(stats.maxValues) } : {}),
        ...(raw.deletionVector ? { dv: descriptor(raw.deletionVector) } : {}),
      }
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    root,
    version,
    fields,
    partitionColumns: metaData.partitionColumns,
    files,
    fingerprint: `delta:${hashValue([root, version, files.map((f) => fileKey(f.path, f.dv))])}`,
  }
}

function checkProtocol(protocol: NonNullable<Action['protocol']>): void {
  if (protocol.minReaderVersion > 3) {
    throw new Error(
      `This Delta table needs reader version ${protocol.minReaderVersion}, which Coda does not read yet.`,
    )
  }
  const unknown = (protocol.readerFeatures ?? []).filter((f) => !READER_FEATURES.has(f))
  if (unknown.length) {
    throw new Error(
      `This Delta table uses ${unknown.join(', ')}, which Coda does not read yet — reading it ` +
        'anyway could return rows the table does not hold.',
    )
  }
}

interface SparkField {
  name: string
  type: string | { type: string }
  metadata?: Record<string, unknown>
}

function schemaFields(schemaString: string, mapped: boolean): DeltaField[] {
  const schema = JSON.parse(schemaString) as { fields: SparkField[] }
  return schema.fields.map((field) => {
    const physical = mapped ? field.metadata?.['delta.columnMapping.physicalName'] : undefined
    return {
      name: field.name,
      physical: typeof physical === 'string' ? physical : field.name,
      type: typeof field.type === 'string' ? field.type : 'nested',
    }
  })
}

/** A deletion vector with its numbers as numbers — a checkpoint hands them over as `bigint`. */
function descriptor(dv: DeletionVectorDescriptor): DeletionVectorDescriptor {
  return {
    storageType: dv.storageType,
    pathOrInlineDv: dv.pathOrInlineDv,
    ...(dv.offset === undefined || dv.offset === null ? {} : { offset: Number(dv.offset) }),
    sizeInBytes: Number(dv.sizeInBytes),
    cardinality: Number(dv.cardinality),
  }
}

interface Stats {
  numRecords?: number
  minValues?: Record<string, unknown>
  maxValues?: Record<string, unknown>
}

/**
 * A file's stats, with every integer a double cannot hold kept as its text: past 2^53 a double is
 * a different number, and an eighteen-digit id rounded is a different neuron — the file skipping
 * built on it would skip the file that holds the id. CAVE's own JSON has the same problem and
 * `quoteWideIntegers` is its answer, string-aware on purpose: a text column's min or max may hold
 * `,720575940600000013,` and a pattern that looked inside a string would splice quotes into it.
 */
export function parseStats(text: string): Stats {
  return JSON.parse(quoteWideIntegers(text)) as Stats
}

/** A stats object's values by column, nested struct columns left out — a reader keeps none. */
function flatStats(values: Record<string, unknown>): Record<string, DeltaStat> {
  const out: Record<string, DeltaStat> = {}
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[name] = value
    }
  }
  return out
}
