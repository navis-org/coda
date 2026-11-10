/**
 * Table to Points: three columns of a table read as a position, so anything with coordinates in
 * it can be drawn and measured as geometry.
 *
 * The op and its rules are `lib/tablePoints.ts`. What belongs here is the card, and the two
 * decisions a card has to make that a table cannot answer for itself:
 *
 * **Which columns.** Resolved through `ctx.column()` (invariant 5), so inference, `validate`,
 * `evaluate` and the provenance key all read the same answer — and a column a `Filter Table`
 * upstream has not produced yet is kept rather than substituted.
 *
 * **What the numbers mean.** A column of numbers is not nanometres until somebody says so, and
 * everything downstream that measures a distance asks: `Points in Volumes`, `Cortical Depth`,
 * the 3D viewer's scale bar. `Nanometres per unit` is that statement, and it is **applied**
 * rather than recorded: the cloud that comes out is nanometres, always.
 *
 * A `units: 'voxels'` tag was the first shape and is the wrong one — a reader who said `voxels`
 * honestly got `geometryUnitsProblem`'s refusal downstream, which explains that the *dataset's*
 * Meta has no `voxelSize`, about a cloud built from a CSV that has no dataset and with no node
 * anywhere that could convert it. A scale also says `4, 4, 40`, which a two-valued enum cannot
 * and which is the ordinary case for a table of positions.
 *
 * **`cheap`, because it is reading cells already in memory.** No fetch, no Python, so changing a
 * column redraws without a Run.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { NUMERIC_DTYPES } from '../../core/types'
import { isTableValue } from '../../core/values'
import { plural } from '../../style/format'
import { checkPointsSize } from '../lib/pointsSize'
import {
  POINT_AXES,
  TABLE_POINTS_SCALE_REFUSAL,
  axesRefusal,
  tablePointsSchema,
  tablePointsValue,
} from '../lib/tablePoints'
import type { PointColumns } from '../lib/tablePoints'
import { parseScale } from '../../data/units'

/** The three pickers, resolved the one way (invariant 5), for every reader of them. */
function axisColumns(ctx: { column: (id: string) => string | undefined }): PointColumns {
  return { x: ctx.column('x'), y: ctx.column('y'), z: ctx.column('z') }
}

registerNode({
  type: 'core.tablePoints',
  label: 'Table to Points',
  category: 'transform',
  description:
    'Read three columns of a table as x, y and z, giving a point cloud that can be drawn in 3D or asked which region, layer or depth each point is in. Any other columns you name ride along.',
  guide:
    'Turns a table\u2019s rows into points: name the three coordinate columns, and anything ' +
    'under `Carry` rides along as a point attribute. `Nanometres per unit` says what the ' +
    'numbers are and is applied, so the cloud comes out in nanometres. Rows without three ' +
    'numbers have no position and are left out.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Points', type: T.points() }],
  params: [
    /*
     * One paragraph for three pickers, `landmarkTransform`'s shape. The argument below is the
     * same for each axis and was written out three times before — which is three places a
     * correction has to land.
     *
     * **`optional` with no default, so nothing is substituted.** A picker with a declared
     * default resolves to the first compatible column when the one it names is missing, and on
     * this node that is some unrelated numeric column read as a coordinate: a cloud in the wrong
     * place, drawn without complaint. A demo caught exactly that, reading `size` as z. The cost
     * is that `optional` also means "empty is legitimate" to generic surfaces, which `validate`
     * then contradicts — the honest fix is a picker flag meaning *never substitute*, and that is
     * a change to `resolveColumn`'s rules rather than to this card.
     */
    ...POINT_AXES.map((axis) => ({
      id: axis,
      kind: 'column' as const,
      label: axis.toUpperCase(),
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: '',
      optional: true,
      help: `The column holding each row’s ${axis} coordinate.`,
    })),
    {
      id: 'carry',
      kind: 'columns',
      label: 'Carry',
      from: 'in',
      default: [],
      help: 'Other columns to keep as attributes of each point — a `neuronId` to colour by, a label, a score. The coordinate columns are the geometry now, so they are not carried unless you name them here.',
    },
    {
      id: 'scale',
      kind: 'string',
      label: 'Nanometres per unit',
      default: '1, 1, 1',
      placeholder: '1, 1, 1',
      help: 'What one unit of these columns is in nanometres, as `x, y, z` — `1, 1, 1` if they are already nanometres, `4, 4, 40` for a table of 4x4x40 nm voxels. The cloud is nanometres afterwards, which is what everything that measures a distance expects.',
    },
  ],

  /**
   * The attribute schema, before anything runs — the carried columns with the dtypes they had
   * upstream, so a carried `neuronId` stays text (invariant 8) and every picker below this node
   * is offered the same columns whether or not it has run.
   */
  inferOutputs: (ctx) => ({
    out: T.points(tablePointsSchema(ctx.attributes('in'), ctx.columns('carry'))),
  }),

  validate(ctx) {
    const issues: string[] = []
    const axes = axesRefusal(axisColumns(ctx))
    if (axes) issues.push(axes)
    if (!parseScale(String(ctx.params.scale))) issues.push(TABLE_POINTS_SCALE_REFUSAL)
    return issues
  },

  evaluate(ctx) {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Table input is missing')
    const columns = axisColumns(ctx)
    const unset = axesRefusal(columns)
    if (unset) throw new Error(unset)

    const scale = parseScale(String(ctx.params.scale))
    if (!scale) throw new Error(TABLE_POINTS_SCALE_REFUSAL)
    /*
     * Before the cloud is built, not after: `pointsSize.ts`' own contract is that the guard runs
     * before anything is allocated, and the row count is an upper bound on the points since
     * dropping only shrinks it. Checking afterwards would allocate the whole buffer and every
     * carried column and *then* refuse, which is the allocation the crash floor exists to stop.
     */
    checkPointsSize(
      ctx,
      table.length,
      tablePointsSchema(table.schema, ctx.columns('carry')).columns.length,
      ` from ${table.length.toLocaleString()} rows`,
      'Filter the table first, or carry fewer columns.',
    )
    /*
     * A picker *keeps* a chosen column that has not arrived (invariant 5), which is right — but
     * running with one means every row drops, and "a blank or non-numeric coordinate" would be
     * blaming the cells for the schema. Named here instead.
     */
    const absent = POINT_AXES.filter((axis) => !(columns[axis]! in table.data))
    if (absent.length > 0) {
      throw new Error(
        `This table has no ${absent.map((axis) => `\`${columns[axis]}\``).join(', ')} column. ` +
          'Pick a column that is in it, or check what the node above is producing.',
      )
    }

    const { points, dropped } = tablePointsValue(table, columns, ctx.columns('carry'), scale)
    if (dropped > 0) {
      ctx.warn(
        `${dropped} of ${plural(table.length, 'row')} had no position — a blank or ` +
          'non-numeric coordinate — and are not in the cloud.',
      )
    }
    return { out: points }
  },
})
