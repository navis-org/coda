/**
 * How much of the `localStorage` budget an autosave actually spends.
 *
 * Written because the claim being repeated — "a graph can be big, an Explore select-all is capped
 * at 10,000 ids" — was a comment in `library.ts` rather than a measurement, and the decision it is
 * used to settle needs one: whether the *set of open workflows* can live in `localStorage` beside
 * the single-slot autosave, or has to go to IndexedDB.
 *
 * `serializeGraph` is exactly what `saveAutosave` writes, so its output length is the charge — in
 * UTF-16 code units, which is both what `String.length` answers and what browsers meter the quota
 * in. The wizard's own workflows stand in for "an ordinary graph", because `demoWorkflow` is what
 * the tour's canvas and thirty test files already load. The Explore selection is measured at the
 * shape the widget actually writes: `neuron.explore`'s `selection` param, a list of id strings.
 *
 *   pnpm vite-node scripts/probe-autosave-budget.ts
 *
 * Prints through `console.error`, the convention `probe-network-export.ts` and `probe-influence.ts`
 * follow: this is a maintenance script whose output is for a reader, not a pipeline.
 */

import { emptyGraph, newId, serializeGraph } from '../src/core/graph'
import type { CodaGraph } from '../src/core/graph'
import { registerBuiltinSources } from '../src/data/builtins'
import '../src/nodes'
import { SELECT_ALL_WARN } from '../src/nodes/query/explore'
import type { AnalysisId } from '../src/wizard/options'
import { demoWorkflow } from '../src/wizard/build'

registerBuiltinSources({ mockLatencyMs: 0 })

/** From `persistence.ts`. Both bounds apply to the per-tab slots, not to the shared key. */
const MAX_SLOTS = 6
const MAX_SLOT_BYTES = 2_000_000

const ANALYSES: AnalysisId[] = [
  'partners',
  'matrix',
  'influence',
  'paths',
  'network',
  'cluster',
  'morphology',
  'nblast',
  'neurons',
]

const kb = (chars: number) => `${(chars / 1024).toFixed(1)} kB`

function row(label: string, chars: number): void {
  const byBytes = Math.floor(MAX_SLOT_BYTES / Math.max(chars, 1))
  const fit = Math.min(MAX_SLOTS, byBytes)
  console.error(
    `  ${label.padEnd(44)} ${String(chars).padStart(9)} chars  ${kb(chars).padStart(9)}` +
      `   slots that fit: ${fit}${fit === MAX_SLOTS ? ' (count-bound)' : ''}`,
  )
}

console.error('\n--- an ordinary workflow, as the wizard builds it -------------------------\n')
const ordinary: number[] = []
for (const id of ANALYSES) {
  try {
    const chars = serializeGraph(demoWorkflow(id)).length
    ordinary.push(chars)
    row(`demoWorkflow('${id}')`, chars)
  } catch (err) {
    console.error(`  demoWorkflow('${id}') — skipped: ${(err as Error).message}`)
  }
}
const median = ordinary.sort((a, b) => a - b)[Math.floor(ordinary.length / 2)] ?? 0

/**
 * A graph whose Explore node holds `n` selected ids, which is the one gesture that can put six
 * figures of them into a param — see `SELECT_ALL_WARN`.
 *
 * CAVE root ids, because they are the long ones: 18 digits against neuPrint's 9 to 11.
 */
function withSelection(n: number): CodaGraph {
  const ids = Array.from({ length: n }, (_, i) => String(864691128455000000n + BigInt(i)))
  const graph = emptyGraph('Explore selection')
  graph.nodes.push({
    id: newId('n'),
    type: 'neuron.explore',
    position: { x: 0, y: 0 },
    params: { selection: ids },
  })
  return graph
}

console.error('\n--- a graph carrying an Explore selection ---------------------------------\n')
const selections = [1_000, 10_000, SELECT_ALL_WARN, 100_000]
const bySize = new Map<number, number>()
for (const n of selections) {
  const chars = serializeGraph(withSelection(n)).length
  bySize.set(n, chars)
  const note = n === SELECT_ALL_WARN ? '  <- where select-all starts warning' : ''
  row(`${n.toLocaleString()} CAVE root ids in one param`, chars + 0)
  if (note) console.error(`  ${' '.repeat(44)}${note}`)
}

console.error('\n--- what the open set would cost, if it lived in localStorage -------------\n')
const worst = bySize.get(SELECT_ALL_WARN) ?? 0
console.error(
  `  median ordinary workflow: ${kb(median)}   |   at the select-all warning: ${kb(worst)}\n`,
)
for (const open of [3, 5, 10]) {
  console.error(
    `  ${String(open).padStart(2)} open: ${kb(open * median).padStart(9)} of ordinary work` +
      `   |   ${kb(open * worst).padStart(9)} if each carries a warned selection`,
  )
}
console.error(
  `\n  The slot budget is ${kb(MAX_SLOT_BYTES)} across ${MAX_SLOTS} slots, and the shared key` +
    `\n  holds one more copy of the active graph on top of that.\n`,
)

/*
 * Pretty-printed against compact.
 *
 * `saveAutosave` and `saveWorkflow` both call `serializeGraph` with no options, which is
 * `JSON.stringify(out, null, 2)`; only the share link asks for `compact`. The indentation is
 * worth reading in a file somebody opens, and worth nothing at all in a storage slot — this is
 * how much it costs where the budget is actually tight.
 */
console.error('\n--- what the indentation costs -------------------------------------------\n')
for (const [label, graph] of [
  ["demoWorkflow('network')", demoWorkflow('network')],
  ['25,000-id selection', withSelection(SELECT_ALL_WARN)],
] as const) {
  const pretty = serializeGraph(graph).length
  const compact = serializeGraph(graph, { compact: true }).length
  console.error(
    `  ${label.padEnd(28)} pretty ${kb(pretty).padStart(9)}   compact ${kb(compact).padStart(9)}` +
      `   saving ${(100 - (compact / pretty) * 100).toFixed(0)}%`,
  )
}
console.error('')
