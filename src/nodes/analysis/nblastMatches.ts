/**
 * NBLAST Matches: a score matrix's best hits, as a table.
 *
 * The bridge between the two shapes Coda thinks in. A matrix is what you *look* at — the
 * Heatmap draws one, Linkage clusters one — and a table is what you *work* with: Filter, Sort,
 * Join, Download and Build Network all take one and none of them takes a matrix. "Which five
 * neurons is each of these most like" is a question with a long, thin answer, and until now
 * the only node that produced one was `neuron.nblastKnn`, which computes its own scores.
 *
 * Three questions rather than three nodes, because they are the same question at three
 * cut-offs and share every other control:
 *
 * - **top N per neuron** — the ranked shortlist. Rectangular, so a group with fewer valid
 *   cells than N simply gets fewer rows.
 * - **everything above a cutoff** — either an absolute score, or a band around each group's
 *   *own* best. Note what the second one means: `0.05` keeps everything within 5% of that
 *   group's top match, which is not "the top 5%". It is the useful one when the neurons vary
 *   in how good their best match is, which in a cell-type search they always do.
 * - **how many clear a cutoff** — one number per group, for choosing the cutoff before paying
 *   for the matches.
 *
 * ## It is not NBLAST-only, and the name is a compromise
 *
 * Nothing here reads anything NBLAST-specific: any `MatrixValue` works, including a Pivot's, an
 * Adjacency's or a syNBLAST's, and the only thing it asks of one is which way round its scores
 * run. The node is called NBLAST Matches because that is what somebody is looking
 * for in the palette nine times out of ten, and a node called "Matrix Matches" is one nobody
 * finds. `guide` says the general case out loud so it is not a secret.
 *
 * ## Why this crosses the Python bridge
 *
 * It does not have to. At Coda's matrix sizes a partial sort is microseconds of JavaScript,
 * and fastcore's implementation exists for matrices tens of gigabytes wide. What it buys is
 * **parity**: `percentage` means what navis means by it, `skip_self` is the diagonal rather
 * than a name comparison, and ties break the same way. Those are decisions somebody would
 * otherwise re-make slightly differently here, and a match table that disagrees with navis by
 * a rule nobody wrote down is worse than one that is a few milliseconds slower. The runtime
 * is also already booted in the graph this node belongs to — the matrix came from NBLAST.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isMatrixValue } from '../../core/values'
import { runMatches } from '../../pyodide/matches'
import type { MatchMode } from '../../pyodide/matches'
import {
  MATCH_AXES,
  MATCH_CUTOFFS,
  MATCH_DIRECTIONS,
  MATCH_MODES,
  checkMatchSize,
  checkSkipSelf,
  matchIssues,
  matchParamsFrom,
  matchRequestFrom,
  matchSchema,
  matchTable,
} from '../lib/matchOps'

registerNode({
  type: 'neuron.nblastMatches',
  label: 'NBLAST Matches',
  category: 'analysis',
  description:
    'Pull each neuron’s best matches out of a score matrix, as a table with the columns `query`, `target`, `rank` and `score`, or `query` and `matches` when counting. NBLAST k-NN names the same pair `queryId` and `targetId`.',
  guide:
    'Turns a score matrix into a table with one row per match: the neuron, its match, the ' +
    'rank and the score. Keep the top N matches per neuron, every match above a score, or ' +
    'every match within a fraction of the neuron’s own best score; or just count matches per ' +
    'neuron to help choose a cutoff. Any score matrix works, not just NBLAST’s.',
  cost: 'expensive',
  inputs: [{ id: 'in', label: 'Matrix', type: T.matrix() }],
  outputs: [{ id: 'matches', label: 'Matches', type: T.table(matchSchema('top')) }],
  params: [
    {
      id: 'mode',
      kind: 'enum',
      label: 'Extract',
      default: 'top',
      options: MATCH_MODES,
      help: 'Keep the top matches per neuron, every match past a cutoff, or count how many matches each neuron has past a cutoff.',
    },
    {
      id: 'n',
      kind: 'int',
      label: 'Matches per neuron',
      default: 5,
      min: 1,
      max: 1000,
      visibleIf: (params) => String(params.mode) === 'top',
      help: 'How many matches to keep per neuron, best first. If the matrix has fewer, you get a warning.',
    },
    {
      id: 'cutoff',
      kind: 'enum',
      label: 'Cutoff',
      default: 'threshold',
      options: MATCH_CUTOFFS,
      visibleIf: (params) => String(params.mode) !== 'top',
      help: '"an absolute score" uses one cutoff for every neuron. "within % of each best" is relative to each neuron’s own best match, which helps when some neurons match much better than others.',
    },
    {
      id: 'threshold',
      kind: 'number',
      label: 'Score at least',
      default: 0.5,
      step: 0.05,
      visibleIf: (params) =>
        String(params.mode) !== 'top' && String(params.cutoff) === 'threshold',
      help: 'Keep matches scoring at least this (at most, on a distance matrix). For normalised NBLAST scores, 0.5 is a good start.',
    },
    {
      id: 'percentage',
      kind: 'number',
      label: 'Within (fraction)',
      default: 0.05,
      min: 0,
      max: 1,
      step: 0.01,
      visibleIf: (params) =>
        String(params.mode) !== 'top' && String(params.cutoff) === 'percentage',
      help: 'Given as a fraction: 0.05 keeps every match within 5% of that neuron’s own best match.',
    },
    {
      id: 'skipSelf',
      kind: 'boolean',
      label: 'Skip self-matches',
      default: true,
      help: 'Ignore the diagonal, i.e. each neuron’s match with itself. Turn off for a square matrix built from two different sets.',
    },
    {
      id: 'axis',
      kind: 'enum',
      label: 'Matches for',
      default: '0',
      options: MATCH_AXES,
      advanced: true,
      help: 'Find matches for each row or each column. Pick "each column (target)" to read a query-against-target matrix from the target’s side.',
    },
    {
      id: 'direction',
      kind: 'enum',
      label: 'Best means',
      default: 'auto',
      options: MATCH_DIRECTIONS,
      advanced: true,
      help: 'Whether high or low scores are better. "from the matrix" uses what the matrix declares, and assumes higher is better if it declares nothing (a Pivot never does).',
    },
  ],

  /*
   * Fully derivable from the mode, which is why this is a real inference rather than an
   * `observed` fallback — the columns do not depend on the data, only on which question was
   * asked. That is also why the value column is called `score` unconditionally rather than
   * taking the matrix's own `valueLabel`; see the note beside `matchSchema`.
   */
  inferOutputs: (ctx) => ({
    matches: T.table(matchSchema(String(ctx.params.mode) as MatchMode)),
  }),

  validate: (ctx) => matchIssues(matchParamsFrom(ctx.params)),

  evaluate: async (ctx) => {
    const matrix = ctx.input('in')
    if (!isMatrixValue(matrix)) throw new Error('NBLAST Matches takes a score matrix.')
    if (matrix.rowLabels.length === 0 || matrix.colLabels.length === 0) {
      throw new Error('The matrix is empty')
    }

    const params = matchParamsFrom(ctx.params)
    checkSkipSelf(matrix, params.skipSelf)
    checkMatchSize(ctx, matrix, params)

    ctx.progress(0.01, `${matrix.rowLabels.length} × ${matrix.colLabels.length}`)
    const result = await runMatches(matchRequestFrom(matrix, params), {
      onProgress: ctx.progress,
      signal: ctx.signal,
    })

    return { matches: matchTable(matrix, result, params.axis) }
  },
})
