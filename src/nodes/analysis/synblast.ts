/**
 * syNBLAST: how alike are these neurons in *where they connect*?
 *
 * NBLAST's sibling, and a different question rather than a cheaper answer to the same one.
 * NBLAST scores how well one neuron's arbor lies along another's, so two cells with the same
 * shape score high whoever they talk to. This compares the **synapses** — for every query
 * connector the nearest target connector of the same polarity, scored through the same FCWB
 * lookup table with the dot product fixed at 1, because a synapse has no direction. Two
 * neurons with identical morphology whose inputs arrive in different places score low here
 * and high there, and that difference is the whole reason to have both.
 *
 * Synapses in, a score matrix out — a `MatrixValue` on the same scale as NBLAST's, so the
 * Heatmap draws it, Linkage clusters it, NBLAST Matches pulls the top hits out of it and
 * Download writes the CSV, none of which had to learn anything.
 *
 * **The input is a point cloud and not a neuron list, which is the one structural difference
 * from `neuron.nblast`.** A `SkeletonsValue` is already one item per neuron; a `PointsValue`
 * is one row per *synapse*, with the neuron in a column. So this node groups first, and every
 * consequence of that — first-appearance order, orphan synapses getting a row of their own,
 * the label being read at a group's first point — is recorded in `synblastOps.ts`.
 *
 * **Filter upstream, not here.** There is no polarity or region control on this card even
 * though both would be one line, because the Synapses node already has the first and Filter
 * already has the second, and a second place to narrow a point cloud is a second place for the
 * matrix to disagree with the table beside it.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { NblastSymmetry } from '../../pyodide/nblast'
import { runSynblast } from '../../pyodide/nblast'
import { SYMMETRY_OPTIONS, nblastMatrix } from '../lib/nblastOps'
import { hasPolarity, synapseLabels, synapseSetFrom, synblastSidesFrom } from '../lib/synblastOps'
import { warnAboveParam } from '../lib/limitParams'
import { MAX_NEURONS } from '../query/morphology'

export const synblastNode = registerNode({
  type: 'neuron.synblast',
  label: 'syNBLAST',
  category: 'analysis',
  description: 'Score how alike neurons are by where their synapses sit, as a matrix.',
  guide:
    'Compare neurons by their synapses rather than by their shape: for each connector, how far ' +
    'away the nearest connector of the same polarity on the other neuron is. Wire one set of ' +
    'Synapses for an all-by-all, or two to score one group against another. Two cells with the ' +
    'same arbor that talk to different partners score low here and high on NBLAST, which is ' +
    'the reason to run both.',
  cost: 'expensive',
  inputs: [
    { id: 'query', label: 'Query', type: T.points() },
    { id: 'target', label: 'Target', type: T.points(), required: false },
  ],
  outputs: [{ id: 'scores', label: 'Scores', type: T.matrix() }],
  params: [
    {
      id: 'symmetry',
      kind: 'enum',
      label: 'Symmetry',
      default: 'mean',
      options: SYMMETRY_OPTIONS,
      help:
        'A neuron with few synapses can sit entirely inside the cloud of one with many, so ' +
        'the two directions of a pair disagree. The mean is the usual choice and is what ' +
        'makes an all-by-all matrix read the same on both sides of its diagonal.',
    },
    {
      id: 'polarityColumn',
      kind: 'column',
      label: 'Polarity',
      from: 'query',
      default: 'polarity',
      optional: true,
      help:
        'Which column says whether a synapse is an input or an output. Set, a presynapse is ' +
        'only ever compared against presynapses — which is the standard way to run this, and ' +
        'why it defaults to the column the Synapses node emits. Cleared, every connector is ' +
        'one pool.',
    },
    {
      id: 'labelColumn',
      kind: 'column',
      label: 'Label by',
      from: 'query',
      default: '',
      optional: true,
      help:
        'Which attribute names each row. Read at each neuron’s first synapse, so a column ' +
        'that varies within a neuron gives whichever value came back first. Neuron ids where ' +
        'this is empty or unset.',
    },
    {
      id: 'normalize',
      kind: 'boolean',
      label: 'Normalise',
      default: true,
      advanced: true,
      help: 'Divide by the score of a neuron against itself, so a perfect match is 1.',
    },
    warnAboveParam({
      threshold: MAX_NEURONS,
      min: 2,
      cost:
        'the comparison runs either way. Note the cost here grows with the *synapse* count ' +
        'rather than the neuron count, and the node warns about that separately.',
    }),
  ],

  // A matrix carries no schema — its labels are data, decided by the run. `neuron.nblast`'s
  // answer, and `core.pivot`'s for its Matrix half.
  inferOutputs: () => ({ scores: T.matrix() }),

  validate: (ctx) => {
    /*
     * The one edit-time question worth asking, and it is about a column rather than about a
     * number: a point cloud with no polarity column compares every connector against every
     * other, which is a different — and much less discriminating — measure wearing the same
     * name. Said here because the alternative is a matrix that is merely *worse* rather than
     * wrong, which is the kind of thing nobody notices.
     */
    return ctx.column('polarityColumn')
      ? []
      : ['No polarity column, so inputs and outputs are compared against each other']
  },

  evaluate: async (ctx) => {
    const { query, queryGroups, target, targetGroups } = synblastSidesFrom(
      ctx,
      ctx.input('query'),
      ctx.input('target'),
      Number(ctx.params.limit ?? MAX_NEURONS),
    )

    const polarity = ctx.column('polarityColumn')
    // Resolved against the *query's* attributes, which is where the picker reads from. A
    // Target that does not carry the column falls back to one pool on its own side rather
    // than refusing — the same rule `nblastLabels` applies to a label column per neuron.
    const byType = hasPolarity(query.attributes, polarity)

    ctx.progress(0.01, `${queryGroups.length} neurons`)
    const result = await runSynblast(
      {
        query: synapseSetFrom(query, queryGroups, polarity),
        ...(target && targetGroups
          ? { target: synapseSetFrom(target, targetGroups, polarity) }
          : {}),
        byType,
        normalize: ctx.params.normalize !== false,
        symmetry: String(ctx.params.symmetry ?? 'mean') as NblastSymmetry,
      },
      { onProgress: ctx.progress, signal: ctx.signal },
    )

    const label = ctx.column('labelColumn')
    const rowLabels = synapseLabels(query, queryGroups, label)
    return {
      scores: nblastMatrix(
        result,
        rowLabels,
        // The target's rows are its own, and a column picked on the Query port names a column
        // the Target may not even have — so the far side falls back to neuron ids rather than
        // silently labelling one set with another's idea of a name. `neuron.nblast`'s call.
        // An all-by-all reuses the row labels, which is what makes that fallback visible here
        // rather than something a reader has to infer from two identical calls.
        target && targetGroups ? synapseLabels(target, targetGroups, undefined) : rowLabels,
      ),
    }
  },
})
