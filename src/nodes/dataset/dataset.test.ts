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
import { CatmaidSource } from '../../data/catmaid/CatmaidSource'
import { DEFAULT_CATMAID_SERVER } from '../../data/catmaid/credentials'
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

/** The `datastack` param's completions, resolved against the live registry. */
function datastackSuggestions(): string[] {
  const param = (requireNodeDef('dataset.cave').params ?? []).find((p) => p.id === 'datastack')
  if (!param || param.kind !== 'string') throw new Error('no datastack string param')
  return param.suggestions?.(ctxFor('dataset.cave')) ?? []
}

describe('per-dataset nodes', () => {
  it('arrives already pointed at its dataset, with no source to choose', () => {
    const def = requireNodeDef('dataset.mock.opticlobe')
    expect(def.category).toBe('dataset')
    // Version is the only question left; the old node also asked which backend and which dataset.
    expect((def.params ?? []).filter((p) => !p.advanced).map((p) => p.id)).toEqual(['version'])
  })

  it('infers the dataset id its evaluate will use', () => {
    const def = requireNodeDef('dataset.mock.opticlobe')
    const types = def.inferOutputs!(ctxFor('dataset.mock.opticlobe'))
    expect(datasetRef(types['dataset'])).toEqual({
      sourceId: 'mock',
      datasetId: 'optic-lobe-mini',
    })
  })

  it('offers Latest plus each listed version, with no duplicate values', () => {
    const values = versionOptions('dataset.mock.opticlobe').map((o) => o.value)
    expect(values[0]).toBe('')
    // A select with two options sharing a value cannot express which one is chosen.
    expect(new Set(values).size).toBe(values.length)
  })

  it('names the version that Latest currently resolves to', () => {
    // "Latest" with no version beside it is a provenance question mark on a shared graph.
    expect(versionOptions('dataset.mock.opticlobe')[0]?.label).toMatch(/Latest \(.+\)/)
  })

  it('reports a version the server does not offer', () => {
    const def = requireNodeDef('dataset.mock.opticlobe')
    const issues = def.validate!(ctxFor('dataset.mock.opticlobe', { version: 'v9.9' }))
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
    const graph = addNode(emptyGraph('t'), node('dataset.mock.opticlobe'))
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(graph, { mode: 'full' })
    const value = sched.output('ds', 'dataset')
    expect(isDatasetValue(value) && value.datasetId).toBe('optic-lobe-mini')
    expect(isDatasetValue(value) && value.sourceId).toBe('mock')
  })

  it('feeds a downstream query node', () => {
    let graph = addNode(emptyGraph('t'), node('dataset.mock.opticlobe'))
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
      'optic-lobe-mini',
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
      node('neuron.dataset', { source: 'mock', dataset: 'optic-lobe-mini' }),
    )
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(graph, { mode: 'full' })
    expect(isDatasetValue(sched.output('ds', 'dataset'))).toBe(true)
  })
})

/**
 * A dataset node for a datastack this account cannot read.
 *
 * The other half of the listing fix. `runListing` tolerates a refusal so that one datastack an
 * account lacks access to cannot empty the picker — which makes "absent from the listing" the
 * ordinary shape of "you may not read this", and left the node pointed at it reporting
 * `no dataset "(none)" on CAVE. Available: <two datasets nobody asked for>`. Reported from a real
 * session, on `minnie65_public`.
 */
describe('a dataset node whose datastack refused', () => {
  const REASON =
    'CAVE will not serve minnie65_public until you have accepted MICrONS Data Use — accept ' +
    'them at https://global.daf-apis.com/sticky_auth/api/v1/tos/3/accept. Your token is fine; ' +
    'signing in again will not help.'

  /** A CAVE source that lists nothing and knows why, which is the state after one listing. */
  class RefusingCave extends CaveSource {
    override listDatasets(): Promise<never[]> {
      return Promise.resolve([])
    }
    override peekDatasets(): never[] {
      return []
    }
    override whyDatasetMissing(ref: string): string | undefined {
      return ref.startsWith('minnie65_public') ? REASON : undefined
    }
  }

  beforeEach(() => {
    registerSource(new RefusingCave())
  })
  afterEach(() => {
    registerSource(new CaveSource())
  })

  it('says why on the card, without waiting for a Run', () => {
    // The node nobody can run, marked before anybody presses Run: `validate` used to stay silent
    // whenever the listing was empty, because it could not tell "not arrived" from "refused".
    const def = requireNodeDef('dataset.minnie65')
    expect(def.validate?.(ctxFor('dataset.minnie65'))).toEqual([REASON])
  })

  it('fails a run with the reason rather than with somebody else’s datasets', async () => {
    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })
    let g = emptyGraph('refused')
    g = addNode(g, node('dataset.minnie65', {}))
    await scheduler.run(g, { mode: 'full' })

    const error = scheduler.info('ds').error ?? ''
    expect(error).toBe(REASON)
    // The sentence it replaced described the symptom and named nothing actionable.
    expect(error).not.toContain('(none)')
    expect(error).not.toContain('Available:')
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
    expect(versionOptions('dataset.cave').map((o) => o.label)).toEqual([
      'Name a datastack first',
    ])
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
    const bad =
      def.validate?.(
        ctxFor('dataset.cave', { datastack: 'x', neuronTable: 'n', version: 'latest' }),
      ) ?? []
    expect(bad.join(' ')).toContain('not a materialization number')
    // Empty is "latest", as it is on every family dataset node — not a missing value.
    expect(
      def.validate?.(ctxFor('dataset.cave', { datastack: 'x', neuronTable: 'n', version: '' })),
    ).toEqual([])
  })

  it('completes the datastack name from what the token can see, and only once it can', async () => {
    const listed = ['b_stack', 'a_stack']
    setToken('test-token')
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify(String(url).endsWith('/info/api/v2/datastacks') ? listed : []),
          ),
      } as Response),
    )

    // Invariant 2's state again, and the reason this is a `datalist` and not a `select`: on the
    // first render of every session there is nothing to offer, and a control that empties reads
    // as one that has forgotten what the graph says.
    expect(datastackSuggestions()).toEqual([])
    await vi.waitFor(() => expect(datastackSuggestions()).toHaveLength(2))
    expect(datastackSuggestions()).toEqual(['a_stack', 'b_stack'])

    vi.unstubAllGlobals()
    resetCaveCredentials()
  })

  it('offers nothing, and asks nothing, before there is a token', async () => {
    resetCaveCredentials()
    const fetched = vi.fn()
    vi.stubGlobal('fetch', fetched)
    expect(datastackSuggestions()).toEqual([])
    await Promise.resolve()
    // The listing endpoint needs the credential: with no `Authorization` header the info service
    // redirects into a sign-in page, which from a browser is a CORS failure rather than a status.
    expect(fetched).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('keeps a datastack the listing does not mention', async () => {
    // The node exists for the datastack Coda ships nothing for, and a private one need not be in
    // any listing at all — so the field takes free text and `evaluate` never checks the name
    // against the list. A `select` here would be a control that cannot express the node's job.
    const param = (requireNodeDef('dataset.cave').params ?? []).find(
      (p) => p.id === 'datastack',
    )
    expect(param?.kind).toBe('string')

    const def = requireNodeDef('dataset.cave')
    const issues = def.validate?.(
      ctxFor('dataset.cave', { datastack: 'nobodys_stack', neuronTable: 'n' }),
    )
    expect(issues).toEqual([])
  })

  it('puts the neuron table and its id column on the card, not in the inspector', () => {
    const params = requireNodeDef('dataset.cave').params ?? []
    const advanced = (id: string) => params.find((p) => p.id === id)?.advanced === true

    /*
     * `validate` complains "name a table listing this datastack's neurons" until the first of
     * these is set, and the inspector is closed by default — so as `advanced` these were a card
     * asking for something that had no field on it. The id column comes with it because the two
     * are one decision. The connection view stays inspector-only: not naming one is an ordinary
     * configuration whose only consequence is that Connectivity declines, said on that node.
     */
    expect(advanced('neuronTable')).toBe(false)
    expect(advanced('idColumn')).toBe(false)
    expect(advanced('connectionView')).toBe(true)
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

/**
 * `Custom CATMAID`, whose one interesting control is the project dropdown.
 *
 * A CATMAID project id is a bare integer whose meaning is per-instance — `1` is FAFB on VFB and
 * something else on a lab server — so the list has to come from the server, which puts this in
 * `Custom CAVE`'s position rather than `Custom neuPrint`'s: the control is empty on **every**
 * reload until a listing lands, and an empty select is invariant 2's usual silent failure.
 *
 * A fresh source per case, because `peekDatasets` starts its listing once per instance and
 * remembers — so a shared one would make "not listed yet" pass or fail by test order.
 */
describe('Custom CATMAID', () => {
  const PROJECTS = [
    { id: 1, title: 'Adult Brain', comment: null },
    { id: 7, title: 'L1 larva', comment: null },
  ]

  beforeEach(() => {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        String(url).includes('/projects/')
          ? new Response(JSON.stringify(PROJECTS), { status: 200 })
          : new Response('{"detail":"not stubbed"}', { status: 404 }),
      ),
    )
    registerSource(new CatmaidSource(DEFAULT_CATMAID_SERVER, 'catmaid', 'CATMAID'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** The `project` param's options, resolved against the live registry. */
  function projectOptions(params: ParamValues = {}): EnumOption[] {
    const param = (requireNodeDef('dataset.catmaid').params ?? []).find(
      (p) => p.id === 'project',
    )
    if (!param || param.kind !== 'enum') throw new Error('no project enum')
    return typeof param.options === 'function'
      ? param.options(ctxFor('dataset.catmaid', params))
      : param.options
  }

  it('says the list has not arrived rather than offering an empty select', () => {
    // "Not yet" is not "not here" — the peek has only just started the listing.
    expect(projectOptions().map((o) => o.label)).toEqual(['Projects not listed yet'])
  })

  it('keeps a stored project as an option while the list is unknown, and claims nothing', () => {
    // The list is per-instance, so it is absent on every reload; a pinned project blanking for a
    // second reads as having been forgotten. Offered *plainly* — labelling it "(not listed)"
    // here would be the looking-versus-not-here conflation, about a project that is listed.
    const options = projectOptions({ project: '7' })
    expect(options.map((o) => o.value)).toEqual(['', '7'])
    expect(options.map((o) => o.label)).toEqual(['Projects not listed yet', '7'])
  })

  it('marks a stored project the server does not offer, once it has answered', async () => {
    await requireSource('catmaid').listDatasets()
    const options = projectOptions({ project: '4' })
    expect(options.map((o) => o.value)).toEqual(['', '1', '7', '4'])
    expect(options.at(-1)?.label).toBe('4 (not listed)')
  })

  it('names each project once the server answers, since a bare id identifies nothing', async () => {
    await requireSource('catmaid').listDatasets()
    const options = projectOptions()
    expect(options.map((o) => o.value)).toEqual(['', '1', '7'])
    expect(options.map((o) => o.label)).toEqual([
      'Pick a project',
      'Adult Brain (1)',
      'L1 larva (7)',
    ])
  })

  it('publishes the source for the server it names, not the default one', () => {
    // The whole reason a source is registered per instance: two CATMAIDs share no project ids,
    // no annotation graph and no volume list, so reading them as one is a wrong answer.
    const type = requireNodeDef('dataset.catmaid').inferOutputs?.(
      ctxFor('dataset.catmaid', { server: 'lab.example.org', project: '1' }),
    )?.['dataset']
    expect(datasetRef(type)).toEqual({
      sourceId: 'catmaid:https://lab.example.org',
      datasetId: '1',
    })
  })

  it('asks for a project rather than resolving one, since there is no newest', () => {
    const def = requireNodeDef('dataset.catmaid')
    expect((def.validate?.(ctxFor('dataset.catmaid')) ?? []).join(' ')).toContain(
      'Pick a project',
    )
  })

  it('says nothing about a stored project until the list arrives, then names what is offered', async () => {
    const def = requireNodeDef('dataset.catmaid')
    // Unknown is not empty: otherwise every card warns for the first second of every load.
    expect(def.validate?.(ctxFor('dataset.catmaid', { project: '4' }))).toEqual([])
    await requireSource('catmaid').listDatasets()
    const issues = def.validate?.(ctxFor('dataset.catmaid', { project: '4' })) ?? []
    expect(issues.join(' ')).toContain('No project "4"')
    expect(issues.join(' ')).toContain('1 (Adult Brain)')
    expect(def.validate?.(ctxFor('dataset.catmaid', { project: '7' }))).toEqual([])
  })

  it('runs to a dataset carrying the project title', async () => {
    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })
    let g = emptyGraph('custom-catmaid')
    g = addNode(g, node('dataset.catmaid', { project: '7' }))
    await scheduler.run(g, { mode: 'full' })

    const value = scheduler.output('ds', 'dataset')
    if (!isDatasetValue(value)) throw new Error(scheduler.info('ds').error ?? 'no dataset')
    expect(value.datasetId).toBe('7')
    expect(value.label).toBe('L1 larva')
  })
})

/**
 * The population checkboxes.
 *
 * Each fails as a wrong *count* rather than as an error — which is the whole reason the
 * request-level `Traced` default this replaces was taken out. The gate matters as much as the
 * flags: the controls only make sense where the columns exist, and a checkbox on a CAVE
 * datastack would be the old failure with a new spelling.
 */
describe('the population checkboxes', () => {
  const paramIds = (type: string) => (requireNodeDef(type).params ?? []).map((p) => p.id)
  const POPULATION = ['tracedOnly', 'typedOnly', 'superclassOnly']

  it('are offered by the neuPrint families and by nobody else', () => {
    for (const id of POPULATION) {
      expect(paramIds('dataset.hemibrain')).toContain(id)
      expect(paramIds('dataset.neuprint')).toContain(id)
      // CAVE spells the same ideas `super_class` and `cell_type`; the mock is not a connectome
      // anybody proofreads; CATMAID has no segmentation at all.
      expect(paramIds('dataset.cave')).not.toContain(id)
      expect(paramIds('dataset.catmaid')).not.toContain(id)
      expect(paramIds('dataset.mock.opticlobe')).not.toContain(id)
    }
  })

  it('are inspector-only, and none is presentational or hidden', () => {
    for (const id of POPULATION) {
      const param = (requireNodeDef('dataset.hemibrain').params ?? []).find((p) => p.id === id)
      // `advanced` moves the control to the inspector; the card reports the *effect* in one line
      // instead — see `populationSummary`.
      expect(param?.advanced).toBe(true)
      // Not `internal`: these are somebody's settings, so the card's `… N more` hint counts them.
      expect(param?.internal).toBeUndefined()
      /*
       * Never `presentational` and never `visibleIf`-hidden. Each decides which neurons every
       * query below returns, so all three belong in the provenance key (invariant 4) — a hidden
       * param is dropped from it, and one that still reached `evaluate` would let a stale result
       * survive an edit.
       */
      expect(param?.presentational).toBeUndefined()
      expect(param?.visibleIf).toBeUndefined()
      // Absent is off even where the declared default is on — see `populationFrom`.
      expect(param?.absentMeans).toBe(false)
    }
  })

  /*
   * The per-family defaults, which are a judgement about the dataset rather than the backend:
   * hemibrain is thoroughly typed, where male-CNS classifies what it has looked at by superclass
   * and hemibrain publishes no such column at all.
   */
  it('start ticked per family, not per backend', () => {
    const started = (type: string) =>
      Object.entries(defaultParams(requireNodeDef(type)))
        .filter(([id, value]) => POPULATION.includes(id) && value === true)
        .map(([id]) => id)

    expect(started('dataset.hemibrain')).toEqual(['typedOnly'])
    expect(started('dataset.malecns')).toEqual(['superclassOnly'])
    // A family that has not made the judgement, and the custom node which is pointed at nothing.
    expect(started('dataset.manc')).toEqual([])
    expect(started('dataset.neuprint')).toEqual([])
  })

  it('reach the inferred type, so surfaces that never run can read them', () => {
    const def = requireNodeDef('dataset.hemibrain')
    const on = def.inferOutputs!(ctxFor('dataset.hemibrain', { tracedOnly: true }))
    const off = def.inferOutputs!(
      ctxFor('dataset.hemibrain', { tracedOnly: false, typedOnly: false }),
    )
    expect(datasetRef(on['dataset'])?.population).toEqual(['traced', 'typed'])
    expect(datasetRef(off['dataset'])?.population).toBeUndefined()
  })

  /*
   * The back-compatibility rule, and the one worth a test of its own: `defaultParams` writes the
   * default into a node when it is *created* and never runs over a loaded graph, so a node saved
   * before these existed holds no key for them — and it queried every `:Neuron` when it was
   * built. Reading absent as the declared default would change what a published graph returns,
   * and its provenance key with it, on nothing more than opening the file.
   */
  it('read an absent param as off, so a saved graph keeps its neuron set', () => {
    const def = requireNodeDef('dataset.hemibrain')
    const saved = makeInferContext(def, { version: '' }, {})
    expect(datasetRef(def.inferOutputs!(saved)['dataset'])?.population).toBeUndefined()
    // While a node created today arrives with this family's judgement on.
    expect(defaultParams(def).typedOnly).toBe(true)
  })

  /*
   * A warning rather than a refusal: the filter is dropped before the query is built, so the run
   * returns *more* rows rather than none. What that leaves is a ticked box doing nothing, and
   * saying so is the whole fix.
   */
  it('warn when the dataset publishes no column for one of them', async () => {
    /*
     * Through the custom node, because a *family* node stays quiet until the dataset listing has
     * arrived — "that is the connection panel's story to tell, not a per-node error on every
     * dataset node in the graph" — and this source has no token.
     *
     * And **after discovery has settled**, which is the other half of the same rule one layer
     * down: until it does, `discoveredNeuronSchema` answers undefined and the warning stays
     * quiet, because a schema that has not arrived is not a schema without `superclass` in it.
     * Discovery here fails on every request and still lands, leaving the canonical columns —
     * which carry `status` and `type` and no `superclass`.
     */
    const def = requireNodeDef('dataset.neuprint')
    const at = (params: ParamValues) =>
      def.validate!(ctxFor('dataset.neuprint', { dataset: 'hemibrain:v1.2.1', ...params }))

    // Quiet before it lands, which is a fact worth pinning rather than a step to get past.
    expect(at({ superclassOnly: true })).toEqual([])
    await (requireSource('neuprint') as NeuPrintSource).discover('hemibrain:v1.2.1')

    expect(at({ superclassOnly: true }).join(' ')).toContain('Superclass only')
    // Warned about, but not refused: the filter is dropped and the run returns more rows.
    expect(at({ superclassOnly: true }).join(' ')).toContain('every neuron the server has')
    expect(at({ typedOnly: true, tracedOnly: true })).toEqual([])
  })
})
