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
 * neuron to colour a 3D scene by. `ZapBench Traces → Reduce Matrix → Join → Skeletons` is that
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
  description: 'Aggregate a matrix’s rows or columns into one table row each.',
  guide:
    'Turns a matrix into a table with one row per matrix row — or per column — carrying whichever ' +
    'statistics you tick: mean, median, sd, min, max, sum, and n. This is the way out of a matrix ' +
    'for everything that is not a picture: a trace or similarity matrix has no per-neuron number ' +
    'until something reduces it, and a table has one you can sort, filter, join onto a neuron ' +
    'table and colour a 3D scene by. Note that the control names the axis that *survives* — ' +
    '“each row, across its columns” — and that non-finite cells are skipped, so a neuron whose ' +
    'row is all NaN comes out null rather than zero.',
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
      help: 'Which lines survive. “Each row, across its columns” gives one output row per matrix row — for a trace matrix, one per neuron. The other way round transposes the answer, which is why both halves are named.',
    },
    {
      id: 'stats',
      kind: 'multiEnum',
      label: 'Statistics',
      noun: 'statistic',
      emptyLabel: 'labels only',
      default: ['mean'],
      options: REDUCE_STAT_OPTIONS,
      help: 'One column per tick, in the order ticked. Non-finite cells are skipped: a line with none comes out null, except sum, which is 0, and n, which is the count. sd is the sample standard deviation and is null below two values. Median is the one that costs a sort per line.',
    },
    {
      id: 'prefix',
      kind: 'string',
      label: 'Prefix',
      default: '',
      placeholder: 'none',
      help: 'Prepended to every statistic’s column name, so “zap” gives zap_mean and zap_max. Worth setting when two of these meet at a Join, where two columns called mean leave one picker with a stale answer.',
    },
    {
      id: 'excludeDiagonal',
      kind: 'boolean',
      label: 'Exclude diagonal',
      default: false,
      help: 'Drop each line’s self-comparison — the cell where a Similarity, NBLAST or Adjacency matrix scores a neuron against itself, which otherwise drags every mean towards 1. Applied only where the row and column labels are the same list; ignored with a warning anywhere else, since a square matrix is not necessarily a self-comparison.',
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
