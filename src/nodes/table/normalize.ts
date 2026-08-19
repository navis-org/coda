import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isMatrixValue } from '../../core/values'
import type { NormalizeMode } from '../lib/tableOps'
import { NORMALIZE_OPTIONS, normalizeMatrix } from '../lib/tableOps'

/**
 * Rescale a matrix. Raw synapse counts are dominated by whichever cell type happens to be
 * numerous, so row-fraction is usually what makes a connectivity matrix readable.
 */
export const normalizeNode = registerNode({
  type: 'core.normalize',
  label: 'Normalize',
  category: 'analysis',
  description: 'Rescale matrix values by row, column, global max, or log.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Matrix', type: T.matrix() }],
  outputs: [{ id: 'out', label: 'Matrix', type: T.matrix() }],
  params: [
    { id: 'mode', kind: 'enum', label: 'Mode', default: 'row', options: NORMALIZE_OPTIONS },
  ],

  evaluate: (ctx) => {
    const matrix = ctx.input('in')
    if (!isMatrixValue(matrix)) throw new Error('Input is not a matrix')
    return { out: normalizeMatrix(matrix, String(ctx.params.mode ?? 'row') as NormalizeMode) }
  },
})
