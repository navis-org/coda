/**
 * Embedding: a neighbourhood graph laid out in two dimensions, for a Scatter Plot.
 *
 * Linkage answers what the *groups* are; this answers what the *neighbourhood* looks like.
 * UMAP builds a fuzzy k-nearest-neighbour graph and then finds the 2D arrangement whose own
 * neighbourhood graph is most like it — so what it preserves is who is near whom, and what it
 * does not preserve is distance between things that were never near each other. Two clusters
 * far apart on the card are not more different than two that are close.
 *
 * **Three input ports, one wired, and they converge on one thing.** A score matrix, a table of
 * feature vectors and a table of nearest neighbours are three ways of writing down a k-NN
 * graph, which is all UMAP reads. `embedOps.ts` holds the three adapters and the reason the
 * middle one is a convenience rather than a scaling win.
 *
 * **More than one wired is refused rather than ranked.** Nothing here makes "the matrix wins"
 * a defensible rule, and a silent precedence on an `expensive` node is a picture somebody
 * believes computed from an input it ignored.
 *
 * **The seed is what makes this cacheable at all.** UMAP is stochastic, so invariant 4 would
 * otherwise need a nonce; a seeded PRNG turns "re-run for a different picture" into an ordinary
 * param edit and makes two runs of one graph the same arrangement. It is also why the
 * Annotations pickers can be *data* rather than presentational the way a Dendrogram's are —
 * relabelling re-runs the embedding, and at a fixed seed the identical layout comes back.
 *
 * What this cannot claim, and the clustering pair can: `umap-js` is a reimplementation rather
 * than a binding, so the notebook this exports and the card do not agree cell-for-cell. See
 * `src/umap/run.ts`, which is also where the reason it is not Python lives.
 */

import type { EvalContext } from '../../core/node'
import { ID_COLUMN_NAME } from '../../core/ids'
import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isMatrixValue, isTableValue } from '../../core/values'
import type { MatrixValue } from '../../core/values'
import { runUmap } from '../../umap/run'
import {
  EMBED_ISSUES,
  SOURCE_GROUP,
  checkEmbedCount,
  checkEmbedMatrix,
  checkNeighbourDistances,
  clampNeighbours,
  countAnnotated,
  embedRoute,
  embedSchema,
  embedTable,
  knnFromMatrix,
  knnFromNeighbours,
} from '../lib/embedOps'
import { displayLabels } from '../lib/displayLabels'
import {
  checkLinkageDistances,
  matrixStats,
  transformFor,
  warnUnrecordedCells,
} from '../lib/linkageOps'
import {
  SIMILARITY_LAYOUT_OPTIONS,
  SIMILARITY_METRIC_OPTIONS,
  featuresFromLong,
  featuresFromWide,
  isLongLayout,
  similarityMatrix,
} from '../lib/similarityOps'
import type { SimilarityMetric } from '../lib/similarityOps'

export const embedNode = registerNode({
  type: 'core.embed',
  label: 'Embedding',
  category: 'analysis',
  description: 'Lay out a similarity matrix or feature table in 2D with UMAP.',
  guide:
    'UMAP in the browser: a score matrix, a table of feature vectors or a table of nearest ' +
    'neighbours becomes two coordinates per neuron, ready for a Scatter Plot. It preserves who ' +
    'is near whom, so distance between clusters means nothing, and it is stochastic — the Seed ' +
    'is part of the picture. Wire Neighbours from NBLAST k-NN to skip the all-by-all matrix.',
  cost: 'expensive',

  inputs: [
    // Built from `EMBED_ROUTES`, which is also what refuses an ambiguous wiring and what both
    // exporters read — see `embedRoute`.
    {
      id: 'matrix',
      label: 'Matrix',
      type: T.matrix(),
      required: false,
      exclusiveGroup: SOURCE_GROUP,
    },
    {
      id: 'features',
      label: 'Features',
      type: T.table(),
      required: false,
      exclusiveGroup: SOURCE_GROUP,
    },
    {
      id: 'neighbours',
      label: 'Neighbours',
      type: T.table(),
      required: false,
      exclusiveGroup: SOURCE_GROUP,
    },
    /*
     * Optional, and its two pickers are the only ones here that do not change where a point
     * lands. They are still data — `Scatter Plot` colours by a real column, so this has to be
     * one — which is the opposite of `out.dendrogram`'s answer for the same-looking port. There
     * a leaf's name is a drawing and the pickers are presentational so that trying `type`, then
     * `hemilineage` re-runs no expensive Linkage; here the label leaves the node in a table.
     */
    { id: 'annotations', label: 'Annotations', type: T.table(), required: false },
  ],
  outputs: [{ id: 'out', label: 'Embedding', type: T.table(embedSchema()) }],

  params: [
    {
      id: 'neighbors',
      kind: 'int',
      label: 'Neighbours',
      default: 15,
      min: 2,
      max: 200,
      help:
        'How local the structure is. Small values keep fine detail, large ones the overall ' +
        'shape. Counts the neuron itself, so 15 means 14 neighbours.',
    },
    {
      id: 'minDist',
      kind: 'number',
      label: 'Min distance',
      default: 0.1,
      min: 0,
      max: 0.99,
      step: 0.05,
      slider: true,
      help:
        'How tightly points may pack. Near zero gives dense clumps, larger values spread them ' +
        'out. Changes the drawing, not the neighbourhoods.',
    },
    {
      id: 'seed',
      kind: 'int',
      label: 'Seed',
      default: 42,
      min: 0,
      max: 1_000_000,
      help:
        'UMAP is stochastic: the same seed gives the same arrangement. Change it to check ' +
        'that a group you read off the plot is real.',
    },
    {
      id: 'spread',
      kind: 'number',
      label: 'Spread',
      default: 1,
      min: 0.1,
      max: 10,
      step: 0.1,
      advanced: true,
      help: 'The scale the whole embedding is drawn at. Read together with Min distance, which cannot exceed it.',
    },
    {
      id: 'epochs',
      kind: 'int',
      label: 'Epochs',
      default: 0,
      min: 0,
      max: 5000,
      advanced: true,
      help:
        'How long the layout is optimised for. 0 uses umap-learn’s default: 500 below ten ' +
        'thousand points, 200 above.',
    },

    // --- the Matrix route ------------------------------------------------
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
        'UMAP needs distances. "Auto" asks the matrix, inverting it if it carries ' +
        'similarities. Same as the Linkage node’s.',
    },

    // --- the Features route ----------------------------------------------
    {
      id: 'layout',
      kind: 'enum',
      label: 'Feature layout',
      default: 'long',
      advanced: true,
      options: SIMILARITY_LAYOUT_OPTIONS,
      help: '"Long" is a table of triplets, as Partner Vectors produces; "wide" is one row per neuron with a column per feature.',
    },
    {
      id: 'observations',
      kind: 'column',
      label: 'Observations',
      from: 'features',
      default: '',
      advanced: true,
      visibleIf: isLongLayout,
      help: 'What each point in the plot will be — the neurons being compared.',
    },
    {
      id: 'featureColumn',
      kind: 'column',
      label: 'Features',
      from: 'features',
      default: '',
      advanced: true,
      visibleIf: isLongLayout,
      help: 'What they are being compared over. From Partner Vectors this is "feature".',
    },
    {
      id: 'value',
      kind: 'column',
      label: 'Value',
      from: 'features',
      dtypes: NUMERIC_DTYPES,
      default: '',
      optional: true,
      advanced: true,
      visibleIf: isLongLayout,
      help: 'How strong each pair is. Left empty, the vector is 1 wherever a pair is listed at all.',
    },
    {
      id: 'idColumn',
      kind: 'column',
      label: 'Id column',
      from: 'features',
      default: '',
      advanced: true,
      visibleIf: (params) => !isLongLayout(params),
      help: 'The column naming each row. Everything else picked below is a dimension.',
    },
    {
      id: 'wideFeatures',
      kind: 'columns',
      label: 'Feature columns',
      from: 'features',
      dtypes: NUMERIC_DTYPES,
      default: [],
      advanced: true,
      visibleIf: (params) => !isLongLayout(params),
      help: 'The numeric columns to compare over.',
    },
    {
      id: 'metric',
      kind: 'enum',
      label: 'Metric',
      default: 'cosine',
      advanced: true,
      options: SIMILARITY_METRIC_OPTIONS,
      help: 'How two feature vectors are compared, before UMAP sees them. Same list as the Similarity Matrix node’s.',
    },

    // --- the Neighbours route --------------------------------------------
    {
      id: 'queryColumn',
      kind: 'column',
      label: 'Neighbour: from',
      from: 'neighbours',
      default: 'queryId',
      advanced: true,
      help: 'The column naming the neuron a row is about. These are the points that get laid out.',
    },
    {
      id: 'targetColumn',
      kind: 'column',
      label: 'Neighbour: to',
      from: 'neighbours',
      default: 'targetId',
      advanced: true,
      help: 'The column naming its neighbour. A neighbour that never appears as a "from" is dropped; the card says how many.',
    },
    {
      id: 'scoreColumn',
      kind: 'column',
      label: 'Neighbour: score',
      from: 'neighbours',
      dtypes: NUMERIC_DTYPES,
      default: 'score',
      optional: true,
      advanced: true,
      help: 'How close the pair is. Left empty, every listed neighbour counts the same.',
    },
    {
      id: 'scoreIs',
      kind: 'enum',
      label: 'Scores are',
      default: 'similarity',
      advanced: true,
      options: [
        { value: 'similarity', label: 'similarities (bigger is more alike)' },
        { value: 'distance', label: 'distances (bigger is further apart)' },
      ],
      help: 'NBLAST k-NN emits similarities, so that is the default.',
    },

    // --- annotations ------------------------------------------------------
    {
      id: 'matchOn',
      kind: 'column',
      label: 'Match on',
      from: 'annotations',
      default: 'neuronId',
      optional: true,
      advanced: true,
      help: 'The column in the Annotations table holding the same names this embedding’s points carry.',
    },
    {
      id: 'labelBy',
      kind: 'column',
      label: 'Label by',
      from: 'annotations',
      default: 'type',
      optional: true,
      advanced: true,
      help: 'What to write into the "annotation" column — cell type, hemilineage, a Cut Tree cluster. A Scatter Plot downstream colours by it.',
    },
  ],

  /*
   * Constant, which is the whole point of `annotation` being a fixed column name rather than
   * the picked one: nothing here depends on a schema that has not arrived, so a Scatter Plot
   * downstream fills its pickers before anything runs.
   */
  inferOutputs: () => ({ out: T.table(embedSchema()) }),

  validate: (ctx) => {
    const selected = embedRoute((port) => ctx.inputs[port] !== undefined)
    if (!selected.ok) return [selected.refusal]
    const route = selected.route
    if (route === 'features') {
      if (isLongLayout(ctx.params)) {
        const observations = ctx.column('observations')
        const featureColumn = ctx.column('featureColumn')
        if (!observations || !featureColumn) return [EMBED_ISSUES.longColumns]
        if (observations === featureColumn) return [EMBED_ISSUES.sameFeature]
      } else {
        if (!ctx.column('idColumn')) return [EMBED_ISSUES.wideId]
        if (ctx.columns('wideFeatures').length === 0) return [EMBED_ISSUES.wideFeatures]
      }
    }
    if (route === 'neighbours') {
      const query = ctx.column('queryColumn')
      const target = ctx.column('targetColumn')
      if (!query || !target) return [EMBED_ISSUES.neighbourColumns]
      if (query === target) return [EMBED_ISSUES.sameNeighbour]
    }
    if (ctx.inputs.annotations !== undefined && !ctx.column('labelBy')) {
      return ['Annotations is wired but nothing is picked to label by']
    }
    /*
     * The two are one curve's parameters rather than two settings — `findABParams` fits the
     * repulsion to them — and past this point there is no curve to fit. umap-learn refuses it
     * outright; umap-js does not, so an unfittable pair there comes back as an arrangement
     * that merely looks wrong. Said at edit time, where the number is still on screen.
     */
    if (Number(ctx.params.minDist ?? 0.1) > Number(ctx.params.spread ?? 1)) {
      return [
        'Min distance cannot exceed Spread — the first is how tightly points may pack within the second',
      ]
    }
    return []
  },

  evaluate: async (ctx) => {
    // The same decision `validate` reports, thrown instead — one statement of it, so the card's
    // badge and the run's error cannot disagree about which wiring is legal.
    const selected = embedRoute((port) => ctx.input(port) !== undefined)
    if (!selected.ok) throw new Error(selected.refusal)
    const route = selected.route

    const requested = Number(ctx.params.neighbors ?? 15)
    let graph
    if (route === 'neighbours') {
      const table = ctx.input('neighbours')
      if (!isTableValue(table)) throw new Error('Neighbours is not a table')
      const query = ctx.column('queryColumn')
      const target = ctx.column('targetColumn')
      if (!query || !target) throw new Error(EMBED_ISSUES.neighbourColumns)
      const scoreIs =
        String(ctx.params.scoreIs ?? 'similarity') === 'distance' ? 'distance' : 'similarity'
      ctx.progress(0.02, `${table.length.toLocaleString()} neighbour rows`)
      const built = knnFromNeighbours(
        table,
        { query, target, score: ctx.column('scoreColumn'), scoreIs },
        requested,
        ctx,
      )
      checkNeighbourDistances(built.graph.distances, scoreIs)
      if (built.losses.unknownTargets > 0) {
        ctx.warn(
          `${built.losses.unknownTargets.toLocaleString()} rows name a neighbour that never ` +
            `appears in "${query}", so it has no point of its own and was dropped. An NBLAST ` +
            `k-NN with a Target wired compares two different populations, which is what a large ` +
            `number here means.`,
        )
      }
      if (built.losses.isolated > 0) {
        ctx.warn(
          `${built.losses.isolated.toLocaleString()} neurons ended up with no neighbours at all. ` +
            `UMAP has nothing to place them by, so they land wherever the initialisation put them ` +
            `— read them as unplaced rather than as outliers.`,
        )
      }
      graph = built.graph
    } else {
      const matrix = matrixFor(ctx, route)
      checkEmbedMatrix(ctx, matrix)
      const transform = transformFor(matrix.measure, String(ctx.params.distance ?? 'auto'))
      /*
       * Before anything is laid out: a matrix of counts read as similarities gives negative
       * distances, which UMAP embeds without complaint. `linkageOps`' guards, verbatim, because
       * it is the same mistake with the same two opposite fixes — and through **one** scan of
       * the cells, which is what the shared `matrixStats` is for.
       */
      const stats = matrixStats(matrix)
      checkLinkageDistances(matrix, transform, stats)
      warnUnrecordedCells(ctx, matrix, stats)
      const k = clampNeighbours(ctx, requested, matrix.rowLabels.length)
      ctx.progress(0.1, `${matrix.rowLabels.length.toLocaleString()} observations`)
      graph = knnFromMatrix(matrix, transform, k)
    }

    const coords = await runUmap(
      graph,
      {
        nNeighbors: graph.indices[0]?.length ?? requested,
        minDist: Number(ctx.params.minDist ?? 0.1),
        spread: Number(ctx.params.spread ?? 1),
        seed: Number(ctx.params.seed ?? 42),
        epochs: Number(ctx.params.epochs ?? 0),
      },
      { onProgress: ctx.progress, signal: ctx.signal },
    )

    const annotations = annotationsFor(ctx)
    if (annotations) {
      const matched = countAnnotated(graph.labels, annotations)
      if (matched === 0) {
        ctx.warn(
          `Nothing in the Annotations table matched — "${ctx.column('matchOn') ?? 'neuronId'}" ` +
            `holds none of the names this embedding's points carry, so the annotation column is ` +
            `empty. Check it is the column holding the same ids.`,
        )
      } else if (matched < graph.labels.length) {
        ctx.progress(
          1,
          `${matched.toLocaleString()} of ${graph.labels.length.toLocaleString()} labelled`,
        )
      }
    }

    return { out: embedTable(graph.labels, coords, annotations) }
  },
})

/**
 * The matrix the two matrix-shaped routes both end on.
 *
 * The Features route builds one here rather than taking a different path through UMAP, so the
 * distance guard, the square-population check and the k-NN read are written once. What it costs
 * is stated in `embedOps.ts`: this is `n²`, and folding the Similarity Matrix card in does not
 * change that.
 */
function matrixFor(ctx: EvalContext, route: string): MatrixValue {
  if (route === 'matrix') {
    const matrix = ctx.input('matrix')
    if (!isMatrixValue(matrix)) throw new Error('Matrix input is not a matrix')
    return matrix
  }
  const table = ctx.input('features')
  if (!isTableValue(table)) throw new Error('Features is not a table')

  let features
  if (isLongLayout(ctx.params)) {
    const observations = ctx.column('observations')
    const featureColumn = ctx.column('featureColumn')
    if (!observations || !featureColumn) throw new Error(EMBED_ISSUES.longColumns)
    features = featuresFromLong(table, observations, featureColumn, ctx.column('value'))
  } else {
    const idColumn = ctx.column('idColumn')
    const picked = ctx.columns('wideFeatures')
    if (!idColumn) throw new Error(EMBED_ISSUES.wideId)
    if (picked.length === 0) throw new Error(EMBED_ISSUES.wideFeatures)
    features = featuresFromWide(table, idColumn, picked)
  }

  checkEmbedCount(ctx, features.labels.length)
  ctx.progress(0.05, `${features.labels.length.toLocaleString()} observations`)
  // Asked as distances, so the `Distance` control resolves to `none` through the same
  // `transformFor` the wired-matrix route uses rather than through a branch here.
  return similarityMatrix(
    features,
    String(ctx.params.metric ?? 'cosine') as SimilarityMetric,
    'distance',
    ctx,
  )
}

/**
 * The label per point a wired Annotations table supplies, or nothing.
 *
 * `displayLabels` rather than `labelsByNeuron` directly, which is the guard rather than the
 * join: `labelsByNeuron` reads through `getColumn`, so a picker naming a column the table does
 * not have would *throw* where the honest answer is that nothing can name these points. Its
 * four ways of answering nothing are one answer here too — the `annotation` column comes back
 * empty and the node says so.
 */
function annotationsFor(ctx: EvalContext): ReadonlyMap<string, string> | undefined {
  const table = ctx.input('annotations')
  return displayLabels(
    isTableValue(table) ? table : undefined,
    ctx.column('matchOn') ?? ID_COLUMN_NAME,
    ctx.column('labelBy'),
  )
}
