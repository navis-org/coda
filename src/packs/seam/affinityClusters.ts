/**
 * Affinity Clusters: run the point affinity transformer over each neuron's skeleton and group its
 * points into the neurons the model thinks they belong to.
 *
 * **Named for what it does, not for what it was hoped to find.** It clusters points by predicted
 * affinity; reading more than one cluster as a merge was always the reader's inference rather than
 * the model's claim — and SEAM has since measured this checkpoint at chance on real FlyWire
 * merges. `seam:findMerges` is being built to do that instead (`docs/seam-model-a-plan.md`).
 *
 * The parts are in their own modules and this file is the card. What is decided *here*:
 *
 * ## `expensive`, and the consent gate above it
 *
 * Invariant 6 is not negotiable: a `cheap` node would fire a 406 MB download and a WebGPU run on
 * every keystroke. On top of that the download itself is **opt-in** — a tick box the node refuses
 * until, and only while the weights are not already in the cache. That is a first-use question,
 * not a permanent mode: once the bytes are here the box stops mattering and the node runs. The
 * figure in the refusal is the manifest's own summed `bytes`, never a constant kept here.
 *
 * ## The three numbers are literals the model's config *checks*
 *
 * `Points`, `Threshold` and `Minimum cluster size` have authoritative values in the checkpoint's
 * own config, and a param cannot take its default from one: `defaultParams` runs when the node is
 * inserted and cannot fetch, and invariant 4 forbids `ctx.params.x ?? literal`. So the table
 * carries the shipped checkpoint's values as static literals and the parsed config is used to
 * **warn** when a model disagrees with them, naming both numbers. A retrained model with a
 * different sampler or scale is refused outright (`parseAffinityConfig`); these three only change
 * what the answer means, so they warn.
 *
 * ## One unusable skeleton must not stop the others
 *
 * `skipReason` is a third verdict beside warn and refuse. A skipped neuron keeps its place in the
 * `Skeletons` output, unlabelled, and its row in `Table`, null; it contributes no points, so it is
 * absent from `Points` and from the layer. Skips are reported once as a count per reason.
 *
 * ## What the node does not claim, now measured
 *
 * The checkpoint was trained on *synthetic* merges — two neurons each centred and then offset by
 * ~20 µm — and whether that carried over to real ones was the open question this node shipped
 * with. It did not: SEAM scored this checkpoint **at chance** on real FlyWire merges. So the node
 * is named for the operation it performs rather than the finding it was hoped to make, it says
 * "looks like" throughout, and `help/affinityClusters.md` states the measurement. It is kept because a *retrained* affinity model is a live possibility and
 * everything around the checkpoint — the sampler, the parity probe, the clustering, the converter
 * — is what such a model would otherwise be rebuilt against. Nothing here writes to a segmentation.
 */

import { formatBytes } from '../../core/limits'
import type { Warner } from '../../core/limits'
import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import type { LayersValue, PointsValue, SkeletonsValue } from '../../core/values'
import { boundsOf, isSkeletonsValue, layersFrom } from '../../core/values'
import { loadManifest, variantBytes } from '../../ml/manifest'
import { openModel } from '../../ml/session'
import { gpuSupport, preferredVariant } from '../../ml/support'
import { weightsCached } from '../../ml/weights'
import { checkPointsSize } from '../../nodes/lib/pointsSize'
import { agree, plural } from '../../style/format'
import type { AffinityConfig } from './affinityConfig'
import { parseAffinityConfig } from './affinityConfig'
import type { NeuronSummary } from './affinityOps'
import { clusterAffinities, clusterConfidence, summarise } from './affinityOps'
import { affinityMatrix } from './affinityRun'
import type { PointRows } from './affinityTables'
import {
  affinityPointsSchema,
  affinityPointsTable,
  clusterSummarySchema,
  clusterSummaryTable,
} from './affinityTables'
import { checkAffinitySize } from './checkAffinitySize'
import { labelSkeleton } from './labelSkeleton'
import { AFFINITY_MODELS, AFFINITY_TASK, affinityModel } from './models'
import { CLUSTER_NODE_VALUE } from './nodeValues'
import { DEFAULT_SEED, pointCloud, skipReason } from './pointCloud'
import type { ClusterPoints } from './scene'
import { clusterLayer, writeDrawnPositions } from './scene'

/**
 * One neuron the model actually ran on.
 *
 * One record rather than five index-aligned arrays. Two of those arrays held the *same*
 * `Int32Array` object under two names, and nothing but convention kept the five in step — a
 * future `continue` that skipped one would desynchronise the outputs silently, which for this
 * node means a skeleton drawn with another neuron's clusters.
 *
 * It extends **both** consumers' parameter types, so a record missing something `affinityPointsTable`
 * or `clusterLayer` needs is an error here rather than at the call that passes it whole.
 */
interface RanNeuron extends PointRows, ClusterPoints {
  /** Its index in the **input** set, which is what puts a result back beside the skipped ones. */
  readonly at: number
  readonly summary: NeuronSummary
  /** A cluster per *skeleton node*, already in the form `nodeValues` holds. */
  readonly nodeLabels: Float32Array
}

/** One sentence for the two surfaces that say it: the card at edit time, and the run. */
const unknownModel = (id: string) =>
  `This build does not carry a model called "${id}". Pick one from \`Model\`.`

/**
 * The shipped FlyWire checkpoint's own numbers, as literals. See the header for why they cannot
 * come from the manifest, and `affinityConfig.ts` for what happens when a model disagrees.
 */
const DEFAULT_POINTS = 1024
const DEFAULT_THRESHOLD = 0.8
const DEFAULT_MIN_CLUSTER = 30

/** Where a model's weights land on the progress bar before the first neuron is encoded. */
const DOWNLOAD_SHARE = 0.2

export const affinityClustersNode = packNode({
  type: 'seam:affinityClusters',
  label: 'Affinity Clusters',
  category: 'analysis',
  description:
    'Groups each skeleton’s points into the neurons a point affinity model thinks they belong to. Its published checkpoint scores at chance on real merges — read the clusters as what the model sees, not as a finding.',
  guide:
    'Samples points from each skeleton, asks a transformer whether each pair is on the same ' +
    'neuron, and clusters the answers. The Layers output goes into the Neuroglancer node’s Extra ' +
    'layers socket. The shipped checkpoint was trained on synthetic merges and scores at chance ' +
    'on real ones, so this shows you what a shape model sees rather than where a merge is.',
  cost: 'expensive',
  inputs: [
    { id: 'in', label: 'Skeletons', type: T.skeletons() },
    // Chains like Neuroglancer Source, for the same reason: a port takes one wire, so several
    // layers reach one scene by passing through.
    { id: 'layers', label: 'Layers', type: T.layers(), required: false },
  ],
  outputs: [
    { id: 'skeletons', label: 'Skeletons', type: T.skeletons() },
    { id: 'points', label: 'Points', type: T.points() },
    { id: 'summary', label: 'Table', type: T.table() },
    { id: 'layers', label: 'Layers', type: T.layers() },
  ],
  params: [
    {
      id: 'model',
      kind: 'enum',
      label: 'Model',
      default: AFFINITY_MODELS[0]!.id,
      options: AFFINITY_MODELS.map((model) => ({ value: model.id, label: model.label })),
      help: AFFINITY_MODELS.map((model) => `${model.label}: ${model.detail}`).join(' '),
    },
    {
      id: 'download',
      kind: 'boolean',
      label: 'Download the model',
      default: false,
      help: 'The weights are a few hundred megabytes and are fetched once, then kept in this browser. Tick this to allow the download; after it has happened the box no longer matters.',
    },
    {
      id: 'points',
      kind: 'int',
      label: 'Points',
      default: DEFAULT_POINTS,
      min: 64,
      step: 256,
      help: 'How many points to sample from each skeleton. The model was trained at 1024. The work grows with the square of this, so 2048 is four times the wait.',
    },
    {
      id: 'threshold',
      kind: 'number',
      label: 'Threshold',
      default: DEFAULT_THRESHOLD,
      min: 0,
      max: 1,
      step: 0.05,
      advanced: true,
      help: 'A distance threshold on 1 − affinity, as the paper states it: 0.8 links points whose average affinity is above 0.2. Lower it to split more readily.',
    },
    {
      id: 'minClusterSize',
      kind: 'int',
      label: 'Minimum cluster size',
      default: DEFAULT_MIN_CLUSTER,
      min: 1,
      step: 5,
      advanced: true,
      help: 'Clusters smaller than this become background rather than a neuron of their own. The training data deliberately held fragments belonging to no complete neuron.',
    },
    {
      id: 'layerName',
      kind: 'string',
      label: 'Layer name',
      default: '',
      advanced: true,
      placeholder: 'predicted clusters',
      help: 'The annotation layer’s name in neuroglancer.',
    },
  ],

  inferOutputs: (ctx) => {
    const attributes = ctx.attributes('in')
    const summary = clusterSummarySchema(attributes)
    return {
      skeletons: T.skeletons(summary),
      points: T.points(affinityPointsSchema()),
      summary: T.table(summary),
      layers: T.layers(),
    }
  },

  validate: (ctx) => {
    const issues: string[] = []
    const id = String(ctx.params.model)
    if (!affinityModel(id)) issues.push(unknownModel(id))
    // Said on the card rather than only on Run: the download is the thing somebody wants to know
    // about before they press it. It cannot say whether the cache already holds the weights --
    // that is a question for IndexedDB and `validate` is synchronous -- so the wording is about
    // what the tick box permits rather than about what will happen.
    if (!ctx.params.download) {
      issues.push(
        'Tick `Download the model` to allow the weights to be fetched. Nothing is downloaded ' +
          'until you do, and once they are cached this stops mattering.',
      )
    }
    return issues
  },

  evaluate: async (ctx) => {
    const skeletons = ctx.input('in')
    if (!isSkeletonsValue(skeletons)) {
      throw new Error(
        'Nothing is wired into `Skeletons`. Wire in skeletons, e.g. from the Skeletons node.',
      )
    }
    const id = String(ctx.params.model)
    const model = affinityModel(id)
    if (!model) throw new Error(unknownModel(id))

    // Asked before anything is fetched: a browser that cannot run the model should say so in one
    // sentence rather than after 406 MB.
    const gpu = await gpuSupport()
    if (gpu.refusal) throw new Error(gpu.refusal)

    const points = Math.round(Number(ctx.params.points))
    const items = skeletons.items
    // One verdict per item, so every output stays index-aligned with the input.
    const skipped = items.map((item) => skipReason(item, skeletons, 'Skeletons'))
    const running = skipped.filter((reason) => reason === undefined).length
    if (running === 0) {
      throw new Error(
        `None of these ${plural(items.length, 'skeleton')} can be asked about: ` +
          `${skipped.find(Boolean) ?? 'there are none'}.`,
      )
    }
    // At the top, before the model is opened: `EvalContext.warn`'s own rule.
    checkAffinitySize(ctx, points, running)
    // The cloud the node *returns*, which `checkAffinitySize` does not price: that one is about
    // the matrices held per neuron, this is `neurons x points` rows of four columns, and
    // `pointsSize.ts` calls itself the guard every node building a points value goes through.
    checkPointsSize(
      ctx,
      running * points,
      affinityPointsSchema().columns.length,
      ' of sampled points',
      'Lower `Points`, or send fewer neurons.',
    )
    reportSkipped(ctx, skipped)

    ctx.progress(0, 'reading the model')
    const loaded = await loadManifest(model.manifestUrl, ctx.signal)
    if (loaded.manifest.task !== AFFINITY_TASK) {
      throw new Error(
        `${model.label} is a ${loaded.manifest.task} model, not a ${AFFINITY_TASK} one.`,
      )
    }
    const config = parseAffinityConfig(loaded.manifest.config, loaded.manifest.id)
    const threshold = Number(ctx.params.threshold)
    const minClusterSize = Math.round(Number(ctx.params.minClusterSize))
    warnOnConfigDisagreement(ctx, model.label, config, { points, threshold, minClusterSize })

    const variant = preferredVariant(loaded.manifest)
    if (!variant) {
      throw new Error(
        `None of ${model.label}'s builds can run on this browser's GPU. ` +
          `${gpu.vendor ? `The adapter reports ${gpu.vendor}. ` : ''}` +
          `This is a property of the published model, not of the neurons.`,
      )
    }
    const bytes = variantBytes(loaded.manifest, variant)
    if (!ctx.params.download && !(await weightsCached(loaded, variant))) {
      throw new Error(
        `${model.label} is a ${formatBytes(bytes)} download and \`Download the model\` is off. ` +
          `Tick it to allow the download; it is fetched once and kept in this browser.`,
      )
    }

    // `WeightProgress.received` is **per part**, and `bytes` is the whole variant — so the two
    // have to be reconciled here or the bar fills to 97% over the encoder, drops back to zero and
    // crawls to 100% over the 10 MB decoder. Each part's latest figure is kept and summed; a
    // cached part announces its full length once (`announce(held.byteLength, true)`), so the same
    // sum is right whether the bytes came off the network or out of IndexedDB.
    const received = new Map<string, number>()
    const session = await openModel({
      manifestUrl: model.manifestUrl,
      variant,
      task: AFFINITY_TASK,
      signal: ctx.signal,
      onProgress: (progress) => {
        received.set(progress.part, progress.received)
        let held = 0
        for (const part of received.values()) held += part
        ctx.progress(
          bytes > 0 ? (DOWNLOAD_SHARE * held) / bytes : 0,
          progress.cached ? 'opening the model' : `fetching ${model.label}`,
        )
      },
    })

    // The whole drawn cloud, sized before the loop: every neuron that runs contributes exactly
    // `points` points, so there is nothing to concatenate afterwards and each neuron's slice is
    // a free view onto this one buffer.
    const positions = new Float32Array(running * points * 3)
    const ran: RanNeuron[] = []

    try {
      for (let i = 0; i < items.length; i++) {
        if (skipped[i]) continue
        const item = items[i]!
        const cloud = pointCloud(item, {
          globalScale: config.preprocessing.globalScale,
          points,
          seed: DEFAULT_SEED,
        })
        // Its position among the neurons that *ran* — not `RanNeuron.at`, which is its position
        // in the input set. Two different indices, so two different names.
        const runIndex = ran.length
        const affinity = await affinityMatrix(session, cloud.positions, points, {
          signal: ctx.signal,
          onProgress: (fraction) =>
            ctx.progress(
              DOWNLOAD_SHARE + ((1 - DOWNLOAD_SHARE) * (runIndex + fraction)) / running,
              `${item.id} (${runIndex + 1} of ${running})`,
            ),
        })

        const clustering = clusterAffinities(affinity, points, { threshold, minClusterSize })
        const confidence = clusterConfidence(affinity, points, clustering.labels)
        const from = runIndex * points * 3
        const slice = positions.subarray(from, from + points * 3)
        writeDrawnPositions(item.positions, cloud.sourceIndex, slice)
        ran.push({
          at: i,
          neuronId: item.id,
          sourceIndex: cloud.sourceIndex,
          labels: clustering.labels,
          confidence,
          summary: summarise(clustering, confidence),
          // Converted here rather than in one pass at the end: a skeleton's labels are one entry
          // per *node*, and the largest published FlyWire skeleton is 338,087 of them. Holding
          // every neuron's `Int32Array` and then building a `Float32Array` against each doubles
          // the peak on the biggest thing this node allocates.
          nodeLabels: new Float32Array(
            labelSkeleton(item.positions, cloud.sourceIndex, clustering.labels),
          ),
          positions: slice,
        })
      }
    } finally {
      await session.close()
    }

    warnOnClusterCount(ctx, ran)

    // Back beside the neurons that were skipped. One lookup rather than a parallel array per
    // field, so the record's "nothing to keep in step" property holds all the way to the outputs
    // — and mapped over `items`, which is what makes the columns **dense**: `new Array(n)` leaves
    // holes, `Array.prototype.map` preserves them, and a hole reads `undefined` where every
    // consumer of a skipped neuron's cell expects `null`.
    const byItem: (RanNeuron | undefined)[] = []
    for (const neuron of ran) byItem[neuron.at] = neuron

    const summary = clusterSummaryTable(
      skeletons.attributes,
      items.map((_, i) => byItem[i]?.summary),
    )
    const labelled: SkeletonsValue = {
      ...skeletons,
      attributes: summary,
      items: items.map((item, i) => {
        const labels = byItem[i]?.nodeLabels
        if (!labels) return item
        return { ...item, nodeValues: { ...item.nodeValues, [CLUSTER_NODE_VALUE]: labels } }
      }),
    }

    const cloudValue: PointsValue = {
      kind: 'points',
      positions,
      attributes: affinityPointsTable(ran),
      bounds: boundsOf([positions]),
      ...(skeletons.units ? { units: skeletons.units } : {}),
      ...(skeletons.space ? { space: skeletons.space } : {}),
    }

    const built = clusterLayer(ran, String(ctx.params.layerName).trim() || 'predicted clusters')
    if (built.dropped > 0) {
      ctx.warn(
        `The neuroglancer layer draws the first ${plural(built.drawn, 'point')} and leaves ` +
          `${built.dropped.toLocaleString()} out — a local annotation layer of more ` +
          `than that does not draw at a usable frame rate. The Points and Skeletons outputs are ` +
          `whole; send fewer neurons, or lower \`Points\`, to draw all of them.`,
      )
    }
    const upstream = ctx.input('layers')
    const layers: LayersValue = {
      kind: 'layers',
      items: [...layersFrom(upstream), built.layer],
    }

    return { skeletons: labelled, points: cloudValue, summary, layers }
  },
})

/**
 * One sentence per reason, never one per neuron.
 *
 * `MeshDetail`'s shape for tolerated per-item failures: a set where every skeleton is in voxels
 * would otherwise raise the same sentence hundreds of times, and `ctx.warn` collapses repeats but
 * says nothing about how many there were.
 */
function reportSkipped(ctx: Warner, skipped: readonly (string | undefined)[]): void {
  const total = skipped.length
  const counts = new Map<string, number>()
  for (const reason of skipped) {
    if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  for (const [reason, count] of counts) {
    ctx.warn(
      `${count.toLocaleString()} of ${total.toLocaleString()} skeletons ` +
        `${agree(count, 'was', 'were')} left out: ${reason}. ${agree(count, 'It keeps', 'They keep')} ` +
        `a row in Table and a place in Skeletons, with no clusters, and ${agree(count, 'adds', 'add')} ` +
        `no points.`,
    )
  }
}

/**
 * Say when the chosen model's own config disagrees with the card.
 *
 * A warning rather than a substitution: the numbers are what the reader set, and silently running
 * at the model's instead would be a card whose controls do not describe what happened. Both
 * numbers are named, because "the model expects something else" is not actionable.
 */
function warnOnConfigDisagreement(
  ctx: Warner,
  label: string,
  config: AffinityConfig,
  set: { points: number; threshold: number; minClusterSize: number },
): void {
  const say = (control: string, chosen: number, trained: number) => {
    if (chosen === trained) return
    ctx.warn(
      `\`${control}\` is ${chosen}, and ${label} was trained and evaluated at ${trained}. The ` +
        `answer is still the model's; it is being asked a question it has not been checked on.`,
    )
  }
  say('Points', set.points, config.preprocessing.samplesPerNeuron)
  say('Threshold', set.threshold, config.clustering.threshold)
  say('Minimum cluster size', set.minClusterSize, config.clustering.minClusterSize)
}

/**
 * More than a few clusters on one neuron is out of distribution.
 *
 * The paper's own ablation reports the model biased towards under-segmentation, so a neuron
 * coming back in six pieces is more likely the model being asked something it cannot answer than
 * six neurons in one segment. Stated once over the set.
 */
function warnOnClusterCount(ctx: Warner, ran: readonly RanNeuron[]): void {
  const many = ran.filter((r) => r.summary.clusters > 4).length
  if (many === 0) return
  ctx.warn(
    `${plural(many, 'neuron')} came back in more than four clusters. The model was evaluated on ` +
      `segments holding one or two neurons and is biased towards merging rather than splitting, ` +
      `so that many pieces is more likely a question it cannot answer than that many neurons.`,
  )
}
