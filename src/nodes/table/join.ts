import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { JoinHow } from '../lib/tableOps'
import { joinSchema, joinTables } from '../lib/tableOps'

/**
 * Key join of two tables. Colliding right-hand column names get a suffix rather than
 * being silently dropped — in a scientific pipeline, quietly losing a column is worse
 * than an ugly name.
 */
export const joinNode = registerNode({
  type: 'core.join',
  label: 'Join',
  category: 'transform',
  description: 'Annotate the left table with matching rows from the right table.',
  guide:
    'Annotate the left table with matching rows from the right — cell types onto an edge list, your own annotations onto a query result. A right-hand column whose name collides with one on the left gets a suffix rather than being dropped: in a scientific pipeline an ugly name beats a column that quietly disappeared. Two inputs, chained for more.',
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
      options: [
        { value: 'left', label: 'left (keep unmatched)' },
        { value: 'inner', label: 'inner (matched only)' },
      ],
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
    const schema = joinSchema(
      ctx.schema('left'),
      ctx.schema('right'),
      ctx.column('rightKey'),
      String(ctx.params.suffix ?? '_r'),
    )
    return { out: schema ? T.table(schema) : T.table() }
  },

  validate: (ctx) => {
    const issues: string[] = []
    const leftCol = ctx.column('leftKey')
    const rightCol = ctx.column('rightKey')
    if (ctx.inputs.left && ctx.inputs.right && leftCol && rightCol) {
      const left = ctx.schema('left')?.columns.find((c) => c.name === leftCol)
      const right = ctx.schema('right')?.columns.find((c) => c.name === rightCol)
      if (left && right && left.dtype !== right.dtype) {
        issues.push(
          `Key dtypes differ (${leftCol}: ${left.dtype} vs ${rightCol}: ${right.dtype}) — matches are compared as text`,
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
    const leftKey = ctx.column('leftKey')
    const rightKey = ctx.column('rightKey')
    if (!leftKey || !rightKey) throw new Error('Both join keys must be selected')
    return {
      out: joinTables(
        left,
        right,
        leftKey,
        rightKey,
        String(ctx.params.how ?? 'left') as JoinHow,
        String(ctx.params.suffix ?? '_r'),
      ),
    }
  },
})
