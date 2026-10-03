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
  nblastSidesFrom,
} from '../lib/nblastOps'
import { geometryLabels } from '../lib/geometryLabels'
// The Skeletons node's ceiling, imported rather than restated — see `nblast.ts`.
import { labelColumnParam, warnAboveParam } from '../lib/limitParams'
import { MAX_NEURONS } from '../lib/limitParams'

registerNode({
  type: 'neuron.nblastKnn',
  label: 'NBLAST k-NN',
  category: 'analysis',
  description:
    'Find each neuron’s most similar neurons, as a table of matches with the columns `queryId`, `targetId`, `rank` and `score`.',
  guide:
    'Finds the top matches for each query neuron using NBLAST, scoring only a shortlist of ' +
    'likely candidates instead of all pairs, which makes it fast for large populations. The ' +
    'output is a table with one row per match, ready for Build Network or Embedding.',
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
      // A thousand rather than the old hundred. The output is one row per match, so this
      // multiplies the result rather than the search — 10,000 neurons at k=1,000 is ten million
      // rows, which is a table Coda can build and a person can filter.
      max: 1000,
      help: 'How many neighbours to keep for each neuron, best first. With a Target wired, a neuron in both sets counts itself as one.',
    },
    {
      id: 'symmetry',
      kind: 'enum',
      label: 'Symmetry',
      default: 'mean',
      options: SYMMETRY_OPTIONS,
      help: 'How to combine the two scores of each pair, before the best matches are picked.',
    },
    labelColumnParam(
      'Adds a name for each side of a match. Neuron ids where this is empty or unset.',
    ),
    {
      id: 'resample',
      kind: 'number',
      label: 'Resample (µm)',
      default: 1,
      min: 0,
      step: 0.5,
      advanced: true,
      help: 'Resample skeletons to this point spacing before comparing. 1 µm is the convention; 0 keeps each skeleton as traced.',
    },
    {
      id: 'nCandidates',
      kind: 'int',
      label: 'Candidates',
      default: 200,
      min: 10,
      // Capped at the shared neuron ceiling rather than at 2,000: a shortlist longer than the
      // population it is drawn from is the point where this stops being a shortlist at all,
      // and that population is what `MAX_NEURONS` bounds.
      max: MAX_NEURONS,
      step: 10,
      advanced: true,
      help: 'How many candidates per neuron get a full score. More finds more of the true best matches but is slower; 200 recovers about 99% of the top 20.',
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
      help: 'Weight each point by how line-like its neighbourhood is, which plays down tufts and branch points.',
    },
    warnAboveParam({
      threshold: MAX_NEURONS,
      min: 2,
      counting: 'searching more than this many neurons',
    }),
  ],

  /*
   * The label columns are conditional on the picker, so the schema is answered from the same
   * resolution `evaluate` uses — invariant 5, and the reason this is not just `knnSchema(true)`.
   *
   * The id columns are the same argument one seam further out: their dtype is whatever the
   * Query's own `neuronId` is, which the *source* decides, so reading it here is what keeps the
   * advertised schema equal to the one `evaluate` builds. Unwired there is nothing to read and
   * it falls back to `knnSchema`'s default; see there for why that default is `str`.
   */
  inferOutputs: (ctx) => ({
    matches: T.table(
      knnSchema(
        ctx.column('labelColumn') !== undefined,
        idTypeOf(attributeSchema(ctx.inputs.query, 'nodes')),
      ),
    ),
  }),

  validate: (ctx) => nblastIssues(Number(ctx.params.resample)),

  evaluate: async (ctx) => {
    const { query, target: targetValue } = nblastSidesFrom(
      ctx,
      ctx.input('query'),
      ctx.input('target'),
      Number(ctx.params.limit),
    )

    ctx.progress(0.01, `${query.items.length} neurons`)
    const result = await runNblastKnn(
      {
        query: dotpropSetFrom(query),
        ...(targetValue ? { target: dotpropSetFrom(targetValue) } : {}),
        k: Number(ctx.params.k),
        nCandidates: Number(ctx.params.nCandidates),
        tangentK: Number(ctx.params.tangentK),
        resample: Number(ctx.params.resample),
        normalize: ctx.params.normalize !== false,
        symmetry: String(ctx.params.symmetry) as NblastSymmetry,
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
              query: geometryLabels(query, label),
              // Resolved against the far side's own attributes, falling back to neuron ids for a
              // column it does not carry — the same rule `geometryLabels` applies per neuron.
              target: geometryLabels(neighbours, label),
            }
          : undefined,
      ),
    }
  },
})
