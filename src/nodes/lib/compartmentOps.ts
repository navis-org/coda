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

import type { BUILT_IN_NODE_VALUES } from './nodeValues'
import { ID_COLUMN_NAME } from '../../core/ids'
import type { ParamDef, ParamValues } from '../../core/node'
import { listEntries } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { MeshesValue, PointsValue, SkeletonsValue, TableValue } from '../../core/values'
import { makeTable, splitName } from '../../core/values'
import type { CallOptions } from '../../pyodide/engine'
import type { PropagationWeighting, PythonSplitMethod } from '../../pyodide/topology'
import type { SplitStatus } from './splitStatus'
import { hasSplit } from './splitStatus'
import { runSplitCompartments, splitStatusOf } from '../../pyodide/topology'
import { UNIDENTIFIED, groupSynapses } from './synblastOps'
import type { SplitCorrection } from './splitCorrections'
import { applyCorrections } from './splitCorrections'
import type { VolumeCompartment } from './splitByVolume'
import { foldColumns } from './tableOps'
import { checkGeometryUnits } from '../../data/units'
import { frameClash, frameClashMessage } from './transformOps'
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

/**
 * How a split is computed: the heal, and the chosen method's own knobs and no other's — so a method
 * keys its cached split on what it reads, and switching method and back finds it again. Flow and
 * the heal are every split surface's; the method choice is Split Axon/Dendrite's alone, and a card
 * without one (Topology) is flow.
 */
export type SplitSettings = {
  /** Join a fragmented skeleton into one tree before splitting it. */
  readonly heal: boolean
} & (
  | {
      readonly method: 'flow'
      /** The linker is every node at or above this fraction of peak flow. */
      readonly flowThresh: number
      /** A fragment is axon when its pre/post fraction ratio is at least this. */
      readonly splitVal: number
    }
  | {
      readonly method: 'propagation'
      readonly weighting: PropagationWeighting
      readonly alpha: number
      readonly maxIter: number
      readonly tol: number
    }
  | {
      readonly method: 'roi'
      /** Names of the wired volumes that hold `inside`; empty is every wired volume. */
      readonly volumes: readonly string[]
      readonly inside: VolumeCompartment
      /** How far outside a volume's surface a node still counts as inside it, in µm. */
      readonly margin: number
    }
  | {
      readonly method: 'tag'
      /** Node tags marking where the axon starts; it and everything distal of it are axon. */
      readonly axonTags: readonly string[]
      /** The same for the dendrite. */
      readonly dendriteTags: readonly string[]
    }
)

/** The methods that run in Python, which `splitSkeletons` takes: not by ROI, not by tag. */
export type PythonSplitSettings = Extract<SplitSettings, { method: PythonSplitMethod }>

/**
 * How a split is computed: the Python methods, and the ones that run here and need no Python (by
 * ROI, by tag), which join this list and not the bridge's.
 */
export type SplitMethod = PythonSplitMethod | 'roi' | 'tag'

/** What one method needs from the card's inputs, and what it can write beside the labels. */
interface SplitMethodSpec {
  /** What the card's `Method` control calls it. */
  readonly label: string
  /** It splits from where synapses sit, so a run without a `Synapses` cloud is refused. */
  readonly needsSynapses: boolean
  /** It tests nodes against the regions on `Volumes`. */
  readonly needsVolumes: boolean
  /** It walks the tree, so a fragmented skeleton wants joining first: the heal is its control. */
  readonly walksTree: boolean
  /** The per-node value it can write, and the switch on the card that asks for it. */
  readonly value?: { readonly name: SplitValueName; readonly param: string }
}

/**
 * Every method, in the order the card offers them. One entry per method, keyed over `SplitMethod`,
 * so a method added to the type and missing here — its reader included — is a compile error rather
 * than a card that quietly reads it as flow. The option list, the reader, `validate`, `evaluate` and
 * the heal's visibility all read this.
 */
export const SPLIT_METHODS: {
  readonly [K in SplitMethod]: SplitMethodSpec & {
    /** The card's settings for this method: the heal and its own knobs, no other method's. */
    readonly read: (params: ParamValues) => Extract<SplitSettings, { method: K }>
  }
} = {
  flow: {
    label: 'synapse flow',
    needsSynapses: true,
    needsVolumes: false,
    walksTree: true,
    value: { name: 'flow', param: 'flow' },
    read: (params) => ({
      heal: params.heal === true,
      method: 'flow',
      flowThresh: Number(params.flowThresh),
      splitVal: Number(params.splitVal),
    }),
  },
  propagation: {
    label: 'label propagation',
    needsSynapses: true,
    needsVolumes: false,
    walksTree: true,
    value: { name: 'axonProbability', param: 'probability' },
    read: (params) => ({
      heal: params.heal === true,
      method: 'propagation',
      // Declared on the card, so `withDefaults` has filled them (invariant 4).
      weighting: params.weighting as PropagationWeighting,
      alpha: Number(params.alpha),
      maxIter: Number(params.maxIter),
      tol: Number(params.tol),
    }),
  },
  // A node is in a region or it is not: nothing to walk, nothing per node to write.
  roi: {
    label: 'by ROI',
    needsSynapses: false,
    needsVolumes: true,
    walksTree: false,
    read: (params) => ({
      heal: params.heal === true,
      method: 'roi',
      volumes: listEntries(String(params.volumes)),
      inside: params.inside as VolumeCompartment,
      margin: Math.max(0, Number(params.margin)),
    }),
  },
  // Distal of a tag is a walk from the soma, so a fragmented neuron wants healing first.
  tag: {
    label: 'by tag',
    needsSynapses: false,
    needsVolumes: false,
    walksTree: true,
    read: (params) => ({
      heal: params.heal === true,
      method: 'tag',
      axonTags: listEntries(String(params.axonTags)),
      dendriteTags: listEntries(String(params.dendriteTags)),
    }),
  },
}

/** The card's `Method` options, from the table. */
export const SPLIT_METHOD_OPTIONS = (Object.keys(SPLIT_METHODS) as SplitMethod[]).map(
  (value) => ({
    value,
    label: SPLIT_METHODS[value].label,
  }),
)

/** Which compartment a split by ROI's volumes hold, as the card offers it. */
export const VOLUME_COMPARTMENT_OPTIONS = [
  { value: 'axon', label: 'the axon' },
  { value: 'dendrite', label: 'the dendrite' },
] as const satisfies readonly { value: VolumeCompartment; label: string }[]

/** Label propagation's seed weightings, likewise declared once. */
export const WEIGHTING_OPTIONS = [
  { value: 'balance', label: 'balanced' },
  { value: 'count', label: 'by synapse count' },
  { value: 'none', label: 'none' },
] as const satisfies readonly { value: PropagationWeighting; label: string }[]

/**
 * A card's method — flow where the stored value is missing or names no method (a card saved before
 * the control, or a hand-edited file), flow being what such a card always was.
 */
export function splitMethodOf(params: ParamValues): SplitMethod {
  const stored = params.method
  return typeof stored === 'string' && stored in SPLIT_METHODS
    ? (stored as SplitMethod)
    : 'flow'
}

/** What a card's method needs and offers — `SPLIT_METHODS`' entry for it. */
export const splitMethodSpec = (params: ParamValues): SplitMethodSpec =>
  SPLIT_METHODS[splitMethodOf(params)]

/** `visibleIf` for a method's own controls. */
export const whenMethod =
  (method: SplitMethod) =>
  (params: ParamValues): boolean =>
    splitMethodOf(params) === method

/** The node values a split writes, every one of which a re-split replaces: the built-in ones. */
export type SplitValueName = (typeof BUILT_IN_NODE_VALUES)[number]['value']

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

/**
 * A card's split settings, read once: the heal, the method, and that method's knobs. A card with no
 * `Method` (Topology) reads `SPLIT_METHODS.flow.read` directly, flow being all it can mean.
 */
export function readSplitSettings(params: ParamValues): SplitSettings {
  return SPLIT_METHODS[splitMethodOf(params)].read(params)
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
  /**
   * Where each neuron's synapses landed, for the per-compartment counts; undefined per neuron where
   * none were placed (a split by ROI or by tag with no Synapses wired), whose counts then read null.
   */
  readonly assignments: readonly (SynapseAssignment | undefined)[]
  /** Each item's `parentDistances`, which the assignment needed and the cable totals need again. */
  readonly distances: readonly Float32Array[]
  /**
   * The method's per-node value, only when asked for: flow as a fraction of each neuron's peak, or
   * the propagation's probability. Per item, undefined where there is none.
   */
  readonly values?: {
    readonly name: SplitValueName
    readonly perItem: readonly (Float32Array | undefined)[]
  }
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
  settings: PythonSplitSettings,
  options: CallOptions & {
    distances?: readonly Float32Array[]
    /** Each neuron's synapses already placed on its nodes, from `synapses` and `distances`. */
    assignments?: readonly SynapseAssignment[]
    /** Also bring back the method's per-node value (`SPLIT_METHODS`). */
    values?: boolean
  } = {},
): Promise<SetSplit> {
  const { distances, values, assignments: placed, ...call } = options
  const propagate = settings.method === 'propagation'

  call.onProgress?.(0, 'assigning synapses to nodes')
  const lengths = distances ?? skeletons.items.map((item) => parentDistances(item))
  const assignments =
    placed ??
    skeletons.items.map((item, i) =>
      assignSynapses(item, synapses.get(item.id)?.sites ?? [], lengths[i]),
    )

  // Positions only where a step reads them: the heal, and the propagation's edge lengths.
  const packed = flattenForSplit(skeletons, assignments, settings.heal || propagate)
  // Read before the call: `transferable` detaches every buffer the moment it is posted —
  // `offsets` included, which is why it is copied out for the scatter below.
  const offsets = packed.offsets.slice()

  const result = await runSplitCompartments(
    { ...packed, ...settings, flow: values && !propagate, probability: values && propagate },
    {
      ...call,
      onProgress: (fraction, note) => call.onProgress?.(0.2 + fraction * 0.8, note),
    },
  )

  /** Each item's slice of a per-node array, through `f`. */
  const slices = <A extends Int32Array | Float32Array>(raw: A) =>
    skeletons.items.map((_, i) => raw.subarray(offsets[i]!, offsets[i + 1]!) as A)
  // Flow is a count of paths, shown over each neuron's peak; a probability is already 0..1. Each
  // its own buffer, so a neuron kept downstream does not hold the whole run's.
  const perItem = propagate
    ? result.probability && slices(result.probability).map((slice) => new Float32Array(slice))
    : result.flow && slices(result.flow).map(peakFraction)
  return {
    labels: slices(result.compartment).map((slice) => new Uint8Array(slice)),
    status: Array.from(result.status, splitStatusOf),
    assignments,
    distances: lengths,
    ...(perItem
      ? { values: { name: SPLIT_METHODS[settings.method].value!.name, perItem } }
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
 * The set with each split stored on its skeleton (`SkeletonGeometry.split`), and the method's
 * per-node value (`SPLIT_METHODS`) where that was asked for.
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
      const ok = hasSplit(split.status[i]!)
      // Every value a split writes goes, whichever method this one is: a re-split by the other
      // method must not leave the first one's answer behind.
      const values = { ...nodeValues }
      for (const { value } of Object.values(SPLIT_METHODS)) if (value) delete values[value.name]
      const value = ok ? split.values?.perItem[i] : undefined
      if (value) values[split.values!.name] = value
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
    if (!rows || !hasSplit(split.status[i]!)) return
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
    hasSplit(split.status[i]!)
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
  const unsplit = status.filter((s) => !hasSplit(s)).length
  const unsettled = status.filter((s) => s === 'not converged').length
  if (unsplit === 0 && unsettled === 0) return undefined
  const fragmented = status.filter((s) => s === 'multiple roots').length
  const untagged = status.filter((s) => s === 'no tags').length
  const parts: string[] = []
  if (unsplit > 0) {
    parts.push(
      `${unsplit} of ${status.length} neurons could not be split. See ${where.column}.` +
        (fragmented > 0
          ? ` ${fragmented} of them arrived in several pieces. Tick \`Heal fragmented skeletons\`` +
            `${where.heal ?? ''} to join them first.`
          : '') +
        (untagged > 0 ? ` ${untagged} of them carry none of the named tags.` : ''),
    )
  }
  if (unsettled > 0) {
    // navis's own warning sign, said rather than printed: the labels are kept, as navis keeps them.
    parts.push(
      `Label propagation did not converge for ${unsettled} of ${status.length} neurons, so their ` +
        `split may be noise. Raise \`Max iterations\`, or check them in the expanded view.`,
    )
  }
  return parts.join(' ')
}

const SNAP_CONSEQUENCE = 'a synapse cannot be placed on the skeleton it belongs to.'

/**
 * The skeletons' half of `requireSynapseFrame`, for a caller that can check it before it has the
 * synapses — Connection Compartments, before the fetch the answer would be refused after.
 */
export function requireSkeletonUnits(skeletons: SkeletonsValue): void {
  checkGeometryUnits('The', skeletons, 'skeletons', 'Skeletons', SNAP_CONSEQUENCE)
}

/** Both frame clauses of `requireSynapseFrame`: neither is fixable by snapping harder. */
const SNAP_ANYWHERE = 'Every synapse would snap to whichever node happened to be nearest.'

/**
 * That skeletons and the synapses placed on them share units and a template space — what both
 * the split and Connection Compartments check before snapping a site to a node. Throws, naming
 * the remedy; nothing is snapped across a frame.
 */
export function requireSynapseFrame(skeletons: SkeletonsValue, points: PointsValue): void {
  requireSkeletonUnits(skeletons)
  checkGeometryUnits('The', points, 'synapses', 'Synapses', SNAP_CONSEQUENCE)
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
}

/** Both frame clauses of `requireVolumeFrame`. */
const TEST_ANYWHERE = 'Every node would be tested against a region somewhere else.'

/**
 * That skeletons and the volumes a split by ROI tests them against share units and a template
 * space — `requireSynapseFrame`'s counterpart. Across frames every node falls outside every volume
 * and the split reads as a neuron that is all one compartment, so this refuses rather than warns.
 */
export function requireVolumeFrame(skeletons: SkeletonsValue, volumes: MeshesValue): void {
  const clash = frameClash(skeletons, volumes)
  if (clash) {
    throw new Error(
      frameClashMessage(
        clash,
        { left: 'The skeletons', right: 'the volumes' },
        { units: TEST_ANYWHERE, space: TEST_ANYWHERE },
      ),
    )
  }
}
