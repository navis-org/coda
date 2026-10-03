/**
 * Reduce Matrix: a matrix's lines as a table of statistics.
 *
 * The counterpart of `core.pivot`, and the node that stops a matrix being a dead end. Pivot
 * takes a long table to a grid; this takes a grid to one row per line, which is the shape every
 * node that is not a viewer wants — Filter, Sort, Join, Download, Build Network and the whole
 * colour-by-a-column family all take a table and none of them takes a matrix.
 *
 * Written for the question a ZapBench trace matrix raises and could not answer: 3,000 neurons
 * against 7,879 timesteps draws a heatmap, and what somebody wants from it is one number per
 * neuron to colour a 3D scene by. `Neurons to ZapBench Traces → Reduce Matrix → Join → Skeletons` is that
 * chain, and before this node the only thing downstream of a trace matrix was the picture.
 *
 * It is not trace-specific and nothing here knows what a trace is: a Similarity, Adjacency,
 * NBLAST or Pivot matrix reduces the same way, which is what `Exclude diagonal` is for.
 *
 * The axis word, the null rule and the diagonal are each argued in `matrixReduce.ts`, where
 * they are implemented and where both emitters read them.
 *
 * ## Why the prefix is a param and not a downstream Rename
 *
 * `core.rename` could do it, and for one statistic it would be the same number of gestures. It
 * stops being so the moment two of these feed one Join: `mean` and `max` from a trace matrix
 * beside `mean` and `max` from an adjacency are four columns of two names, and `core.join`'s
 * suffix rule then names them `mean` and `mean_r` — which is the case `foldNodeColumns` exists
 * to stop, one picker with two answers of which the second is stale. Naming them at the source
 * is the fix; `zap_mean` beside `adj_mean` needs no rule at all.
 *
 * That decision is where `matrixReduce.ts`' memo comes from, and the two are one call rather
 * than two: owning the naming concern puts a param that changes no number into the provenance
 * key, so the arithmetic has to survive somebody typing in it.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isMatrixValue } from '../../core/values'
import {
  REDUCE_AXIS_OPTIONS,
  REDUCE_STAT_OPTIONS,
  readReduceOptions,
  reduceMatrixSchema,
  reduceMatrixTable,
} from '../lib/matrixReduce'

registerNode({
  type: 'core.reduceMatrix',
  label: 'Reduce Matrix',
  category: 'transform',
  description:
    'Summarise each row or each column of a matrix as one table row. The result is `label` plus one column per statistic you tick, and `Prefix` renames them all, so `zap` gives `zap_mean`.',
  guide:
    'Summarises each row (or each column) of a matrix with the statistics you tick, such as ' +
    'mean, max or sd, and returns them as a table keyed by label. Use it to get from a trace or ' +
    'similarity matrix to one number per neuron that you can sort, join or colour by.',
  cost: 'cheap',

  inputs: [{ id: 'in', label: 'Matrix', type: T.matrix() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],

  params: [
    {
      id: 'axis',
      kind: 'enum',
      label: 'Reduce',
      default: 'rows',
      options: REDUCE_AXIS_OPTIONS,
      help: 'Which way to reduce. "each row, across its columns" gives one output row per matrix row, e.g. one per neuron for a trace matrix.',
    },
    {
      id: 'stats',
      kind: 'multiEnum',
      label: 'Statistics',
      noun: 'statistic',
      emptyLabel: 'labels only',
      default: ['mean'],
      options: REDUCE_STAT_OPTIONS,
      help: 'One column per statistic, in the order ticked. Non-finite cells are skipped; a line with none gives null (0 for "sum" and "n"). "sd" is the sample standard deviation.',
    },
    {
      id: 'prefix',
      kind: 'string',
      label: 'Prefix',
      default: '',
      placeholder: 'none',
      help: 'Added to the start of each statistic’s column name, so "zap" gives zap_mean. Set it when two of these tables meet at a Join.',
    },
    {
      id: 'excludeDiagonal',
      kind: 'boolean',
      label: 'Exclude diagonal',
      default: false,
      help: 'Skip the cells that score a neuron against itself, e.g. in a Similarity, NBLAST or Adjacency matrix. Only applies when the row and column labels are the same list.',
    },
  ],

  /*
   * Exact from the params alone — a matrix carries no schema to pass through, and every output
   * column is a chip beside a prefix. So the pickers downstream fill as soon as the chips are
   * ticked, with nothing run and no `observesOutputSchema`.
   */
  inferOutputs: (ctx) => ({ out: T.table(reduceMatrixSchema(readReduceOptions(ctx.params))) }),

  evaluate: (ctx) => {
    const matrix = ctx.input('in')
    if (!isMatrixValue(matrix)) throw new Error('Input is not a matrix')
    const options = readReduceOptions(ctx.params)
    /*
     * Empty chips are a legitimate state rather than a half-built card: what comes out is the
     * axis's labels, one per row, which is the matrix's own identity and a perfectly good thing
     * to want. `emptyLabel` says so where the chips would be, so nothing here has to.
     */
    return { out: reduceMatrixTable(matrix, options, ctx) }
  },
})
