import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { JoinHow, JoinSpec } from '../lib/tableOps'
import { JOIN_OPTIONS, joinKeyDType, joinSchema, joinTables } from '../lib/tableOps'

/**
 * The node's params as the op's argument, in one place.
 *
 * `inferOutputs`, `validate` and `evaluate` all need the same four, and the schema half and
 * the value half have to be handed *identical* ones — `how` decides whether the key column
 * widens (invariant 3), so a default written out twice and typed differently in one of them
 * would publish a schema the run does not produce.
 */
function specOf(ctx: {
  column: (id: string) => string | undefined
  params: Readonly<Record<string, unknown>>
}): JoinSpec {
  return {
    leftKey: ctx.column('leftKey') ?? '',
    rightKey: ctx.column('rightKey') ?? '',
    how: String(ctx.params.how ?? 'left') as JoinHow,
    suffix: String(ctx.params.suffix ?? '_r'),
  }
}

/**
 * Key join of two tables. Colliding right-hand column names get a suffix rather than
 * being silently dropped — in a scientific pipeline, quietly losing a column is worse
 * than an ugly name.
 *
 * The four directions are the complete set, and `right` is not redundant with swapping the
 * wires: the output's columns stay in left-then-right order either way, so nothing downstream
 * has to be repointed to try the other one. See `joinTables` for what each direction does
 * about a duplicated key, and for the one key column a row from the right alone arrives with.
 */
export const joinNode = registerNode({
  type: 'core.join',
  label: 'Join',
  category: 'transform',
  description: 'Annotate the left table with matching rows from the right table.',
  guide:
    'Annotate the left table with matching rows from the right. Join type decides which rows survive: left keeps every left row, inner only matches, outer all rows, right every right row. Right-hand columns that collide get a suffix rather than being dropped. Chain for more tables.',
  cost: 'cheap',
  inputs: [
    { id: 'left', label: 'Left', type: T.table() },
    { id: 'right', label: 'Right', type: T.table() },
  ],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    { id: 'leftKey', kind: 'column', label: 'Left key', from: 'left', default: '' },
    { id: 'rightKey', kind: 'column', label: 'Right key', from: 'right', default: '' },
    {
      id: 'how',
      kind: 'enum',
      label: 'Type',
      default: 'left',
      help: 'Which rows survive: every left row, only matched rows, every row of both sides, or every right row.',
      options: JOIN_OPTIONS,
    },
    {
      id: 'suffix',
      kind: 'string',
      label: 'Suffix',
      help: 'Appended to right-hand column names that collide with the left table.',
      default: '_r',
      advanced: true,
    },
  ],

  inferOutputs: (ctx) => {
    const schema = joinSchema(ctx.schema('left'), ctx.schema('right'), specOf(ctx))
    return { out: schema ? T.table(schema) : T.table() }
  },

  validate: (ctx) => {
    const issues: string[] = []
    const spec = specOf(ctx)
    if (ctx.inputs.left && ctx.inputs.right && spec.leftKey && spec.rightKey) {
      const left = ctx.schema('left')
      const right = ctx.schema('right')
      const l = left?.columns.find((c) => c.name === spec.leftKey)
      const r = right?.columns.find((c) => c.name === spec.rightKey)
      if (l && r && l.dtype !== r.dtype) {
        // The reconciliation is `joinKeyDType`, asked rather than restated — it only bites
        // where a right-only row can put a right key value into the left key column, and it
        // reconciles i64 with f64 rather than sending that pair to text. A column changing
        // dtype under every picker downstream is not something to discover after a run.
        const key = joinKeyDType(left, right, spec)
        issues.push(
          `Key dtypes differ (${spec.leftKey}: ${l.dtype} vs ${spec.rightKey}: ${r.dtype}) — matches are compared as text` +
            (key ? `, and "${spec.leftKey}" comes out as ${key}` : ''),
        )
      }
    }
    return issues
  },

  evaluate: (ctx) => {
    const left = ctx.input('left')
    const right = ctx.input('right')
    if (!isTableValue(left)) throw new Error('Left input is not a table')
    if (!isTableValue(right)) throw new Error('Right input is not a table')
    const spec = specOf(ctx)
    if (!spec.leftKey || !spec.rightKey) throw new Error('Both join keys must be selected')
    return { out: joinTables(left, right, spec) }
  },
})
