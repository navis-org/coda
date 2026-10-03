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
  nblastMatrix,
  nblastSidesFrom,
} from '../lib/nblastOps'
import { matrixAxisLabels } from '../lib/geometryLabels'
// The ceiling is the *fetch's*, not this node's: nothing can reach here that the Skeletons
// node would not hand over. Imported rather than restated, or "parity" is a comment.
import { labelColumnParam, warnAboveParam } from '../lib/limitParams'
import { MAX_NEURONS } from '../lib/limitParams'

registerNode({
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
    'Compare neurons by shape: NBLAST scores every pair on how well one neuron lines up with ' +
    'the other. Wire one set of Skeletons for an all-by-all, or a second set into Target to ' +
    'compare two groups. The output is a matrix of scores, typically clustered with Linkage.',
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
      help: 'Resample skeletons to this point spacing before comparing. 1 µm is the convention; 0 keeps each skeleton as traced.',
    },
    {
      id: 'symmetry',
      kind: 'enum',
      label: 'Symmetry',
      default: 'mean',
      options: SYMMETRY_OPTIONS,
      help: 'How to combine the two scores of each pair. They differ because a small neuron can lie entirely inside a large one; "mean of both directions" is the usual choice.',
    },
    labelColumnParam(
      'Which attribute names each row. Neuron ids where this is empty or unset.',
    ),
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
      help: 'Weight each point by how line-like its neighbourhood is, which plays down tufts and branch points.',
    },
    warnAboveParam({
      threshold: MAX_NEURONS,
      min: 2,
      counting: 'comparing more than this many neurons',
    }),
  ],

  /*
   * A matrix carries no schema — its labels are data, decided by the run — so there is nothing
   * to infer beyond the kind. That is the same answer `core.pivot` gives for its Matrix half.
   */
  inferOutputs: () => ({ scores: T.matrix() }),

  validate: (ctx) => nblastIssues(Number(ctx.params.resample)),

  evaluate: async (ctx) => {
    const { query, target: targetValue } = nblastSidesFrom(
      ctx,
      ctx.input('query'),
      ctx.input('target'),
      Number(ctx.params.limit),
    )

    const rows = query.items.length
    const cols = targetValue ? targetValue.items.length : rows
    checkNblastSize(ctx, rows, cols)

    ctx.progress(0.01, `${rows} neurons`)
    const result = await runNblast(
      {
        query: dotpropSetFrom(query),
        ...(targetValue ? { target: dotpropSetFrom(targetValue) } : {}),
        k: Number(ctx.params.k),
        resample: Number(ctx.params.resample),
        normalize: ctx.params.normalize !== false,
        symmetry: String(ctx.params.symmetry) as NblastSymmetry,
        useAlpha: ctx.params.useAlpha === true,
      },
      { onProgress: ctx.progress, signal: ctx.signal },
    )

    const [rowLabels, colLabels] = matrixAxisLabels(
      query,
      targetValue,
      ctx.column('labelColumn'),
    )
    return { scores: nblastMatrix(result, rowLabels, colLabels) }
  },
})
