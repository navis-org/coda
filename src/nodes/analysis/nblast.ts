/**
 * NBLAST: how alike are these neurons, shape for shape?
 *
 * Skeletons in, a score matrix out — which is a `MatrixValue`, so the Heatmap draws it, the
 * Normalize node rescales it and Download writes it as a CSV, none of which had to learn
 * anything about this node. The comparison is Costa et al.'s NBLAST run by **navis-fastcore**,
 * the same Rust implementation navis uses, loaded into the page as a Python runtime the first
 * time somebody presses Run. `src/pyodide/` is that half; nothing in it is in the bundle.
 *
 * **This is a spike.** What it is spiking is not the algorithm — that is somebody else's, and
 * it is finished — but the cost of hosting it: about ten megabytes on first use, of which nine
 * tenths is CPython and numpy rather than NBLAST, and a comparison that runs single-threaded
 * because Pyodide has no pthreads and a `SharedArrayBuffer` needs headers a GitHub Pages deploy
 * cannot set. Both numbers are in `pyodide/runtime.ts`, measured rather than estimated. The
 * node is deliberately small so that what is being judged is that cost.
 *
 * **Everything here changes the scores, so nothing is presentational.** Even `Label by` does:
 * the labels are part of the matrix that leaves the port, not a way of drawing it. A node whose
 * every param is in the provenance key is unusual enough here to be worth saying out loud.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { NblastSymmetry } from '../../pyodide/nblast'
import { runNblast } from '../../pyodide/nblast'
import {
  SYMMETRY_OPTIONS,
  checkNblastSize,
  dotpropSetFrom,
  nblastIssues,
  nblastLabels,
  nblastMatrix,
  nblastSidesFrom,
} from '../lib/nblastOps'
// The ceiling is the *fetch's*, not this node's: nothing can reach here that the Skeletons
// node would not hand over. Imported rather than restated, or "parity" is a comment.
import { MAX_NEURONS } from '../query/morphology'

export const nblastNode = registerNode({
  type: 'neuron.nblast',
  label: 'NBLAST',
  category: 'analysis',
  description: 'Score how alike neurons are in shape, as a matrix.',
  /*
   * Held to three sentences, unlike most, because this node has a help document and the overlay
   * prints this above it under a `TL;DR` label — see `docs/help.md`. Everything that used to be
   * here and is not now (the scoring, the Pyodide download, the throughput) is in that document,
   * which is the surface with room for it. Two or three sentences is what `core/node.ts` asks
   * of every `guide`; this one was eight.
   */
  guide:
    'Compare neurons by shape rather than by connectivity, scoring every pair on how well one ' +
    'neuron’s arbor lies along the other’s. Wire one set of Skeletons for an all-by-all — the ' +
    'usual way in — or a second set to score one group against another. The result is a ' +
    'matrix, ready for a Heatmap or a clustering.',
  cost: 'expensive',
  inputs: [
    { id: 'query', label: 'Query', type: T.skeletons() },
    { id: 'target', label: 'Target', type: T.skeletons(), required: false },
  ],
  outputs: [{ id: 'scores', label: 'Scores', type: T.matrix() }],
  params: [
    {
      id: 'resample',
      kind: 'number',
      label: 'Resample (µm)',
      default: 1,
      min: 0,
      step: 0.5,
      help:
        'Space the points evenly before comparing, in micrometres. Too fine and your NBLAST will ' +
        'take forever. Too coarse and your scores will be meaningless. 1 µm is the convention, and the default. '+
        ' Setting it to 0 leaves each skeleton exactly as it was traced.',
    },
    {
      id: 'symmetry',
      kind: 'enum',
      label: 'Symmetry',
      default: 'mean',
      options: SYMMETRY_OPTIONS,
      help:
        'A small neuron can lie entirely inside a large one, so the two directions of a pair ' +
        'disagree. The mean is the usual choice and is what makes an all-by-all matrix read ' +
        'the same on both sides of its diagonal.',
    },
    {
      id: 'labelColumn',
      kind: 'column',
      label: 'Label by',
      from: 'query',
      default: '',
      optional: true,
      help: 'Which attribute names each row. Neuron ids where this is empty or unset.',
    },
    {
      id: 'k',
      kind: 'int',
      label: 'Tangent neighbours',
      default: 5,
      min: 2,
      max: 20,
      advanced: true,
      help: 'Points used to fit each tangent vector. 5 is the convention for skeletons.',
    },
    {
      id: 'normalize',
      kind: 'boolean',
      label: 'Normalise',
      default: true,
      advanced: true,
      help: 'Divide by the score of a neuron against itself, so a perfect match is 1.',
    },
    {
      id: 'useAlpha',
      kind: 'boolean',
      label: 'Weight by alpha',
      default: false,
      advanced: true,
      help:
        'Weight each point by how strongly its neighbourhood is a line rather than a blob, ' +
        'which plays down tufts and branch points.',
    },
    {
      id: 'limit',
      kind: 'int',
      label: 'Max neurons',
      default: 100,
      min: 2,
      max: MAX_NEURONS,
      step: 10,
      advanced: true,
      help: 'Refuse either side above this, rather than locking the tab up scoring.',
    },
  ],

  /*
   * A matrix carries no schema — its labels are data, decided by the run — so there is nothing
   * to infer beyond the kind. That is the same answer `core.pivot` gives for its Matrix half.
   */
  inferOutputs: () => ({ scores: T.matrix() }),

  validate: (ctx) => nblastIssues(Number(ctx.params.resample ?? 1)),

  evaluate: async (ctx) => {
    const { query, target: targetValue } = nblastSidesFrom(
      ctx.input('query'),
      ctx.input('target'),
      Number(ctx.params.limit ?? 100),
    )

    const rows = query.items.length
    const cols = targetValue ? targetValue.items.length : rows
    checkNblastSize(rows, cols)

    ctx.progress(0.01, `${rows} neurons`)
    const result = await runNblast(
      {
        query: dotpropSetFrom(query),
        ...(targetValue ? { target: dotpropSetFrom(targetValue) } : {}),
        k: Number(ctx.params.k ?? 5),
        resample: Number(ctx.params.resample ?? 1),
        normalize: ctx.params.normalize !== false,
        symmetry: String(ctx.params.symmetry ?? 'mean') as NblastSymmetry,
        useAlpha: ctx.params.useAlpha === true,
      },
      { onProgress: ctx.progress, signal: ctx.signal },
    )

    const label = ctx.column('labelColumn')
    return {
      scores: nblastMatrix(
        result,
        nblastLabels(query, label),
        // The target's rows are its own, and a column picked on the Query port names a column
        // the Target may not even have — so the far side falls back to neuron ids rather than
        // silently labelling one set with another's idea of a name.
        targetValue ? nblastLabels(targetValue, undefined) : nblastLabels(query, label),
      ),
    }
  },
})
