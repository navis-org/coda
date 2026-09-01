/**
 * Coda's own answers for one graph, written out for the two exporter probes to compare against.
 *
 *     pnpm probe:netexport
 *
 * The first third of a three-language check. `src/export/python/emitters/analysis.ts` and its R
 * twin claim that a notebook exported from `net.metrics` / `net.centrality` reproduces the card
 * — and nothing in `pnpm test` executes a line of either helper, because the goldens check the
 * emitted *text* and `check-export.py` checks that the names it calls exist. Text that parses
 * and resolves is not text that agrees.
 *
 * It earned that immediately. The first run of the Python helper disagreed with the canvas on
 * two numbers, both because networkx and Coda part company over self-loops:
 * `overall_reciprocity` divides by every edge including the loops, and `eigenvector_centrality`
 * keeps them — so one heavy autapse became an eigenvector of its own, scoring 1.0 while every
 * real hub in the graph rounded to zero. Reading the emitter did not catch either; running it
 * did, on the first graph it was given.
 *
 * Hence the shape of the graph below: a self-loop, an isolated node, reciprocal pairs, two
 * components and weights over two orders of magnitude. What it deliberately does **not** have is
 * parallel links — the notebook's graph comes out of `from_pandas_edgelist` over grouped links
 * and cannot hold them, so a probe graph with parallels would be comparing two different graphs
 * and calling the difference a bug.
 */

import { writeFileSync } from 'node:fs'

import { column, tableSchema } from '../src/core/types'
import type { NetworkValue } from '../src/core/values'
import { tableFromRows } from '../src/core/values'
import { networkMetrics } from '../src/nodes/lib/networkMetrics'
import type { CentralityOptions } from '../src/nodes/lib/networkCentrality'
import { CENTRALITY_DEFAULTS, networkCentrality } from '../src/nodes/lib/networkCentrality'

const OUT = process.argv[2] ?? '/tmp/coda-network-probe.json'

/**
 * The options the probe runs under, and each is chosen to exercise a branch.
 *
 * `weighted` because the unweighted path is a BFS in every implementation and the weighted one
 * is three different shortest-path routines that have to agree on what `1/weight` means.
 * `eigenvector` because it defaults off, so nothing else would ever run it. `samples: 0` because
 * a sampled sweep is the one setting where the three deliberately disagree — igraph has no pivot
 * sampling at all — and the emitters say so in a `NOTE` rather than pretending otherwise.
 */
const OPTIONS: CentralityOptions = {
  ...CENTRALITY_DEFAULTS,
  eigenvector: true,
  weighted: true,
  samples: 0,
  seed: 7,
}

const NODE_SCHEMA = tableSchema(column('id', 'str'))
const EDGE_SCHEMA = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64'),
)

/** A seeded LCG, so the graph is the same one on every machine and in every language. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function build(): { ids: string[]; links: Array<[string, string, number]> } {
  const rand = lcg(20260901)
  const ids: string[] = []
  for (let i = 0; i < 40; i++) ids.push(`n${i}`)

  const seen = new Set<string>()
  const links: Array<[string, string, number]> = []
  const link = (a: number, b: number) => {
    const key = `${a}>${b}`
    if (a === b || seen.has(key)) return
    seen.add(key)
    links.push([ids[a]!, ids[b]!, Math.floor(rand() * 200) + 1])
  }

  // Two components: everything below 28 in one, 28..37 in another, 38 and 39 left bare.
  for (let i = 1; i < 28; i++) link(Math.floor(rand() * i), i)
  for (let i = 29; i < 38; i++) link(28 + Math.floor(rand() * (i - 28)), i)
  for (let i = 0; i < 90; i++) link(Math.floor(rand() * 28), Math.floor(rand() * 28))
  for (let i = 0; i < 20; i++) link(28 + Math.floor(rand() * 10), 28 + Math.floor(rand() * 10))
  // Reciprocal pairs, so `reciprocity` is measuring something.
  for (const [a, b] of [
    [1, 2],
    [3, 4],
    [30, 31],
  ] as const) {
    link(a, b)
    link(b, a)
  }
  // The autapse — heavy, so a measure that fails to drop it fails loudly rather than subtly.
  seen.add('5>5')
  links.push([ids[5]!, ids[5]!, 400])
  return { ids, links }
}

function columns(table: {
  schema: { columns: Array<{ name: string }> }
  data: Record<string, unknown[]>
}): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const col of table.schema.columns) out[col.name] = table.data[col.name]!
  return out
}

async function main(): Promise<void> {
  const { ids, links } = build()
  const network: NetworkValue = {
    kind: 'network',
    directed: true,
    nodes: tableFromRows(
      NODE_SCHEMA,
      ids.map((id) => ({ id })),
    ),
    edges: tableFromRows(
      EDGE_SCHEMA,
      links.map(([source, target, weight]) => ({ source, target, weight })),
    ),
  }

  const metrics = networkMetrics(network)
  const centrality = await networkCentrality(network, OPTIONS)

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        note: 'Generated by scripts/probe-network-export.ts — Coda’s own answers, for the exporter probes.',
        directed: true,
        options: OPTIONS,
        nodes: ids,
        links,
        metrics: {
          nodes: columns(metrics.nodeStats),
          summary: columns(metrics.summary),
        },
        centrality: {
          nodes: columns(centrality.nodeStats),
          summary: columns(centrality.summary),
        },
      },
      null,
      1,
    )}\n`,
  )
  // `console.error`, as `zoo-index.ts` does: this is a maintenance script whose output is
  // progress rather than data, and the lint rule here allows `warn` and `error` only.
  console.error(`wrote ${OUT}`)
  console.error(`  ${ids.length} nodes, ${links.length} links, options: ${JSON.stringify(OPTIONS)}`)
}

await main()
