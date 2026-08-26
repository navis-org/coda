/**
 * The Zoo's two halves, and the seam between them.
 *
 * `publish.ts` writes an index entry and `format.ts` reads one, so the tests that matter are
 * the ones where a generator and a reader could quietly disagree — an index that validates in
 * CI and renders as nothing is the failure this whole arrangement is arranged against.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { emptyGraph, serializeGraph } from '../../core/graph'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { registerBuiltinSources } from '../builtins'
import { resetCache } from '../cache'
import '../../nodes'
import { ZOO_INDEX_VERSION, isRepoPath, parseZooIndex } from './format'
import { buildEntry, graphProblems, graphRequires, layoutDigest } from './publish'
import { loadZooGraph, loadZooIndex } from './source'

beforeAll(() => registerBuiltinSources({ mockLatencyMs: 0 }))

afterEach(() => {
  vi.unstubAllGlobals()
  resetCache()
})

/** A three-node chain on the synthetic optic lobe: dataset → find → table. */
function chain() {
  const graph = emptyGraph('Test')
  const types = ['dataset.mock.opticlobe', 'neuron.findNeurons', 'out.table']
  graph.nodes = types.map((type, i) => ({
    id: `n${i}`,
    type,
    position: { x: i * 400, y: 0 },
    params: defaultParams(requireNodeDef(type)),
  }))
  graph.edges = [
    { id: 'e0', source: 'n0', sourceHandle: 'dataset', target: 'n1', targetHandle: 'dataset' },
    { id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n2', targetHandle: 'in' },
  ]
  return graph
}

const META = {
  name: 'A test workflow',
  summary: 'Three nodes that do very little.',
  tags: ['Testing'],
  authors: [{ name: 'Someone', github: 'someone' }],
  requires: ['mock'],
}

function build(overrides: Partial<Parameters<typeof buildEntry>[0]> = {}) {
  return buildEntry({
    slug: 'a-test-workflow',
    meta: META,
    graphText: serializeGraph(chain()),
    graphPath: 'workflows/a-test-workflow/graph.coda.json',
    updatedAt: '2026-08-26T10:00:00Z',
    ...overrides,
  })
}

describe('the layout digest', () => {
  it('carries a node per node and an edge per wire, in graph order', () => {
    const digest = layoutDigest(chain())
    expect(digest.nodes).toEqual([
      [0, 0, 'dataset.mock.opticlobe'],
      [400, 0, 'neuron.findNeurons'],
      [800, 0, 'out.table'],
    ])
    expect(digest.edges).toEqual([
      [0, 1],
      [1, 2],
    ])
  })

  it('collapses two wires between the same pair into one line', () => {
    // Not a cycle and not a mistake — see the gotcha in CLAUDE.md. It is one line at card scale,
    // and the second copy is bytes in a file every visitor downloads.
    const graph = chain()
    graph.edges.push({
      id: 'e2',
      source: 'n0',
      sourceHandle: 'dataset',
      target: 'n1',
      targetHandle: 'dataset',
    })
    expect(layoutDigest(graph).edges).toEqual([
      [0, 1],
      [1, 2],
    ])
  })
})

describe('what a workflow requires', () => {
  it('reads the source off the dataset node rather than the node type', () => {
    expect(graphRequires(chain())).toEqual(['mock'])
  })

  it('is empty for a graph with no dataset node', () => {
    const graph = chain()
    graph.nodes = graph.nodes.slice(1)
    graph.edges = graph.edges.slice(1)
    expect(graphRequires(graph)).toEqual([])
  })
})

describe('validating a deposited graph', () => {
  it('accepts a clean one', () => {
    const { problems } = graphProblems(serializeGraph(chain()))
    expect(problems).toEqual([])
  })

  it('treats a dropped node type as an error, not a warning', () => {
    // In the app a load warning means "we saved what we could of your file". In a repository it
    // means the entry as committed is not the entry that will open, which is not shippable.
    const graph = chain()
    graph.nodes[1]!.type = 'core.thisNeverExisted'
    const { problems } = graphProblems(JSON.stringify(graph))
    expect(
      problems.some((p) => p.level === 'error' && p.message.includes('core.thisNeverExisted')),
    ).toBe(true)
  })

  it('warns about a param the node no longer declares', () => {
    // The drift detector. `deserializeGraph` keeps params verbatim, so this one survives a load
    // silently, does nothing, and leaves a workflow that looks configured and is not.
    const graph = chain()
    graph.nodes[1]!.params = { ...graph.nodes[1]!.params, renamedLastYear: 3 }
    const { problems } = graphProblems(JSON.stringify(graph))
    const drift = problems.find((p) => p.message.includes('renamedLastYear'))
    expect(drift?.level).toBe('warning')
  })

  it('refuses a graph with no nodes', () => {
    const { problems } = graphProblems(serializeGraph(emptyGraph()))
    expect(problems).toContainEqual({ level: 'error', message: 'the graph has no nodes' })
  })
})

describe('building an index entry', () => {
  it('derives what the contributor did not have to write', () => {
    const { entry } = build()
    expect(entry).toMatchObject({
      slug: 'a-test-workflow',
      name: 'A test workflow',
      requires: ['mock'],
      nodeCount: 3,
      // Lower-cased, so a chip row does not carry "Testing" and "testing" as two filters.
      tags: ['testing'],
    })
    expect(entry?.layout.nodes).toHaveLength(3)
  })

  it('fails when the declared requirements miss a source the graph uses', () => {
    const { entry, problems } = build({ meta: { ...META, requires: [] } })
    expect(entry).toBeUndefined()
    expect(
      problems.some((p) => p.level === 'error' && p.message.includes('missing mock')),
    ).toBe(true)
  })

  it('fails when they name a source no dataset node uses', () => {
    const { problems } = build({ meta: { ...META, requires: ['mock', 'neuprint'] } })
    expect(problems.some((p) => p.message.includes('neuprint'))).toBe(true)
  })

  it('refuses a summary too long for the one line a card gives it', () => {
    const { entry } = build({ meta: { ...META, summary: 'x'.repeat(200) } })
    expect(entry).toBeUndefined()
  })

  it('ships an entry with no tags, and says so', () => {
    const { entry, problems } = build({ meta: { ...META, tags: [] } })
    expect(entry).toBeDefined()
    expect(problems.every((p) => p.level === 'warning')).toBe(true)
  })
})

describe('reading an index', () => {
  const entry = () => build().entry!

  function index(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      version: ZOO_INDEX_VERSION,
      updatedAt: '2026-08-26T10:00:00Z',
      repo: 'navis-org/coda-zoo',
      ref: 'main',
      workflows: [entry()],
      ...overrides,
    })
  }

  it('round-trips what the generator wrote', () => {
    const { index: parsed, dropped } = parseZooIndex(index())
    expect(dropped).toEqual([])
    expect(parsed.workflows[0]).toEqual(entry())
  })

  it('drops one bad entry rather than the whole list', () => {
    // An entry is written by whoever opened the pull request. One contributor's mistake must not
    // be everybody's empty browser.
    const { index: parsed, dropped } = parseZooIndex(
      index({ workflows: [{ name: 'no slug' }, entry()] }),
    )
    expect(parsed.workflows).toHaveLength(1)
    expect(dropped).toEqual(['no slug'])
  })

  it('keeps the first of two entries sharing a slug', () => {
    const first = { ...entry(), name: 'First' }
    const second = { ...entry(), name: 'Second' }
    const { index: parsed, dropped } = parseZooIndex(index({ workflows: [first, second] }))
    expect(parsed.workflows.map((w) => w.name)).toEqual(['First'])
    expect(dropped).toHaveLength(1)
  })

  it('refuses an index from a newer format, naming the versions', () => {
    expect(() => parseZooIndex(index({ version: ZOO_INDEX_VERSION + 1 }))).toThrow(/this build/)
  })

  it('remaps edge indices when a layout node is dropped', () => {
    // Dropping a node shifts every index after it. An edge kept by its original index joins the
    // wrong two boxes — a picture that is wrong rather than missing.
    const broken = {
      ...entry(),
      layout: {
        nodes: [
          [0, 0, 'a'],
          ['x', 0, 'b'],
          [800, 0, 'c'],
        ],
        edges: [
          [0, 2],
          [1, 2],
        ],
      },
    }
    const { index: parsed } = parseZooIndex(index({ workflows: [broken] }))
    const layout = parsed.workflows[0]!.layout
    expect(layout.nodes).toHaveLength(2)
    // 0 → 0 and 2 → 1. The edge naming the dropped node goes with it.
    expect(layout.edges).toEqual([[0, 1]])
  })
})

describe('paths in an index', () => {
  it.each([
    ['workflows/a/graph.coda.json', true],
    ['index.json', true],
    ['../../etc/passwd', false],
    ['/etc/passwd', false],
    ['https://elsewhere.example/graph.json', false],
    ['//elsewhere.example/graph.json', false],
    ['workflows\\a\\graph.json', false],
  ])('%s → %s', (path, ok) => {
    expect(isRepoPath(path)).toBe(ok)
  })

  it('drops an entry whose graph path leaves the repository', () => {
    const escaped = { ...build().entry!, graph: '../../../etc/passwd' }
    const text = JSON.stringify({ version: 1, workflows: [escaped] })
    const { index: parsed, dropped } = parseZooIndex(text)
    expect(parsed.workflows).toEqual([])
    expect(dropped[0]).toContain('not repo-relative')
  })
})

describe('fetching', () => {
  function stub(handler: (url: string) => { ok: boolean; status?: number; body?: string }) {
    const calls: string[] = []
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      const { ok, status = ok ? 200 : 500, body = '' } = handler(url)
      return Promise.resolve({
        ok,
        status,
        statusText: '',
        text: () => Promise.resolve(body),
      } as Response)
    })
    return calls
  }

  const body = JSON.stringify({ version: 1, workflows: [build().entry!] })

  it('asks raw.githubusercontent for the index, and nothing else', async () => {
    const calls = stub(() => ({ ok: true, body }))
    const result = await loadZooIndex()
    expect(calls).toEqual([
      'https://raw.githubusercontent.com/navis-org/coda-zoo/main/index.json',
    ])
    expect(result.index.workflows).toHaveLength(1)
    expect(result.stale).toBe(false)
  })

  it('serves the cached copy without a second request', async () => {
    const calls = stub(() => ({ ok: true, body }))
    await loadZooIndex()
    await loadZooIndex()
    expect(calls).toHaveLength(1)
  })

  it('falls back to a cached copy when the network fails, and says it is stale', async () => {
    stub(() => ({ ok: true, body }))
    await loadZooIndex()

    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    // `force` skips the cache on the way in; the fallback is what puts it back.
    const result = await loadZooIndex({ force: true })
    expect(result.stale).toBe(true)
    expect(result.index.workflows).toHaveLength(1)
  })

  it('reports a failure with nothing in hand, naming both possible causes', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    await expect(loadZooIndex()).rejects.toThrow(/cross-origin/)
  })

  it('re-fetches a graph when the entry says it changed, not on a clock', async () => {
    const entry = build().entry!
    const calls = stub(() => ({ ok: true, body: '{}' }))
    await loadZooGraph(entry)
    await loadZooGraph(entry)
    expect(calls).toHaveLength(1)
    await loadZooGraph({ ...entry, updatedAt: '2026-09-01T00:00:00Z' })
    expect(calls).toHaveLength(2)
  })
})
