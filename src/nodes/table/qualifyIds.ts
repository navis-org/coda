/**
 * Qualify Ids: `720575940623374218` → `flywire:720575940623374218`, and back.
 *
 * The node that mints the qualified form [comparative.md](../../../docs/comparative.md)'s
 * decision 1 specifies, and the one that takes it off again. Both directions live here because
 * they are one rule read in two directions, and a pair that drifted would strip a prefix the
 * other half never wrote.
 *
 * **Why a qualified id at all.** Co-clustering puts two connectomes' neurons on one observation
 * axis, and neuron 12345 exists in both. The alternative — a second `dataset` column forming a
 * composite key — is more honest and sorts properly, and was declined because every join,
 * dedupe and group-by in this codebase keys on **one** column: a forgotten `dataset` column
 * silently merges two different neurons.
 *
 * **The property that makes it safe** is that `isNeuronId` rejects the result. A qualified id is
 * not digits, so every query builder that splices one refuses it loudly rather than fetching the
 * wrong neuron. That is why this node warns rather than being quiet about what it produces: the
 * output column is deliberately no longer usable as an id, and that is the point.
 *
 * **Mint one only where two datasets meet in one table.** A qualified id in a single-dataset
 * branch is a neuron that can no longer be looked up, so the usual position is immediately
 * before a `Stack Tables` and immediately after whatever reads the clusters back.
 */

import { registerNode } from '../../core/registry'
import {
  ID_COLUMN_NAME,
  QUALIFIED_SEPARATOR,
  qualifiedDataset,
  qualifyId,
  unqualifyId,
} from '../../core/ids'
import {
  T,
  column,
  findColumn,
  isTabular,
  schemaOf,
  tableSchema,
  uniqueName,
} from '../../core/types'
import type { TableSchema } from '../../core/types'
import type { CellValue, ColumnData } from '../../core/values'
import { getColumn, isTableValue, makeTable } from '../../core/values'

type Direction = 'add' | 'remove'

const DIRECTION_OPTIONS: Array<{ value: Direction; label: string }> = [
  { value: 'add', label: 'Add the dataset prefix' },
  { value: 'remove', label: 'Strip the dataset prefix' },
]

interface QualifySpec {
  column: string
  direction: Direction
  prefix: string
  /** On `remove`, a column to put the stripped dataset in. Empty adds none. */
  into: string
}

/**
 * The column the stripped dataset lands in, or undefined where none was asked for.
 *
 * Exported for the emitters, `relabelTarget`'s reason one node over: pandas' `out[name] = …` and
 * R's `df[[name]] <- …` both *overwrite* a column of that name where this node suffixes, so an
 * emitter passing the typed name straight through writes a notebook that silently drops a
 * column the canvas kept. A table that already carries `dataset` — Match Cell Types' report, an
 * annotation base, a prior unqualify — is not a hypothetical.
 *
 * Not `relabelTarget` itself: that one answers the *source* column for `into === column`, which
 * is right there (naming the column you are rewriting means rewriting it in place) and wrong
 * here (this always appends).
 */
export function qualifyTarget(
  schema: TableSchema | undefined,
  into: string,
): string | undefined {
  const name = into.trim()
  if (!name) return undefined
  return uniqueName(new Set((schema?.columns ?? []).map((c) => c.name)), name)
}

/**
 * The output columns.
 *
 * One function behind both halves — `relabelLayout`'s arrangement, and here the schema is
 * genuinely derived: `remove` with a dataset column named adds one, and the id column becomes
 * `str` in both directions because a qualified id is not a number and an unqualified one has
 * been through text to get here.
 */
function qualifyLayout(schema: TableSchema, spec: QualifySpec) {
  const source = findColumn(schema, spec.column)
  if (!source) return undefined
  const columns = schema.columns.map((c) =>
    c.name === source.name ? column(c.name, 'str') : c,
  )
  const dataset =
    spec.direction === 'remove' ? qualifyTarget({ columns }, spec.into) : undefined
  if (!dataset) return { columns, dataset: undefined }
  return { columns: [...columns, column(dataset, 'str')], dataset }
}

function qualifySchema(
  schema: TableSchema | undefined,
  spec: QualifySpec,
): TableSchema | undefined {
  if (!schema) return undefined
  const layout = qualifyLayout(schema, spec)
  return layout ? tableSchema(...layout.columns) : schema
}

export const qualifyIdsNode = registerNode({
  type: 'core.qualifyIds',
  label: 'Qualify Ids',
  category: 'transform',
  description: 'Tag a neuron id with the dataset it came from, or take that tag off again.',
  guide:
    'Rewrites an id column to dataset:id, which is what lets two connectomes share one table ' +
    'without neuron 12345 in one being mistaken for neuron 12345 in the other — the shape ' +
    'co-clustering needs before Stack Tables. Strip it again on the way back out. The tagged ' +
    'value is deliberately no longer a valid neuron id, so anything that would query it refuses ' +
    'loudly instead of fetching the wrong neuron; only qualify where two datasets actually meet.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],

  params: [
    {
      id: 'column',
      kind: 'column',
      label: 'Id column',
      from: 'in',
      default: ID_COLUMN_NAME,
      help: 'The column carrying the neuron ids.',
    },
    {
      id: 'direction',
      kind: 'enum',
      label: 'Direction',
      default: 'add',
      options: DIRECTION_OPTIONS,
    },
    {
      id: 'prefix',
      kind: 'string',
      label: 'Dataset',
      default: '',
      visibleIf: (params) => params.direction !== 'remove',
      help: 'What to tag these ids with — a short name for the dataset they came from, like flywire or hemibrain.',
    },
    {
      id: 'into',
      kind: 'string',
      label: 'Dataset column',
      default: '',
      visibleIf: (params) => params.direction === 'remove',
      help: 'Name a column to keep the stripped dataset in, so a filter or a group-by can still tell the two apart. Empty discards it.',
    },
  ],

  /*
   * Kind straight through, `core.combineColumns`' rule. Worth stating what it means here: a
   * *qualified* neuron table is still a neuron table as far as the type system goes, and every
   * geometry node downstream will refuse its ids at fetch time rather than at edit time. That is
   * decision 1's bargain — noisy rather than silent — and the alternative, demoting the kind,
   * would break the Stack Tables this exists to feed.
   */
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    const shaped = qualifySchema(schemaOf(input), specOf(ctx))
    return { out: input.kind === 'neurons' ? T.neurons(shaped) : T.table(shaped) }
  },

  validate: (ctx) => {
    const spec = specOf(ctx)
    const issues: string[] = []
    if (spec.direction === 'add') {
      if (!spec.prefix) issues.push('No dataset name — the ids pass through untagged.')
      if (spec.prefix.includes(QUALIFIED_SEPARATOR)) {
        issues.push(
          `"${spec.prefix}" contains "${QUALIFIED_SEPARATOR}", which is the separator — the ` +
            `dataset read back will be "${spec.prefix.split(QUALIFIED_SEPARATOR)[0]}".`,
        )
      }
      issues.push(
        'A tagged id is deliberately not a valid neuron id: anything downstream that queries ' +
          'the dataset will refuse it rather than fetch the wrong neuron. Strip it again before ' +
          'fetching geometry.',
      )
    }
    return issues
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    const spec = specOf(ctx)
    const layout = qualifyLayout(table.schema, spec)
    if (!layout) throw new Error(`Column "${spec.column}" not found`)

    const source = getColumn(table, spec.column)
    const ids: CellValue[] = new Array(table.length)
    const datasets: CellValue[] = layout.dataset ? new Array(table.length) : []
    for (let row = 0; row < table.length; row++) {
      const cell = source[row]
      // A null stays null rather than becoming the string "flywire:null" — an absent id is
      // absent in both directions, and tagging one would invent a neuron.
      if (cell === null || cell === undefined) {
        ids[row] = null
        if (layout.dataset) datasets[row] = null
        continue
      }
      const text = String(cell)
      if (spec.direction === 'add') {
        ids[row] = spec.prefix ? qualifyId(spec.prefix, text) : text
      } else {
        ids[row] = unqualifyId(text)
        if (layout.dataset) datasets[row] = qualifiedDataset(text) ?? null
      }
    }

    const data: Record<string, ColumnData> = {}
    for (const col of layout.columns) {
      if (col.name === spec.column) data[col.name] = ids
      else if (col.name === layout.dataset) data[col.name] = datasets
      else data[col.name] = table.data[col.name]!
    }
    return { out: makeTable(tableSchema(...layout.columns), data, table.kind) }
  },
})

/** The node's params as the op's argument, read once — `join.ts`'s `specOf` idiom. */
function specOf(ctx: {
  params: Readonly<Record<string, unknown>>
  column: (id: string) => string | undefined
}): QualifySpec {
  return {
    column: ctx.column('column') ?? '',
    direction: String(ctx.params.direction ?? 'add') as Direction,
    prefix: String(ctx.params.prefix ?? '').trim(),
    // Trimmed here rather than at each reader — it was trimmed again in the layout and once
    // more in each emitter, which is three chances to disagree about whether " " names a column.
    into: String(ctx.params.into ?? '').trim(),
  }
}
