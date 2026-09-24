/**
 * Distance between: how far apart are these neurons, in micrometres.
 *
 * NBLAST's layout — a Query port, an optional Target, a matrix out — asking the question NBLAST
 * cannot. An NBLAST score says how alike two arbours are in shape; it says nothing about whether
 * they are in the same part of the brain, and two identically-shaped cells in opposite
 * hemispheres score highly. This answers the other half: closest approach, mean separation, how
 * much cable of one runs within two micrometres of the other.
 *
 * **It is also the first node in Coda that hands `Linkage` a real distance.** Every other matrix
 * on the canvas is a similarity or a count, which `transformFor` has to invert with `1 - x`;
 * `measure: 'distance'` here means a clustering takes the cells as they stand.
 *
 * ## One node, three methods, and the params switch with the method
 *
 * `visibleIf` on a `method` enum rather than three nodes, which is `cluster.cut`'s shape. The
 * three are one question — how far apart — asked with different tolerances for what "apart"
 * means, they share every input, every refusal and every unit, and the whole of what differs
 * between them is two controls. `within` is the one with a claim to its own node: it reports a
 * *quantity* rather than a distance, so the matrix's unit and `measure` change under it. That is
 * a fact about a cell, though, not about a port — which is why it is a method here and not a
 * second card.
 *
 * ## `expensive`, and nothing here fetches
 *
 * The other clause of the rule, `Points in Volumes`' case exactly: a spatial index per neuron and
 * a search per point after that. `cheap` would rebuild every tree on the keystroke that renamed
 * a label column.
 *
 * The arithmetic, and every argument about what these numbers mean, is in
 * `nodes/lib/geometryDistance.ts`.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { makeMatrix } from '../../core/values'
import { matrixAxisLabels } from '../lib/geometryLabels'
import type { ResolvedShape } from '../lib/geometryDistance'
import {
  DISTANCE_KINDS,
  METHOD_OPTIONS,
  REPORT_OPTIONS,
  STATISTIC_OPTIONS,
  checkDistanceSize,
  countLookups,
  distanceMeasure,
  distanceParamsFrom,
  distanceShapeFrom,
  distanceSidesFrom,
  distanceValueLabel,
  distanceValues,
  isDistanceKind,
  mixedQuantityRefusal,
  needsQueryIndexes,
  pairsWalked,
  symmetryOptionsFor,
  estimatedSeconds,
  wrongDistanceKindReason,
} from '../lib/geometryDistance'
import { buildTargetIndexes } from '../lib/geometryIndex'
// The Skeletons node's ceiling, imported rather than restated — see `nblast.ts`.
import { labelColumnParam, warnAboveParam } from '../lib/limitParams'
import { MAX_NEURONS } from '../lib/limitParams'

registerNode({
  type: 'neuron.distance',
  /*
   * The **label** only: `type` is `neuron.distance` and stays that way, being what a saved
   * `.coda.json` holds. `_TODOs.md` called this "Distance between" before it was built, which is
   * the name that says the node takes two sides — "Distance" alone reads like a column of them.
   */
  label: 'Distance between',
  category: 'analysis',
  description:
    'Measure how far apart neurons are in space, or how much of one lies close to the other, as ' +
    'a matrix.',
  /*
   * Held short, as `neuron.nblast`'s is and for its reason: this node has a help document, and
   * the overlay prints this above it under a `TL;DR` label. Everything cut from here — the
   * weighting, the two directions, the soma that is not there — is in that document.
   */
  guide:
    'Measures how far apart neurons are: the closest approach, the mean or median separation, ' +
    'the distance between centroids, or how much cable or surface of one lies within a given ' +
    'distance of the other. Wire one set of skeletons or meshes for an all-by-all, or a second ' +
    'for one group against another. The averages are weighted by cable or by surface, so ' +
    'resampling upstream does not move them.',
  cost: 'expensive',
  inputs: [
    { id: 'query', label: 'Query', type: T.any(), kinds: DISTANCE_KINDS },
    { id: 'target', label: 'Target', type: T.any(), kinds: DISTANCE_KINDS, required: false },
  ],
  outputs: [{ id: 'matrix', label: 'Matrix', type: T.matrix() }],
  params: [
    {
      id: 'method',
      kind: 'enum',
      label: 'Measure',
      default: 'nearest',
      options: METHOD_OPTIONS,
      help: 'Nearest-point works from every part of the Query to the closest part of the Target. Centroid compares one point per neuron — the centre of mass of its cable or surface. Within counts how much of a neuron lies close to the other.',
    },
    {
      id: 'statistic',
      kind: 'enum',
      label: 'Statistic',
      default: 'min',
      options: STATISTIC_OPTIONS,
      visibleIf: (params) => params.method === 'nearest',
      help: 'Reduces one neuron’s nearest-point distances to a single number. These are distances to the *nearest* part of the other neuron, never between every pair of points: an all-pairs mean measures how big each neuron is more than how near the two are.',
    },
    {
      id: 'within',
      kind: 'number',
      label: 'Within (µm)',
      default: 2,
      min: 0,
      step: 0.5,
      visibleIf: (params) => params.method === 'within',
      help: 'How close counts as close. 2 µm is navis’s default for cable overlap and is about the distance across which a synapse could plausibly be made.',
    },
    {
      id: 'report',
      kind: 'enum',
      label: 'Report',
      default: 'absolute',
      options: REPORT_OPTIONS,
      visibleIf: (params) => params.method === 'within',
      help: 'Absolute is µm of cable or µm² of surface. A fraction divides by the neuron’s own total, which is what makes two neurons of different sizes comparable — and is the only form a clustering can use directly, an absolute overlap being unbounded.',
    },
    {
      id: 'symmetry',
      kind: 'enum',
      label: 'Symmetry',
      default: 'mean',
      /*
       * Drawn **dead** for a closest approach between two skeletons, where the quantity is
       * symmetric and every setting is the identity — see `symmetryOptionsFor`, which is also
       * why this is an empty options list rather than a second `visibleIf`: the answer depends on
       * the two sockets' kinds, which `visibleIf` cannot see, and an empty enum keeps the stored
       * value where a hidden param loses it.
       */
      options: (ctx) => symmetryOptionsFor(distanceShapeFrom(ctx)),
      empty: 'Not used — a closest approach between two skeletons is symmetric',
      /*
       * The vocabulary the catalogue cannot get from an options *function*, which prints
       * `(options depend on the input)` — `detailParam`'s note and its measurement: a model that
       * cannot see the options guesses, and nothing refuses a guess on a dynamic enum.
       */
      catalogueNote:
        'One of mean, min, max, query. Offered for every measure but a closest approach between ' +
        'two skeletons, which is symmetric — the control is drawn dead there.',
      // `symmetryOptionsFor` reads the two input *types*, which are already resolved; nothing
      // here reaches a source listing.
      optionsWithoutPeek: true,
      // Hidden for `centroid`, which has one direction by construction. Hidden params are out of
      // the cache key, so switching to centroid and back cannot leave a stale one in it.
      visibleIf: (params) => params.method !== 'centroid',
      help: 'A small neuron can lie entirely alongside a large one, so the two directions of a pair disagree — and only the Query side is sampled at all, so they disagree by how each was reconstructed too. The mean is the usual choice and makes an all-by-all matrix symmetric.',
    },
    labelColumnParam(
      'Which attribute names each row. Neuron ids where this is empty or unset.',
    ),
    warnAboveParam({
      threshold: MAX_NEURONS,
      min: 1,
      counting: 'measuring more than this many neurons',
    }),
  ],

  /*
   * A matrix carries no schema — its labels are data, decided by the run — so there is nothing to
   * infer beyond the kind. `neuron.nblast`'s answer, for its reason.
   */
  inferOutputs: () => ({ matrix: T.matrix() }),

  /*
   * Two things a type can see. The kind check is what the `any` ports cannot do on their own:
   * `kinds` refuses a wire whose kind is *known* and wrong, and says nothing about a socket
   * upstream that has not resolved — which is the ordinary state of a half-built graph and not a
   * mistake. What it cannot catch is the pair, so the mixed-quantity refusal is asked here as
   * well as in `evaluate`: it depends only on the two kinds and the params, both of which are
   * known at edit time, and a card that goes red on Run for something visible while it was being
   * configured is a worse card.
   */
  validate: (ctx) => {
    const issues: string[] = []
    for (const [port, side] of [
      ['query', 'Query'],
      ['target', 'Target'],
    ] as const) {
      const kind = ctx.inputs[port]?.kind
      // One sentence for both layers — `evaluate` throws the same one through
      // `distanceSidesFrom`, which is `wrongKindReason`'s arrangement.
      if (kind && !isDistanceKind(kind)) issues.push(wrongDistanceKindReason(side, kind))
    }
    const mixed = mixedQuantityRefusal(distanceShapeFrom(ctx))
    if (mixed) issues.push(mixed)
    return issues
  },

  evaluate: async (ctx) => {
    const params = distanceParamsFrom(ctx.params)
    const { query, target } = distanceSidesFrom(
      ctx,
      ctx.input('query'),
      ctx.input('target'),
      Number(ctx.params.limit),
    )

    /*
     * The three facts every question below is asked of, built once. Two of them have the same
     * type, so passed positionally a swapped pair compiles — see `DistanceShape`.
     */
    const shape: ResolvedShape = {
      params,
      queryKind: query.kind,
      ...(target ? { targetKind: target.kind } : {}),
    }

    const mixed = mixedQuantityRefusal(shape)
    if (mixed) throw new Error(mixed)

    const targetValue = target ?? query
    const allByAll = target === undefined
    const rows = query.items.length
    const cols = targetValue.items.length
    /*
     * Counted and said **before any tree is built** — `volumeBoxes`' rule. Asked for the trees
     * first, the sentence arrives after a second of index building the reader was never told
     * about and could not cancel.
     *
     * `pairsWalked` rather than the arithmetic: an all-by-all halves only where the *cells* are
     * symmetric, and written out here it halved on every all-by-all — so the one configuration
     * that walks the whole grid was priced at half of it.
     */
    const pairs = pairsWalked(rows, cols, shape, allByAll)
    const lookups = countLookups(query.items, targetValue.items, params, pairs)
    checkDistanceSize(ctx, rows, cols, estimatedSeconds(pairs, lookups, shape), shape)

    ctx.progress(0.01, `${rows} neurons`)

    /*
     * Building the indexes is its own stretch of the bar, and on full-resolution meshes it is
     * most of the run. A third of the bar for it and two thirds for the walk is arbitrary, and
     * arbitrary in the direction that matters: an index pass that reports nothing looks like a
     * hang.
     */
    const indexHooks = (from: number, to: number) => ({
      progress: (fraction: number) => ctx.progress(from + (to - from) * fraction),
      signal: ctx.signal,
    })
    const targetIndexes =
      params.method === 'centroid'
        ? []
        : await buildTargetIndexes(targetValue, indexHooks(0.01, 0.25))
    /*
     * **`needsQueryIndexes`, not `needsBothDirections`.** A dual-tree descent reads both trees
     * however few directions it reports, so gating the second index set on "are two directions
     * combined" quietly switched the fast path off for `Symmetry: query against target only` —
     * five times slower on a two-port comparison, and priced as though it had run.
     *
     * An all-by-all hands the *same array* over on both fields rather than leaving `cellFor` to
     * work out that its query indexes are its target indexes. It costs nothing — one reference —
     * and it keeps that rule where the indexes are built instead of in two places.
     */
    // No `centroid` arm: `needsQueryIndexes` is already false for it — `needsBothDirections`
    // excludes it by name and `descentApplies` needs `nearest` or `within` — so the guard was a
    // second copy of a policy stated one function away.
    const queryIndexes = allByAll
      ? targetIndexes
      : needsQueryIndexes(shape)
        ? await buildTargetIndexes(query, indexHooks(0.25, 0.35))
        : undefined

    const values = await distanceValues(
      {
        ...shape,
        queryItems: query.items,
        targetItems: targetValue.items,
        targetIndexes,
        ...(queryIndexes ? { queryIndexes } : {}),
        allByAll,
      },
      {
        progress: (fraction: number) => ctx.progress(0.35 + 0.65 * fraction),
        signal: ctx.signal,
      },
    )

    const [rowLabels, colLabels] = matrixAxisLabels(query, target, ctx.column('labelColumn'))
    return {
      matrix: makeMatrix(
        rowLabels,
        colLabels,
        values,
        distanceValueLabel(params, query.kind),
        distanceMeasure(params),
      ),
    }
  },
})
