#!/usr/bin/env node
/**
 * Execute the real adapter and pinned packages in Pyodide (not a mocked Python call).
 *
 *   PYODIDE_PATH=/path/to/pyodide node scripts/probe-dotmotif.mjs
 *
 * The same package lists feed this probe and the browser runtime: `dotmotifPackages` by URL,
 * `dotmotifWheels` from `public/wheels/` (the browser resolves those against the site root).
 * Requests are encoded by the app's own `dotmotifHost`, imported as TypeScript — plain Node 26
 * strips its types — so the keys under test are the ones the node sends. What that encoding
 * refuses (empty, repeated and dangling ids, parallel links) is `dotmotifHost.test.ts`'s.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bootPyodide,
  loadModule,
  probeReport,
  readRepoFile,
  root,
  sources,
} from './lib/pyodideProbe.mjs'
import { dotmotifHost, matchColumns } from '../src/nodes/lib/dotmotifHost.ts'

const packages = [
  ...sources.dotmotifPackages,
  ...sources.dotmotifWheels.map((name) => join(root, 'public', 'wheels', name)),
]

async function load() {
  const py = await bootPyodide()
  await loadModule(py, 'src/pyodide/dotmotif.py', packages)
  return py
}

/** The request the node sends, from a network written as plain columns. */
function encode({ directed, nodes, edges, query, maxMatches, maxRoles = 1000 }) {
  const text = (cells) => cells.map((cell) => String(cell ?? ''))
  const { ids, ...keys } = dotmotifHost(
    text(nodes.id),
    text(edges.source),
    text(edges.target),
    directed,
  )
  return { request: { directed, query, maxMatches, maxRoles, ...keys, nodes, edges }, ids }
}

/** Every reply's `keys` crossed as an Int32Array; checked once, at the end. */
let keysTyped = true

async function main() {
  const { check, attempt, finish } = probeReport()
  const manifest = JSON.parse(readRepoFile('public/wheels/manifest.json'))
  check(
    'every served wheel is in the manifest, and nothing else is',
    JSON.stringify(Object.keys(manifest).sort()) ===
      JSON.stringify([...sources.dotmotifWheels].sort()),
  )
  check(
    'the served DotMotif wheel is the version sources.json names',
    sources.dotmotifWheels.includes(`dotmotif-${sources.dotmotifVersion}-py3-none-any.whl`),
  )
  for (const [filename, entry] of Object.entries(manifest)) {
    const bytes = readFileSync(join(root, 'public', 'wheels', filename))
    check(
      `${filename}: pinned artifact hash`,
      createHash('sha256').update(bytes).digest('hex') === entry.sha256,
    )
  }
  const py = await load()
  check(
    'only the four pure-Python dependencies load',
    JSON.stringify(Object.keys(py.loadedPackages).sort()) ===
      JSON.stringify(['dotmotif', 'grandiso', 'lark', 'networkx']),
  )
  // Fail this whole probe if a future refactor silently restores the slower
  // NetworkX search. GrandIso inherits constraint helpers, but not its find().
  py.runPython(`
from dotmotif.executors import NetworkXExecutor
def _forbid_networkx_search(*args, **kwargs):
    raise AssertionError("Coda must use GrandIso, not NetworkX search")
NetworkXExecutor.find = _forbid_networkx_search
assert _CodaGrandIsoExecutor.find is GrandIsoExecutor.find
`)
  check(
    'the adapter is pinned to the version sources.json names',
    py.globals.get('_DOTMOTIF_VERSION') === sources.dotmotifVersion,
  )
  const callable = py.globals.get('coda_dotmotif_run')
  const path = {
    directed: true,
    nodes: { id: ['1', '2', '3'], type: ['input', 'middle', 'output'], size: [1, 2, 3] },
    edges: { source: ['1', '2'], target: ['2', '3'], weight: [5, 2] },
    query: 'A -> B; B -> C',
    maxMatches: 100,
  }
  function call(fn, overrides) {
    const { request, ids } = encode({ ...path, ...overrides })
    let proxy
    try {
      proxy = fn(request, () => {})
      const reply = proxy.toJs({ dict_converter: Object.fromEntries })
      keysTyped &&= reply.keys instanceof Int32Array
      return { ...matchColumns(reply, ids), count: reply.count, ...(reply.refused && { refused: true }) }
    } finally {
      proxy?.destroy()
    }
  }
  const execute = (overrides = {}) => call(callable, overrides)
  function matches(label, overrides, expected) {
    const result = attempt(label, () => execute(overrides))
    if (result) check(`${label}: count`, result.count === expected)
    return result
  }
  function rejects(label, overrides, expected) {
    try {
      execute(overrides)
      check(`${label}: rejected`, false)
    } catch (error) {
      check(`${label}: actionable error`, String(error.message).includes(expected))
    }
  }

  const chain = matches('directed chain', {}, 1)
  check(
    'membership roles and IDs retain meaning',
    JSON.stringify(chain) ===
      JSON.stringify({
        matchId: [1, 1, 1],
        variable: ['A', 'B', 'C'],
        nodeId: ['1', '2', '3'],
        count: 1,
      }),
  )
  matches('edge threshold', { query: 'A -> B [weight >= 3]' }, 1)
  matches('node attributes', { query: 'A -> B; A.type = "input"' }, 1)
  matches(
    'original ID and endpoint attributes',
    { query: 'A -> B [source = "1"]; A.id = "1"' },
    1,
  )
  matches('named edge attributes', { query: 'A -> B as ab; ab.weight >= 3' }, 1)
  matches('dynamic node attributes', { query: 'A -> B; A.size < B.size' }, 2)
  matches('macros', { query: 'chain(a,b,c) { a -> b\n b -> c }; chain(A,B,C)' }, 1)
  matches('absent closing edge', { query: 'A -> B; B -> C; C !> A' }, 1)
  matches('absent reverse edge', { query: 'A -> B; B !> A' }, 2)
  matches(
    'default feed-forward triangle',
    {
      edges: { source: ['1', '2', '1'], target: ['2', '3', '3'] },
      query: 'A -> B; B -> C; A -> C',
    },
    1,
  )
  matches(
    'connected query on a disconnected host',
    {
      nodes: { id: ['1', '2', '3', '4', 'isolated'] },
      edges: { source: ['1', '3'], target: ['2', '4'] },
      query: 'A -> B',
    },
    2,
  )
  rejects('negative-only variables', { query: 'A !> B' }, 'connected by required edges')
  // Contradictions must be rejected, rather than reported as an empty set.
  rejects('contradictory topology', { query: 'A -> B; A !> B' }, 'conflict')
  matches('zero matches', { query: 'A -> B [weight > 100]' }, 0)
  matches(
    'extra host edges are allowed',
    {
      edges: { source: ['1', '2', '1'], target: ['2', '3', '3'] },
    },
    1,
  )
  matches(
    'negative edge excludes the same otherwise valid chain',
    {
      edges: { source: ['1', '2', '1'], target: ['2', '3', '3'] },
      query: 'A -> B; B -> C; A !> C',
    },
    0,
  )
  matches(
    'all roles distinct even if two nodes form a cycle',
    {
      nodes: { id: ['1', '2'] },
      edges: { source: ['1', '2'], target: ['2', '1'] },
    },
    0,
  )
  rejects('self-loop cannot be invented', { query: 'A -> A' }, 'Required self-loop')
  matches('negative self-loop', { query: 'A -> B; A !> A' }, 2)
  matches(
    'negative self-loop excludes a real loop',
    {
      edges: { source: ['1', '2', '1'], target: ['2', '3', '1'] },
      query: 'A -> B; A !> A',
    },
    1,
  )
  rejects(
    'disconnected positive components',
    {
      nodes: { id: ['1', '2', '3', '4'] },
      edges: { source: ['1', '3'], target: ['2', '4'] },
      query: 'A -> B; C -> D',
    },
    'connected by required edges',
  )
  matches('empty host', { nodes: { id: [] }, edges: { source: [], target: [] } }, 0)
  matches('undirected chain', { directed: false }, 2)
  matches(
    'undirected triangle',
    {
      directed: false,
      edges: { source: ['1', '2', '3'], target: ['2', '3', '1'] },
      query: 'A -> B; B -> C; C -> A',
    },
    6,
  )
  matches(
    'symmetric role assignments retained',
    {
      edges: { source: ['1', '2'], target: ['3', '3'] },
      query: 'A -> C; B -> C; A === B',
    },
    2,
  )

  const refused = matches('more roles than maxRoles is refused before the search', { maxRoles: 2 }, 0)
  check('a refusal says so', refused?.refused === true)
  const limited = matches('bounded prefix', { query: 'A -> B', maxMatches: 1 }, 1)
  check(
    'bounded directed prefix uses canonical host order',
    JSON.stringify(limited?.nodeId) === JSON.stringify(['1', '2']),
  )
  const reordered = matches(
    'reordered equivalent tables',
    {
      nodes: { id: ['3', '2', '1'] },
      edges: { source: ['2', '1'], target: ['3', '2'] },
      query: 'A -> B',
      maxMatches: 1,
    },
    1,
  )
  check(
    'bounded prefix is deterministic',
    JSON.stringify(limited) === JSON.stringify(reordered),
  )

  matches(
    'null and missing static attributes follow DotMotif None semantics',
    { query: 'A -> B; A.missing = None' },
    2,
  )
  matches(
    'missing attribute inequality follows DotMotif semantics',
    { query: 'A -> B; A.missing != "known"' },
    2,
  )
  matches(
    'null ordered comparisons are nonmatches',
    {
      nodes: { id: ['1', '2', '3'], size: [null, 2, 3] },
      query: 'A -> B; A.size < B.size',
    },
    1,
  )
  // The eval guard, seen from outside: under upstream's `eval`, `str` is the builtin type and
  // equals no cell. `dotmotif.py` also refuses to load at all if its patch did not take.
  matches(
    'bare Python builtin names remain text',
    {
      nodes: { id: ['1', '2', '3'], type: ['str', 'middle', 'output'] },
      query: 'A -> B; A.type = str',
    },
    1,
  )
  matches(
    'syntax inside strings and comments is not rejected',
    {
      nodes: { id: ['1', '2', '3'], label: ['A -+ B', '', ''] },
      query: 'A -> B; A.label = "A -+ B" # A -| B\n',
    },
    1,
  )
  matches(
    'arbitrary column names do not collide with NetworkX arguments',
    {
      nodes: { id: ['1', '2', '3'], node_for_adding: [1, 2, 3] },
      edges: { source: ['1', '2'], target: ['2', '3'], u_of_edge: [1, 2] },
      query: 'A -> B as edge; A["node_for_adding"] = 1; edge["u_of_edge"] = 1',
    },
    1,
  )
  matches(
    'macro quoted number remains a string',
    {
      nodes: { id: ['1', '2', '3'], x: ['1', 1, 2] },
      query: 'm(A,B) { A -> B\n A.x = "1" }; m(X,Y)',
    },
    1,
  )
  matches(
    'macro quoted boolean remains a string',
    {
      nodes: { id: ['1', '2', '3'], x: ['True', true, false] },
      query: 'm(A,B) { A -> B\n A.x = "True" }; m(X,Y)',
    },
    1,
  )

  rejects('empty query', { query: '' }, 'Enter a DotMotif query')
  rejects('comment-only query', { query: '# comment' }, 'Unexpected')
  rejects(
    'unknown static role',
    { query: 'A -> B; C.type = "x"' },
    'neither a node nor a named edge',
  )
  rejects('unknown dynamic role', { query: 'A -> B; A.size < C.size' }, 'has no motif edge')
  rejects('unknown symmetry role', { query: 'A -> B; C === D' }, 'must have a motif edge')
  rejects(
    'overlapping symmetry declarations cannot lose transitive constraints',
    { query: 'A -> B; B -> C; C -> D; A.x = 1; C.y = 2; A === B; C === D; B === C' },
    'Overlapping === groups',
  )
  rejects(
    'duplicate motif declarations cannot lose attributes',
    { query: 'A -> B; A -> B [weight > 99]' },
    'only once',
  )
  rejects('typed edges cannot silently ignore actions', { query: 'A -+ B' }, 'Typed edges')
  rejects(
    'negative edges cannot have constraints',
    { query: 'A -> B; B !> A [weight > 2]' },
    'Absent edges',
  )
  rejects(
    'dynamic edges cannot falsely compare missing values',
    { query: 'A -> B as x; B -> C as y; x.missing = y.missing' },
    'two edge attributes',
  )
  rejects(
    'dynamic macro references cannot bind external roles',
    { query: 'm(A,B) { A -> B\n A.x = B.x }; m(X,Y); Y -> B' },
    'Dynamic comparisons inside macros',
  )
  rejects(
    'nested macros cannot misbind constraint parameters',
    { query: 'm(A,B) { A -> B\n A.x = 1 }; n(A,B) { m(B,A) }; n(X,Y)' },
    'Nested macros',
  )
  rejects(
    'edge aliases cannot silently shadow',
    { query: 'A -> B as edge; B -> C as edge; edge.weight = 2' },
    'aliases must be unique',
  )
  rejects(
    'edge alias cannot be a node name',
    { query: 'A -> B as A; A.size = 1' },
    'aliases must not share',
  )
  rejects(
    'global edge aliases cannot capture macro node constraints',
    { query: 'A -> B as p; m(p,q) { p -> q\n p.x = 1 }; m(X,Y)' },
    "macro parameter's name",
  )
  rejects('nonfinite literal', { query: 'A -> B [weight = 1e1000]' }, 'finite numbers')

  py.FS.writeFile('/tmp/coda-dotmotif-query.dm', 'A -> B\n')
  rejects('a query never reads a file', { query: '/tmp/coda-dotmotif-query.dm' }, 'Unexpected')
  py.FS.unlink('/tmp/coda-dotmotif-query.dm')
  const n = 1000
  const started = performance.now()
  matches(
    '1000-node chain exact result',
    {
      nodes: { id: Array.from({ length: n }, (_, i) => String(i)) },
      edges: {
        source: Array.from({ length: n - 1 }, (_, i) => String(i)),
        target: Array.from({ length: n - 1 }, (_, i) => String(i + 1)),
      },
      maxMatches: n,
    },
    n - 2,
  )
  console.log(`1000-node chain      ${(performance.now() - started).toFixed(0)} ms`)
  callable.destroy()

  // A second CPython instance gets a fresh hash seed. A same-runtime rerun
  // misses the host-key string-set ordering bug this guards against.
  const fresh = await load()
  const freshCall = fresh.globals.get('coda_dotmotif_run')
  try {
    const again = attempt('fresh runtime', () => call(freshCall, { query: 'A -> B', maxMatches: 1 }))
    check(
      'bounded prefix survives a fresh Python runtime',
      JSON.stringify(again) === JSON.stringify(limited),
    )
  } finally {
    freshCall.destroy()
  }
  check('keys come back as an Int32Array', keysTyped)
  finish(py)
}

main().catch((error) => {
  console.error(String(error?.message ?? error))
  process.exitCode = 1
})
