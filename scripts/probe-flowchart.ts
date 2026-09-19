/**
 * Coda's flow-chart layering for a set of graphs, written out for the two exporter probes.
 *
 *     pnpm probe:flowchart
 *
 * The first third of a three-language check, on `probe-network-export.ts`' pattern and for its
 * reason: the goldens check the emitted *text* and `check-export.py` checks that what it calls
 * exists, but nothing in `pnpm test` executes a line of `coda_flow_layers`. Text that parses is
 * not text that agrees.
 *
 * What has to agree is the whole point of the node. A layering is *positions*, so a document
 * whose helper puts a box one column over from where the card put it has drawn a different
 * circuit, and nothing about the figure says so. The cycle pass is where that is most likely: a
 * connectome subgraph holds reciprocal pairs as a matter of course, and which half of a pair is
 * called feedback decides the layering of everything downstream of it.
 *
 * Hence the graphs below. Each is small enough to reason about and each exercises one thing the
 * obvious implementation gets wrong: a skip edge (which earliest-layering answers differently
 * from longest-path), a three-cycle, a reciprocal pair, an autapse, an isolated node, and a
 * column whose values are sparse and partly absent.
 *
 * ## What it found
 *
 * Both helpers agreed with the canvas on all six graphs on the first run. **Every bug was in the
 * dozen lines that draw**, which is why each language probe also lifts the emitted cell out of
 * its golden and executes it — four in the R cell, none of them visible from reading it:
 *
 *  - `extd_graph` carries **only `orig` and `arrow.mode`**; every attribute of the original
 *    edges is gone, so `E(.g)$weight` was `NULL` and the widths and arrow labels were silently
 *    absent. `orig` is the 1-based original edge index, and reading through it gives each piece
 *    of a split edge the original's value.
 *  - A split edge is three edges there, so labelling `E(.g)$label` printed the number **three
 *    times along one arrow**.
 *  - `sugi$layout` has a row per *real* vertex, so plotting `extd_graph` with it is
 *    `The layout has 4 rows, but the graph has 6 vertices`. The extended graph's own
 *    coordinates are `.g$layout`.
 *  - Sugiyama's layer axis runs **downwards**, so left-to-right needs the axes exchanged *and*
 *    the layer axis negated. Exchanging them alone drew the circuit right to left — a figure
 *    that looks perfectly plausible and is backwards.
 *
 * The gift in the same measurement: `arrow.mode` is already 0 on every piece of a split edge but
 * the last, so a routed arrow draws one head at its real target and the emitter must not touch it.
 */

import { writeFileSync } from 'node:fs'

import { column, tableSchema } from '../src/core/types'
import type { NetworkValue } from '../src/core/values'
import { tableFromRows } from '../src/core/values'
import { flowGraph } from '../src/nodes/lib/flowChartOps'

const OUT = process.argv[2] ?? '/tmp/coda-flowchart-probe.json'

const NODE_SCHEMA = tableSchema(column('id', 'str'), column('hops', 'i64'))
const EDGE_SCHEMA = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64'),
)

interface Case {
  name: string
  why: string
  nodes: Array<[string, number | null]>
  edges: Array<[string, string, number]>
  /** Set where the case is about the column arm rather than the longest-path one. */
  layerColumn?: string
}

const CASES: Case[] = [
  {
    name: 'chain',
    why: 'the base case, and the only one every implementation agrees on by accident',
    nodes: [
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ],
    edges: [
      ['a', 'b', 10],
      ['b', 'c', 20],
    ],
  },
  {
    name: 'skip',
    why: 'longest path puts c in layer 2; earliest layering puts it in 1 and reverses a->b->c',
    nodes: [
      ['a', null],
      ['b', null],
      ['c', null],
    ],
    edges: [
      ['a', 'c', 5],
      ['a', 'b', 6],
      ['b', 'c', 7],
    ],
  },
  {
    name: 'cycle',
    why: 'longest path over a graph with a cycle either hangs or depends on the start node',
    nodes: [
      ['a', null],
      ['b', null],
      ['c', null],
    ],
    edges: [
      ['a', 'b', 1],
      ['b', 'c', 2],
      ['c', 'a', 3],
    ],
  },
  {
    name: 'reciprocal',
    why: 'the ordinary connectome case: one half has to be called feedback and roots decide which',
    nodes: [
      ['a', null],
      ['b', null],
      ['c', null],
    ],
    edges: [
      ['a', 'b', 4],
      ['b', 'a', 5],
      ['b', 'c', 6],
    ],
  },
  {
    name: 'autapse-and-island',
    why: 'a self loop constrains nothing, and an unwired node is layer 0 rather than an error',
    nodes: [
      ['a', null],
      ['b', null],
      ['island', null],
    ],
    edges: [
      ['a', 'a', 9],
      ['a', 'b', 1],
    ],
  },
  {
    name: 'sparse-column',
    why: '0/2/5 renumber to three adjacent layers, and an absent value lands after every one',
    nodes: [
      ['a', 0],
      ['b', 2],
      ['c', 5],
      ['unknown', null],
    ],
    edges: [
      ['a', 'b', 1],
      ['b', 'c', 1],
    ],
    layerColumn: 'hops',
  },
]

function build(one: Case): NetworkValue {
  return {
    kind: 'network',
    directed: true,
    nodes: tableFromRows(
      NODE_SCHEMA,
      one.nodes.map(([id, hops]) => ({ id, hops })),
    ),
    edges: tableFromRows(
      EDGE_SCHEMA,
      one.edges.map(([source, target, weight]) => ({ source, target, weight })),
    ),
  }
}

const out = CASES.map((one) => {
  const graph = flowGraph(build(one), {
    ...(one.layerColumn ? { layerColumn: one.layerColumn } : {}),
  })
  return {
    name: one.name,
    nodes: one.nodes.map(([id]) => id),
    hops: Object.fromEntries(one.nodes),
    edges: one.edges,
    layerColumn: one.layerColumn ?? null,
    /** The answer the two helpers have to reproduce, keyed by node id. */
    layers: Object.fromEntries(graph.nodes.map((node) => [node.id, node.layer])),
    /** And the classification that falls out of it, so a feedback edge cannot move unnoticed. */
    kinds: Object.fromEntries(
      graph.edges.map((edge) => [`${edge.source}->${edge.target}`, edge.kind]),
    ),
  }
})

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`)
// `console.error`, as `probe-network-export.ts` and `zoo-index.ts` do: the `scripts/**` eslint
// block that lifts `no-console` covers `.js`/`.mjs` only, and this is diagnostic output rather
// than the script's product — which is the JSON file.
console.error(`Coda's layering for ${out.length} graphs -> ${OUT}`)
for (const one of out) {
  const layers = Object.entries(one.layers)
    .map(([id, layer]) => `${id}=${layer}`)
    .join(' ')
  const back = Object.entries(one.kinds)
    .filter(([, kind]) => kind !== 'forward')
    .map(([edge, kind]) => `${edge} ${kind}`)
  console.error(`  ${one.name.padEnd(20)} ${layers}${back.length ? `   [${back.join(', ')}]` : ''}`)
  console.error(`  ${' '.repeat(20)} ${CASES.find((c) => c.name === one.name)!.why}`)
}
