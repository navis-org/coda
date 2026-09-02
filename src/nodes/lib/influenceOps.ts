/**
 * Bounded influence: the published influence score, computed over a ball instead of a
 * connectome.
 *
 * Bates et al. define a neuron's influence on another through a linear rate model,
 * `tau dr/dt = (W - I)r + s`, whose steady state is `r = (I - W~)^-1 s`. The reference
 * implementation (DrugowitschLab/ConnectomeInfluenceCalculator, `calculate_influence`) solves
 * that inverse directly, which means holding every edge of the connectome — seed-to-all, and
 * for CAVE not a thing a browser can do at all. The Neumann series of the same inverse is
 *
 *     r = s + g W s + g^2 W^2 s + g^3 W^3 s + ...
 *
 * so a traversal bounded at `H` hops is not a different metric. It is that sum stopped early,
 * which is what `04_weighted_graph_traversal.ipynb` computes and what this module computes.
 *
 * Four things about that came out of reading the two references against each other, and each
 * one decides something here.
 *
 * **The gain is the published `lambda_max`, exactly, and only because of how W is normalised.**
 * `InfluenceCalculator` scales W by `lambda_max / lambda_max(W)`. With `norm` weights —
 * `count / sum(count) per post`, computed after the count threshold — W is row-stochastic, so
 * `lambda_max(W)` is 1 and the rescale *is* a per-hop factor of `lambda_max`. Hence `gain`
 * below, and hence the help text saying it is the same knob rather than an analogue of it.
 * The package's own default (`syn_weight_measure='count'`) has no such identity: its scale
 * factor is a spectral property of the whole matrix, so it is precisely the thing a ball cannot
 * know, and it is why this implements the `norm` variant and says so.
 *
 * **The denominator is local to the postsynaptic neuron.** Nothing in W depends on the extent
 * of the graph, so a bounded traversal computes the *same* entries as an unbounded one — there
 * is no renormalisation to drift as the ball grows. That is what makes any of this legitimate.
 *
 * **The two directions are not symmetric, and the cheap one is the one people ask for.**
 * Travelling `inputs` — "which neurons influence this set" — fetches each carrying neuron's
 * input list, which is simultaneously the edges *and* their denominator; and because a post's
 * input fractions sum to one, mass is conserved per hop, so the propagating vector is a
 * distribution over where the drive came from and a discarded fraction is literally a
 * discarded fraction of the answer. Travelling `outputs` fetches an output list, whose
 * denominators belong to the far end — a second lookup, and one only some backends publish —
 * and nothing bounds the total mass. `denominators` is required in that direction for that
 * reason, and absent it this throws rather than inventing an out-normalisation, which would be
 * a different metric wearing the same column name.
 *
 * **Every term is non-negative, so a bounded answer is a lower bound and never a guess.** Hops
 * that were not walked, mass the frontier limit dropped and mass that went to an unpublished
 * fragment all subtract and none add. `truncation` turns the last term's mass into a ceiling on
 * what the missing hops could have contributed; the two loss counters do the same for the other
 * two. A caller that reports those numbers is reporting an error bar, not a caveat.
 *
 * One implementation note that is easy to get wrong because every other traversal here does the
 * opposite: **this is not a breadth-first search.** `W^k s` requires every neuron carrying mass
 * at hop *k* to spread it, whether or not it also spread at hop *k-1* — that is what puts
 * recurrent loops into the score at all. So a neuron is *fetched* once and cached, and then
 * propagated from on every subsequent hop. `traverseConnectivity` skips an expanded node; doing
 * that here would silently drop every cycle.
 */

import type { ParamValues } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { ID_COLUMN_NAME, compareIds, idText } from '../../core/ids'
import type { NeuronId } from '../../core/ids'
import type { ConnectionDirection } from '../../data/source'
import { endpointSchema } from './connectivityOps'

// The query-relative column names a `fetchConnectivity` result arrives under. Restated here
// rather than imported from `connectivityOps`, which keeps them private and renames them on the
// way out to `preId`/`postId`; this module never emits an edge list, so it has nothing to rename.
const NEURON_TYPE = 'neuronType'
const PARTNER_ID = 'partnerId'
const PARTNER_TYPE = 'partnerType'
const WEIGHT = 'weight'

// The score columns. Module-private: `influenceSchema` is what publishes them, and a second
// exported spelling is how a column name drifts from the schema that declares it.
const INFLUENCE_COLUMN = 'influence'
const INFLUENCE_LOG_COLUMN = 'influenceLog'
const HOPS_COLUMN = 'hops'
const SEED_COLUMN = 'isSeed'
const QUERY_ID_COLUMN = 'queryId'
const QUERY_TYPE_COLUMN = 'queryType'

/**
 * The floor and shift in the reference implementation's `adjust_influence`.
 *
 * Transcribed rather than chosen: raw scores span many orders of magnitude, `exp(-24)` is the
 * junk-node floor the package applies before taking a log, and `+24` is what lifts the result
 * back above zero. Keeping their number is what makes a Coda column and a package column
 * comparable at a glance.
 */
const ADJUST_CONST = 24

// ---------------------------------------------------------------------------
// The params, read once
// ---------------------------------------------------------------------------

/** Which definition of W's divisor a run is using. See the node's `Denominator` control. */
export type Denominator = 'traversal' | 'connected' | 'all'

export interface InfluenceParams {
  direction: ConnectionDirection
  denominator: Denominator
  maxHops: number
  minWeight: number
  gain: number
  frontierLimit: number
  includeFragments: boolean
  /** `Seed weighting`: true divides one unit between the seeds instead of giving each one. */
  shareSeedMass: boolean
  /** `Per query neuron`: keep the query neurons apart so the Per Query port can be filled. */
  perQuery: boolean
}

/**
 * The node's eight settings, decoded once.
 *
 * **In `nodes/lib` because the exporters import from here**, which is `regionOptions`' rule and
 * its recorded incident: written per caller, the node and the R emitter had already drifted on
 * what an empty value meant. Every default below appears in exactly two places — the
 * `ParamDef.default` that the card shows, and this function — and the notebook emitter reads
 * this rather than re-spelling them, so a changed default cannot silently export a different run
 * from the one the canvas made.
 */
export function influenceParamsFrom(params: ParamValues): InfluenceParams {
  const denominator = params.denominator
  return {
    perQuery: params.perQuery === true,
    direction: params.direction === 'outputs' ? 'outputs' : 'inputs',
    denominator: denominator === 'connected' || denominator === 'all' ? denominator : 'traversal',
    maxHops: Math.max(1, Math.floor(Number(params.maxHops ?? 4))),
    minWeight: Math.max(1, Math.floor(Number(params.minWeight ?? 5))),
    gain: Number(params.gain ?? 0.5),
    frontierLimit: Math.max(0, Math.floor(Number(params.frontierLimit ?? 2000))),
    includeFragments: params.includeFragments === true,
    shareSeedMass: params.seedWeighting === 'share',
  }
}

/**
 * The one combination that cannot be computed, as a predicate rather than three readings of it.
 *
 * Travelling `outputs`, W's divisor belongs to the receiving neuron and an outputs query never
 * returns it. Asked by `validate`, by `evaluate` and by the notebook emitter — the prose each
 * of them wraps it in differs, because the audiences do, but the condition may not.
 */
export function needsPublishedTotals(params: InfluenceParams): boolean {
  return params.direction === 'outputs' && params.denominator === 'traversal'
}

// ---------------------------------------------------------------------------
// The propagating vector
// ---------------------------------------------------------------------------

/**
 * A non-negative quantity per neuron, in one or more independent channels.
 *
 * One channel is the ordinary case — a single vector `W^k s`. Several is the bidirectional
 * case, where the forward half has to keep the seeds apart: the answer wanted there is *per
 * source*, and a single pooled vector can only say what the set did together. Channel *i* is
 * then seed *i*, in the order they were given.
 *
 * Sparse, because it is: absent means zero, and at low hop counts most of the connectome is
 * absent. Dense within a neuron, because the channel count is fixed and small — and the count
 * itself is not carried, because every `Float64Array` in the map already states it.
 */
export type Spread = Map<NeuronId, Float64Array>

/** One hop's worth of fetching, query-relative. Injected so this module never sees a source. */
export type InfluenceFetch = (
  neuronIds: NeuronId[],
  direction: ConnectionDirection,
) => Promise<TableValue>

/**
 * Total input synapses per postsynaptic neuron — the denominator of W, when the caller supplies
 * it rather than letting the traversal sum what it fetched.
 *
 * Required travelling `outputs`, where the postsynaptic end is the far one and its input list
 * was never fetched. Optional travelling `inputs`, where it is the frontier itself: absent
 * there means "sum the rows that came back", which is the reference implementation's rule
 * (`count / sum(count) per post`, after the count threshold) and needs no second query.
 *
 * The two are **not** interchangeable and a caller must not pick per hop or per backend: they
 * differ by whatever input sits below the weight threshold, and one W built from both is not a
 * matrix anybody can name.
 */
export type DenominatorLookup = (postIds: NeuronId[]) => Promise<Map<NeuronId, number>>

export interface PropagateOptions {
  /** Where the perturbation (travelling `outputs`) or the readout (travelling `inputs`) sits. */
  seeds: readonly NeuronId[]
  /** Mass each seed starts with. 1 matches the reference; 1/|seeds| makes sets comparable. */
  seedMass?: number
  /**
   * Keep the seeds in separate channels, so the result can be read per seed.
   *
   * Costs a `Float64Array(seeds.length)` per reached neuron, so it is off unless the caller
   * genuinely needs the split — which is only the forward half of a bidirectional run.
   */
  perSeedChannels?: boolean
  /** `inputs` walks towards the influencers; `outputs` walks towards the influenced. */
  direction: ConnectionDirection
  /** Hops to walk. 0 is legitimate and yields the seed vector alone. */
  hops: number
  /** The per-hop factor. The reference implementation's `lambda_max`; see the module comment. */
  gain: number
  fetch: InfluenceFetch
  /** Required travelling `outputs`. See `DenominatorLookup`. */
  denominators?: DenominatorLookup
  /**
   * Which newly reached neurons the dataset actually publishes — `Include fragments` unticked.
   *
   * Asked once per hop with the ids not asked about before, exactly as `traverseConnectivity`
   * asks it, and the seeds are exempt for the same reason: a body somebody pasted in is not a
   * body to filter away.
   *
   * **It does not touch the denominator.** A fragment that was dropped still received synapses
   * and still consumed input share, so the drive it carried away is *lost*, not redistributed —
   * counted in `fragmentMass` rather than quietly inflating everyone else's fraction. That is
   * where this parts company with the reference implementation, whose denominator is the sum
   * over whatever edge list it was handed.
   */
  published?: (ids: NeuronId[]) => Promise<Set<NeuronId>>
  /**
   * Keep at most this many neurons carrying mass into the next hop, strongest first. 0 is no
   * limit. This is the only thing bounding the fetch, and what it costs is reported.
   */
  frontierLimit?: number
  /** Called before each hop with the hop number, the total, and how many neurons are carrying. */
  onHop?: (hop: number, hops: number, carrying: number) => void
  signal?: AbortSignal
}

export interface PropagateResult {
  direction: ConnectionDirection
  gain: number
  /** `terms[k]` is `g^k W^k s`. Index 0 is the seed vector, so the length is `hops + 1`. */
  terms: Spread[]
  /** The running sum of `terms`, which is the influence itself when nothing else is combined. */
  total: Spread
  /** The first hop at which a neuron carried anything. */
  firstHop: Map<NeuronId, number>
  /** The id cell each neuron arrived as, so an 18-digit root id is never rebuilt from text. */
  cells: Map<NeuronId, CellValue>
  /** The first non-empty type seen for a neuron. */
  types: Map<NeuronId, string | null>
  /** Mass the frontier limit discarded, per hop. An artefact of the budget. */
  droppedMass: number[]
  /** Mass that went to a neuron the dataset does not publish, per hop. A property of the data. */
  fragmentMass: number[]
  /** Neurons the denominator lookup had no answer for. Their edges carried nothing. */
  missingDenominator: Set<NeuronId>
  /** Distinct neurons whose partners were fetched — what the run actually cost. */
  fetched: number
}

/** The magnitude of one neuron's entry, summed over channels. Every channel is non-negative. */
function magnitude(values: Float64Array): number {
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]!
  return sum
}

/** Total mass in a spread, over every neuron and channel. */
export function spreadMass(spread: Spread): number {
  let sum = 0
  for (const values of spread.values()) sum += magnitude(values)
  return sum
}

/**
 * A spread as one number per neuron, added over its channels.
 *
 * On a pooled walk there is one channel and this is it. On a walk channelled per query neuron it
 * is the total across them — the same number the pooled walk would have produced, because the
 * propagation is linear in the seed vector. One function rather than two for that reason: a
 * separate "read channel 0" would be right for one kind of walk and quietly wrong for the other.
 */
export function summedVector(spread: Spread): Map<NeuronId, number> {
  const out = new Map<NeuronId, number>()
  for (const [id, values] of spread) {
    const value = magnitude(values)
    if (value !== 0) out.set(id, value)
  }
  return out
}

// ---------------------------------------------------------------------------
// One neuron's edges, cached across hops
// ---------------------------------------------------------------------------

interface Adjacency {
  /** Partner keys, in fetch order. */
  partners: NeuronId[]
  weights: number[]
  /**
   * Sum of `weights`, over **every** row that came back.
   *
   * The denominator travelling `inputs` when the caller supplies none, and computed before the
   * `published` filter runs so that dropping a fragment loses drive rather than reassigning it.
   */
  total: number
}

/**
 * The entry a fetched-but-partnerless neuron gets. Shared, so **never mutated** — `readAdjacency`
 * replaces it with an entry of its own the moment a row arrives.
 */
const EMPTY: Adjacency = { partners: [], weights: [], total: 0 }

/**
 * Fold a query-relative connectivity table into the adjacency cache.
 *
 * `neuronId` is whichever end was asked about and `partnerId` the other, so the postsynaptic
 * end is `neuronId` travelling `inputs` and `partnerId` travelling `outputs`. Everything else
 * in this module is written in terms of "the queried end" and "the far end" precisely so that
 * this is the only function that has to know which is which.
 */
function readAdjacency(
  table: TableValue,
  asked: readonly NeuronId[],
  cache: Map<NeuronId, Adjacency>,
  cells: Map<NeuronId, CellValue>,
  types: Map<NeuronId, string | null>,
): void {
  // Seeded empty first: a neuron with no partners above the threshold must still count as
  // fetched, or every later hop asks about it again and the run costs a query per hop per
  // dead end.
  for (const id of asked) if (!cache.has(id)) cache.set(id, EMPTY)

  const near = table.data[ID_COLUMN_NAME]
  const nearType = table.data[NEURON_TYPE]
  const far = table.data[PARTNER_ID]
  const farType = table.data[PARTNER_TYPE]
  const weight = table.data[WEIGHT]
  if (!near || !far) return

  const noteType = (id: NeuronId, raw: CellValue | undefined) => {
    const held = types.get(id)
    if (held !== undefined && held !== null && held !== '') return
    types.set(id, raw === null || raw === undefined || raw === '' ? null : String(raw))
  }

  for (let i = 0; i < table.length; i++) {
    const nearCell = near[i] ?? null
    const farCell = far[i] ?? null
    const nearId = idText(nearCell)
    const farId = idText(farCell)
    if (nearId === null || farId === null) continue

    if (!cells.has(nearId)) cells.set(nearId, nearCell)
    if (!cells.has(farId)) cells.set(farId, farCell)
    noteType(nearId, nearType?.[i])
    noteType(farId, farType?.[i])

    const value = Number(weight?.[i] ?? 0)
    if (!Number.isFinite(value) || value <= 0) continue

    // Folded straight into the cache entry rather than through an intermediate map and a copy.
    // `EMPTY` is shared, so the first row for a neuron replaces it rather than pushing into it.
    let entry = cache.get(nearId)
    if (!entry || entry === EMPTY) {
      entry = { partners: [], weights: [], total: 0 }
      cache.set(nearId, entry)
    }
    entry.partners.push(farId)
    entry.weights.push(value)
    entry.total += value
  }
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Walk `hops` hops from the seeds, accumulating `sum_k g^k W^k s`.
 *
 * Each round propagates from *every* neuron currently carrying mass, not only from the ones
 * that arrived last round — see the module comment. Only the neurons whose edges have never
 * been fetched are asked about, so a hop's query cost falls away as the ball stops growing
 * even though its arithmetic cost does not.
 */
export async function propagate(opts: PropagateOptions): Promise<PropagateResult> {
  const hops = Math.max(0, Math.floor(opts.hops))
  const gain = opts.gain
  const seedMass = opts.seedMass ?? 1
  const outward = opts.direction === 'outputs'
  const limit = Math.max(0, Math.floor(opts.frontierLimit ?? 0))

  if (outward && !opts.denominators) {
    // A developer-facing invariant, not a user-facing refusal: the node gates this on the
    // source's `synapseTotals` capability long before anything is fetched. Travelling
    // `outputs`, W's denominator belongs to the far end and there is no honest way to guess it
    // — normalising by the presynaptic neuron's output total instead would produce a different
    // quantity under the same name, which is the substitution the whole design refuses.
    throw new Error('propagate: travelling outputs requires a denominator lookup')
  }

  const seeds = [...new Set(opts.seeds)]
  const channels = opts.perSeedChannels ? Math.max(1, seeds.length) : 1

  const cache = new Map<NeuronId, Adjacency>()
  const cells = new Map<NeuronId, CellValue>()
  const types = new Map<NeuronId, string | null>()
  const denominators = new Map<NeuronId, number>()
  const missingDenominator = new Set<NeuronId>()
  const firstHop = new Map<NeuronId, number>()
  const droppedMass: number[] = []
  const fragmentMass: number[] = []

  /** Seeds, plus everything `published` has said yes to. Unread when there is no filter. */
  const kept = new Set<NeuronId>(seeds)
  const asked = new Set<NeuronId>(seeds)

  let current: Spread = new Map()
  seeds.forEach((id, index) => {
    const values = new Float64Array(channels)
    values[opts.perSeedChannels ? index : 0] = seedMass
    current.set(id, values)
    firstHop.set(id, 0)
  })

  const total: Spread = new Map()
  const terms: Spread[] = []

  const accumulate = (spread: Spread, scale: number) => {
    const scaled: Spread = new Map()
    for (const [id, values] of spread) {
      const out = new Float64Array(channels)
      for (let c = 0; c < channels; c++) out[c] = values[c]! * scale
      scaled.set(id, out)
      const held = total.get(id)
      if (held) {
        for (let c = 0; c < channels; c++) held[c] = held[c]! + out[c]!
      } else {
        total.set(id, out.slice())
      }
    }
    terms.push(scaled)
  }

  accumulate(current, 1)

  for (let hop = 1; hop <= hops && current.size > 0; hop++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    opts.onHop?.(hop, hops, current.size)

    const carrying = [...current.keys()]
    const unfetched = carrying.filter((id) => !cache.has(id))
    if (unfetched.length > 0) {
      const table = await opts.fetch(unfetched, opts.direction)
      readAdjacency(table, unfetched, cache, cells, types)
    }

    /*
     * Denominators, asked once per hop for everything postsynaptic that this hop will divide
     * by and that is not already known. Travelling `inputs` that is the carrying set itself;
     * travelling `outputs` it is the far ends, which are only knowable after the fetch — which
     * is why this sits here rather than beside it.
     */
    if (opts.denominators) {
      const wanted = new Set<NeuronId>()
      const want = (id: NeuronId) => {
        if (!denominators.has(id) && !missingDenominator.has(id)) wanted.add(id)
      }
      for (const id of unfetched) {
        if (!outward) want(id)
        else for (const partner of cache.get(id)?.partners ?? []) want(partner)
      }
      if (wanted.size > 0) {
        const answered = await opts.denominators([...wanted])
        for (const id of wanted) {
          const value = answered.get(id)
          if (value === undefined || !Number.isFinite(value) || value <= 0) {
            missingDenominator.add(id)
          } else {
            denominators.set(id, value)
          }
        }
      }
    }

    const next = new Map<NeuronId, Float64Array>()
    const add = (id: NeuronId, from: Float64Array, share: number) => {
      let held = next.get(id)
      if (!held) {
        held = new Float64Array(channels)
        next.set(id, held)
      }
      for (let c = 0; c < channels; c++) held[c] = held[c]! + from[c]! * share
    }

    for (const [id, mass] of current) {
      const adjacency = cache.get(id)
      if (!adjacency || adjacency.partners.length === 0) continue
      // Travelling `inputs` the divisor belongs to the queried neuron and is the same for
      // every one of its edges, so it is read once out here. Travelling `outputs` it belongs
      // to each partner and is read in the loop.
      const near = outward ? 0 : (denominators.get(id) ?? adjacency.total)
      if (!outward && near <= 0) continue
      for (let i = 0; i < adjacency.partners.length; i++) {
        const partner = adjacency.partners[i]!
        const divisor = outward ? (denominators.get(partner) ?? 0) : near
        if (divisor <= 0) continue
        add(partner, mass, adjacency.weights[i]! / divisor)
      }
    }

    // The published filter, then the frontier limit — in that order, because a fragment that
    // has been dropped must not occupy a slot the limit would otherwise have given to a neuron
    // the answer can name.
    let toFragments = 0
    if (opts.published) {
      const unknown = [...next.keys()].filter((id) => !asked.has(id))
      if (unknown.length > 0) {
        for (const id of await opts.published(unknown)) kept.add(id)
        for (const id of unknown) asked.add(id)
      }
      for (const [id, values] of next) {
        if (kept.has(id)) continue
        toFragments += magnitude(values)
        next.delete(id)
      }
    }
    fragmentMass.push(toFragments)

    let toLimit = 0
    if (limit > 0 && next.size > limit) {
      // Measured once per neuron rather than inside the comparator: `magnitude` is a loop over
      // the channels, and a comparator calling it twice makes the sort O(n log n · channels)
      // where the channel count is the candidate set of a bidirectional run.
      const ranked: Array<[NeuronId, number]> = []
      for (const [id, values] of next) ranked.push([id, magnitude(values)])
      ranked.sort(
        // Strongest first. Ids break the tie so that two runs of the same query keep the same
        // neurons — invariant 4 needs a deterministic result, and a limit that resolved ties by
        // `Map` order would resolve them by fetch order.
        (a, b) => b[1] - a[1] || compareIds(a[0], b[0]),
      )
      for (let i = limit; i < ranked.length; i++) {
        toLimit += ranked[i]![1]
        next.delete(ranked[i]![0])
      }
    }
    droppedMass.push(toLimit)

    current = next
    for (const id of next.keys()) if (!firstHop.has(id)) firstHop.set(id, hop)
    accumulate(current, Math.pow(gain, hop))
  }

  return {
    direction: opts.direction,
    gain,
    terms,
    total,
    firstHop,
    cells,
    types,
    droppedMass,
    fragmentMass,
    missingDenominator,
    fetched: cache.size,
  }
}

// ---------------------------------------------------------------------------
// Meeting in the middle
// ---------------------------------------------------------------------------

export interface HopSplit {
  /** Hops walked from the sources, travelling `outputs`. */
  forward: number
  /** Hops walked from the targets, travelling `inputs`. */
  backward: number
}

/**
 * How a hop budget is divided when both ends are named.
 *
 * **This does not buy what the equivalent in `pathOps.ts` buys, and the difference is worth
 * knowing before changing it.** A route has to be searched from both ends because it is only a
 * route once both endpoints are pinned. Influence is not like that: the per-source ranking is
 * `sum_k g^k z_k[j]` where `z` is the backward walk, so with only the readout set named there
 * is nothing for a second walk to halve, and the single pass at full depth is already the whole
 * answer. That is why a one-ended run gets `{ forward: 0, backward: hops }` here and no split
 * at all.
 *
 * What the split buys when both ends *are* named is fetch count, which is the real cost. A ball
 * grows multiplicatively, so `ball(A) + ball(B)` is far smaller than `ball(A + B)`; the price is
 * that the answer is then restricted to the sources named, since the forward half has to keep
 * them in separate channels to say anything per source.
 *
 * The deeper half goes to the **smaller** set, because that is the ball that can afford it. Two
 * things override that: with no forward half available — the backend publishes no synapse
 * totals, so W's denominator cannot be had from the presynaptic end — the whole budget goes
 * backward and this degenerates to the single-pass answer, which is correct rather than a
 * failure; and a `hops` of 1 cannot be split at all.
 */
export function splitHops(
  hops: number,
  sourceCount: number,
  targetCount: number,
  forwardAvailable: boolean,
): HopSplit {
  const budget = Math.max(0, Math.floor(hops))
  if (!forwardAvailable || sourceCount === 0 || targetCount === 0) {
    return { forward: 0, backward: budget }
  }
  const forward =
    sourceCount <= targetCount ? Math.ceil(budget / 2) : Math.floor(budget / 2)
  return { forward, backward: budget - forward }
}

/**
 * Combine the two halves into a score per neuron of the scored set.
 *
 * For any `a + b = k`, `z_0' W^k s = z_b' W^a s`, so one decomposition per `k` is enough and
 * every path of length `k` is counted exactly once. Both halves already carry their own power of
 * the gain, so the product carries `g^k` with nothing to reapply. `a = min(k, A)` is what keeps
 * that legal: below `A` the leading half covers the whole hop, and above it the remainder is at
 * most `B` because `k` never exceeds `A + B`.
 *
 * **Which half carries the channels is the caller's business, not this function's**, and that is
 * why the parameters are named for the channels rather than for the direction. The scored set is
 * the *presynaptic* side travelling upstream and the *postsynaptic* side travelling downstream —
 * so a signature that took `(forward, backward)` would be right for one direction and silently
 * return the wrong neurons' scores for the other. The dot product itself is symmetric; only the
 * seeding is not.
 *
 * Both halves are pruned, and both are non-negative, so a term the pruning removed from either
 * side removes a product and never adds one. The combined score stays a lower bound, which is
 * the property the whole design leans on.
 */
export function combineHalves(
  channelled: PropagateResult,
  pooled: PropagateResult,
  scored: readonly NeuronId[],
): Map<NeuronId, number> {
  const scores = new Map<NeuronId, number>()
  const channelledDepth = channelled.terms.length - 1
  const pooledDepth = pooled.terms.length - 1
  if (channelledDepth < 0 || pooledDepth < 0) return scores

  // Accumulated densely and written out once. The key set is fixed and index-addressable by
  // channel, where a `Map` get/set pair per contribution is two hashes per (overlap × candidate).
  const totals = new Float64Array(scored.length)

  for (let k = 0; k <= channelledDepth + pooledDepth; k++) {
    const a = Math.min(k, channelledDepth)
    const b = k - a
    if (b > pooledDepth) continue
    const near = channelled.terms[a]!
    const far = pooled.terms[b]!
    // Walk whichever side has fewer entries and look the other up: the two overlap only where
    // the halves met, which past the first hop is a small fraction of either.
    const walkNear = near.size <= far.size
    const walk = walkNear ? near : far
    const look = walkNear ? far : near
    for (const [id, values] of walk) {
      const other = look.get(id)
      if (!other) continue
      const channels = walkNear ? values : other
      const weight = (walkNear ? other[0] : values[0])!
      if (weight === 0) continue
      for (let c = 0; c < scored.length; c++) totals[c] = totals[c]! + channels[c]! * weight
    }
  }

  for (let c = 0; c < scored.length; c++) {
    if (totals[c] !== 0) scores.set(scored[c]!, totals[c]!)
  }
  return scores
}

/**
 * The same fetch, asked in batches.
 *
 * A fact about the seam rather than about the traversal, and it is here because getting it
 * wrong is invisible until the frontier is large: `NeuPrintSource.fetchConnectivity` inlines its
 * id list into the Cypher literal and — unlike `fetchSynapseTotals`, which chunks — has no
 * batching of its own, because every caller before this one asked about neurons somebody had
 * named. A propagation asks about neurons it *found*, which past the first hop is thousands.
 *
 * Serial, not concurrent, for `fetchSynapseTotals`' stated reason: these are aggregates over a
 * shared production database and the node has already said what it is doing.
 *
 * `FRONTIER_BATCH` is `SYNAPSE_TOTALS_BATCH`'s number — measured on male-cns as the point where
 * the response curve is still flat — and lives here beside the rationale rather than on the node,
 * since a constant and the paragraph explaining it in two files are two files nobody edits
 * together.
 */
export const FRONTIER_BATCH = 5_000

export function batched(fetch: InfluenceFetch, size: number = FRONTIER_BATCH): InfluenceFetch {
  if (!(size > 0)) return fetch
  return async (neuronIds, direction) => {
    if (neuronIds.length <= size) return fetch(neuronIds, direction)
    const parts: TableValue[] = []
    for (let at = 0; at < neuronIds.length; at += size) {
      parts.push(await fetch(neuronIds.slice(at, at + size), direction))
    }
    return concatBatches(parts)
  }
}

/**
 * Batches of one query's results, end to end.
 *
 * Deliberately not `stackTables`: that reconciles two schemas and refuses on a dtype conflict,
 * which is the right thing for two tables a user wired together and pure overhead for *n* answers
 * to one question, all built by the same source from the same schema. Folding it pairwise would
 * also be quadratic in the batch count.
 */
function concatBatches(parts: readonly TableValue[]): TableValue {
  const first = parts[0]
  if (!first) throw new Error('concatBatches: nothing to concatenate')
  if (parts.length === 1) return first
  let total = 0
  for (const part of parts) total += part.length
  const data: Record<string, ColumnData> = {}
  for (const col of first.schema.columns) {
    const out: ColumnData = new Array(total).fill(null)
    let at = 0
    for (const part of parts) {
      const from = part.data[col.name]
      if (from) for (let i = 0; i < part.length; i++) out[at + i] = from[i] ?? null
      at += part.length
    }
    data[col.name] = out
  }
  return makeTable(first.schema, data, first.kind)
}

/**
 * The id cells and types two halves saw, merged.
 *
 * Beside `combineHalves` rather than in the node, because the rules are about a
 * `PropagateResult` and belong wherever a field could be added to one: a cell is kept from
 * whichever half saw it first, and the first non-empty type wins — `readAdjacency`'s rule and
 * `endpointNeurons`' before it, since a result that disagrees with itself about a neuron's type
 * is not grounds to prefer whichever copy arrived last.
 *
 * **`firstHop` is deliberately not merged.** Under a split a neuron's hop count is its distance
 * from whichever end reached it, which is two different measurements in one column; the node
 * takes it from the single half when there is one and leaves it empty otherwise.
 */
export function mergeProvenance(halves: readonly PropagateResult[]): {
  cells: Map<NeuronId, CellValue>
  types: Map<NeuronId, string | null>
} {
  const cells = new Map<NeuronId, CellValue>()
  const types = new Map<NeuronId, string | null>()
  for (const half of halves) {
    for (const [id, cell] of half.cells) if (!cells.has(id)) cells.set(id, cell)
    for (const [id, type] of half.types) if (types.get(id) == null) types.set(id, type)
  }
  return { cells, types }
}

// ---------------------------------------------------------------------------
// What the answer does not contain
// ---------------------------------------------------------------------------

/**
 * A ceiling on everything the unwalked hops could have added, or null when there is none.
 *
   * Travelling `inputs` a post's input fractions sum to at most one, so no hop can carry more
 * mass than the one before it and the tail is bounded by `m_H g / (1 - g)`. Travelling
 * `outputs` there is no such bound — a neuron's outgoing input-fractions sum to whatever they
 * sum to — so this is null and the caller has to say "unknown" rather than a number.
 *
 * Null also at a gain of 1 or more, where the series does not converge and the honest answer
 * to "how much is missing" is "as much as you like".
 */
export function truncation(result: PropagateResult): number | null {
  const { gain, direction } = result
  if (direction === 'outputs' || !(gain > 0 && gain < 1)) return null
  const last = result.terms[result.terms.length - 1]
  const lastTermMass = last ? spreadMass(last) : 0
  return (lastTermMass * gain) / (1 - gain)
}

/**
 * The reference implementation's `adjust_influence`, one value at a time.
 *
 * `sign(x) * (log(max(|x|, exp(-c))) + c)`. Raw scores span many orders of magnitude, so this is
 * what the package plots and what a heatmap of these wants; the floor is what keeps a neuron
 * that received nothing from becoming `-Infinity` and taking a colour scale with it.
 *
 * The sign handling is kept even though nothing here produces a negative score, because the one
 * thing that would — signing edges by neurotransmitter — is a deliberate omission rather than an
 * impossibility, and a transform that quietly assumed positivity would have to be found again.
 */
export function adjustInfluence(value: number): number {
  if (!Number.isFinite(value)) return 0
  const sign = Math.sign(value)
  if (sign === 0) return 0
  const magnitude = Math.max(Math.abs(value), Math.exp(-ADJUST_CONST))
  return sign * (Math.log(magnitude) + ADJUST_CONST)
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * The output schema: the dataset's own id and type columns, then the score.
 *
 * `endpointSchema` rather than a literal, so `neuronId` is carried over **whole** from the
 * source's connectivity schema — dtype and unit included. A CAVE root id is `str` there and has
 * to be `str` here; declaring `i64` over cells that are text on half the backends is invariant
 * 8's failure mode one layer up from the `Number()` it usually names.
 */
export function influenceSchema(sourceConnectivity: TableSchema | undefined): TableSchema {
  return tableSchema(
    ...endpointSchema(sourceConnectivity).columns,
    column(INFLUENCE_COLUMN, 'f64'),
    column(INFLUENCE_LOG_COLUMN, 'f64'),
    column(HOPS_COLUMN, 'i64'),
    column(SEED_COLUMN, 'bool'),
  )
}

/**
 * The per-query shape: the same score before it is summed over the neurons somebody wired in.
 *
 * `queryId`/`queryType` name the neuron on the **Neurons** port and `neuronId`/`type` the neuron
 * that influenced it — the same two names the totals table uses for that end, deliberately, so a
 * column picker configured against one port still resolves against the other.
 *
 * Direction-neutral names rather than `preId`/`postId`, because which end is presynaptic flips
 * with `Direction`: travelling upstream the influencer is presynaptic and travelling downstream
 * it is not. `Connectivity` can use the synapse's own words because a connection has a direction;
 * an influence has a *subject*, and that is what these name.
 */
export function influencePairsSchema(sourceConnectivity: TableSchema | undefined): TableSchema {
  const [id, type] = endpointSchema(sourceConnectivity).columns
  return tableSchema(
    { ...id!, name: QUERY_ID_COLUMN },
    { ...type!, name: QUERY_TYPE_COLUMN },
    id!,
    type!,
    column(INFLUENCE_COLUMN, 'f64'),
    column(INFLUENCE_LOG_COLUMN, 'f64'),
    column(HOPS_COLUMN, 'i64'),
    column(SEED_COLUMN, 'bool'),
  )
}

export interface InfluencePairsOptions {
  /** The walk's accumulated spread, one channel per query neuron. */
  total: Spread
  /** The query neurons, in channel order — `propagate`'s `seeds` with `perSeedChannels` on. */
  queries: readonly NeuronId[]
  schema: TableSchema
  cells: Map<NeuronId, CellValue>
  types: Map<NeuronId, string | null>
  firstHop: Map<NeuronId, number>
  /** Report only these influencers. Absent keeps every neuron the walk reached. */
  keep?: Set<NeuronId>
}

/**
 * One row per (query neuron, influencer) pair that carries anything.
 *
 * The totals port is this table summed over `queryId`, which is a property worth having rather
 * than a coincidence: both are read off the same channelled walk, so a `Pivot` of this and the
 * ranking beside it cannot disagree about a number.
 *
 * **A pair carrying nothing is not a row.** A dense |queries| x |reached| table is mostly zeroes
 * — a neuron four hops from one query is usually unreachable from most of the others — and a
 * zero here means "no path found within the budget", which a heatmap should draw as absent
 * rather than as a measured zero. `Pivot` fills the gaps at the point somebody asks for a grid.
 *
 * Ordered by query, then by score. A stable order matters here for the same reason it does in
 * the totals table: a run that reshuffles makes every downstream diff unreadable.
 */
export function influencePairs(opts: InfluencePairsOptions): TableValue {
  const rows: Array<{ query: number; id: NeuronId; score: number }> = []
  for (const [id, values] of opts.total) {
    if (opts.keep && !opts.keep.has(id)) continue
    for (let q = 0; q < values.length; q++) {
      const score = values[q]!
      if (score > 0) rows.push({ query: q, id, score })
    }
  }
  rows.sort((a, b) => a.query - b.query || b.score - a.score || compareIds(a.id, b.id))

  const columns = opts.schema.columns
  const data: Record<string, ColumnData> = {}
  for (const col of columns) data[col.name] = []
  const queryIds = data[QUERY_ID_COLUMN]!
  const queryTypes = data[QUERY_TYPE_COLUMN]!
  const ids = data[ID_COLUMN_NAME]!
  const types = data[columns[3]!.name]!
  const scores = data[INFLUENCE_COLUMN]!
  const adjusted = data[INFLUENCE_LOG_COLUMN]!
  const hops = data[HOPS_COLUMN]!
  const isSeed = data[SEED_COLUMN]!
  const queried = new Set(opts.queries)

  for (const row of rows) {
    const query = opts.queries[row.query]!
    // Cells as they arrived, never rebuilt from a key — invariant 8. A query neuron the walk
    // never saw on an edge has no fetched cell, and its key is the text it was asked about.
    queryIds.push(opts.cells.get(query) ?? query)
    queryTypes.push(opts.types.get(query) ?? null)
    ids.push(opts.cells.get(row.id) ?? row.id)
    types.push(opts.types.get(row.id) ?? null)
    scores.push(row.score)
    adjusted.push(adjustInfluence(row.score))
    hops.push(opts.firstHop.get(row.id) ?? null)
    isSeed.push(queried.has(row.id))
  }
  return makeTable(opts.schema, data)
}

export interface InfluenceTableOptions {
  scores: Map<NeuronId, number>
  schema: TableSchema
  cells: Map<NeuronId, CellValue>
  types: Map<NeuronId, string | null>
  firstHop: Map<NeuronId, number>
  seeds: Iterable<NeuronId>
  /** Drop rows at or below this. 0 keeps everything that received anything at all. */
  floor?: number
}

/**
 * One row per neuron that received anything, strongest first.
 *
 * A `neurons` table rather than a plain one, which is the whole reason the score is not simply
 * appended to an edge list: the top twenty influencers of a set are exactly what somebody wants
 * to hand straight to Skeletons, Adjacency or another Connectivity, and only a `Neurons` value
 * fits those ports.
 *
 * Seeds are kept, flagged rather than filtered. Their score is at least their own seed mass —
 * the `k = 0` term — plus whatever came back to them round a loop, and that second part is a
 * real measurement about recurrence which a table that dropped them could not report. The
 * reference implementation keeps them too, under `is_seed`.
 */
export function influenceTable(opts: InfluenceTableOptions): TableValue {
  const floor = opts.floor ?? 0
  const seeds = new Set(opts.seeds)
  const rows = [...opts.scores.entries()].filter(([, score]) => score > floor)
  rows.sort(([idA, a], [idB, b]) => b - a || compareIds(idA, idB))

  const ids: ColumnData = []
  const types: ColumnData = []
  const scores: ColumnData = []
  const adjusted: ColumnData = []
  const hops: ColumnData = []
  const isSeed: ColumnData = []

  for (const [id, score] of rows) {
    // The cell as it arrived, never rebuilt from the key — invariant 8. A seed that was never
    // reached by an edge has no fetched cell, and its key is the text it was asked about, which
    // is the one case where the key *is* the cell.
    ids.push(opts.cells.get(id) ?? id)
    types.push(opts.types.get(id) ?? null)
    scores.push(score)
    adjusted.push(adjustInfluence(score))
    hops.push(opts.firstHop.get(id) ?? null)
    isSeed.push(seeds.has(id))
  }

  const idName = opts.schema.columns[0]!.name
  const typeName = opts.schema.columns[1]!.name
  return makeTable(
    opts.schema,
    {
      [idName]: ids,
      [typeName]: types,
      [INFLUENCE_COLUMN]: scores,
      [INFLUENCE_LOG_COLUMN]: adjusted,
      [HOPS_COLUMN]: hops,
      [SEED_COLUMN]: isSeed,
    },
    'neurons',
  )
}
