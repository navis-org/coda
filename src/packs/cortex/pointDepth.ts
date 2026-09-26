/**
 * Cortical Depth's two halves: a point cloud's attributes with where each point sits in the
 * cortex, and — where a typing is read — which cell type each end of a synapse is.
 *
 * Headless and side by side (invariant 3): `pointDepthSchema` is what inference promises and
 * `pointDepthValue` what `evaluate` returns, agreed on by `pointDepth.test.ts`. The placement is
 * `placeAll`, the gallery's own walk, so a soma and a synapse at one place come out at one depth.
 *
 * **Types are looked up per end, never joined.** A synapse cloud has a row per synapse and two
 * ids on it, `neuronId` and `partnerId`; a join would take one key and multiply nothing, but it
 * would also need to be written twice with a rename between. A lookup keyed by id is the same
 * annotation, read once, for both — and a partner the typing does not mention (most of a
 * neuron's partners are fragments) is null, not a type.
 */

import type { NeuronId } from '../../core/ids'
import { ID_COLUMN_NAME, idText } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { column, findColumn, tableSchema } from '../../core/types'
import type { CellValue, ColumnData, PointsValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { TYPE_COLUMN_NAME } from '../../data/annotations/types'
import { foldColumns } from '../../nodes/lib/tableOps'
import { LAYER_COLUMN } from './cells'
import type { CorticalFrame } from './frames'
import { placeAll } from './frames'

/**
 * Micrometres below the pia; negative above it. `POINT_` because the gallery's own is
 * `soma_depth` (`cells.ts`' `DEPTH_COLUMN`), and one name with two values in one pack is an
 * auto-import away from the wrong default.
 */
export const POINT_DEPTH_COLUMN = 'depth'
/** Micrometres across the cortex, in the frame's flattened axis. */
const LATERAL_COLUMN = 'lateral'
/** The cell type of the neuron on the other side of the synapse. */
export const PARTNER_TYPE_COLUMN = 'partnerType'
/** The column on a synapse cloud naming the other side. */
const PARTNER_COLUMN = 'partnerId'

/**
 * The attributes with the frame's columns folded in (`foldColumns`: a same-named column is written
 * over in its slot), and the typing's where one is read — the point's own type under the name the
 * annotation readers give it (`TYPE_COLUMN_NAME`). `partnerType` only on a cloud that has a
 * partner to type — a soma cloud has none.
 */
export function pointDepthSchema(
  attributes: TableSchema | undefined,
  typed: boolean,
): TableSchema {
  const minted = [
    column(POINT_DEPTH_COLUMN, 'f64'),
    column(LATERAL_COLUMN, 'f64'),
    column(LAYER_COLUMN, 'str'),
    ...(typed ? [column(TYPE_COLUMN_NAME, 'str')] : []),
    ...(typed && attributes && findColumn(attributes, PARTNER_COLUMN)
      ? [column(PARTNER_TYPE_COLUMN, 'str')]
      : []),
  ]
  return attributes ? foldColumns(attributes, minted) : tableSchema(...minted)
}

/**
 * The value half: every point, placed, and how many sit too far above the pia for a layer.
 * `types` is the typing keyed by id (`displayLabels`), or undefined where none is read — which is
 * what `typed` means to the schema.
 */
export function pointDepthValue(
  points: PointsValue,
  frame: CorticalFrame,
  types: ReadonlyMap<NeuronId, string> | undefined,
): { points: PointsValue; outside: number } {
  const attributes = points.attributes
  const positions = points.positions
  const placed = placeAll(
    frame,
    attributes.length,
    (i) => positions[i * 3]!,
    (i) => positions[i * 3 + 1]!,
  )
  const schema = pointDepthSchema(attributes.schema, !!types)
  const data: Record<string, ColumnData> = {
    ...attributes.data,
    [POINT_DEPTH_COLUMN]: placed.depth,
    [LATERAL_COLUMN]: placed.lateral,
    [LAYER_COLUMN]: placed.layer,
  }
  if (types) {
    data[TYPE_COLUMN_NAME] = lookup(attributes.data[ID_COLUMN_NAME], attributes.length, types)
    if (findColumn(schema, PARTNER_TYPE_COLUMN)) {
      data[PARTNER_TYPE_COLUMN] = lookup(
        attributes.data[PARTNER_COLUMN],
        attributes.length,
        types,
      )
    }
  }
  return {
    points: { ...points, attributes: makeTable(schema, data, attributes.kind) },
    outside: placed.outside,
  }
}

/**
 * Each row's type, by its id. A synapse cloud's `neuronId` is a handful of ids repeated down
 * hundreds of thousands of rows, so the last cell's answer is kept and a repeat skips the lookup.
 */
function lookup(
  ids: ColumnData | undefined,
  length: number,
  types: ReadonlyMap<NeuronId, string>,
): (string | null)[] {
  const out = new Array<string | null>(length)
  let last: CellValue | undefined
  let answer: string | null = null
  for (let row = 0; row < length; row++) {
    const cell = ids?.[row] ?? null
    if (cell !== last) {
      const id = idText(cell)
      answer = (id && types.get(id)) ?? null
      last = cell
    }
    out[row] = answer
  }
  return out
}
