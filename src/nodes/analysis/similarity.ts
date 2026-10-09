/**
 * Similarity Matrix: every observation against every other, over sparse feature vectors.
 *
 * The algorithm and the reason there is no feature matrix in the middle are in
 * `nodes/lib/similarityOps.ts`. What belongs here is the **shape of the input**, because that
 * is the one thing this node asks somebody to decide.
 *
 * Two layouts, one node. `long` is three column pickers over a table of triplets — the form a
 * Group By or `Partner Vectors` hands over, and the form that scales, since a row exists only
 * where there is something to say. `wide` is an id column plus a multi-select of numeric
 * columns — an uploaded embedding, or a `Pivot → Table`. They are one node rather than two
 * because they answer the same question and differ only in where the features are written
 * down; splitting them would put "which metric" in two places and let the two drift.
 *
 * The layout is an `enum` with `visibleIf` pickers rather than two ports or two nodes, which
 * is `core.groupBy`'s precedent for a param whose meaning depends on another. Hidden params
 * are excluded from the provenance key, so the wide picker sitting on a stale column set
 * cannot make a long run look stale.
 *
 * **`measure` is set on the output**, and it is what makes `Similarity Matrix → Linkage` need
 * no configuration: Linkage inverts a similarity and leaves a distance alone by reading that
 * field. Pivot cannot answer it — its cells are whatever aggregation was picked — which is why
 * clustering a pivot needs a Normalize in front of it and clustering this one does not.
 *
 * Every per-metric fact this node reads — the option list, whether the Output control means
 * anything, what the cells are called — comes out of `METRICS` in the ops module. Adding the
 * sixth metric its header promises should be one row there and nothing here.
 */

import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isTableValue } from '../../core/values'
import {
  SIMILARITY_LAYOUT_OPTIONS,
  SIMILARITY_METRIC_OPTIONS,
  SIMILARITY_OUTPUT_OPTIONS,
  featuresFromLong,
  featuresFromWide,
  hasSimilarityForm,
  isLongLayout,
  similarityMatrix,
} from '../lib/similarityOps'
import type { SimilarityMetric, SimilarityOutput } from '../lib/similarityOps'

registerNode({
  type: 'core.similarity',
  label: 'Similarity Matrix',
  category: 'analysis',
  description:
    'Compare every observation with every other over its features, as a similarity or distance matrix.',
  guide:
    'Compares every neuron (or other observation) with every other one over a table of ' +
    'features, e.g. connectivity from Partner Vectors, using cosine, Jaccard, Pearson or ' +
    'Euclidean. The square matrix it returns goes into Linkage for clustering or into a Heatmap.',
  cost: 'expensive',

  inputs: [{ id: 'in', label: 'Features', type: T.table() }],
  outputs: [{ id: 'matrix', label: 'Matrix', type: T.matrix() }],

  params: [
    {
      id: 'layout',
      kind: 'enum',
      label: 'Layout',
      default: 'long',
      options: SIMILARITY_LAYOUT_OPTIONS,
      help: 'How the table is laid out. "Long (one row per pair)" is what Partner Vectors and Group By produce, and scales best.',
    },
    {
      id: 'observations',
      kind: 'column',
      label: 'Observations',
      from: 'in',
      default: '',
      visibleIf: isLongLayout,
      help: 'The column naming what is compared, usually neurons. These become the rows and columns of the matrix.',
    },
    {
      id: 'features',
      kind: 'column',
      label: 'Features',
      from: 'in',
      default: '',
      visibleIf: isLongLayout,
      help: 'The column to compare over. From Partner Vectors this is `feature`.',
    },
    {
      id: 'value',
      kind: 'column',
      label: 'Value',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: '',
      optional: true,
      visibleIf: isLongLayout,
      help: 'How strong each pair is. Leave empty to compare only which features each observation has.',
    },
    {
      id: 'idColumn',
      kind: 'column',
      label: 'Id column',
      from: 'in',
      default: '',
      visibleIf: (params) => !isLongLayout(params),
      help: 'The column naming each row.',
    },
    {
      id: 'wideFeatures',
      kind: 'columns',
      label: 'Feature columns',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: [],
      visibleIf: (params) => !isLongLayout(params),
      help: 'The numeric columns to compare over. For "Jaccard (presence)", a zero counts as absent.',
    },
    {
      id: 'metric',
      kind: 'enum',
      label: 'Metric',
      default: 'cosine',
      options: SIMILARITY_METRIC_OPTIONS,
      help: '"Cosine" ignores overall magnitude, so a strongly and a weakly connected neuron with the same partners match. "Jaccard (presence)" ignores weights; "Euclidean" also compares magnitude.',
    },
    {
      /*
       * Hidden for a metric with no similarity form, which today is Euclidean. A hidden param is
       * excluded from the provenance key (invariant 4), so `evaluate` must reach the same answer
       * without reading it — `METRICS` in `similarityOps.ts` is where that fact lives, and this
       * control, `effectiveOutput`, the value label and the inversion in the finish pass are
       * four readers of the one row rather than four spellings of the same exception.
       */
      id: 'output',
      kind: 'enum',
      label: 'Cells are',
      default: 'similarity',
      options: SIMILARITY_OUTPUT_OPTIONS,
      visibleIf: (params) => hasSimilarityForm(String(params.metric) as SimilarityMetric),
      help: '"Distance" is 1 − similarity. Either works with Linkage; heatmaps are easier to read as similarities.',
    },
  ],

  inferOutputs: () => ({ matrix: T.matrix() }),

  validate: (ctx) => {
    if (isLongLayout(ctx.params)) {
      const observations = ctx.column('observations')
      const features = ctx.column('features')
      if (!observations || !features) return ['Pick an `Observations` and a `Features` column.']
      if (observations === features) {
        return [
          '`Observations` and `Features` are the same column, so every observation is compared ' +
            'only with itself. Pick a different column for one of them.',
        ]
      }
      return []
    }
    if (!ctx.column('idColumn')) return ['Pick an `Id column` naming each row.']
    if (ctx.columns('wideFeatures').length === 0)
      return ['Pick at least one of the `Feature columns`.']
    return []
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    const metric = String(ctx.params.metric) as SimilarityMetric
    // Handed over as stored: `similarityMatrix` resolves it through `effectiveOutput` itself,
    // and resolving it twice is two call sites that have to stay in step for no gain.
    const output = String(ctx.params.output) as SimilarityOutput

    let features
    if (isLongLayout(ctx.params)) {
      const observations = ctx.column('observations')
      const featureColumn = ctx.column('features')
      if (!observations || !featureColumn) {
        throw new Error('Pick an `Observations` and a `Features` column.')
      }
      features = featuresFromLong(table, observations, featureColumn, ctx.column('value'))
    } else {
      const idColumn = ctx.column('idColumn')
      const picked = ctx.columns('wideFeatures')
      if (!idColumn) throw new Error('Pick an `Id column` naming each row.')
      if (picked.length === 0) throw new Error('Pick at least one of the `Feature columns`.')
      features = featuresFromWide(table, idColumn, picked)
    }

    if (features.labels.length < 2) {
      throw new Error(
        `A similarity matrix needs at least 2 observations; this has ` +
          `${features.labels.length}. Check that \`Observations\` is the column naming the neurons.`,
      )
    }
    return { matrix: similarityMatrix(features, metric, output, ctx) }
  },
})
