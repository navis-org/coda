/**
 * The axon/dendrite split of a whole skeleton set, as one function.
 *
 * Group the synapse cloud by neuron, snap each neuron's sites to its nodes, flatten, cross the
 * bridge once. The split is the one number here somebody compares against navis, so the sequence
 * is written once and every surface calls it: Neuron Topology over a set, and `useCompartments`
 * (the card's live split) over the one neuron on screen.
 *
 * A module of its own rather than more of `topologyOps.ts`, whose header records why that file
 * imports nothing from `src/pyodide` but types: it is the tree-walk library every morphometric
 * reaches, and a worker-shaped module in its import graph is a cost every one of them pays. Only
 * the nodes that actually split import this.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { ParamDef, ParamValues } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { PointsValue, SkeletonsValue, TableValue } from '../../core/values'
import { makeTable, splitName } from '../../core/values'
import type { CallOptions } from '../../pyodide/engine'
import type { SplitStatus } from '../../pyodide/topology'
import { runSplitCompartments, splitStatusOf } from '../../pyodide/topology'
import { UNIDENTIFIED, groupSynapses } from './synblastOps'
import type { SplitCorrection } from './splitCorrections'
import { applyCorrections } from './splitCorrections'
import { foldColumns } from './tableOps'
import type { CompartmentStats, SynapseAssignment, SynapseSite } from './topologyOps'
import {
  assignSynapses,
  compartmentStats,
  flattenForSplit,
  parentDistances,
  polarityColumn,
  siteAt,
  splitColumnData,
  splitColumns,
} from './topologyOps'

/** navis's two tuning knobs and the opt-in heal — the three controls every split surface draws. */
export interface SplitSettings {
  /** The linker is every node at or above this fraction of peak flow. */
  readonly flowThresh: number
  /** A fragment is axon when its pre/post fraction ratio is at least this. */
  readonly splitVal: number
  /** Join a fragmented skeleton into one tree before splitting it. */
  readonly heal: boolean
}

/**
 * The three controls, declared once for every card that splits — Neuron Topology behind its
 * checkbox, Split Axon/Dendrite on its face. `shared` is what differs between those two: where
 * the control sits and whether it is in force.
 */
export function splitParams(
  shared: {
    advanced?: boolean
    visibleIf?: (params: ParamValues) => boolean
    group?: string
  } = {},
): ParamDef[] {
  return [
    /*
     * navis's two tuning knobs, and the pair is deliberate: between them they cover both ways a
     * split comes out wrong. `flowThresh` decides *where* the neuron is cut, `splitVal` decides
     * *which side is which*. The honest way to set either is to move it and look at the arbour.
     */
    {
      ...shared,
      id: 'flowThresh',
      kind: 'number',
      label: 'Linker threshold',
      help: 'Nodes at or above this fraction of peak synapse flow are linker. navis’s default is 0.9; lower it to mark more as linker.',
      default: 0.9,
      min: 0.1,
      max: 1,
      step: 0.05,
    },
    /*
     * navis's `split='prepost:X'`, which its docstring documents and its signature hides — the
     * argument reads as a plain enum until you notice the colon. Worth exposing because it is the
     * knob for the failure that looks most like a bug: a neuron whose axon and dendrite come out
     * swapped, or whose linker-adjacent twigs all land on one side.
     */
    {
      ...shared,
      id: 'splitVal',
      kind: 'number',
      label: 'Axon threshold',
      help: 'A fragment is axon if its output-to-input ratio is at least this. navis’s default is 1; lower favours axon, higher favours dendrite.',
      default: 1,
      min: 0.1,
      max: 3,
      step: 0.05,
    },
    /*
     * Opt-in, because a bridge is an edge nobody traced — and it carries synapse flow, so it can
     * move the linker. A skeleton derived from a segmentation routinely arrives as a forest
     * (every fish2 body sampled was 13 to 627 pieces), which the split refuses outright; this
     * joins the pieces first with fastcore's `heal_skeleton`, no distance cap. The joins exist
     * only inside the split: the skeleton drawn and measured, and the cable in every
     * per-compartment column, are the traced edges alone.
     */
    {
      ...shared,
      id: 'heal',
      kind: 'boolean',
      label: 'Heal fragmented skeletons',
      help: 'Join a skeleton that arrived in pieces before splitting it; a fragmented neuron cannot be split otherwise. The skeleton drawn and measured is unchanged.',
      default: false,
    },
  ]
}

/** `splitParams`' values, read once. */
export function readSplitSettings(params: ParamValues): SplitSettings {
  return {
    flowThresh: Number(params.flowThresh),
    splitVal: Number(params.splitVal),
    heal: params.heal === true,
  }
}

/** One split per item of the set it was computed from, index-aligned with `skeletons.items`. */
export interface SetSplit {
  /**
   * One `CODE_*` code per node, per item — `SkeletonGeometry.split`'s type, so a label set
   * can be stored on its skeleton as it stands. Each is its own buffer, never a view onto the
   * whole set's: an item kept by a downstream Select would otherwise hold every neuron's labels,
   * and the cache budget (which sums `byteLength`) would not see them.
   */
  readonly labels: Uint8Array[]
  readonly status: SplitStatus[]
  /** Where each neuron's synapses landed, for the per-compartment counts. */
  readonly assignments: SynapseAssignment[]
  /** Each item's `parentDistances`, which the assignment needed and the cable totals need again. */
  readonly distances: readonly Float32Array[]
  /** Per item, flow as a fraction of its peak — only when asked for, undefined where unsplit. */
  readonly flow?: readonly (Float32Array | undefined)[]
}

/** One neuron's rows of a synapse cloud, and the same rows as the split reads them. */
export interface NeuronSynapses {
  /** Row indices into the cloud, so an answer per site can be written back to its row. */
  readonly rows: readonly number[]
  /** `rows`, in order, as sites. */
  readonly sites: readonly SynapseSite[]
}

/**
 * Synapse sites grouped by the neuron they belong to.
 *
 * The bucketing is `groupSynapses` from `synblastOps.ts` — a cloud is one flat table with the
 * neuron in a column, and "which neuron is this row" is a question that already had one answer,
 * including the `idText` rule invariant 8 asks for. Written again here the two immediately
 * differed on unidentified rows.
 *
 * What is local is only the projection: syNBLAST wants row *indices* into the cloud it scores,
 * this wants `SynapseSite`s for the nearest-node pass. `UNIDENTIFIED` is dropped rather than
 * kept as a bucket, because the id is the join key against a skeleton and there is no skeleton
 * for a row whose neuron could not be read.
 */
export function sitesByNeuron(points: PointsValue): Map<string, NeuronSynapses> {
  const polarity = polarityColumn(points)
  const out = new Map<string, NeuronSynapses>()
  for (const group of groupSynapses(points)) {
    if (group.id === UNIDENTIFIED) continue
    out.set(group.id, {
      rows: group.rows,
      sites: group.rows.map((row) => siteAt(points, row, polarity)),
    })
  }
  return out
}

/**
 * Split every skeleton of a set into axon, dendrite and linker, in one crossing of the bridge.
 *
 * Sites are matched to a skeleton by its `id`; a neuron with none comes back `no synapses`
 * rather than missing, so the result always lines up with `skeletons.items`. `distances` is
 * threaded through when the caller already has them — `parentDistances` is a `Math.hypot` per
 * node, and Topology computes it once for its morphometrics.
 *
 * `onProgress` runs over 0..1 for this call alone; the caller maps it into its own range.
 */
export async function splitSkeletons(
  skeletons: Pick<SkeletonsValue, 'items'>,
  synapses: ReadonlyMap<string, Pick<NeuronSynapses, 'sites'>>,
  settings: SplitSettings,
  options: CallOptions & {
    distances?: readonly Float32Array[]
    /** Also bring back each node's synapse flow, as a fraction of its neuron's peak. */
    flow?: boolean
  } = {},
): Promise<SetSplit> {
  const { distances, flow, ...call } = options

  call.onProgress?.(0, 'assigning synapses to nodes')
  const lengths = distances ?? skeletons.items.map((item) => parentDistances(item))
  const assignments = skeletons.items.map((item, i) =>
    assignSynapses(item, synapses.get(item.id)?.sites ?? [], lengths[i]),
  )

  const packed = flattenForSplit(skeletons, assignments, settings.heal)
  // Read before the call: `transferable` detaches every buffer the moment it is posted —
  // `offsets` included, which is why it is copied out for the scatter below.
  const offsets = packed.offsets.slice()

  const result = await runSplitCompartments(
    { ...packed, ...settings, flow },
    {
      ...call,
      onProgress: (fraction, note) => call.onProgress?.(0.2 + fraction * 0.8, note),
    },
  )

  const rawFlow = result.flow
  return {
    labels: skeletons.items.map(
      (_, i) => new Uint8Array(result.compartment.subarray(offsets[i]!, offsets[i + 1]!)),
    ),
    status: Array.from(result.status, splitStatusOf),
    assignments,
    distances: lengths,
    ...(rawFlow
      ? {
          flow: skeletons.items.map((_, i) =>
            peakFraction(rawFlow.subarray(offsets[i]!, offsets[i + 1]!)),
          ),
        }
      : {}),
  }
}

/**
 * One neuron's flow over its own peak: 0..1, its own buffer, undefined where there is no peak.
 *
 * Per neuron because the raw number is a count of input-to-output paths and spans orders of
 * magnitude between a small neuron and a large one, so on one colour scale the largest in a scene
 * would wash the rest out. As a fraction, the linker is visibly everything at or above `Linker
 * threshold`, on every neuron alike. No peak means the split did not run there (`no synapses`,
 * `multiple roots`), and zeros would read as a neuron that carries no flow.
 */
function peakFraction(flow: Float32Array): Float32Array | undefined {
  let peak = 0
  for (const v of flow) if (v > peak) peak = v
  if (!(peak > 0)) return undefined
  return Float32Array.from(flow, (v) => v / peak)
}

/**
 * The set with each split stored on its skeleton (`SkeletonGeometry.split`), and its flow
 * (`nodeValues.flow`) where that was asked for.
 *
 * Only where the split worked: a neuron that came back `multiple roots` or `no synapses` has no
 * answer, and all-unassigned labels on it would read as a split that found nothing. What the item
 * already carried from an earlier split is dropped either way — a re-split with other settings must
 * not leave the old answer on the neurons the new one could not reach. Other per-node values ride
 * through untouched.
 */
export function withSplit(skeletons: SkeletonsValue, split: SetSplit): SkeletonsValue {
  return {
    ...skeletons,
    items: skeletons.items.map((item, i) => {
      const { split: _stale, nodeValues, ...geometry } = item
      const ok = split.status[i] === 'ok'
      const { flow: _staleFlow, ...others } = nodeValues ?? {}
      const flow = ok ? split.flow?.[i] : undefined
      const values = flow ? { ...others, flow } : others
      return {
        ...geometry,
        ...(ok ? { split: split.labels[i]! } : {}),
        ...(Object.keys(values).length > 0 ? { nodeValues: values } : {}),
      }
    }),
  }
}

/** The column `labelSynapses` adds — named for what it holds, as `Skeleton to Points` names its. */
export const SYNAPSE_COMPARTMENT_COLUMN = 'compartment'

/** `labelSynapses`' schema half. The column replaces one of the same name, in its slot. */
export function labelledSynapsesSchema(schema: TableSchema | undefined): TableSchema {
  return foldColumns(schema ?? tableSchema(), [column(SYNAPSE_COMPARTMENT_COLUMN, 'str')])
}

/**
 * The cloud with the compartment each synapse landed on: `axon`, `dendrite` or `linker`, and null
 * for a row whose neuron has no skeleton here or no split.
 *
 * Read off the assignment the split itself used, so a synapse is labelled by the node that counted
 * it — a second nearest-node pass could put a site on the boundary on the other side.
 */
export function labelSynapses(
  points: PointsValue,
  skeletons: Pick<SkeletonsValue, 'items'>,
  synapses: ReadonlyMap<string, Pick<NeuronSynapses, 'rows'>>,
  split: SetSplit,
): PointsValue {
  const names = new Array<string | null>(points.attributes.length).fill(null)
  skeletons.items.forEach((item, i) => {
    const rows = synapses.get(item.id)?.rows
    if (!rows || split.status[i] !== 'ok') return
    const nodeOf = split.assignments[i]!.nodeOf
    const labels = split.labels[i]!
    rows.forEach((row, k) => {
      const node = nodeOf[k]!
      if (node >= 0) names[row] = splitName(labels[node]!)
    })
  })
  return {
    ...points,
    attributes: makeTable(labelledSynapsesSchema(points.attributes.schema), {
      ...points.attributes.data,
      [SYNAPSE_COMPARTMENT_COLUMN]: names,
    }),
  }
}

/**
 * The skeletons' attribute table with the split's columns after it — `splitSummaryTable`'s schema
 * half. The attributes come along so the summary can be grouped by `type` or filtered by
 * `segregationIndex` and still name its neurons.
 */
export function splitSummarySchema(attributes: TableSchema | undefined): TableSchema {
  return foldColumns(attributes ?? tableSchema(column(ID_COLUMN_NAME, 'str')), [
    ...splitColumns(),
    // How many hand corrections reached this neuron — so a corrected split can be told apart from
    // the automatic one in the table, as the splitter's `corrected` flag does in its saved files.
    column('corrections', 'i64'),
  ])
}

/** One row per neuron: its attributes, then cable and synapses per compartment, then corrections. */
export function splitSummaryTable(
  skeletons: SkeletonsValue,
  split: SetSplit,
  /** Hand corrections applied, per item. */
  corrections: readonly number[],
): TableValue {
  return makeTable(splitSummarySchema(skeletons.attributes.schema), {
    ...skeletons.attributes.data,
    ...splitColumnData(splitStats(skeletons, split)),
    corrections: skeletons.items.map((_, i) => corrections[i] ?? 0),
  })
}

/**
 * A split with each neuron's hand corrections applied — `applyCorrections` across the set.
 *
 * Only where the split worked: a neuron with no automatic split has nothing for a correction to
 * correct, so its corrections are counted stale with the rest. The labels of an uncorrected neuron
 * are the split's own, by identity.
 */
export function correctSplit(
  skeletons: Pick<SkeletonsValue, 'items'>,
  split: SetSplit,
  corrections: readonly SplitCorrection[],
): { split: SetSplit; applied: number[]; stale: number } {
  const byNeuron = new Map<string, SplitCorrection[]>()
  for (const c of corrections) {
    const list = byNeuron.get(c.neuron)
    if (list) list.push(c)
    else byNeuron.set(c.neuron, [c])
  }
  const results = skeletons.items.map((item, i) =>
    split.status[i] === 'ok'
      ? applyCorrections(item, split.labels[i]!, byNeuron.get(item.id) ?? [])
      : { labels: split.labels[i]!, applied: 0 },
  )
  const applied = results.map((r) => r.applied)
  // Every correction is applied or it is not — on a missing neuron, an unsplit one, or nowhere.
  // Floored, because a neuron listed twice in the set is corrected twice.
  const stale = Math.max(0, corrections.length - applied.reduce((a, b) => a + b, 0))
  return { split: { ...split, labels: results.map((r) => r.labels) }, applied, stale }
}

/** Cable and synapses per compartment, per neuron — what both split surfaces tabulate. */
export function splitStats(
  skeletons: Pick<SkeletonsValue, 'items'>,
  split: SetSplit,
): CompartmentStats[] {
  return skeletons.items.map((item, i) =>
    compartmentStats(
      item,
      split.labels[i],
      split.assignments[i],
      split.status[i]!,
      split.distances[i],
    ),
  )
}

/**
 * How many neurons have no split, as the warning every split surface owes — or undefined when
 * every one split. Said out loud rather than left in a column nobody reads: navis refuses a
 * multi-rooted neuron outright, and reporting it instead is only an improvement if the count
 * reaches the card, or a run that split three of forty neurons looks exactly like one that split
 * forty. `where` is the surface's own pointer: which column says why, and where Heal is.
 */
export function splitWarning(
  status: readonly SplitStatus[],
  where: { readonly column: string; readonly heal?: string },
): string | undefined {
  const unsplit = status.filter((s) => s !== 'ok').length
  if (unsplit === 0) return undefined
  const fragmented = status.filter((s) => s === 'multiple roots').length
  return (
    `${unsplit} of ${status.length} neurons could not be split. See ${where.column}.` +
    (fragmented > 0
      ? ` ${fragmented} of them arrived in several pieces. Tick \`Heal fragmented skeletons\`` +
        `${where.heal ?? ''} to join them first.`
      : '')
  )
}
