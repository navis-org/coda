/**
 * What a large viewer selection costs the editor, at the sizes an embedding of a whole connectome
 * produces — a lasso round a cluster of fish2's 129,325 neurons.
 *
 * A Scatter Plot's `selection` is a list of id strings in the node's params, so it is in the
 * document: in the autosave (`localStorage`, written to a shared key *and* a per-tab slot capped at
 * `MAX_SLOT_BYTES`), in every file and share link, and in the provenance key every graph edit
 * recomputes. This measures each of those, for a selection of `n` ids, against the same workflow
 * with none — so the number is the selection's own cost:
 *
 *  - **autosave**: `serializeGraph(…, { compact: true })`, exactly what `saveAutosave` writes — its
 *    length (UTF-16 units, what the quota meters) and the time to build it;
 *  - **load**: `deserializeGraph` of that string;
 *  - **share link**: `encodeShareFragment`, deflated;
 *  - **an unrelated edit**: what the store recomputes on every graph mutation — `inferGraph` and the
 *    scheduler's keys (`refreshStates`) — after a param changes on a *different* node, warm.
 *
 * Three id shapes: fish2's own ids (`--project <bigclust dir>` reads them from its meta; 9 digits),
 * CAVE root ids (18 digits, the long case), and qualified ids from two stacked connectomes
 * (`flywire:…`, `hemibrain:…`). Ids are taken in row order, as a lasso writes them.
 *
 *   pnpm probe:selection-scale [--project ~/Downloads/bigclust-projects/fish2-connectivity2]
 */

import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { join } from 'node:path'
import { homedir } from 'node:os'

import type { CodaGraph } from '../src/core/graph'
import {
  addEdge,
  addNode,
  deserializeGraph,
  emptyGraph,
  serializeGraph,
  setNodeParam,
  topoSort,
} from '../src/core/graph'
import { inferGraph } from '../src/core/inference'
import { registerBuiltinSources } from '../src/data/builtins'
import { encodeShareFragment } from '../src/data/share/fragment'
import '../src/nodes'
import { MAX_SLOT_BYTES } from '../src/store/persistence'
import { node } from '../src/test/graph'
import { sourcelessScheduler } from '../src/test/scheduler'
import { caveRootIds } from '../src/nodes/lib/__fixtures__/rng'

registerBuiltinSources({ mockLatencyMs: 0 })

const args = process.argv.slice(2)
const projectArg = args[args.indexOf('--project') + 1]
const project = args.includes('--project') ? projectArg?.replace(/^~/, homedir()) : undefined

async function fish2Ids(): Promise<string[] | undefined> {
  if (!project) return undefined
  const rows = await parquetReadObjects({
    file: await asyncBufferFromFile(join(project, 'meta.parquet')),
    columns: ['id'],
  })
  return rows.map((r) => String(r.id))
}

/** A workflow of ordinary size with one Scatter Plot holding `selection`. */
function workflow(selection: readonly string[]): CodaGraph {
  let g = emptyGraph('selection probe')
  g = addNode(g, node('data', 'neuron.dataset'))
  g = addNode(g, node('find', 'neuron.findNeurons'))
  g = addNode(g, node('scatter', 'out.scatter', { selection: [...selection], idColumn: 'neuronId' }))
  g = addNode(g, node('table', 'out.table'))
  g = addNode(g, node('filter', 'core.filterTable'))
  g = addEdge(g, { source: 'data', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'scatter', targetHandle: 'in' })
  g = addEdge(g, { source: 'scatter', sourceHandle: 'selected', target: 'filter', targetHandle: 'in' })
  g = addEdge(g, { source: 'filter', sourceHandle: 'out', target: 'table', targetHandle: 'in' })
  return g
}

function time<T>(fn: () => T, repeat = 1): { ms: number; value: T } {
  let value = fn()
  const t0 = performance.now()
  for (let i = 0; i < repeat; i++) value = fn()
  return { ms: (performance.now() - t0) / repeat, value }
}

async function measure(label: string, ids: readonly string[]) {
  const g = workflow(ids)
  const autosave = time(() => serializeGraph(g, { compact: true }), 5)
  const load = time(() => deserializeGraph(autosave.value), 5)
  const t0 = performance.now()
  const link = await encodeShareFragment(g)
  const linkMs = performance.now() - t0

  // An unrelated edit, warm: the selection array is the same object across edits, as it is when
  // `setNodeParam` spreads a params record it did not write.
  // `refreshStates` skips its key pass on an empty cache, so the keys are asked for directly —
  // `desiredKeys` is the pass every edit runs once anything has.
  const scheduler = sourcelessScheduler()
  const keysOf = (graph: CodaGraph) =>
    (
      scheduler as unknown as {
        desiredKeys(g: CodaGraph, i: unknown, o: readonly string[]): Map<string, string>
      }
    ).desiredKeys(graph, inferGraph(graph), topoSort(graph).order)
  let current = g
  keysOf(current)
  const edits: number[] = []
  for (let i = 0; i < 20; i++) {
    current = setNodeParam(current, 'filter', 'label', `edit ${i}`)
    const e0 = performance.now()
    keysOf(current)
    edits.push(performance.now() - e0)
  }
  edits.sort((a, b) => a - b)
  return {
    label,
    autosaveChars: autosave.value.length,
    autosaveMs: autosave.ms,
    loadMs: load.ms,
    linkChars: link.length,
    linkMs,
    editMs: edits[Math.floor(edits.length / 2)]!,
  }
}

const kb = (chars: number) => `${(chars / 1024).toFixed(0)} kB`
const real = await fish2Ids()
const shapes: [string, (n: number) => string[]][] = [
  ['CAVE root ids', caveRootIds],
  // Two connectomes stacked, as a comparative workflow qualifies them, alternating as a table sorted
  // by type puts them: the shuffled CAVE ids above, and hemibrain-shaped ten-digit ones.
  [
    'qualified ids',
    (n) =>
      caveRootIds(n).map((id, i) =>
        i % 2 ? `hemibrain:${1_000_000_000 + i * 37}` : `flywire:${id}`,
      ),
  ],
]

// `slice` past the end is the whole list, so the last row is all of fish2 whatever its size.
if (real) shapes.unshift(['fish2 ids', (n) => real.slice(0, n)])

console.error(
  '\nselection                     autosave        (ms) | load (ms) | share link       (ms) | unrelated edit (ms)',
)
const base = await measure('none', [])
const line = (r: Awaited<ReturnType<typeof measure>>) =>
  console.error(
    `${r.label.padEnd(28)} ${kb(r.autosaveChars).padStart(8)} ${r.autosaveMs.toFixed(1).padStart(9)} | ` +
      `${r.loadMs.toFixed(1).padStart(9)} | ${kb(r.linkChars).padStart(8)} ${r.linkMs.toFixed(1).padStart(9)} | ` +
      `${r.editMs.toFixed(2).padStart(10)}` +
      (r.autosaveChars > MAX_SLOT_BYTES ? '   <- autosave over the slot' : ''),
  )
line(base)
for (const [name, make] of shapes) {
  for (const n of [10_000, 50_000, 129_325]) {
    const ids = make(n)
    line(await measure(`${ids.length.toLocaleString()} ${name}`, ids))
  }
}
console.error(
  `\nThe autosave is written twice — a shared key and this tab's slot, the slot capped at ` +
    `${(MAX_SLOT_BYTES / 1e6).toFixed(0)}M characters — against a localStorage budget of about 5M per origin.\n`,
)
