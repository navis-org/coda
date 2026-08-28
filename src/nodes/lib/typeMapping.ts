/**
 * Cell types matched across datasets — the pure core of `Match Cell Types`.
 *
 * Two connectomes share no neuron ids, so comparing them needs a *correspondence*, and the unit
 * of correspondence is the cell type: the smallest thing conserved across brains of a species.
 * That is not a column lookup. Type labels are revised with each new dataset and not backported,
 * so the maleCNS carries `type`, `hemibrainType`, `flywireType` and `mancType`, and between any
 * two of them four things can happen — nothing, a rename, a merge (`X,Y`), or a split
 * (`A_a`/`A_b` where the other dataset has only `X`). See
 * [comparative.md](../../../docs/comparative.md).
 *
 * The answer, ported from cocoa's `GraphMapper`, is a graph. Neurons and labels are both nodes;
 * `neuron → label` edges come from the declared type columns, and `label ↔ label` edges from
 * compound splitting and from hand-written synonyms. **Labels are shared between datasets by
 * their text**, and that is the only place the two brains touch. Then:
 *
 * 1. drop every connected component that does not hold neurons from *all* the datasets;
 * 2. inside each survivor keep only the nodes lying on a shortest neuron-to-neuron path that
 *    **crosses** datasets — a label joining two neurons of the same dataset corresponds nothing;
 * 3. split the survivor as far as it splits without any part losing a dataset;
 * 4. the connected components of what is left are the shared labels.
 *
 * **The answer depends on how many datasets are in it, and that is the whole reason this
 * function is N-ary.** cocoa's worked example: across FlyWire's two hemispheres `AOTU008a` and
 * `AOTU008b` stay distinct, because each has a direct `AOTU008a—AOTU008a` crossing and step 3
 * can therefore cut `AOTU008` loose. Add the hemibrain, where only `AOTU008` exists, and the
 * only path reaching all three datasets runs through it — so all three collapse into one label.
 * A three-dataset mapping is *not* two two-dataset mappings composed, which is why nothing here
 * lets a caller chain two of these.
 *
 * It follows that **one dataset produces no mapping at all**, and that is the honest answer
 * rather than a gap: there is no correspondence to establish, so every neuron comes back
 * unmatched. "Which of this neuron's four type columns is the specific one" is a real and
 * separate question, and it belongs to a single-dataset transform rather than to a hidden branch
 * in here — one function, one definition of what a shared label is.
 *
 * ## Where this departs from cocoa, and why
 *
 * - **The bipartition is our own greedy modularity, not networkx's.** cocoa calls
 *   `nx.community.greedy_modularity_communities(best_n=2)`; `greedyBipartition` below is the
 *   same Clauset-Newman-Moore agglomeration with an explicit lexicographic tie-break, because
 *   [invariant 4](../../../docs/invariants.md) needs `evaluate` deterministic and CNM's merge
 *   order is otherwise decided by dictionary order. The tie-break is the part that matters: a
 *   difference from networkx changes *which* split is proposed, and a proposal is then accepted
 *   or rejected by the dataset-coverage and ratio checks — so an implementation difference costs
 *   granularity, never validity.
 * - **`labels: 'random'` is not carried over.** It is a fresh UUID per run, so it is exactly the
 *   hidden mutable state invariant 4 requires a nonce for, and a label nobody can read is not
 *   worth one.
 * - **Ids are text and compared with `compareIds`.** cocoa's `id` mode does `int(...)`, which is
 *   [invariant 8](../../../docs/invariants.md)'s failure on an eighteen-digit root id.
 * - **Neurons are grouped by their sorted label *set*** rather than by the column-ordered tuple
 *   `collapse_neuron_nodes` uses. Same connectivity, and it groups slightly harder — two neurons
 *   whose columns disagree only in order are one node here and two there.
 * - **No `joblib`.** The all-pairs shortest-path trim is quadratic in a component's size, and
 *   cocoa parallelises it. Here a component past `COMPONENT_NODE_CAP` is left untrimmed and
 *   warned about, which is a coarser mapping rather than a wait —
 *   [limits.md](../../../docs/limits.md): a guard rail warns, it does not refuse.
 *
 * Headless, synchronous and allocation-bounded: everything a caller has to *fetch* — the full
 * per-dataset annotation table, decision 4 in comparative.md — happens above this file, so all
 * of the logic that is hard to get right is reachable from a plain unit test.
 */

import { ID_COLUMN_NAME, compareIds, idText } from '../../core/ids'
import type { NeuronId } from '../../core/ids'
import { SILENT, warnOverThreshold } from '../../core/limits'
import type { Warner } from '../../core/limits'
import { column, tableSchema } from '../../core/types'
import type { CellValue, ColumnData, TableValue, Value } from '../../core/values'
import { isTableValue, makeTable, tableFromRows } from '../../core/values'

/** How the shared label for a matched group is spelled. cocoa's `labels`, minus `random`. */
export type LabelMode = 'first' | 'all' | 'id'

/**
 * The same three, as a picker's options — here rather than in the node, which is where every
 * other option list in `nodes/lib` sits relative to its union (`PARTNER_BY_OPTIONS` under
 * `PartnerBy`, `SIMILARITY_METRIC_OPTIONS` under `SimilarityMetric`). Typed against `LabelMode`,
 * so adding a fourth mode to the union fails to compile against the picker that offers three
 * instead of silently offering three.
 */
export const LABEL_MODE_OPTIONS: ReadonlyArray<{ value: LabelMode; label: string }> = [
  { value: 'first', label: 'Shortest name' },
  { value: 'all', label: 'Every name, joined' },
  { value: 'id', label: 'Lowest neuron id' },
]

/** One neuron and every type label it carries, across all the columns the caller chose. */
export interface MapperNeuron {
  id: NeuronId
  labels: readonly string[]
}

/**
 * One dataset's whole annotation table, reduced to what the mapper reads.
 *
 * Deliberately not an object with a `name` on it. Everything this function returns is
 * index-aligned with the array it was given, so naming the datasets is the *caller's* business —
 * a name in here would be a field nothing reads and a second place for the node's dataset labels
 * to live.
 */
export type MapperDataset = readonly MapperNeuron[]

/**
 * A hand-written `label ↔ label` edge — cocoa's `add_synonym`, and the route by which a
 * hand-curated correspondence enters an otherwise derived mapping.
 */
export interface LabelSynonym {
  label: string
  synonym: string
}

export interface MapperOptions {
  /** Labels to delete outright before anything else — cocoa's `add_bad_labels`. */
  badLabels?: readonly string[]
  /** What separates the parts of a compound label. Default `,`. */
  compoundSeparator?: string
  /**
   * Prefixes marking a label whose separator is part of its *name*. Default
   * `DEFAULT_NO_SPLIT_PREFIXES`.
   *
   * A param rather than a constant because these are one connectome's naming habits and
   * [decision 3](../../../docs/comparative.md) is explicit that those belong in pre-filled
   * settings the user can see and override, never baked in. They also travel with the separator:
   * a deployment that separates compounds with `|` has no reason to inherit FlyWire's
   * comma-era exceptions.
   */
  noSplitPrefixes?: readonly string[]
  /** Default `first`. */
  labelMode?: LabelMode
  /** Allow a correspondence whose path runs through another *neuron*. Default false. */
  allowIndirect?: boolean
  synonyms?: readonly LabelSynonym[]
  /**
   * Told when a component was too large to trim and split.
   *
   * `SILENT` for a caller with no card to put it on — never optional, which is the shape
   * [limits.md](../../../docs/limits.md) records as reading like "the check is optional" when
   * what is meant is "there is nobody to tell".
   */
  warn?: Warner
}

/** One shared label, with how many neurons carry it in each dataset. */
export interface LabelCount {
  label: string
  /** Index-aligned with the datasets passed in. */
  counts: readonly number[]
  /**
   * Two datasets' counts for this label differ by more than `SUSPICIOUS_COUNT_RATIO`.
   *
   * cocoa's `label_suspicious`, and it is the most useful column in the report: 4 neurons in one
   * brain against 40 in another is a mapping error rather than a finding, and the only place it
   * shows up is here. A mapping shipped without this is a mapping that gets trusted.
   */
  suspicious: boolean
}

export interface TypeMapping {
  /** Per dataset, in input order: that dataset's own **bare** ids to the shared label. */
  labels: readonly ReadonlyMap<NeuronId, string>[]
  report: readonly LabelCount[]
  /** Per dataset, how many neurons came out with no shared label at all. */
  unmatched: readonly number[]
}

/**
 * Prefixes under which a separator is part of the label's name rather than a join.
 *
 * cocoa's, and each is a real label a naive split destroys: `(M_adPNm4,M_adPNm5)b` is one type
 * whose *name* contains a comma, and `CB.FB3,4A9` is a compartment path. Exported so the node
 * can pre-fill the param with them and so a caller can see what it is overriding.
 */
export const DEFAULT_NO_SPLIT_PREFIXES: readonly string[] = ['(', 'CB.']

/**
 * The smallest number of counted neurons two datasets may differ by before a label is called
 * suspicious — a factor of two, cocoa's number.
 *
 * Named rather than inlined because it is a *user-visible* rule: it decides a column in the
 * report, it is quoted in `LabelCount.suspicious` above and again in comparative.md, and three
 * spellings of one number is how the report comes to disagree with its own documentation.
 */
export const SUSPICIOUS_COUNT_RATIO = 0.5

/**
 * How much of a dataset may match nothing before the node says so.
 *
 * Named for `SUSPICIOUS_COUNT_RATIO`'s reason and *because* of it: the two are unrelated rules
 * that happen to share a number, in one feature, so a reader who greps `0.5` here finds two and
 * cannot tell which one the report column uses. This one governs an attribution rather than a
 * column — a mapping covering a tenth of a brain produces a perfectly ordinary pair of tables,
 * and everything built on it then silently describes that tenth.
 */
export const UNMATCHED_WARN_FRACTION = 0.5

/**
 * The size past which a connected component is left whole rather than trimmed and split.
 *
 * The trim is an all-pairs breadth-first search inside the component and the split is an
 * agglomeration over its nodes, so both are quadratic in it. Real type components are tens of
 * nodes; a component of thousands means the label graph has fused through something generic —
 * an `unknown` that was not listed as a bad label, say — and the honest response is a coarser
 * answer plus a warning naming the size, not a ten-minute main-thread stall.
 */
export const COMPONENT_NODE_CAP = 5000

/**
 * A label node's text is shared across datasets; a neuron node belongs to exactly one.
 *
 * `dataset` is the discriminator: `LABEL_NODE` for a label, an index into the caller's array for
 * a group of neurons. One field rather than a `kind` beside it, because nearly every test in
 * here is really "which dataset is this neuron in", and a separate flag is a second thing that
 * has to stay true.
 */
const LABEL_NODE = -1

interface MapNode {
  /** Label text, or `''` for a neuron group. */
  text: string
  dataset: number
  /** The neurons this node stands for — and, through its length, the node's weight. */
  ids: NeuronId[]
}

interface Graph {
  nodes: MapNode[]
  /** Undirected: `adjacency[a].get(b)` is the total weight between them, recorded both ways. */
  adjacency: Map<number, number>[]
}

function isNeuron(graph: Graph, node: number): boolean {
  return graph.nodes[node]!.dataset !== LABEL_NODE
}

/**
 * Every option resolved once, before anything reads one.
 *
 * The separator in particular was being defaulted in two places — the graph builder and the
 * namer — which is a mapping built on one separator and named with another the day the two
 * expressions drift. One resolution, passed down.
 */
interface Settings {
  bad: Set<string>
  separator: string
  noSplitPrefixes: readonly string[]
  labelMode: LabelMode
  allowIndirect: boolean
  synonyms: readonly LabelSynonym[]
  warn: Warner
}

function settingsFrom(options: MapperOptions): Settings {
  return {
    bad: new Set((options.badLabels ?? []).map((l) => l.trim()).filter(Boolean)),
    separator: options.compoundSeparator || ',',
    noSplitPrefixes: options.noSplitPrefixes ?? DEFAULT_NO_SPLIT_PREFIXES,
    labelMode: options.labelMode ?? 'first',
    allowIndirect: options.allowIndirect ?? false,
    synonyms: options.synonyms ?? [],
    warn: options.warn ?? SILENT,
  }
}

// ---------------------------------------------------------------------------
// Building the label graph

/**
 * A compound label split into its parts, or undefined where it must not be split.
 *
 * The splitting itself is generic — `PS008,PS009` is two types merged, and the edges
 * `PS008,PS009 -> PS008` and `-> PS009` are what let a dataset that kept them apart correspond
 * to one that did not.
 *
 * **The one definition of "this is a compound", used by the graph and by the namer alike.** They
 * were two expressions for a while and they disagreed on exactly the labels the guards exist
 * for: `(M_adPNm4,M_adPNm5)b` was refused an edge and then split anyway when it came to name the
 * group, so the user-visible label contained parts that are not types.
 *
 * The prefix guards are a setting (see `MapperOptions.noSplitPrefixes`). The single-character
 * rule is not, because it is a structural claim about type names rather than one connectome's
 * habit: `P1_17a,b` is one type with two suffixes, and splitting it invents a type called `b`
 * that would then bridge everything else called `b` in both brains.
 */
function splittable(text: string, s: Settings): string[] | undefined {
  if (!text.includes(s.separator)) return undefined
  if (s.noSplitPrefixes.some((prefix) => prefix && text.startsWith(prefix))) return undefined
  const parts = text.split(s.separator).map((p) => p.trim())
  if (parts.some((p) => p.length <= 1)) return undefined
  return parts
}

class GraphBuilder {
  private nodes: MapNode[] = []
  private adjacency: Map<number, number>[] = []
  private labels = new Map<string, number>()

  private add(node: MapNode): number {
    this.nodes.push(node)
    this.adjacency.push(new Map())
    return this.nodes.length - 1
  }

  label(text: string): number {
    const held = this.labels.get(text)
    if (held !== undefined) return held
    const index = this.add({ text, dataset: LABEL_NODE, ids: [] })
    this.labels.set(text, index)
    return index
  }

  neurons(dataset: number, ids: NeuronId[]): number {
    return this.add({ text: '', dataset, ids })
  }

  /** One undirected edge, weights accumulating. */
  link(a: number, b: number, weight: number): void {
    if (a === b) return
    this.adjacency[a]!.set(b, (this.adjacency[a]!.get(b) ?? 0) + weight)
    this.adjacency[b]!.set(a, (this.adjacency[b]!.get(a) ?? 0) + weight)
  }

  build(): Graph {
    return { nodes: this.nodes, adjacency: this.adjacency }
  }
}

/**
 * The composed label graph, with neurons already collapsed into groups.
 *
 * Collapsed *during* construction rather than after, which is the one structural difference from
 * cocoa worth naming: it builds the full graph and then contracts it, we never allocate the node
 * per neuron at all. A whole-brain annotation table is ~140k rows against a few thousand
 * distinct label sets, so this is the difference between a graph that fits inside one node
 * evaluation and one that does not.
 */
function buildGraph(datasets: readonly MapperDataset[], s: Settings): Graph {
  const builder = new GraphBuilder()

  /*
   * Compound labels are counted across every dataset before any edge is added, because the count
   * is the edge's weight and the weight is what the split's modularity reads — a compound two
   * datasets both use should outweigh one only a handful of neurons in one of them carry.
   */
  const compounds = new Map<string, number>()

  for (let d = 0; d < datasets.length; d++) {
    /*
     * Keyed by the JSON of the sorted label set, and holding that set beside the ids rather than
     * splitting the key apart again. A cell type may contain any character — spaces, commas,
     * parentheses all appear in real ones — so a joined key is a string with no inverse.
     */
    const groups = new Map<string, { labels: string[]; ids: NeuronId[] }>()
    for (const neuron of datasets[d]!) {
      const kept: string[] = []
      for (const raw of neuron.labels) {
        const text = raw.trim()
        if (!text || s.bad.has(text)) continue
        // The lookup comes first because `splittable`'s answer is thrown away here — only the
        // count is wanted — and a whole-brain table repeats its few hundred compound labels tens
        // of thousands of times.
        const carried = compounds.get(text)
        if (carried !== undefined) compounds.set(text, carried + 1)
        else if (splittable(text, s)) compounds.set(text, 1)
        if (!kept.includes(text)) kept.push(text)
      }
      if (!kept.length) continue
      kept.sort()
      const key = JSON.stringify(kept)
      const held = groups.get(key)
      if (held) held.ids.push(neuron.id)
      else groups.set(key, { labels: kept, ids: [neuron.id] })
    }

    for (const { labels, ids } of groups.values()) {
      const node = builder.neurons(d, ids)
      // The group stands for `ids.length` neurons, so its edge carries their weight — the same
      // number `collapse_neuron_nodes` gets from summing the collapsed edge list.
      for (const text of labels) builder.link(node, builder.label(text), ids.length)
    }
  }

  for (const [text, count] of compounds) {
    for (const part of splittable(text, s)!) {
      if (!part || s.bad.has(part)) continue
      builder.link(builder.label(text), builder.label(part), count)
    }
  }

  /*
   * Weight 0, as in cocoa: a synonym is an assertion about correspondence, not evidence about
   * how many neurons carry a label. Weighting it would let one hand-written edge out-vote the
   * data in the modularity split, which is the opposite of what somebody adding one wants.
   */
  for (const { label, synonym } of s.synonyms) {
    const a = label.trim()
    const b = synonym.trim()
    if (!a || !b || a === b || s.bad.has(a) || s.bad.has(b)) continue
    builder.link(builder.label(a), builder.label(b), 0)
  }

  return builder.build()
}

// ---------------------------------------------------------------------------
// Graph walks

/**
 * The connected components of the subgraph induced on `nodes`.
 *
 * Both callers restrict: the first to the whole graph, the second to one partition, whose
 * *internal* edges are the only ones that survived the split. Taking the node set explicitly is
 * what lets one walk serve both — the alternative that was tried, scanning every node index and
 * filtering by a membership set, is 10× slower when it is called once per partition, because
 * each call pays for the whole graph.
 */
function connectedComponents(graph: Graph, nodes: readonly number[]): number[][] {
  const inside = new Set(nodes)
  const seen = new Set<number>()
  const components: number[][] = []
  for (const start of nodes) {
    if (seen.has(start)) continue
    const component: number[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const node = stack.pop()!
      component.push(node)
      for (const next of graph.adjacency[node]!.keys()) {
        if (seen.has(next) || !inside.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    }
    components.push(component)
  }
  return components
}

/** Which datasets have neurons in this node set. */
function datasetsIn(graph: Graph, nodes: readonly number[]): Set<number> {
  const present = new Set<number>()
  for (const node of nodes) {
    const dataset = graph.nodes[node]!.dataset
    if (dataset !== LABEL_NODE) present.add(dataset)
  }
  return present
}

function coversAll(graph: Graph, nodes: readonly number[], count: number): boolean {
  return datasetsIn(graph, nodes).size === count
}

/**
 * The nodes of one component that are doing corresponding work.
 *
 * For every ordered pair of neuron nodes in *different* datasets, keep every node on every
 * shortest path between them. What that discards is the dangling label: one that hangs off the
 * component without shortening any crossing, and which would otherwise fuse two groups nothing
 * actually relates.
 *
 * **`allowIndirect` filters paths; it does not change the search.** A path is rejected when a
 * *neuron* sits in its interior — `maleCNS:12345 -> mcns_group_12345 -> maleCNS:54321 ->
 * AOTU001 -> FlyWire:...`, a correspondence asserted by way of somebody else's cell body. The
 * filter runs over the shortest paths rather than restricting the search, and the difference is
 * real: where every shortest crossing goes through a neuron this keeps *nothing* for that pair,
 * rather than silently promoting some longer label-only route into the answer.
 *
 * Done as a dynamic program over the breadth-first predecessor DAG rather than by enumerating
 * paths, since a component of a few dozen labels can hold exponentially many shortest paths.
 * `valid[v]` is "some shortest path from the source to `v` has no neuron in its interior", which
 * is computable in one pass in distance order and is exactly the predicate the backward walk
 * needs in order not to collect a node whose only route home runs through a neuron.
 *
 * **Everything here is indexed by position within the component, not by graph node.** The walk
 * never leaves the component, and typical components are ~16 nodes against a graph of ~80,000:
 * buffers sized by the graph meant a 16-node component allocated half a megabyte and cleared it
 * per source, which measured 627 ms of a 1.7 s whole-run and most of its GC pressure.
 */
function trimToCrossings(graph: Graph, component: readonly number[], s: Settings): Set<number> {
  const size = component.length
  const local = new Map<number, number>()
  component.forEach((node, i) => local.set(node, i))
  const neuronHere = component.map((node) => isNeuron(graph, node))

  const keep = new Set<number>()
  const sources: number[] = []
  for (let i = 0; i < size; i++) if (neuronHere[i]) sources.push(i)

  const dist = new Int32Array(size)
  const valid = new Uint8Array(size)
  const seen = new Uint8Array(size)
  const preds: number[][] = component.map(() => [])

  /** Whether `node` may sit in the *interior* of a kept path. */
  const passable = (node: number): boolean =>
    (s.allowIndirect || !neuronHere[node]) && valid[node] === 1

  for (const source of sources) {
    dist.fill(-1)
    valid.fill(0)
    /*
     * `seen` is cleared once per *source*, not once per target. Within one source the
     * predecessor DAG is fixed and each backward walk drains its stack completely, so a node
     * already expanded for an earlier target has its whole predecessor closure in `keep`
     * already — re-expanding it for the next target can only re-add what is there.
     */
    seen.fill(0)
    for (const list of preds) list.length = 0

    // Breadth-first, recording every predecessor at the previous distance — the shortest-path
    // DAG, not one tree.
    dist[source] = 0
    valid[source] = 1
    const order: number[] = [source]
    for (let head = 0; head < order.length; head++) {
      const node = order[head]!
      for (const next of graph.adjacency[component[node]!]!.keys()) {
        const to = local.get(next)
        if (to === undefined) continue
        if (dist[to] === -1) {
          dist[to] = dist[node]! + 1
          order.push(to)
        }
        if (dist[to] === dist[node]! + 1) preds[to]!.push(node)
      }
    }

    // In distance order, so every predecessor has already been decided.
    for (const node of order) {
      if (node === source) continue
      valid[node] = preds[node]!.some((p) => p === source || passable(p)) ? 1 : 0
    }

    const sourceDataset = graph.nodes[component[source]!]!.dataset
    for (const target of sources) {
      if (target === source || graph.nodes[component[target]!]!.dataset === sourceDataset)
        continue
      if (dist[target] === -1 || !valid[target] || seen[target]) continue

      const stack = [target]
      seen[target] = 1
      keep.add(component[target]!)
      while (stack.length) {
        const node = stack.pop()!
        for (const p of preds[node]!) {
          if (p !== source && !passable(p)) continue
          keep.add(component[p]!)
          if (p !== source && !seen[p]) {
            seen[p] = 1
            stack.push(p)
          }
        }
      }
    }
  }

  return keep
}

// ---------------------------------------------------------------------------
// Splitting

/**
 * One greedy-modularity bipartition of a node set, or fewer parts where it will not divide.
 *
 * Clauset-Newman-Moore: start with every node its own community and repeatedly merge the
 * adjacent pair whose modularity gain is largest, until two are left. Merging deliberately
 * continues past the modularity maximum — this is networkx's `best_n=2`, and the caller wants a
 * *candidate* split to test rather than the partition CNM likes best.
 *
 * Ties are broken on the smallest node index in each community, which is stable because node
 * indices come from a deterministic construction order. Without that, two runs over the same
 * graph give different labels to the same neurons, and [invariant
 * 4](../../../docs/invariants.md)'s cache is then serving a result that no longer reproduces.
 *
 * A merged-away community is one whose `members` is empty — the same fact its emptiness already
 * records, rather than a parallel `alive` array that four separate sites had to keep true.
 */
function greedyBipartition(graph: Graph, nodes: readonly number[]): number[][] {
  if (nodes.length <= 2) return nodes.map((node) => [node])

  const at = new Map<number, number>()
  nodes.forEach((node, i) => at.set(node, i))

  const members: number[][] = nodes.map((node) => [node])
  const degrees = new Float64Array(nodes.length)
  const between: Map<number, number>[] = nodes.map(() => new Map())
  const tag = nodes.map((_, i) => i)
  let total = 0

  for (let i = 0; i < nodes.length; i++) {
    for (const [other, weight] of graph.adjacency[nodes[i]!]!) {
      const j = at.get(other)
      if (j === undefined) continue
      degrees[i]! += weight
      total += weight
      if (j !== i) between[i]!.set(j, weight)
    }
  }
  // Every edge inside the set has weight zero (all of them hand-written synonyms), so modularity
  // has nothing to maximise. Singletons, which the caller's checks then reject.
  if (total === 0) return members

  let count = nodes.length
  while (count > 2) {
    let bestGain = -Infinity
    let bestA = -1
    let bestB = -1
    for (let a = 0; a < nodes.length; a++) {
      if (!members[a]!.length) continue
      for (const [b, weight] of between[a]!) {
        if (b <= a || !members[b]!.length) continue
        const gain = 2 * (weight / total - (degrees[a]! * degrees[b]!) / (total * total))
        const tied = Math.abs(gain - bestGain) <= 1e-12
        if (!tied && gain > bestGain) {
          bestGain = gain
          bestA = a
          bestB = b
        } else if (
          tied &&
          (tag[a]! < tag[bestA]! || (tag[a] === tag[bestA] && tag[b]! < tag[bestB]!))
        ) {
          // The gain is unchanged on purpose: the tie is being broken, not improved on.
          bestA = a
          bestB = b
        }
      }
    }
    // No adjacent pair left: the node set was already in more than two pieces, which the caller
    // reads as a split it did not have to make.
    if (bestA < 0) break

    members[bestA]!.push(...members[bestB]!)
    members[bestB] = []
    degrees[bestA]! += degrees[bestB]!
    tag[bestA] = Math.min(tag[bestA]!, tag[bestB]!)
    between[bestA]!.delete(bestB)
    for (const [other, weight] of between[bestB]!) {
      if (other === bestA) continue
      between[bestA]!.set(other, (between[bestA]!.get(other) ?? 0) + weight)
      between[other]!.set(bestA, (between[other]!.get(bestA) ?? 0) + weight)
      between[other]!.delete(bestB)
    }
    between[bestB]!.clear()
    count--
  }

  return members.filter((m) => m.length)
}

/** The ratio between the largest and smallest dataset's worth of neurons in a node set. */
function datasetRatio(graph: Graph, nodes: readonly number[]): number | undefined {
  const sizes = new Map<number, number>()
  for (const node of nodes) {
    const { dataset, ids } = graph.nodes[node]!
    if (dataset !== LABEL_NODE) sizes.set(dataset, (sizes.get(dataset) ?? 0) + ids.length)
  }
  if (!sizes.size) return undefined
  const values = [...sizes.values()]
  const low = Math.min(...values)
  return low > 0 ? Math.max(...values) / low : undefined
}

/**
 * How far a split may drift from the whole's dataset ratio before it is rejected.
 *
 * cocoa's number. The test is easy to dismiss as a refinement and should not be: a cut that
 * leaves 40 neurons against 4 on one side and 4 against 40 on the other keeps every dataset
 * present in both halves and is still wrong, and that is exactly the shape a merged type
 * produces when it is cut along the wrong axis.
 */
const RATIO_DRIFT = 2.5

/**
 * The finest division of a component that every dataset survives — cocoa's
 * `split_check_recursive`. Bipartition, test, recurse; a rejected split means this node set is
 * as fine as it gets.
 */
function splitCheckRecursive(graph: Graph, nodes: readonly number[], out: number[][]): void {
  const datasets = datasetsIn(graph, nodes)
  const ratio = datasetRatio(graph, nodes)
  const split = greedyBipartition(graph, nodes)

  const valid =
    split.length > 1 &&
    split.every((group) => {
      if (datasetsIn(graph, group).size !== datasets.size) return false
      const groupRatio = datasetRatio(graph, group)
      if (!ratio || !groupRatio) return true
      return groupRatio / ratio <= RATIO_DRIFT && ratio / groupRatio <= RATIO_DRIFT
    })

  if (!valid) {
    out.push([...nodes])
    return
  }
  for (const group of split) splitCheckRecursive(graph, group, out)
}

/**
 * Every component that reaches all the datasets, trimmed and split as far as it goes.
 *
 * The three steps that turn a raw label graph into candidate correspondences, in one place, so
 * that `matchCellTypes` below reads as "partition, then name". The partitions are disjoint and
 * only their *internal* edges survive, which is what lets the naming pass walk each one on its
 * own rather than rebuilding a graph of the survivors.
 */
function partitionComponents(graph: Graph, datasetCount: number, s: Settings): number[][] {
  const partitions: number[][] = []
  let oversized = 0
  let largest = 0

  const everyNode = graph.nodes.map((_, i) => i)
  for (const component of connectedComponents(graph, everyNode)) {
    if (!coversAll(graph, component, datasetCount)) continue

    let nodes = component
    if (component.length > COMPONENT_NODE_CAP) {
      oversized++
      largest = Math.max(largest, component.length)
    } else {
      const kept = trimToCrossings(graph, component, s)
      if (kept.size !== component.length) {
        nodes = component.filter((node) => kept.has(node))
        if (!coversAll(graph, nodes, datasetCount)) continue
      }
    }

    let labelCount = 0
    for (const node of nodes) if (!isNeuron(graph, node)) labelCount++
    if (labelCount > 1 && nodes.length <= COMPONENT_NODE_CAP) {
      splitCheckRecursive(graph, nodes, partitions)
    } else {
      partitions.push(nodes)
    }
  }

  if (oversized) {
    warnOverThreshold(s.warn, {
      count: largest,
      threshold: COMPONENT_NODE_CAP,
      unit: 'labels and neuron groups in one type component',
      control: 'the size a component can still be trimmed and split at',
      cost:
        `${oversized} component${oversized === 1 ? ' was' : 's were'} matched whole, so their ` +
        `shared labels are coarser than they could be. A component this large usually means one ` +
        `generic label is joining everything, which belongs in the ignored labels.`,
    })
  }

  return partitions
}

// ---------------------------------------------------------------------------
// Naming

/**
 * What one matched group is called.
 *
 * `first` prefers short, non-compound names — ordering on the number of parts before the text is
 * what stops `PS008,PS009` beating `PS008` for a group holding both. `all` is every distinct
 * part of every label in the group, so a merge reads as the merge it is. `id` cannot be decided
 * per component at all (it has to know which ids are duplicated across the whole mapping) and is
 * finished off in `resolveIdLabels`.
 *
 * Both readings go through `splittable`, so a label the *graph* refused to split is not split
 * here either. A group named after the pieces of a label that has no pieces is a shared label
 * containing text that is not a type.
 */
function chooseLabel(texts: readonly string[], s: Settings): string {
  const partsOf = (text: string): string[] => splittable(text, s) ?? [text]

  if (s.labelMode === 'all') {
    const parts = new Set<string>()
    for (const text of texts) for (const part of partsOf(text)) parts.add(part)
    return [...parts].filter(Boolean).sort().join(s.separator)
  }
  const sorted = [...texts].sort(
    (a, b) => partsOf(a).length - partsOf(b).length || (a < b ? -1 : a > b ? 1 : 0),
  )
  return sorted[0] ?? ''
}

/**
 * `id` mode's second half: name each group by the lowest id that names only it.
 *
 * An id is unique only inside its own dataset, so the same digits can appear in two of them —
 * and naming two different matched groups the same thing is the one outcome this mode exists to
 * avoid. Duplicated ids are therefore excluded from the choice entirely, and a group with
 * nothing left keeps its placeholder rather than borrowing a name.
 *
 * `compareIds`, never `Number(...)`: an eighteen-digit root id does not survive a float64
 * ([invariant 8](../../../docs/invariants.md)), and "lowest" among rounded ids is a different
 * neuron's.
 */
function resolveIdLabels(labels: Map<NeuronId, string>[]): void {
  const duplicated = new Set<NeuronId>()
  const seen = new Set<NeuronId>()
  const groups = new Map<string, NeuronId[]>()
  for (const perDataset of labels) {
    for (const [id, label] of perDataset) {
      if (seen.has(id)) duplicated.add(id)
      else seen.add(id)
      const held = groups.get(label)
      if (held) held.push(id)
      else groups.set(label, [id])
    }
  }

  const renamed = new Map<string, string>()
  for (const [placeholder, ids] of groups) {
    const usable = ids.filter((id) => !duplicated.has(id))
    if (!usable.length) continue
    renamed.set(
      placeholder,
      usable.reduce((low, id) => (compareIds(id, low) < 0 ? id : low)),
    )
  }

  for (const perDataset of labels) {
    for (const [id, label] of perDataset) {
      const name = renamed.get(label)
      if (name) perDataset.set(id, name)
    }
  }
}

/**
 * Per-label neuron counts per dataset, and the flag that makes them worth reading.
 *
 * The flag is a question about the smallest count against the largest, which is the same answer
 * every pair would give and one pass rather than d². Sorted by label so the table is stable
 * across runs.
 */
function buildReport(labels: readonly ReadonlyMap<NeuronId, string>[]): LabelCount[] {
  const counts = new Map<string, number[]>()
  labels.forEach((perDataset, d) => {
    for (const label of perDataset.values()) {
      let row = counts.get(label)
      if (!row) {
        row = new Array<number>(labels.length).fill(0)
        counts.set(label, row)
      }
      row[d]!++
    }
  })

  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, row]) => {
      const high = Math.max(...row)
      return {
        label,
        counts: row,
        suspicious: high > 0 && Math.min(...row) / high < SUSPICIOUS_COUNT_RATIO,
      }
    })
}

/**
 * The mapping, and the report that says whether to believe it.
 *
 * Pure and synchronous. Every neuron landing in a component that reaches all the datasets gets a
 * shared label; every other neuron gets nothing, which is the honest answer and is counted in
 * `unmatched` rather than filled in with its own type name — a raw type name in a shared label
 * space is indistinguishable from a matched one, which is the trap `Relabel`'s `unmatched: null`
 * default guards from the other side.
 */
export function matchCellTypes(
  datasets: readonly MapperDataset[],
  options: MapperOptions = {},
): TypeMapping {
  const s = settingsFrom(options)
  const labels: Map<NeuronId, string>[] = datasets.map(() => new Map())

  // Fewer than two datasets is not an error and not a special case: there is no correspondence
  // to establish, so nothing is matched and every neuron is counted as unmatched below.
  if (datasets.length > 1) {
    const graph = buildGraph(datasets, s)
    let placeholder = 0

    for (const partition of partitionComponents(graph, datasets.length, s)) {
      for (const component of connectedComponents(graph, partition)) {
        if (component.length < 2 || !coversAll(graph, component, datasets.length)) continue
        const texts: string[] = []
        for (const node of component)
          if (!isNeuron(graph, node)) texts.push(graph.nodes[node]!.text)
        const name = s.labelMode === 'id' ? `#${placeholder++}` : chooseLabel(texts, s)
        if (!name) continue
        for (const node of component) {
          const { dataset, ids } = graph.nodes[node]!
          if (dataset === LABEL_NODE) continue
          for (const id of ids) labels[dataset]!.set(id, name)
        }
      }
    }

    if (s.labelMode === 'id') resolveIdLabels(labels)
  }

  return {
    labels,
    report: buildReport(labels),
    unmatched: datasets.map((neurons, d) => neurons.length - labels[d]!.size),
  }
}

// ---------------------------------------------------------------------------
// The two halves the node reads

/**
 * One dataset's annotation table, reduced to what `matchCellTypes` takes.
 *
 * Here rather than in the node, and that is [invariant 8](../../../docs/invariants.md)'s doing:
 * this is the one place an id crosses out of a `TableValue` and into the mapper, `idText` is the
 * rule for doing it, and CLAUDE.md records the UI and glue layers as where that keeps being
 * re-broken with a `String(...)` or a `Number(...)`. Beside the algorithm it has a unit test; in
 * a node's `evaluate` it would have none.
 *
 * **A neuron with no usable label is kept, not dropped.** It cannot match, but it is still a
 * neuron in the dataset, and `TypeMapping.unmatched` is a count of what did not match — dropping
 * it here would quietly shrink the denominator and make a mapping that covered a tenth of a
 * brain report as if it covered all of it.
 */
export function mapperDatasetFrom(
  table: TableValue,
  typeColumns: readonly string[],
  idColumn: string = ID_COLUMN_NAME,
): MapperDataset {
  const ids = table.data[idColumn]
  if (!ids) return []
  const columns = typeColumns
    .map((name) => table.data[name])
    .filter((data): data is ColumnData => !!data)

  const neurons: MapperNeuron[] = []
  for (let row = 0; row < table.length; row++) {
    // `idText`, never `String(...)`: an 18-digit root id read off an `i64` column is already a
    // float64, and this is the seam that has to notice rather than the one that rounds.
    const id = idText(ids[row])
    if (!id) continue
    const labels: string[] = []
    for (const data of columns) {
      const label = labelText(data[row])
      if (label) labels.push(label)
    }
    neurons.push({ id, labels })
  }
  return neurons
}

/**
 * The hand-curated half of the correspondence, off the node's optional Synonyms port.
 *
 * cocoa's `add_synonym`, and the route by which somebody's own judgement enters a mapping that
 * is otherwise derived: `LC4` and `Lobula columnar 4` are the same cells and share no text, so
 * nothing in the data will ever join them. Nothing wired, or no columns chosen, means no
 * synonyms — a legitimate state rather than a missing input.
 *
 * Beside `mapperDatasetFrom` because it is the same job on the other table: these two are the
 * only places a `TableValue` crosses into the mapper, and the rule about which cells count is a
 * fact about what the mapper accepts rather than about one node. It is also the one of the pair
 * that looks harmless — it touches no ids — which makes it the one most likely to be
 * re-implemented by the next caller if it lives somewhere private.
 */
export function synonymsFrom(
  value: Value | undefined,
  labelColumn: string | undefined,
  otherColumn: string | undefined,
): LabelSynonym[] {
  if (!isTableValue(value) || !labelColumn || !otherColumn) return []
  const labels = value.data[labelColumn]
  const others = value.data[otherColumn]
  if (!labels || !others) return []

  const synonyms: LabelSynonym[] = []
  for (let row = 0; row < value.length; row++) {
    const label = labelText(labels[row])
    const synonym = labelText(others[row])
    if (label && synonym) synonyms.push({ label, synonym })
  }
  return synonyms
}

/**
 * One cell as a label, or `''` where it is not one.
 *
 * Both adapters above ask the same question — null, undefined and the empty string are all
 * "this row has no label here" — and wrote the same three-way test either side of the banner.
 * A blank is an absence rather than a label, which matters: an empty shared label would pool
 * every unlabelled neuron in both brains into one enormous correspondence.
 */
function labelText(cell: CellValue | undefined): string {
  return cell === null || cell === undefined ? '' : String(cell)
}

/** One dataset's share of the mapping: its own bare ids against the shared label. */
export const MAPPER_LABELS_SCHEMA = tableSchema(
  column(ID_COLUMN_NAME, 'str'),
  column('label', 'str'),
)

/**
 * Built columnar rather than through `tableFromRows`, whose own doc says it is for small and
 * mock data and not for hot paths — this is one row per *neuron*, so a whole-brain mapping hands
 * it 140,000 row objects to transpose straight back into two columns. Measured at 140k: 11.6 ms
 * through the row builder, 1.4 ms this way.
 */
export function mapperLabelsTable(labels: ReadonlyMap<NeuronId, string>): TableValue {
  const ids: CellValue[] = new Array(labels.size)
  const names: CellValue[] = new Array(labels.size)
  let row = 0
  for (const [neuronId, label] of labels) {
    ids[row] = neuronId
    names[row] = label
    row++
  }
  return makeTable(MAPPER_LABELS_SCHEMA, { [ID_COLUMN_NAME]: ids, label: names })
}

/**
 * The report, **long**: one row per (label, dataset) rather than a count column per dataset.
 *
 * A column per dataset would make this the one output whose *schema* depends on the node's
 * arity, which is the shape [invariant 3](../../../docs/invariants.md) exists for — the columns
 * `inferOutputs` promises and the columns `evaluate` builds would be two derivations of one
 * thing, agreeing until somebody changes a name. Long form makes it a constant.
 *
 * It is also the more useful table. Coda's grouping, filtering and charts all read long form,
 * `Partner Vectors` already emits it, and `Compare Connectivity`'s `counts` port is specified
 * the same way — so a reader who has seen one has seen them all. The cost is that `suspicious`
 * repeats down a label's rows, which is a fact about the label rather than about the row; that
 * is the honest trade and it is what makes "show me every suspicious label" one filter.
 */
export const MAPPER_REPORT_SCHEMA = tableSchema(
  column('label', 'str'),
  column('dataset', 'str'),
  column('nNeurons', 'i64'),
  column('suspicious', 'bool'),
)

export function mapperReportTable(
  report: readonly LabelCount[],
  datasetNames: readonly string[],
): TableValue {
  const rows: Array<Record<string, CellValue>> = []
  for (const entry of report) {
    entry.counts.forEach((nNeurons, d) => {
      rows.push({
        label: entry.label,
        dataset: datasetNames[d]!,
        nNeurons,
        suspicious: entry.suspicious,
      })
    })
  }
  return tableFromRows(MAPPER_REPORT_SCHEMA, rows)
}
