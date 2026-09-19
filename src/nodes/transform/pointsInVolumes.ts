/**
 * Which volume is each point in.
 *
 * The node the canvas had no route to at all: a synapse cloud carries a polarity, a partner and
 * a confidence, and **no region**. So "the LC4 outputs that are in LO(R)" — an ordinary question
 * on any connectome — could be asked as a *count* by `ROI Counts` and in no way that produced
 * locations, could not be asked once the volume was a neuron's own mesh, and could not be asked
 * at all on CAVE or CATMAID, whose synapse tables carry coordinates and root ids and nothing
 * about where they are.
 *
 * Points on one socket, meshes on the other, and the same `Volumes` wire the 3D View takes — so
 * `ROI Meshes ▸ Points in Volumes` is two cards, and swapping the shells for `Meshes` asks
 * which synapses are inside another neuron instead, with no change to this node.
 *
 * ## Two outputs and a column, because one wire carries many volumes
 *
 * `Inside` and `Outside` are `Split Neurons`' gesture on a point cloud, and the minted column
 * is what a collection of volumes forces: with sixty-three shells on the wire, a bare pair of
 * ports answers "in something" and throws away *which*. `nodes/lib/pointsInMeshes.ts` argues
 * the pair, the overlap rule and the frame check; `nodes/lib/meshInside.ts` owns the ray.
 *
 * ## `expensive`, and it is the geometry rather than a request
 *
 * Nothing here fetches. What makes it expensive is the other clause of the rule: a tree per
 * volume — the better part of a second over a dataset's primary set — and a ray per
 * point-volume box candidate after that. `cheap` would re-run all of it on the keystroke that
 * renamed the column.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isMeshesValue, isPointsValue } from '../../core/values'
import { buildInsideTests, volumeBoxes } from '../lib/meshInside'
import {
  DEFAULT_VOLUME_COLUMN,
  RAY_WARN,
  VOLUME_COLUMN_PARAM,
  checkPointFrame,
  columnClash,
  countRays,
  labelPointsByVolume,
  splitOnLabels,
  volumeColumnName,
  volumeColumnSchema,
  warnRayCount,
} from '../lib/pointsInMeshes'

registerNode({
  type: 'neuron.pointsInVolumes',
  label: 'Points in Volumes',
  category: 'transform',
  description:
    'Split a point cloud by the meshes enclosing it, adding a `roi` column naming each point’s volume — written over a same-named column rather than beside it.',
  guide:
    'Tests every point of a cloud against a set of meshes and hands back both halves — the points inside some volume, and the rest — with a column naming which volume each one landed in. It is the only route from a synapse cloud to the region a synapse is in: neuPrint, CAVE and CATMAID all publish synapse coordinates with no region attached. The volumes need not be neuropils; a set of neuron meshes on the same socket asks which synapses lie inside another cell. Where volumes overlap the first on the wire wins, and the node says how many points that decided.',
  cost: 'expensive',
  inputs: [
    { id: 'points', label: 'Points', type: T.points() },
    { id: 'volumes', label: 'Volumes', type: T.meshes() },
  ],
  /*
   * `inside` first, so a link dragged off the node starts at the half somebody asked about —
   * `neuron.splitNeurons`' rule, and `neuron.connectivity`'s before it.
   */
  outputs: [
    { id: 'inside', label: 'Inside', type: T.points() },
    { id: 'outside', label: 'Outside', type: T.points() },
  ],
  params: [
    {
      id: VOLUME_COLUMN_PARAM,
      kind: 'string',
      label: 'Column',
      placeholder: DEFAULT_VOLUME_COLUMN,
      help: 'What to call the column naming each point’s volume. A column of this name already on the cloud is written over in place, rather than appearing twice.',
      default: DEFAULT_VOLUME_COLUMN,
    },
  ],

  /*
   * One schema for both ports — see `pointsInMeshes.ts` on why `Outside` carries the column
   * too. Available the moment the wire is made rather than after a Run, so a `Group By` on the
   * region can be configured while this node is still idle.
   */
  inferOutputs: (ctx) => {
    const schema = volumeColumnSchema(ctx.attributes('points'), volumeColumnName(ctx.params))
    return { inside: T.points(schema), outside: T.points(schema) }
  },

  /*
   * **The frame check is not here, and that is a fact about `CodaType` rather than a choice.**
   * Units and a template space live on the *value* — `PointsValue.units`, `MeshesValue.space` —
   * and a type carries a kind and a schema and nothing else, which is the same wall
   * `neuron.stackNeurons` hits and says so at: a mismatch waits for `evaluate`. Nor is there
   * anything to say about the wiring, both ports being concretely typed, so `checkConnection`
   * has already refused anything that does not fit.
   *
   * What is left is the one mistake a type *can* see — a column name whose last word is `id` —
   * and the sentence for it is `idColumnRefusal`'s rather than this file's, because `evaluate`
   * throws the same complaint and `kindClashMessage` records what happens to a refusal written
   * out at both layers. `withNodeColumns` keeps the same rule one layer over by convention
   * (`id` is never among the columns it folds), documented there rather than enforced.
   */
  validate: (ctx) => {
    const clash = columnClash(ctx.attributes('points'), volumeColumnName(ctx.params))
    return clash ? [clash.message] : []
  },

  evaluate: async (ctx) => {
    const points = ctx.input('points')
    if (!isPointsValue(points)) {
      throw new Error('Wire a point cloud — Synapses, or any node handing on one — to Points.')
    }
    const volumes = ctx.input('volumes')
    if (!isMeshesValue(volumes)) {
      throw new Error(
        'Wire meshes to Volumes — ROI Meshes for a dataset’s neuropils, or the Meshes node ' +
          'for neurons.',
      )
    }

    const frame = checkPointFrame(points, volumes)
    if (frame) throw new Error(frame)

    const name = volumeColumnName(ctx.params)
    // Said at both layers on purpose: `validate` marks the card, and a graph loaded with this
    // already stored must not run and quietly rewrite a column it was never going to mention.
    const clash = columnClash(points.attributes.schema, name)
    if (clash?.severity === 'error') throw new Error(clash.message)
    if (clash) ctx.warn(clash.message)

    /*
     * Answered without walking the cloud, and without reaching the library. Falling through cost
     * an `await import` of three and three-mesh-bvh — a multi-hundred-kB chunk on a cold node —
     * to build zero trees, then a full point walk whose body could not do anything, then two
     * subset passes: ~300 ms and ~100 MB of churn at five million points to compute a fact
     * already known on this line.
     */
    if (volumes.items.length === 0) {
      ctx.warn(
        'No volumes on the wire, so every point is outside. Check the Regions picker on ROI ' +
          'Meshes, or whatever filtered the volumes upstream.',
      )
      const labels = new Array<string | null>(points.attributes.length).fill(null)
      return splitOnLabels(points, labels, name)
    }

    /*
     * **The warning is raised before anything is built**, which is what `volumeBoxes` being
     * separate from `buildInsideTests` buys: the prefilter needs no library and no trees, so the
     * one stretch of this run with no abort check in it is entered only after the reader has been
     * told what the rays will cost.
     *
     * `points × volumes` is an exact upper bound on the ray count and costs one multiply, so a
     * cloud that cannot possibly reach the threshold skips the counting sweep entirely — which is
     * every ordinary one: a hundred thousand synapses against a primary set is 6.3 M, under
     * `RAY_WARN`, and was paying a full box sweep of the cloud to discover that.
     */
    const prefilter = volumeBoxes(volumes.items)
    if (points.attributes.length * volumes.items.length > RAY_WARN) {
      warnRayCount(ctx, countRays(points, prefilter.candidateCount), volumes.items.length)
    }

    ctx.progress(0.02, `${volumes.items.length} volumes`)
    const tests = await buildInsideTests(volumes.items, prefilter, {
      progress: (fraction) => ctx.progress(0.02 + fraction * 0.08),
      signal: ctx.signal,
    })

    const { inside, outside, ambiguous } = await labelPointsByVolume(points, volumes, {
      name,
      containing: tests.containing,
      progress: (fraction) => ctx.progress(0.1 + fraction * 0.9),
      signal: ctx.signal,
    })

    if (ambiguous > 0) {
      ctx.warn(
        `${ambiguous.toLocaleString()} of ${points.attributes.length.toLocaleString()} ` +
          `points are inside more than one volume and were named for the first on the ` +
          `wire. Primary regions do not overlap, so this usually means nested meshes.`,
      )
    }
    return { inside, outside }
  },
})
