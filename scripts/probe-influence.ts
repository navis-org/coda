/**
 * Coda's bounded influence, over the reference implementation's own test connectome.
 *
 *     pnpm probe:influence
 *
 * The first half of a two-language check. `influenceOps.test.ts` proves the traversal is
 * internally consistent — mass conserved, both directions agreeing, the meet-in-the-middle
 * reproducing the single pass — but every one of those assertions is Coda checked against Coda.
 * None of them would notice if the whole family of numbers were the wrong metric.
 *
 * So this runs `propagate` over `InfluenceCalculator`'s shipped C. elegans edge list and writes
 * the scores out; `probe-influence.py` builds the same W in numpy, takes the **exact**
 * `(I - gW)^-1 s` that the package solves for, and checks four things a partial sum of a
 * convergent series has to satisfy: it never exceeds the exact answer, it rises monotonically
 * with the hop budget, it converges to the exact answer, and the truncation bound this reports
 * actually contains the gap it claims to.
 *
 * The fetch is the CSV, not a source. There is no network here and no dataset — this is a claim
 * about arithmetic, and mixing a backend into it would make a failure unattributable.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseDelimited } from '../src/data/csv'
import { column, tableSchema } from '../src/core/types'
import type { TableValue } from '../src/core/values'
import { getColumn, tableFromRows } from '../src/core/values'
import type { NeuronId } from '../src/core/ids'
import type { ConnectionDirection } from '../src/data/source'
import { summedVector, combineHalves, propagate, splitHops, truncation } from '../src/nodes/lib/influenceOps'

const OUT = process.argv[2] ?? '/tmp/coda-influence-probe.json'
const CSV = fileURLToPath(new URL('./fixtures/celegans_edgelist.csv', import.meta.url))

/**
 * `str` ids, because the fixture's are cell names.
 *
 * Deliberately the same five columns `CANONICAL_SCHEMAS.connectivity` declares: the probe has to
 * feed `propagate` the shape a real `fetchConnectivity` returns, or it is exercising a code path
 * the app does not have.
 */
const SCHEMA = tableSchema(
  column('neuronId', 'str'),
  column('neuronType', 'str'),
  column('partnerId', 'str'),
  column('partnerType', 'str'),
  column('weight', 'i64', 'synapses'),
)

interface Edge {
  pre: string
  post: string
  count: number
}

/** `parseDelimited` rather than a split on commas — the repo already has one CSV reader. */
function readEdges(): Edge[] {
  const { table } = parseDelimited(readFileSync(CSV, 'utf8'))
  const pre = getColumn(table, 'pre')
  const post = getColumn(table, 'post')
  const count = getColumn(table, 'count')
  const out: Edge[] = []
  for (let i = 0; i < table.length; i++) {
    out.push({ pre: String(pre[i]), post: String(post[i]), count: Number(count[i]) })
  }
  return out
}

const edges = readEdges()

/** Every neuron, in a stable order, so the two languages index the same way. */
const neurons = [...new Set(edges.flatMap((e) => [e.pre, e.post]))].sort()

const byPost = new Map<string, Edge[]>()
const byPre = new Map<string, Edge[]>()
for (const edge of edges) {
  const p = byPost.get(edge.post)
  if (p) p.push(edge)
  else byPost.set(edge.post, [edge])
  const q = byPre.get(edge.pre)
  if (q) q.push(edge)
  else byPre.set(edge.pre, [edge])
}

/** Input totals over the whole edge list — what an `outputs` walk cannot sum for itself. */
const inputTotals = new Map<string, number>()
for (const [post, list] of byPost) {
  inputTotals.set(
    post,
    list.reduce((sum, e) => sum + e.count, 0),
  )
}

let fetchCalls = 0
const fetch = async (
  neuronIds: NeuronId[],
  direction: ConnectionDirection,
): Promise<TableValue> => {
  fetchCalls += 1
  const rows = neuronIds.flatMap((id) =>
    (direction === 'inputs' ? (byPost.get(id) ?? []) : (byPre.get(id) ?? [])).map((edge) => {
      const near = direction === 'inputs' ? edge.post : edge.pre
      const far = direction === 'inputs' ? edge.pre : edge.post
      return {
        neuronId: near,
        neuronType: null,
        partnerId: far,
        partnerType: null,
        weight: edge.count,
      }
    }),
  )
  return tableFromRows(SCHEMA, rows)
}

const denominators = async (ids: NeuronId[]) => {
  const out = new Map<NeuronId, number>()
  for (const id of ids) {
    const value = inputTotals.get(id)
    if (value !== undefined) out.set(id, value)
  }
  return out
}

/*
 * The seed, and the gains this sweeps.
 *
 * `AVAL` and `AVAR` are the command interneurons for backward locomotion — a real recurrent hub
 * rather than a leaf, which is what makes the truncation question interesting: on a chain the
 * partial sum would reach the exact answer at the chain's length and prove nothing about a tail.
 *
 * The gain is swept rather than fixed because **the reference implementation's default is the
 * wrong default for a bounded traversal, and the sweep is what says so.** At `lambda_max = 0.99`
 * the series has a time constant of `1 / (1 - g)` = a hundred hops, and the package's own
 * docstring says that setting amplifies the leading eigenmode a hundredfold — an eigenmode which
 * is a property of the whole connectome and not of anybody's seed. So four hops at 0.99 is five
 * per cent of a quantity whose bulk is the part a ball cannot see. `probe-influence.py` turns
 * this sweep into the table the node's default is read off.
 */
const SEEDS = ['AVAL', 'AVAR']
/** The gain the correctness properties are checked at: the package default, i.e. the hardest. */
const GAIN = 0.99
const HOPS = [1, 2, 3, 4, 6, 8, 12, 20, 40]
const SWEEP_GAINS = [0.5, 0.75, 0.9, 0.95, 0.99]
const SWEEP_HOPS = [2, 3, 4, 6]

async function main() {
  const backward: Record<string, Record<string, number>> = {}
  const bounds: Record<string, number | null> = {}

  for (const hops of HOPS) {
    const result = await propagate({
      seeds: SEEDS,
      direction: 'inputs',
      hops,
      gain: GAIN,
      fetch,
      denominators,
    })
    backward[String(hops)] = Object.fromEntries(summedVector(result.total))
    bounds[String(hops)] = truncation(result)
  }

  /*
   * The forward walk from one neuron, read at the seeds — the same number the backward walk
   * reports for that neuron, by the transpose identity. Run here as well as in the unit tests
   * because the unit fixture has six edges and this one has 3,539: an off-by-one in the
   * denominator lookup survives a graph small enough to have no ambiguity about who is post.
   */
  const forwardOf = 'ASHL'
  const forward = await propagate({
    seeds: [forwardOf],
    direction: 'outputs',
    hops: 8,
    gain: GAIN,
    fetch,
    denominators,
  })
  const forwardVector = summedVector(forward.total)
  const forwardScore = SEEDS.reduce((sum, seed) => sum + (forwardVector.get(seed) ?? 0), 0)

  /*
   * And the meet-in-the-middle at the same total depth, against the single backward pass at that
   * depth. `splitHops` picks the division; the sources here are a handful of sensory neurons, so
   * it should send the deeper half forward.
   */
  const sources = ['ASHL', 'ASHR', 'AWAL', 'AWAR', 'ASKL', 'ASKR']
  const split = splitHops(6, sources.length, SEEDS.length, true)
  const forwardHalf = await propagate({
    seeds: sources,
    perSeedChannels: true,
    direction: 'outputs',
    hops: split.forward,
    gain: GAIN,
    fetch,
    denominators,
  })
  const backwardHalf = await propagate({
    seeds: SEEDS,
    direction: 'inputs',
    hops: split.backward,
    gain: GAIN,
    fetch,
    denominators,
  })
  const combined = Object.fromEntries(combineHalves(forwardHalf, backwardHalf, sources))

  /*
   * The sweep. Same walk, every (gain, hops) pair, so the Python half can put the cost of
   * truncation next to the cost of the gain and read a default off the table rather than
   * off an argument.
   */
  const sweep: Record<string, Record<string, Record<string, number>>> = {}
  for (const g of SWEEP_GAINS) {
    sweep[String(g)] = {}
    for (const hops of SWEEP_HOPS) {
      const result = await propagate({
        seeds: SEEDS,
        direction: 'inputs',
        hops,
        gain: g,
        fetch,
        denominators,
      })
      sweep[String(g)]![String(hops)] = Object.fromEntries(summedVector(result.total))
    }
  }

  /*
   * The per-query shape, over a small seed set. Emitted so `probe-influence.py` can run the
   * generated helper's other branch against it — the branch exists to feed a Heatmap, and a
   * channel indexed one place and read another is the mistake that would still draw a picture.
   */
  const perQuerySeeds = SEEDS
  const channelled = await propagate({
    seeds: perQuerySeeds,
    perSeedChannels: true,
    direction: 'inputs',
    hops: 3,
    gain: GAIN,
    fetch,
    denominators,
  })
  const perQuery: Record<string, number> = {}
  for (const [id, values] of channelled.total) {
    for (let q = 0; q < values.length; q++) {
      if (values[q]! > 0) perQuery[`${perQuerySeeds[q]}|${id}`] = values[q]!
    }
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        seeds: SEEDS,
        gain: GAIN,
        hops: HOPS,
        sweepGains: SWEEP_GAINS,
        sweepHops: SWEEP_HOPS,
        sweep,
        neurons,
        backward,
        bounds,
        forward: { of: forwardOf, hops: 8, score: forwardScore },
        bidirectional: { sources, hops: 6, split, scores: combined },
        perQuery: { seeds: perQuerySeeds, hops: 3, scores: perQuery },
        fetchCalls,
      },
      null,
      2,
    ),
  )
  // `console.error`, the convention `probe-network-export.ts` and `zoo-index.ts` follow: this
  // is progress rather than data, and the lint rule here allows `warn` and `error` only.
  console.error(`wrote ${OUT}`)
  console.error(
    `  ${neurons.length} neurons, ${edges.length} edges, ${fetchCalls} fetches`,
  )
}

void main()
