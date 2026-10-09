/**
 * Split Axon/Dendrite: every skeleton node labelled axon, dendrite or linker, as data on the wire.
 *
 * The split itself is `compartmentOps.splitSkeletons` — navis's synapse flow centrality, the same
 * call Neuron Topology makes — so this card and that one cannot disagree. What this node adds is
 * where the answer goes: onto each skeleton as `SkeletonGeometry.split`, which the 3D View shades
 * by, and onto each synapse as a `compartment` column, which anything that reads a table can group
 * by. Topology keeps only per-neuron totals; those are this node's `Summary`.
 *
 * **`cheap`, because nothing here fetches.** The skeletons and the synapses arrive on wires, so
 * invariant 6 does not apply, and the two thresholds are the controls whose honest setting is
 * found by moving them and looking at the arbour. The Heatmap's clustering is the precedent for a
 * Pyodide call in a `cheap` node. The cost is that the first run in a session pays the runtime
 * download (~10 MB), on the first edit after the node is wired rather than on a Run.
 *
 * **The synapses are a wire, never a fetch.** A Synapses node of the same neurons, both
 * polarities, is the input the split is defined over. A `Synapses Between` cloud is not: its
 * `neuronId` is the presynaptic neuron on every row, so a postsynaptic neuron's inputs would be
 * filed under its partner.
 */

import type { EvalContext } from '../../core/node'
import { registerNode } from '../../core/registry'
import { T, columnNames } from '../../core/types'
import type { PointsValue, SkeletonsValue } from '../../core/values'
import { isPointsValue, isSkeletonsValue } from '../../core/values'
import { memoPromise, untilAborted } from '../../data/memoPromise'
import { checkGeometryUnits } from '../../data/units'
import type { NeuronSynapses, SetSplit, SplitSettings } from '../lib/compartmentOps'
import { parentDistances } from '../lib/topologyOps'
import {
  correctSplit,
  labelSynapses,
  labelledSynapsesSchema,
  readSplitSettings,
  sitesByNeuron,
  splitParams,
  splitSkeletons,
  splitSummarySchema,
  splitSummaryTable,
  splitWarning,
  withSplit,
} from '../lib/compartmentOps'
import { CORRECTIONS_PARAM, readCorrections } from '../lib/splitCorrections'
import { frameClash, frameClashMessage } from '../lib/transformOps'

/**
 * The automatic split, remembered per input pair and settings.
 *
 * So that a hand correction — an edit to `corrections` alone, re-running this `cheap` node — is a
 * TypeScript pass over labels already computed rather than another trip through Python. Keyed on
 * the skeletons value, which the scheduler hands back by identity until something upstream re-runs,
 * then on the settings and the flow flag. Only the latest synapse cloud per skeletons value is
 * kept: a new one is a new input, and the old splits answer nothing about it.
 *
 * Two levels, because half of the work does not depend on the thresholds: grouping the cloud by
 * neuron and every node's parent distance are done once per input pair, where a dragged slider
 * would otherwise redo them, and hold a copy of them, per step. Only the splits are per setting,
 * and bounded, each holding a label array per neuron.
 *
 * Held without a cancel signal and raced against each run's own (`untilAborted`): a cheap node's
 * next edit aborts the previous run, and a shared promise carrying that signal would fail every
 * later run that reused it. A hand-capped `Map` rather than `LruMap`, `memoPromise` taking a `Map`
 * — the exception `core/lruMap.ts` records.
 */
interface Prepared {
  readonly points: PointsValue
  readonly synapses: Map<string, NeuronSynapses>
  readonly distances: Float32Array[]
  readonly splits: Map<string, Promise<SetSplit>>
}
const automaticMemo = new WeakMap<SkeletonsValue, Prepared>()
const MEMO_ENTRIES = 8

async function automaticSplit(
  skeletons: SkeletonsValue,
  points: PointsValue,
  settings: SplitSettings,
  flow: boolean,
  run: Pick<EvalContext, 'progress' | 'signal'>,
): Promise<{ synapses: Map<string, NeuronSynapses>; split: SetSplit }> {
  let prepared = automaticMemo.get(skeletons)
  if (prepared?.points !== points) {
    prepared = {
      points,
      synapses: sitesByNeuron(points),
      distances: skeletons.items.map((item) => parentDistances(item)),
      splits: new Map(),
    }
    automaticMemo.set(skeletons, prepared)
  }
  const { synapses, distances, splits } = prepared
  const key = `${settings.flowThresh}|${settings.splitVal}|${settings.heal}|${flow}`
  const split = memoPromise(
    splits,
    key,
    () =>
      splitSkeletons(skeletons, synapses, settings, {
        distances,
        flow,
        onProgress: run.progress,
      }),
    { keep: 'resolved' },
  )
  // Oldest out first: a `Map` iterates in insertion order.
  while (splits.size > MEMO_ENTRIES) splits.delete(splits.keys().next().value!)
  return { synapses, split: await untilAborted(split, run.signal) }
}

/** What a frame mismatch does to the split, whichever axis it is on. */
const SNAP_ANYWHERE = 'Every synapse would snap to whichever node happened to be nearest.'

/** The two columns the split reads off a synapse cloud. */
const NEEDED_COLUMNS = ['neuronId', 'polarity'] as const

registerNode({
  type: 'neuron.splitCompartments',
  label: 'Split Axon/Dendrite',
  category: 'transform',
  description:
    'Label every skeleton node axon, dendrite or linker from where its synapses are, using navis’s synapse flow centrality.',
  guide:
    'Labels each neuron’s skeleton axon, dendrite or linker from where its synapses are, using ' +
    'navis’s synapse flow centrality. Wire in skeletons and a Synapses cloud of the same neurons. ' +
    'Open the card full size to inspect a split on a dendrogram and correct it by hand.',
  cost: 'cheap',
  inputs: [
    { id: 'skeletons', label: 'Skeletons', type: T.skeletons() },
    { id: 'synapses', label: 'Synapses', type: T.points() },
  ],
  /*
   * Skeletons first, so a wire dragged off the card starts at the labelled arbour — the output the
   * node is named for.
   */
  outputs: [
    { id: 'out', label: 'Skeletons', type: T.skeletons() },
    { id: 'labelled', label: 'Synapses', type: T.points() },
    { id: 'summary', label: 'Summary', type: T.neurons() },
  ],
  /*
   * One group, and it changes the data — which is the point. The thresholds are the knobs whose
   * honest setting is found by moving them while looking at the arbour, so they are declared a
   * data group: the full-size view puts them in a tab with a note, and a dashboard cell (which
   * draws only presentational params and data groups) puts them beside a 3D View showing the
   * result. The node is `cheap`, so each move re-splits on its own.
   */
  paramGroups: [
    { id: 'split', label: 'Split', affectsData: true },
    { id: 'display', label: 'Display' },
  ],
  params: [
    ...splitParams({ group: 'split' }),
    /*
     * Hand corrections, written by the expanded view's dendrogram — see `splitCorrections.ts`.
     * Data, in the provenance key, so a saved file and a share link carry them. Not in the Split
     * group, which would put a "clear all" for somebody's afternoon of proofreading on a dashboard
     * cell's rail; the card shows the count, and the inspector can clear them.
     */
    {
      id: CORRECTIONS_PARAM,
      kind: 'ids',
      label: 'Corrections',
      noun: 'corrections',
      default: [],
      help: 'Branches reassigned by hand in the expanded view. They are applied on top of the automatic split, so they still hold when a threshold changes.',
    },
    /*
     * Opt-in, because it is the largest thing the split sends back — a float per node — and only
     * a scene that draws it wants it. Data rather than presentation: it changes what `Skeletons`
     * carries, so it is in the provenance key and in the same group as the thresholds it shows.
     */
    {
      id: 'flow',
      kind: 'boolean',
      label: 'Write synapse flow',
      help: 'Also store each node’s synapse flow on the skeletons, as a fraction of that neuron’s peak, for the 3D View’s “by node value” colours. The linker is every node at or above Linker threshold.',
      default: false,
      group: 'split',
    },
    /*
     * The editor's synapse ticks. Presentational — what the dendrogram draws, never what the node
     * returns — so it stales nothing, and remembered, so a dashboard reopens as it was left. Off the
     * card, which has no dendrogram to draw them on.
     */
    {
      id: 'showSynapses',
      kind: 'boolean',
      label: 'Show synapses',
      help: 'Draw the synapses on the expanded view’s dendrogram: outputs on one side of a branch, inputs on the other.',
      default: true,
      presentational: true,
      advanced: true,
      group: 'display',
    },
  ],

  inferOutputs: (ctx) => ({
    out: T.skeletons(ctx.attributes('skeletons')),
    labelled: T.points(labelledSynapsesSchema(ctx.attributes('synapses'))),
    summary: T.neurons(splitSummarySchema(ctx.attributes('skeletons'))),
  }),

  /*
   * The frame check waits for `evaluate`: units and a template space live on the value, and a type
   * carries a kind and a schema only — `neuron.pointsInVolumes` says the same at the same place.
   */
  validate: (ctx) => {
    const schema = ctx.attributes('synapses')
    if (!schema) return []
    const names = columnNames(schema)
    const missing = NEEDED_COLUMNS.filter((name) => !names.includes(name))
    return missing.length > 0
      ? [
          `The synapses need ${missing.map((m) => `\`${m}\``).join(' and ')} to be split by. ` +
            `Wire in a Synapses node of the same neurons, with both polarities.`,
        ]
      : []
  },

  evaluate: async (ctx) => {
    const skeletons = ctx.input('skeletons')
    if (!isSkeletonsValue(skeletons)) {
      throw new Error(
        'Nothing is wired into `Skeletons`. Wire in skeletons, e.g. from the Skeletons node.',
      )
    }
    const points = ctx.input('synapses')
    if (!isPointsValue(points)) {
      throw new Error(
        'Nothing is wired into `Synapses`. Wire in a Synapses node of the same neurons, with ' +
          'both polarities.',
      )
    }
    const consequence = 'a synapse cannot be placed on the skeleton it belongs to.'
    checkGeometryUnits('The', skeletons, 'skeletons', 'Skeletons', consequence)
    checkGeometryUnits('The', points, 'synapses', 'Synapses', consequence)
    const clash = frameClash(skeletons, points)
    if (clash) {
      throw new Error(
        frameClashMessage(
          clash,
          { left: 'The skeletons', right: 'the synapses' },
          { units: SNAP_ANYWHERE, space: SNAP_ANYWHERE },
        ),
      )
    }

    const automatic = await automaticSplit(
      skeletons,
      points,
      readSplitSettings(ctx.params),
      ctx.params.flow === true,
      ctx,
    )
    const { synapses } = automatic
    const corrections = readCorrections(ctx.params[CORRECTIONS_PARAM])
    const { split, applied, stale } = correctSplit(skeletons, automatic.split, corrections)
    if (stale > 0) {
      ctx.warn(
        `${stale} of ${corrections.length} hand corrections no longer land on a split neuron ` +
          `here: the neuron is not on the input, was not split, or its skeleton has changed. ` +
          `They are kept; remove them in the expanded view.`,
      )
    }

    const unsplit = splitWarning(split.status, {
      column: 'the `splitStatus` column of Summary',
    })
    if (unsplit) ctx.warn(unsplit)
    /*
     * The other half of the join, which fails just as quietly: synapses of neurons that have no
     * skeleton here are not used, and a cloud wired from a different query would leave every
     * neuron `no synapses` while looking like a fine input.
     */
    const ids = new Set(skeletons.items.map((item) => item.id))
    let stray = 0
    for (const [id, group] of synapses) if (!ids.has(id)) stray += group.rows.length
    if (stray > 0) {
      ctx.warn(
        `${stray} of ${points.attributes.length} synapses belong to neurons with no skeleton ` +
          `here, so they were not used and their \`compartment\` is empty.`,
      )
    }

    return {
      out: withSplit(skeletons, split),
      labelled: labelSynapses(points, skeletons, synapses, split),
      summary: splitSummaryTable(skeletons, split, applied),
    }
  },
})
