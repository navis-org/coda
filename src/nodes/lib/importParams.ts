/**
 * The shaping controls both import nodes carry, declared once.
 *
 * `Upload Table` and `Table from URL` are the same node over two ways of getting bytes: they
 * share `uploadShapeSchema`/`uploadShapeTable` for the *values* already, and until this they
 * hand-wrote the *declarations* twice — three params, two option builders and a collision check
 * apiece, differing only in where the schema comes from.
 *
 * That is the factory idiom `colorParams` and `ANNOTATIONS_INPUT` establish, and the asymmetry
 * it prevents was already in the tree: `Upload Table` reported a `Type column` naming a column
 * the file does not have, and `Table from URL` did not.
 *
 * The one genuine difference is where the schema is found, so that is the argument. `renamedColumns`
 * takes *n* renames now, so a third Coda-named column is one entry here rather than six blocks.
 */

import type { ColumnSchemaSource, InferContext, ParamDef, ParamValues } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { findColumn } from '../../core/types'
import type { UploadShape } from './tableOps'

/** How an import node finds the schema of the bytes it last read. Synchronous, invariant 2. */
export type ImportSchemaSource = (params: ParamValues) => TableSchema | undefined

export interface ImportShapeOptions {
  read: ImportSchemaSource
  /** `Text columns` is inspector-only where the card already has a URL and a Refresh on it. */
  textAdvanced?: boolean
}

export function importShapeParams({ read, textAdvanced }: ImportShapeOptions): ParamDef[] {
  const schemaFrom: ColumnSchemaSource = (_inputs, params) => read(params)
  return [
    {
      id: 'idColumn',
      kind: 'enum',
      label: 'ID column',
      help: 'Renamed to neuronId, which is the name every neuron node looks for.',
      default: '',
      /*
       * An enum rather than a `column` param: an enum's stored value reaches the provenance key
       * verbatim, where a column param's is resolved against the available schema first — and a
       * schema that is empty before the first read and full after it would key the node two
       * different ways either side of a run it had just finished.
       */
      options: (ctx) => [
        { value: '', label: 'none (plain table)' },
        // Identifiers only. A float is a measurement and a boolean is a flag; offering either
        // would invite a Neurons table whose neuron ids are neither.
        ...(read(ctx.params)?.columns ?? [])
          .filter((c) => c.dtype === 'i64' || c.dtype === 'str')
          .map((c) => ({ value: c.name, label: c.name })),
      ],
    },
    {
      id: 'typeColumn',
      kind: 'enum',
      label: 'Type column',
      help: 'Renamed to type, which is the name Coda reads a cell type from.',
      default: '',
      /*
       * Every column is offered, unlike `ID column`. A rename is lossless whatever the dtype,
       * and there is no downstream contract that a type be text — where offering a float as an
       * *id* would invite a Neurons table whose neuron ids are neither.
       */
      options: (ctx) => {
        const id = String(ctx.params.idColumn ?? '')
        return [
          { value: '', label: 'none' },
          ...(read(ctx.params)?.columns ?? [])
            // One column cannot be renamed to two names, so the id is not on offer here.
            .filter((c) => c.name !== id)
            .map((c) => ({ value: c.name, label: c.name })),
        ]
      },
    },
    {
      id: 'textColumns',
      kind: 'columns',
      label: 'Text columns',
      help: 'Read these as text rather than numbers — a cluster id is a label, not a quantity.',
      // No port to read: the schema is the node's own, so the picker is handed the lookup.
      from: '',
      schemaFrom,
      default: [],
      optional: true,
      ...(textAdvanced ? { advanced: true } : {}),
    },
  ]
}

/**
 * The three controls as one argument, resolved the way `evaluate` resolves them.
 *
 * One reader for the schema half and the value half, so invariant 3 cannot come apart over a
 * transcription — the same call `stack.ts`'s `readOptions` makes.
 */
export function readImportShape(ctx: {
  params: ParamValues
  columns: (id: string) => string[]
}): UploadShape {
  return {
    idColumn: String(ctx.params.idColumn ?? ''),
    typeColumn: String(ctx.params.typeColumn ?? ''),
    textColumns: ctx.columns('textColumns'),
  }
}

/**
 * What the shaping controls have to say about a schema that has arrived.
 *
 * Only called once the read has settled: a picker naming a column of a file nobody has looked at
 * yet is not drift, it is a schema that has not turned up — the distinction `resolveColumns` and
 * `validateColumnParams` both draw.
 */
export function importShapeIssues(
  ctx: InferContext,
  schema: TableSchema | undefined,
  subject: string,
): string[] {
  if (!schema) return []
  const idColumn = String(ctx.params.idColumn ?? '')
  if (idColumn && !findColumn(schema, idColumn)) {
    return [`ID column "${idColumn}" is not in ${subject}`]
  }
  const typeColumn = String(ctx.params.typeColumn ?? '')
  if (typeColumn && !findColumn(schema, typeColumn)) {
    return [`Type column "${typeColumn}" is not in ${subject}`]
  }
  // Reachable from a saved graph rather than from the picker, which never offers the id. The
  // rename would silently do nothing, since the id claims the column first.
  if (typeColumn && typeColumn === idColumn) {
    return [`"${idColumn}" cannot be both the ID column and the Type column`]
  }
  return []
}
