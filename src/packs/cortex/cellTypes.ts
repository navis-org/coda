/**
 * Where the gallery's cell types come from: the `Cell type source` dropdown, as annotation reads.
 *
 * The gallery takes a bare Dataset. minnie65 keeps its typing — and its proofreading flags — in
 * tables beside the neuron table rather than on it, so a Dataset dropped from the palette arrives
 * with root ids and nothing to group them by. The gallery therefore reads the frame's declared
 * tables itself (`CorticalFrame.cellTypes`, `.proofreading`), through the CAVE table reader the
 * `CAVE table` card uses, and joins them onto whatever the Dataset already carries.
 *
 * **The proofreading table is read whichever typing is chosen**, so switching to the m-types
 * never quietly switches the proofreading filter off. Where the two are one table it is one read.
 *
 * Headless, so `evaluate`, inference and the card ask one function each: `cellTypeRefs` for which
 * tables, `cellTypesSchema` beside `cellTypeAnnotations` for the schema and value halves
 * (invariant 3).
 */

import type { EnumOption, ParamDef } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { datasetRef } from '../../core/types'
import type { DatasetAnnotations } from '../../core/values'
import { peekRefColumns, requireAnnotationProvider } from '../../data/annotations/registry'
import type { AnnotationFetchOptions, AnnotationRef } from '../../data/annotations/types'
import { refKey } from '../../data/annotations/types'
import { joinAnnotations, joinedSchema } from '../../nodes/lib/annotationOps'
import type { DatasetIdentity } from '../../nodes/lib/caveParams'
import { caveTableRef } from '../../nodes/lib/caveParams'
import type { CellTypeSource, CorticalFrame } from './frames'
import { frameOf } from './frames'

/** The dropdown's "read no typing table": the Dataset's own columns, and whatever is wired. */
export const NO_CELL_TYPES = 'none'

/**
 * The dropdown's options. The default is `''` rather than the first table's name, so a graph
 * saved today follows the frame if its first choice is ever revised.
 */
export function cellTypeOptions(frame: CorticalFrame | undefined): EnumOption[] {
  const [first, ...rest] = frame?.cellTypes ?? []
  return [
    first
      ? { value: '', label: first.table, note: first.note }
      : { value: '', label: 'Default' },
    ...rest.map((source) => ({ value: source.table, label: source.table, note: source.note })),
    { value: NO_CELL_TYPES, label: 'None', note: 'the dataset’s own columns' },
  ]
}

/**
 * The `Cell type source` dropdown, one declaration for every Cortex node that reads a typing.
 * **Never presentational**: the chosen table's columns are part of what the node outputs, so the
 * pickers' schema, inference and `evaluate` all go through `cellTypeRefs`. `help` is the node's,
 * since what a type is *for* differs per node.
 */
export function cellTypeSourceParam(help: string): ParamDef {
  return {
    id: 'cellTypes',
    kind: 'enum',
    label: 'Cell type source',
    help,
    options: (ctx) => cellTypeOptions(frameOf(datasetRef(ctx.inputs.dataset))),
    default: '',
  }
}

/**
 * The tables a choice reads, in join order: proofreading first, then the typing, which wins a
 * column both carry. A table name the frame no longer lists — a graph saved against an older
 * declaration — is still read, keeping every column, rather than silently becoming the default.
 *
 * `proofreading: false` is for a reader wanting types alone (Cortical Depth): the flags' own
 * table is then not read — but where one table carries both, the read keeps the flag columns, so
 * it stays the one cache entry the gallery and the dataset's annotation chain share.
 */
export function cellTypeRefs(
  frame: CorticalFrame | undefined,
  { sourceId, datasetId }: DatasetIdentity,
  choice: string,
  { proofreading = true }: { proofreading?: boolean } = {},
): AnnotationRef[] {
  if (!frame || !datasetId || frame.scope !== 'cave') return []
  const typing: CellTypeSource | undefined =
    choice === NO_CELL_TYPES
      ? undefined
      : choice === ''
        ? frame.cellTypes[0]
        : (frame.cellTypes.find((source) => source.table === choice) ?? {
            table: choice,
            note: '',
            columns: '',
          })
  const flags = frame.proofreading
  const flagColumns = flags
    ? [flags.dendrite, flags.axon, ...(flags.strategy ? [flags.strategy.column] : [])]
    : []
  const ref = (table: string, columns: string) =>
    caveTableRef(datasetId, sourceId, { table, columns })
  if (flags && typing?.table === flags.table) {
    // One table carrying both: one read, both sets of columns — a union, so the default reads
    // exactly what the dataset's annotation chain reads and the two share a cache entry. Every
    // column when none are named.
    const columns = typing.columns
      ? [...new Set([...typing.columns.split(', '), ...flagColumns])].join(', ')
      : ''
    return [ref(typing.table, columns)]
  }
  return [
    ...(flags && proofreading ? [ref(flags.table, flagColumns.join(', '))] : []),
    ...(typing ? [ref(typing.table, typing.columns)] : []),
  ]
}

/**
 * The schema half: the Dataset's neuron columns with each table's joined on, as far as they are
 * known. A wide read naming its columns answers at once; one keeping every column answers once
 * its sample lands, which `reportAnnotationsLearned` announces.
 */
export function cellTypesSchema(
  neurons: TableSchema,
  refs: readonly AnnotationRef[],
): TableSchema {
  return refs.reduce((schema, ref) => {
    const columns = peekRefColumns(ref)
    return columns ? joinedSchema(schema, columns) : schema
  }, neurons)
}

/**
 * The value half: the Dataset's own annotations with each table joined on, `joinAnnotations`'
 * rules — every neuron either side knows, the later table winning a name. The tables are read
 * together; each is cached by the reader, so the card's read is the Run's.
 */
export async function cellTypeAnnotations(
  wired: DatasetAnnotations | undefined,
  refs: readonly AnnotationRef[],
  options: AnnotationFetchOptions,
): Promise<DatasetAnnotations | undefined> {
  if (refs.length === 0) return wired
  const tables = await Promise.all(
    refs.map((ref) => requireAnnotationProvider(ref.provider).fetch(ref, options)),
  )
  const [first, ...rest] = wired ? [wired.table, ...tables] : tables
  return {
    key: cellTypesKey(wired, refs),
    table: rest.reduce((joined, next) => joinAnnotations(joined, next), first!),
  }
}

/** What the joined annotations are a function of: the wired chain's key and each table read. */
export function cellTypesKey(
  wired: DatasetAnnotations | undefined,
  refs: readonly AnnotationRef[],
): string {
  return [wired?.key ?? '', ...refs.map(refKey)].join('|')
}
