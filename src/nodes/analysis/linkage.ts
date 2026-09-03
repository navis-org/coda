/**
 * Linkage: the merge tree of a score matrix.
 *
 * NBLAST answers how alike every pair is; this answers what the *groups* are. Hierarchical
 * clustering agglomerates the two nearest observations, then the two nearest of what is left,
 * and records each merge — so the result is not a partition but every partition at once, which
 * is why it is drawn as a tree and cut afterwards rather than being given a k up front.
 *
 * **Two outputs, and the second is the cheap 80% of a clustermap.** `Tree` goes to Dendrogram
 * or Cut Tree; `Ordered` is the input matrix with its rows and columns in leaf order, which
 * wired to the existing Heatmap is the block-diagonal picture with no new drawing code and no
 * second colour scale to keep in step.
 *
 * **fastcore's linkage is SciPy's**, checked rather than assumed — merge order identical on
 * every one of 60 trials across the five methods offered, heights agreeing to 1.3e-15. That is
 * what makes the notebook export a translation rather than a reimplementation, and it is worth
 * knowing before anyone reaches for a hand-rolled clustering here.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isMatrixValue } from '../../core/values'
import type { LinkageSymmetry } from '../../pyodide/linkage'
import { runLinkage } from '../../pyodide/linkage'
import {
  LINKAGE_METHODS,
  LINKAGE_SYMMETRY_OPTIONS,
  checkLinkageDistances,
  checkLinkageInput,
  distanceLabelFor,
  linkageRequestFrom,
  linkageValueFrom,
  orderedMatrix,
  transformFor,
  warnUnrecordedCells,
} from '../lib/linkageOps'

export const linkageNode = registerNode({
  type: 'cluster.linkage',
  label: 'Linkage',
  category: 'analysis',
  description: 'Cluster a score matrix into a merge tree.',
  /*
   * Three sentences, for the reason NBLAST's is: this node has a help document, and the overlay
   * prints this above it under a `TL;DR` label. What used to be here — the reordered second
   * output, the automatic distance conversion — is in that document, where there is room to say
   * why each matters. `help.test.ts` holds the ceiling.
   */
  guide:
    'Perform hierarchical/agglomerative clustering on a distance or similarty matrix. ' +
    'This is the usual next step after NBLAST, and works on any square matrix over one population. ' +
    'Can be wired into a Dendrogram, Cut Tree, or Heatmap node to see the groups and their scores.',
  cost: 'expensive',
  inputs: [{ id: 'in', label: 'Matrix', type: T.matrix() }],
  outputs: [
    { id: 'tree', label: 'Tree', type: T.linkage() },
    { id: 'ordered', label: 'Ordered', type: T.matrix() },
  ],
  params: [
    {
      id: 'method',
      kind: 'enum',
      label: 'Method',
      default: 'ward',
      options: LINKAGE_METHODS,
      help:
        'How the distance between two groups is measured. Ward keeps groups compact and is ' +
        'what the NBLAST paper uses; average is the other common choice and is less eager to ' +
        'split off outliers; single chains, and will happily join two clusters through one ' +
        'intermediate neuron.',
    },
    {
      id: 'symmetry',
      kind: 'enum',
      label: 'Symmetry',
      default: 'mean',
      options: LINKAGE_SYMMETRY_OPTIONS,
      help:
        'A distance has to be symmetric and an NBLAST score is not, so the two directions of ' +
        'each pair are combined first. Note that "use the matrix as it is" reads only the ' +
        'upper triangle — on a matrix that is not already symmetric, the lower half is ' +
        'discarded rather than used.',
    },
    {
      id: 'distance',
      kind: 'enum',
      label: 'Distance',
      default: 'auto',
      advanced: true,
      options: [
        { value: 'auto', label: 'auto (from the matrix)' },
        { value: 'one_minus', label: '1 − value' },
        { value: 'none', label: 'the values are already distances' },
      ],
      help:
        'Clustering needs distances. Auto asks the matrix: NBLAST says it carries ' +
        'similarities, so they are inverted; a matrix that says it carries distances is used ' +
        'as it stands. A matrix that says nothing — a Pivot cannot know — is treated as ' +
        'similarities.',
    },
  ],

  /*
   * Nothing to infer beyond the two kinds. A linkage carries no schema, and a matrix's labels
   * are data decided by the run — the same answer `core.pivot` gives for its Matrix half.
   */
  inferOutputs: () => ({ tree: T.linkage(), ordered: T.matrix() }),

  evaluate: async (ctx) => {
    const matrix = ctx.input('in')
    if (!isMatrixValue(matrix)) throw new Error('Input is not a matrix')
    checkLinkageInput(ctx, matrix)

    const method = String(ctx.params.method ?? 'ward')
    const transform = transformFor(matrix.measure, String(ctx.params.distance ?? 'auto'))
    // Before anything is marshalled: a matrix of counts turned into negative distances
    // clusters perfectly happily and draws nowhere. See `checkLinkageDistances`.
    checkLinkageDistances(matrix, transform)
    // The third of this module's three before-you-cluster guards, and it was the one this
    // node did not call: the Python side substitutes zero for a cell nobody recorded, and
    // `out.heatmap` has always said so where reaching the same clustering through here did
    // not. One substitution, admitted on both surfaces.
    warnUnrecordedCells(ctx, matrix)

    ctx.progress(0.01, `${matrix.rowLabels.length} observations`)
    const result = await runLinkage(
      linkageRequestFrom(matrix, {
        method,
        symmetry: String(ctx.params.symmetry ?? 'mean') as LinkageSymmetry,
        transform,
      }),
      { onProgress: ctx.progress, signal: ctx.signal },
    )

    return {
      tree: linkageValueFrom(result, matrix.rowLabels.slice(), {
        method,
        distanceLabel: distanceLabelFor(matrix, transform),
      }),
      ordered: orderedMatrix(matrix, result.order),
    }
  },
})
