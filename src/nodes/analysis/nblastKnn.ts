/**
 * NBLAST k-NN: each neuron's nearest neighbours in shape, without the full matrix.
 *
 * The sibling of `neuron.nblast` and a different *question* rather than a faster answer to the
 * same one. A matrix asks "how alike is every pair"; this asks "what is this one most like",
 * which is what a similarity search, a k-NN graph and an embedding all actually want. fastcore
 * shortlists candidates from a coarse voxel signature and scores only those, so the cost is
 * `n x nCandidates` rather than `n²` — measured by fastcore on 163,976 neurons at recall@20 of
 * 0.990 while scoring 0.16% of the pairs. **Every score returned is an exact NBLAST value**;
 * only which pairs were considered is approximate.
 *
 * **The output is a long table**, one row per (neuron, neighbour), which is the shape Filter,
 * Sort, Download and — the useful one — Build Network already take. A k-NN graph is what this
 * is for, and building it here would be this node deciding merge rules `net.build` owns.
 *
 * **What it does not yet buy is scale**, and that is worth being plain about: the Skeletons
 * node refuses above 500 neurons, and at 500 the full matrix is only about seventeen seconds.
 * So today this earns its place on the neighbour table and the graph rather than on speed. It
 * is the node that is ready when the fetch ceiling moves.
 */

import { registerNode } from '../../core/registry'
import { T, attributeSchema } from '../../core/types'
import type { NblastSymmetry } from '../../pyodide/nblast'
import { runNblastKnn } from '../../pyodide/nblast'
import {
  SYMMETRY_OPTIONS,
  dotpropSetFrom,
  idTypeOf,
  knnSchema,
  knnTable,
  nblastIssues,
  nblastLabels,
  nblastSidesFrom,
} from '../lib/nblastOps'
// The Skeletons node's ceiling, imported rather than restated — see `nblast.ts`.
import { MAX_NEURONS } from '../query/morphology'

export const nblastKnnNode = registerNode({
  type: 'neuron.nblastKnn',
  label: 'NBLAST k-NN',
  category: 'analysis',
  description: 'Find each neuron’s most similar neurons, as a table of matches.',
  guide:
    'Ask which neurons a neuron is most like, rather than scoring every pair. Each row of the ' +
    'result is one match — the neuron, its neighbour, the rank and the NBLAST score — so ' +
    'Build Network turns it straight into a similarity graph, and Filter or Sort read it like ' +
    'any other table. The shortlist that makes this cheap is approximate while the scores ' +
    'themselves are exact: fastcore measures 99% recall of the true top 20 at the default 200 ' +
    'candidates. Note that with a Target wired, a neuron present in both sets matches itself ' +
    'at 1.00 and takes one of its own k places; without one, every neuron is excluded from ' +
    'its own row.',
  cost: 'expensive',
  inputs: [
    { id: 'query', label: 'Query', type: T.skeletons() },
    { id: 'target', label: 'Target', type: T.skeletons(), required: false },
  ],
  outputs: [{ id: 'matches', label: 'Matches', type: T.table(knnSchema(false)) }],
  params: [
    {
      id: 'k',
      kind: 'int',
      label: 'Matches per neuron',
      default: 5,
      min: 1,
      max: 100,
      help:
        'How many neighbours to keep for each neuron, best first. With a Target wired, a ' +
        'neuron that appears in both sets spends one of these on itself.',
    },
    {
      id: 'symmetry',
      kind: 'enum',
      label: 'Symmetry',
      default: 'mean',
      options: SYMMETRY_OPTIONS,
      help:
        'Applied before the top-k cut, which is why it matters more here than on a matrix: ' +
        'once only k neighbours survive there is no transpose left to symmetrise against.',
    },
    {
      id: 'labelColumn',
      kind: 'column',
      label: 'Label by',
      from: 'query',
      default: '',
      optional: true,
      help: 'Adds a name for each side of a match. Neuron ids where this is empty or unset.',
    },
    {
      id: 'resample',
      kind: 'number',
      label: 'Resample (µm)',
      default: 1,
      min: 0,
      step: 0.5,
      advanced: true,
      help:
        'Space the points evenly before comparing, in micrometres. NBLAST counts points, so ' +
        'without this a finely traced neurite outvotes a coarsely traced one. 0 leaves each ' +
        'skeleton exactly as it was traced.',
    },
    {
      id: 'nCandidates',
      kind: 'int',
      label: 'Candidates',
      default: 200,
      min: 10,
      max: 2000,
      step: 10,
      advanced: true,
      help:
        'Shortlist size per neuron — the one control trading recall against cost. Measured by ' +
        'fastcore on 163,976 neurons, recall of the true top 20 is 0.911 at 50, 0.969 at 100, ' +
        '0.990 at 200 and 0.996 at 400.',
    },
    {
      id: 'tangentK',
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
   * The label columns are conditional on the picker, so the schema is answered from the same
   * resolution `evaluate` uses — invariant 5, and the reason this is not just `knnSchema(true)`.
   *
   * The id columns are the same argument one seam further out: their dtype is whatever the
   * Query's own `neuronId` is, which the *source* decides, so reading it here is what keeps the
   * advertised schema equal to the one `evaluate` builds. Unwired there is nothing to read and
   * it falls back to the `i64` the ports declare.
   */
  inferOutputs: (ctx) => ({
    matches: T.table(
      knnSchema(
        ctx.column('labelColumn') !== undefined,
        idTypeOf(attributeSchema(ctx.inputs.query, 'nodes')),
      ),
    ),
  }),

  validate: (ctx) => nblastIssues(Number(ctx.params.resample ?? 1)),

  evaluate: async (ctx) => {
    const { query, target: targetValue } = nblastSidesFrom(
      ctx.input('query'),
      ctx.input('target'),
      Number(ctx.params.limit ?? 100),
    )

    ctx.progress(0.01, `${query.items.length} neurons`)
    const result = await runNblastKnn(
      {
        query: dotpropSetFrom(query),
        ...(targetValue ? { target: dotpropSetFrom(targetValue) } : {}),
        k: Number(ctx.params.k ?? 5),
        nCandidates: Number(ctx.params.nCandidates ?? 200),
        tangentK: Number(ctx.params.tangentK ?? 5),
        resample: Number(ctx.params.resample ?? 1),
        normalize: ctx.params.normalize !== false,
        symmetry: String(ctx.params.symmetry ?? 'mean') as NblastSymmetry,
        useAlpha: ctx.params.useAlpha === true,
      },
      { onProgress: ctx.progress, signal: ctx.signal },
    )

    const neighbours = targetValue ?? query
    const label = ctx.column('labelColumn')
    return {
      matches: knnTable(
        result,
        query,
        neighbours,
        label
          ? {
              query: nblastLabels(query, label),
              // Resolved against the far side's own attributes, falling back to neuron ids for a
              // column it does not carry — the same rule `nblastLabels` applies per neuron.
              target: nblastLabels(neighbours, label),
            }
          : undefined,
      ),
    }
  },
})
