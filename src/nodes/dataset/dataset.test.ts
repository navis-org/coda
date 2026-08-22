/**
 * The dataset nodes.
 *
 * These are the entry point of every graph, so the things checked here are the ones whose
 * failure would be invisible: that the version a node resolves is the version it queries, that a
 * pinned version survives, and that the legacy generic node still loads.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { inferGraph } from '../../core/inference'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { EnumOption, ParamValues } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { getNodeDef, requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { T, datasetRef } from '../../core/types'
import { isDatasetValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource, requireSource } from '../../data/source'
import { NeuPrintSource } from '../../data/neuprint/NeuPrintSource'
import { DEFAULT_SERVER } from '../../data/neuprint/servers'
import { resetDatastackRecords } from '../../data/cave/datastack'
import { DATASTACK_SPECS, specFor } from '../../data/cave/spec'
import { CaveSource } from '../../data/cave/CaveSource'
import { resetCredentials as resetCaveCredentials, setToken } from '../../data/cave/credentials'
import { peekRootCheck, resetRootChecks } from '../../data/cave/rootIds'
import { resetCache } from '../../data/cache'
import '../index'

beforeAll(async () => {
  await registerSource(new MockSource({ latencyMs: 0 })).listDatasets()
  // Registered but never listed: constructing one does no I/O, which is exactly the state every
  // neuPrint dataset node is in until a token exists and the first listing lands.
  registerSource(new NeuPrintSource())
})

function ctxFor(type: string, params: ParamValues = {}) {
  const def = requireNodeDef(type)
  return makeInferContext(def, { ...defaultParams(def), ...params }, {})
}

function node(type: string, params: ParamValues = {}) {
  const def = requireNodeDef(type)
  return {
    id: 'ds',
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(def), ...params },
  }
}

/** The `version` param's options, resolved against the live registry. */
function versionOptions(type: string, params: ParamValues = {}): EnumOption[] {
  const param = (requireNodeDef(type).params ?? []).find((p) => p.id === 'version')
  if (!param || param.kind !== 'enum') throw new Error(`${type} has no version enum`)
  return typeof param.options === 'function'
    ? param.options(ctxFor(type, params))
    : param.options
}

describe('per-dataset nodes', () => {
  it('arrives already pointed at its dataset, with no source to choose', () => {
    const def = requireNodeDef('dataset.mock.hemibrain')
    expect(def.category).toBe('dataset')
    // Version is the only question left; the old node also asked which backend and which dataset.
    expect((def.params ?? []).filter((p) => !p.advanced).map((p) => p.id)).toEqual(['version'])
  })

  it('infers the dataset id its evaluate will use', () => {
    const def = requireNodeDef('dataset.mock.hemibrain')
    const types = def.inferOutputs!(ctxFor('dataset.mock.hemibrain'))
    expect(datasetRef(types['dataset'])).toEqual({
      sourceId: 'mock',
      datasetId: 'hemibrain-mini',
    })
  })

  it('offers Latest plus each listed version, with no duplicate values', () => {
    const values = versionOptions('dataset.mock.hemibrain').map((o) => o.value)
    expect(values[0]).toBe('')
    // A select with two options sharing a value cannot express which one is chosen.
    expect(new Set(values).size).toBe(values.length)
  })

  it('names the version that Latest currently resolves to', () => {
    // "Latest" with no version beside it is a provenance question mark on a shared graph.
    expect(versionOptions('dataset.mock.hemibrain')[0]?.label).toMatch(/Latest \(.+\)/)
  })

  it('reports a version the server does not offer', () => {
    const def = requireNodeDef('dataset.mock.hemibrain')
    const issues = def.validate!(ctxFor('dataset.mock.hemibrain', { version: 'v9.9' }))
    expect(issues[0]).toContain('v9.9')
  })

  it('stays quiet while the listing has not arrived', () => {
    // Otherwise every dataset node in the graph reports a missing version before the connection
    // panel has had a chance to say the real problem — no token — even once.
    const def = requireNodeDef('dataset.malecns')
    expect(def.validate!(ctxFor('dataset.malecns', { version: 'v1.0' }))).toEqual([])
  })

  it('still resolves a pinned version with no listing, so types survive a reload', () => {
    const def = requireNodeDef('dataset.malecns')
    const types = def.inferOutputs!(ctxFor('dataset.malecns', { version: 'v0.9' }))
    expect(datasetRef(types['dataset'])?.datasetId).toBe('male-cns:v0.9')
  })

  it('runs and emits a dataset value', async () => {
    const graph = addNode(emptyGraph('t'), node('dataset.mock.hemibrain'))
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(graph, { mode: 'full' })
    const value = sched.output('ds', 'dataset')
    expect(isDatasetValue(value) && value.datasetId).toBe('hemibrain-mini')
    expect(isDatasetValue(value) && value.sourceId).toBe('mock')
  })

  it('feeds a downstream query node', () => {
    let graph = addNode(emptyGraph('t'), node('dataset.mock.hemibrain'))
    graph = addNode(graph, {
      id: 'find',
      type: 'neuron.findNeurons',
      position: { x: 300, y: 0 },
      params: defaultParams(requireNodeDef('neuron.findNeurons')),
    })
    graph = addEdge(graph, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'find',
      targetHandle: 'dataset',
    })
    const inference = inferGraph(graph)
    expect(inference.ok).toBe(true)
    // The refinement is what lets column pickers populate before anything runs.
    expect(datasetRef(inference.nodes['find']?.inputs['dataset'])?.datasetId).toBe(
      'hemibrain-mini',
    )
  })
})

describe('Custom neuPrint', () => {
  it('defaults to the Janelia deployment', () => {
    const def = requireNodeDef('dataset.neuprint')
    const server = (def.params ?? []).find((p) => p.id === 'server')
    expect(server?.default).toBe(DEFAULT_SERVER)
  })

  it('asks for a dataset instead of silently producing nothing', () => {
    const def = requireNodeDef('dataset.neuprint')
    expect(def.validate!(ctxFor('dataset.neuprint'))[0]).toContain('Name a dataset')
  })

  it('registers a source for a deployment it has not seen before', () => {
    const def = requireNodeDef('dataset.neuprint')
    const types = def.inferOutputs!(
      ctxFor('dataset.neuprint', {
        server: 'https://neuprint-pre.janelia.org',
        dataset: 'x:v1',
      }),
    )
    const ref = datasetRef(types['dataset'])
    expect(ref?.sourceId).toBe('neuprint:https://neuprint-pre.janelia.org')
    // Inference is what registers it, so evaluate can resolve it a moment later.
    expect(requireSource(ref!.sourceId!)).toBeDefined()
  })

  it('shares one source between two nodes naming the same deployment differently', () => {
    const def = requireNodeDef('dataset.neuprint')
    const a = def.inferOutputs!(
      ctxFor('dataset.neuprint', { server: 'neuprint.janelia.org/', dataset: 'x' }),
    )
    const b = def.inferOutputs!(
      ctxFor('dataset.neuprint', { server: DEFAULT_SERVER, dataset: 'x' }),
    )
    expect(datasetRef(a['dataset'])?.sourceId).toBe(datasetRef(b['dataset'])?.sourceId)
  })
})

describe('the superseded generic node', () => {
  it('is still registered, so a graph saved before the redesign still loads', () => {
    const def = getNodeDef('neuron.dataset')
    expect(def).toBeDefined()
    // An unregistered type renders as "Unknown node" and drops its params.
    expect(def?.hidden).toBe(true)
  })

  it('still evaluates', async () => {
    const graph = addNode(
      emptyGraph('t'),
      node('neuron.dataset', { source: 'mock', dataset: 'hemibrain-mini' }),
    )
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(graph, { mode: 'full' })
    expect(isDatasetValue(sched.output('ds', 'dataset'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Custom CAVE
// ---------------------------------------------------------------------------

/**
 * The materialization dropdown.
 *
 * A datastack a user has just typed is not in `listDatasets` and never will be — that lists
 * only datastacks with a spec in the static table — so this control is fed by a per-datastack
 * peek instead, which is invariant 2's shape and fails in invariant 2's way: silently, as an
 * empty picker that reads as a broken control.
 */
describe('Custom CAVE', () => {
  beforeEach(() => {
    resetDatastackRecords()
  })

  it('says to name a datastack rather than offering an empty list', () => {
    // An empty select reads as a control that does not work; a sentence reads as an instruction.
    expect(versionOptions('dataset.cave').map((o) => o.label)).toEqual(['Name a datastack first'])
  })

  it('offers Latest and keeps a pinned value while the metadata is in flight', () => {
    const options = versionOptions('dataset.cave', { datastack: 'somewhere', version: '783' })
    // Not an empty select: the list is per-datastack, so it is unknown on *every* reload, and a
    // pinned materialization vanishing for a second reads as having been forgotten.
    expect(options.map((o) => o.value)).toEqual(['', '783'])
  })

  it('publishes no dataset id until it can name a materialization', () => {
    // Invariant 2's ordinary state: a typed socket with no id, refilled by `reportSourceLearned`.
    const out = ctxFor('dataset.cave', { datastack: 'somewhere' })
    const type = requireNodeDef('dataset.cave').inferOutputs?.(out)?.['dataset']
    expect(type?.kind).toBe('dataset')
    expect(datasetRef(type)?.datasetId).toBeUndefined()
  })

  it('takes the id from the pinned materialization, through the shared grammar', () => {
    const out = ctxFor('dataset.cave', { datastack: 'somewhere', version: '783' })
    const type = requireNodeDef('dataset.cave').inferOutputs?.(out)?.['dataset']
    expect(datasetRef(type)?.datasetId).toBe('somewhere:783')
  })

  it('refuses a materialization that is not a number, and accepts an empty one', () => {
    const def = requireNodeDef('dataset.cave')
    const bad = def.validate?.(ctxFor('dataset.cave', { datastack: 'x', neuronTable: 'n', version: 'latest' })) ?? []
    expect(bad.join(' ')).toContain('not a materialization number')
    // Empty is "latest", as it is on every family dataset node — not a missing value.
    expect(def.validate?.(ctxFor('dataset.cave', { datastack: 'x', neuronTable: 'n', version: '' }))).toEqual([])
  })

  it('resolves an unpinned materialization by fetching, so the first Run works', async () => {
    /*
     * The half a peek cannot cover, and the most important one: an unpinned node has no
     * materialization at edit time by construction, so if `evaluate` read the peek it would fail
     * on the first press and succeed on the second — the "runs twice, answers differently"
     * signature this codebase keeps being caught by.
     */
    setToken('test-token')
    vi.stubGlobal('fetch', (url: string) => {
      const body = String(url).includes('/info/api/v2/datastack/full/')
        ? { local_server: 'https://local.example', segmentation_source: '' }
        : [
            { version: 42, valid: true, status: 'AVAILABLE' },
            { version: 91, valid: true, status: 'AVAILABLE' },
            // Expired and invalid ones must not win "latest" — a query against either fails.
            { version: 99, valid: true, status: 'EXPIRED' },
            { version: 95, valid: false },
          ]
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(body)),
      } as Response)
    })
    registerSource(new CaveSource())

    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })
    let g = emptyGraph('custom-cave')
    g = addNode(g, node('dataset.cave', { datastack: 'somewhere', neuronTable: 'n' }))
    await scheduler.run(g, { mode: 'full' })

    const value = scheduler.output('ds', 'dataset')
    if (!isDatasetValue(value)) throw new Error(scheduler.info('ds').error ?? 'no dataset')
    expect(value.datasetId).toBe('somewhere:91')
    vi.unstubAllGlobals()
    resetCaveCredentials()
  })

  it('asks for a neuron table or a wire, and takes either', () => {
    const def = requireNodeDef('dataset.cave')
    const bare = ctxFor('dataset.cave', { datastack: 'somewhere' })
    // Neither: nothing can say which neurons exist, so the node would run and refuse.
    expect((def.validate?.(bare) ?? []).join(' ')).toContain('Annotations source')

    // A named table is one answer...
    expect(
      def.validate?.(ctxFor('dataset.cave', { datastack: 'somewhere', neuronTable: 'nuclei' })),
    ).toEqual([])

    // ...and a wired chain is the other, for a datastack that publishes no such table at all.
    const wired = makeInferContext(
      def,
      { ...defaultParams(def), datastack: 'somewhere' },
      { annotations: T.neurons() },
    )
    expect(def.validate?.(wired)).toEqual([])
  })

  it('registers a spec with no neuron table, so the id-driven nodes still work', () => {
    // Those never touch it — connectivity reads the roll-up view by root id, and skeletons,
    // meshes and synapses take ids off a table. Withholding the spec would break them too.
    requireNodeDef('dataset.cave').inferOutputs?.(
      ctxFor('dataset.cave', { datastack: 'bare_one', version: '1' }),
    )
    expect(specFor('bare_one')?.neurons).toBeUndefined()
    expect(specFor('bare_one')?.datastack).toBe('bare_one')
  })

  it('warns about a shipped datastack before asking for anything else on the card', () => {
    // `specFor` prefers the static table, so every other setting here is inert — and asking for
    // a neuron table first answers a question that does not matter. Deliberately checked with
    // the rest of the card empty, which is what it is a second after the node is added.
    const issues =
      requireNodeDef('dataset.cave').validate?.(
        ctxFor('dataset.cave', { datastack: DATASTACK_SPECS[0]?.datastack ?? '' }),
      ) ?? []
    expect(issues.join(' ')).toContain('ships a node')
  })
})

describe('the root-drift advisory follows the wiring', () => {
  /*
   * The advisory is about *these* annotations, and the node is what says which those are. It used
   * to hand over the dataset id alone, so the answer was taken once per session and then stuck:
   * dropping an `Update root IDs` into the chain left the warning up, and pulling one out never
   * raised it. `rootIds.test.ts` pins the mechanism; this pins that the chain's key reaches it.
   */
  const CURRENT = '100000001'
  const RETIRED = '100000002'
  const STAMP = '2023-08-29T00:00:00.000000'

  /** Short ids on purpose: `inputIds` with no Dataset publishes an `i64`, which rounds a wide one. */
  function graphWith(ids: string) {
    let g = emptyGraph('drift')
    g = addNode(g, {
      id: 'ann',
      type: 'neuron.inputIds',
      position: { x: 0, y: 0 },
      params: { ...defaultParams(requireNodeDef('neuron.inputIds')), ids },
    })
    g = addNode(g, node('dataset.cave', { datastack: 'somewhere', neuronTable: 'n' }))
    return addEdge(g, {
      source: 'ann',
      sourceHandle: 'neurons',
      target: 'ds',
      targetHandle: 'annotations',
    })
  }

  async function until(ok: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 1))
    if (!ok()) throw new Error('timed out waiting for the drift check')
  }

  beforeEach(() => {
    resetCache()
    resetRootChecks()
    resetDatastackRecords()
    setToken('test-token')
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const text = String(url)
      const body = text.includes('/datastack/full/')
        ? {
            local_server: 'https://local.example',
            segmentation_source: 'graphene://https://cg.example/segmentation/table/some_table',
          }
        : text.includes('is_latest_roots')
          ? {
              is_latest: (/\[(.*)\]/.exec(String(init?.body ?? ''))?.[1] ?? '')
                .split(',')
                .filter(Boolean)
                .map((id) => id !== RETIRED),
            }
          : [{ version: 783, valid: true, status: 'AVAILABLE', time_stamp: STAMP }]
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(body)),
      } as Response)
    })
    registerSource(new CaveSource())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetCaveCredentials()
    resetRootChecks()
  })

  it('re-asks when the chain changes, in both directions', async () => {
    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })

    await scheduler.run(graphWith(RETIRED), { mode: 'full' })
    await until(() => peekRootCheck('somewhere:783')?.stale === 1)

    // The gesture: a repair upstream, so the dataset is handed different ids under a new key.
    await scheduler.run(graphWith(CURRENT), { mode: 'full' })
    await until(() => peekRootCheck('somewhere:783')?.checked === 1)
    expect(peekRootCheck('somewhere:783')?.stale).toBe(0)

    // And back, which is the half that never fired at all.
    await scheduler.run(graphWith(RETIRED), { mode: 'full' })
    await until(() => peekRootCheck('somewhere:783')?.stale === 1)
  })

  it('forgets the answer when the annotations come off', async () => {
    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await scheduler.run(graphWith(RETIRED), { mode: 'full' })
    await until(() => peekRootCheck('somewhere:783')?.stale === 1)

    let bare = emptyGraph('drift')
    bare = addNode(bare, node('dataset.cave', { datastack: 'somewhere', neuronTable: 'n' }))
    await scheduler.run(bare, { mode: 'full' })
    expect(peekRootCheck('somewhere:783')).toBeUndefined()
  })
})
