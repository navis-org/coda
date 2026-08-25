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

export const nblastMatchesNode = registerNode({
  type: 'neuron.nblastMatches',
  label: 'NBLAST Matches',
  category: 'analysis',
  description: 'Pull each neuron’s best matches out of a score matrix, as a table.',
  guide:
    'Turns a score matrix into the long table every other node wants: one row per match, with ' +
    'the neuron, its match, the rank and the score. Take the top N per neuron, everything ' +
    'above a cutoff, or just the counts so you can pick a cutoff first. Works on any matrix, ' +
    'not only NBLAST’s — and note that the “within %” cutoff is a band around each neuron’s ' +
    'own best match rather than the top few percent overall.',
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
      help:
        'A ranked shortlist per neuron, everything clearing a cutoff, or — when you do not yet ' +
        'know what cutoff to use — how many each neuron would yield at one.',
    },
    {
      id: 'n',
      kind: 'int',
      label: 'Matches per neuron',
      default: 5,
      min: 1,
      max: 1000,
      visibleIf: (params) => String(params.mode ?? 'top') === 'top',
      help:
        'How many to keep, best first. Cut down to what the matrix can offer if it is ' +
        'narrower than this, with a warning saying so rather than an error.',
    },
    {
      id: 'cutoff',
      kind: 'enum',
      label: 'Cutoff',
      default: 'threshold',
      options: MATCH_CUTOFFS,
      visibleIf: (params) => String(params.mode ?? 'top') !== 'top',
      help:
        'An absolute score applies one number to every neuron. A percentage band applies to ' +
        'each neuron’s *own* best match, which is what you want when some neurons have a ' +
        'near-perfect match and others have nothing better than 0.3.',
    },
    {
      id: 'threshold',
      kind: 'number',
      label: 'Score at least',
      default: 0.5,
      step: 0.05,
      visibleIf: (params) =>
        String(params.mode ?? 'top') !== 'top' &&
        String(params.cutoff ?? 'threshold') === 'threshold',
      help:
        'Keep every cell at or above this — at or *below*, on a distance matrix. A normalised ' +
        'NBLAST score runs to 1 for a perfect match, and around 0.5 is the usual place to ' +
        'start looking for a same-type hit.',
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
        String(params.mode ?? 'top') !== 'top' &&
        String(params.cutoff ?? 'threshold') === 'percentage',
      help:
        'A fraction, not a percent: 0.05 keeps everything within 5% of that neuron’s best ' +
        'match. Its own best, not the matrix’s.',
    },
    {
      id: 'skipSelf',
      kind: 'boolean',
      label: 'Skip self-matches',
      default: true,
      help:
        'Drop each neuron’s own diagonal cell, which is 1.00 on a normalised all-by-all and ' +
        'would otherwise take one of the places you asked for. This is the diagonal ' +
        'specifically, so it needs a square matrix — and on a square matrix built from two ' +
        'different sets it drops a cell that is not a self-match. Turn it off there.',
    },
    {
      id: 'axis',
      kind: 'enum',
      label: 'Matches for',
      default: '0',
      options: MATCH_AXES,
      advanced: true,
      help:
        'Which way the matrix is scanned. Rows is the usual answer and is what an all-by-all ' +
        'makes symmetric anyway; columns is for a query-against-target matrix read from the ' +
        'target’s side.',
    },
    {
      id: 'direction',
      kind: 'enum',
      label: 'Best means',
      default: 'auto',
      options: MATCH_DIRECTIONS,
      advanced: true,
      help:
        'Whether a high score or a low one is a good match. “From the matrix” reads what the ' +
        'matrix says it is — NBLAST says similarity, a distance matrix says distance — and ' +
        'assumes higher is better where nothing said, which a Pivot never does.',
    },
  ],

  /*
   * Fully derivable from the mode, which is why this is a real inference rather than an
   * `observed` fallback — the columns do not depend on the data, only on which question was
   * asked. That is also why the value column is called `score` unconditionally rather than
   * taking the matrix's own `valueLabel`; see the note beside `matchSchema`.
   */
  inferOutputs: (ctx) => ({
    matches: T.table(matchSchema(String(ctx.params.mode ?? 'top') as MatchMode)),
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
