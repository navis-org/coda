import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isMatrixValue } from '../../core/values'

export const heatmapNode = registerNode({
  type: 'out.heatmap',
  label: 'Heatmap',
  category: 'visualisation',
  description: 'Render a matrix as a heatmap.',
  guide:
    'A matrix drawn as a grid of coloured cells — the natural end of Adjacency or Pivot. Sequential for counts and fractions, diverging when zero is a meaningful middle, as it is after a log-ratio. Put a Normalize in front of it if one row dominates: a heatmap of raw synapse counts is usually a picture of which cell type is numerous.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Matrix', type: T.matrix() }],
  outputs: [{ id: 'out', label: 'Matrix', type: T.matrix() }],
  params: [
    {
      id: 'scale',
      kind: 'enum',
      label: 'Colour scale',
      default: 'sequential',
      presentational: true,
      options: [
        { value: 'sequential', label: 'sequential' },
        { value: 'diverging', label: 'diverging (0 centred)' },
      ],
    },
    {
      id: 'showValues',
      kind: 'boolean',
      label: 'Show values',
      help: 'Only legible on small matrices; the viewer hides them automatically when cells get too small.',
      default: false,
      presentational: true,
    },
  ],

  evaluate: (ctx) => {
    const matrix = ctx.input('in')
    if (!isMatrixValue(matrix)) throw new Error('Input is not a matrix')
    return { out: matrix }
  },
})
