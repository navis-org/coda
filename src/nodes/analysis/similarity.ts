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

export const similarityNode = registerNode({
  type: 'core.similarity',
  label: 'Similarity Matrix',
  category: 'analysis',
  description:
    'Compare every observation with every other over its features, as a similarity or distance matrix.',
  guide:
    'Turns a table of features into the square matrix a Linkage or a Heatmap takes — connectivity similarity is the case it was written for, but any features work, including an uploaded embedding. It reads the long form directly rather than pivoting first, which is what makes it scale, and it says on the output whether the cells are similarities or distances.',
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
      help: 'Long is a table of triplets — observation, feature, value — which is what Partner Vectors and Group By produce and the only form that scales. Wide is one row per observation with a column per feature, which is what an uploaded embedding looks like.',
    },
    {
      id: 'observations',
      kind: 'column',
      label: 'Observations',
      from: 'in',
      default: '',
      visibleIf: isLongLayout,
      help: 'What the rows and columns of the result will be — the neurons being compared.',
    },
    {
      id: 'features',
      kind: 'column',
      label: 'Features',
      from: 'in',
      default: '',
      visibleIf: isLongLayout,
      help: 'What they are being compared over. From Partner Vectors this is `feature`, which already keeps upstream and downstream apart.',
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
      help: 'How strong each pair is. Left empty the vector is 1 wherever a pair is listed at all, however many rows list it — which asks whether two observations touch the same features rather than how hard.',
    },
    {
      id: 'idColumn',
      kind: 'column',
      label: 'Id column',
      from: 'in',
      default: '',
      visibleIf: (params) => !isLongLayout(params),
      help: 'The column naming each row. Everything else picked below is a dimension.',
    },
    {
      id: 'wideFeatures',
      kind: 'columns',
      label: 'Feature columns',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: [],
      visibleIf: (params) => !isLongLayout(params),
      help: 'The numeric columns to compare over. A zero counts as absent, which matters only to Jaccard (presence).',
    },
    {
      id: 'metric',
      kind: 'enum',
      label: 'Metric',
      default: 'cosine',
      options: SIMILARITY_METRIC_OPTIONS,
      help: 'Cosine ignores overall magnitude, so a strongly and a weakly connected neuron with the same partners come out alike. Jaccard (presence) ignores the weights entirely. Jaccard (weighted) and Pearson both keep them; Euclidean keeps the magnitude too, so it separates by how much as well as by what.',
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
      visibleIf: (params) =>
        hasSimilarityForm(String(params.metric ?? 'cosine') as SimilarityMetric),
      help: 'Distance is 1 − the similarity. Either works into Linkage, which reads which one this is off the matrix; a Heatmap is usually easier to read as similarities.',
    },
  ],

  inferOutputs: () => ({ matrix: T.matrix() }),

  validate: (ctx) => {
    if (isLongLayout(ctx.params)) {
      const observations = ctx.column('observations')
      const features = ctx.column('features')
      if (!observations || !features) return ['Pick an Observations and a Features column']
      if (observations === features) {
        return [
          'Observations and Features point at the same column, which compares every observation only with itself',
        ]
      }
      return []
    }
    if (!ctx.column('idColumn')) return ['Pick the column naming each row']
    if (ctx.columns('wideFeatures').length === 0) return ['Pick at least one feature column']
    return []
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    const metric = String(ctx.params.metric ?? 'cosine') as SimilarityMetric
    // Handed over as stored: `similarityMatrix` resolves it through `effectiveOutput` itself,
    // and resolving it twice is two call sites that have to stay in step for no gain.
    const output = String(ctx.params.output ?? 'similarity') as SimilarityOutput

    let features
    if (isLongLayout(ctx.params)) {
      const observations = ctx.column('observations')
      const featureColumn = ctx.column('features')
      if (!observations || !featureColumn) {
        throw new Error('Pick an Observations and a Features column')
      }
      features = featuresFromLong(table, observations, featureColumn, ctx.column('value'))
    } else {
      const idColumn = ctx.column('idColumn')
      const picked = ctx.columns('wideFeatures')
      if (!idColumn) throw new Error('Pick the column naming each row')
      if (picked.length === 0) throw new Error('Pick at least one feature column')
      features = featuresFromWide(table, idColumn, picked)
    }

    if (features.labels.length < 2) {
      throw new Error(
        `A similarity matrix needs at least 2 observations; this one has ` +
          `${features.labels.length}. Check that the Observations column is the neurons rather ` +
          `than the features.`,
      )
    }
    return { matrix: similarityMatrix(features, metric, output, ctx) }
  },
})
