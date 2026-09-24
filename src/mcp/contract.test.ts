/**
 * The contract `coda-mcp` runs against. See `docs/mcp.md`.
 *
 * Installed servers in another repository call these by name, so a rename passes every other
 * suite here and breaks them the day it deploys. Adding an export is fine; removing or reshaping
 * one is a `v2` directory, with `v1` still served.
 *
 * Offline throughout, as the server runs by default: `fetch` is refused before the module loads,
 * so anything below that needed a network fails here rather than on somebody else's machine.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { deserializeGraph } from '../core/graph'
import { decodePacked, parseShareFragment } from '../data/share/fragment'
// Types only, erased at compile: the module itself is imported below, after `fetch` is refused.
import type * as Contract from './index'

const V1: Record<string, 'function' | 'number' | 'string'> = {
  CONTRACT_VERSION: 'number',
  APP_VERSION: 'string',
  BUILD_ID: 'string',
  guide: 'function',
  nodeTypeIds: 'function',
  nodeEntry: 'function',
  nodeHelp: 'function',
  planSchema: 'function',
  parsePlan: 'function',
  newGraph: 'function',
  applyPlan: 'function',
  describe: 'function',
  check: 'function',
  toJson: 'function',
  shareLink: 'function',
  setCredentials: 'function',
}

/** As a model writes one: the schema's shape, params as a list of pairs. */
const PLAN = {
  summary: 'LC neurons over a size threshold',
  add: [
    { ref: 'ds', type: 'dataset.mock.opticlobe' },
    { ref: 'find', type: 'neuron.findNeurons' },
    { ref: 'filter', type: 'core.filterTable' },
  ],
  remove: [],
  setParams: [
    { node: 'find', param: 'filters', value: ['{"f":"type","op":"matches","v":["LC.*"]}'] },
    { node: 'filter', param: 'column', value: 'size' },
    { node: 'filter', param: 'value', value: '1000' },
  ],
  connect: [
    { from: { node: 'ds', port: 'dataset' }, to: { node: 'find', port: 'dataset' } },
    { from: { node: 'find', port: 'neurons' }, to: { node: 'filter', port: 'in' } },
  ],
  disconnect: [],
}

let coda: typeof Contract

beforeAll(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
  coda = await import('./index')
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('mcp contract v1', () => {
  it('keeps every v1 export, with its kind', () => {
    const exports = coda as unknown as Record<string, unknown>
    for (const [name, kind] of Object.entries(V1)) expect(typeof exports[name], name).toBe(kind)
    expect(coda.CONTRACT_VERSION).toBe(1)
  })

  it('builds, checks, describes and links a workflow with no network', async () => {
    const parsed = coda.parsePlan(JSON.stringify(PLAN))
    if (!parsed.ok) throw new Error(parsed.error)
    const applied = coda.applyPlan(coda.newGraph('contract'), parsed.plan)
    if (!applied.ok) throw new Error(applied.errors.join('\n'))

    expect(Object.keys(applied.created).sort()).toEqual(['ds', 'filter', 'find'])
    expect(coda.check(applied.graph)).toEqual({ ok: true, cyclic: [], issues: [] })

    const listing = coda.describe(applied.graph)
    expect(listing).toContain(applied.created.find!)
    expect(listing).toContain('carries:')

    const link = await coda.shareLink(applied.graph, 'https://coda.science')
    expect(link.startsWith('https://coda.science/#!c1.')).toBe(true)
    const ref = parseShareFragment(link.slice(link.indexOf('#')))
    if (ref.kind !== 'packed') throw new Error(`expected a packed link, got ${ref.kind}`)
    const back = deserializeGraph(await decodePacked(ref.blob))
    expect(back.warnings).toEqual([])
    expect(back.graph.nodes.map((n) => n.id)).toEqual(applied.graph.nodes.map((n) => n.id))
  })

  it('refuses a plan naming a node type that does not exist, and names it', () => {
    const parsed = coda.parsePlan(
      JSON.stringify({ ...PLAN, add: [{ ref: 'x', type: 'no.such' }] }),
    )
    if (!parsed.ok) throw new Error(parsed.error)
    const applied = coda.applyPlan(coda.newGraph(), parsed.plan)
    expect(applied.ok).toBe(false)
    if (!applied.ok) expect(applied.errors.join('\n')).toContain('no.such')
  })

  it('serves one node entry, its help and the plan schema', async () => {
    expect(coda.nodeTypeIds()).toContain('core.filterTable')
    expect(coda.nodeEntry('core.filterTable')).toContain('## core.filterTable')
    expect(coda.nodeEntry('no.such')).toBeUndefined()
    // A former id reads as its successor; the placeholder is not a node a plan can name.
    expect(coda.nodeEntry('zapbench.traces')).toContain('## zapbench:traces')
    expect(coda.nodeEntry('core.missing')).toBeUndefined()
    expect(await coda.nodeHelp('core.filterTable')).toBeTruthy()
    expect(Object.keys((coda.planSchema() as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['add', 'connect', 'setParams']),
    )
  })

  it("frames the guide for a model working through tools, with none of the app's framing", () => {
    const guide = coda.guide()
    for (const appOnly of [
      'You are an assistant inside Coda',
      'Answer with a plan and nothing else',
      'return an empty plan',
      'What a run tells you',
      'An empty canvas',
      'catalogue above',
      'returned after every plan',
    ]) {
      expect(guide).not.toContain(appOnly)
    }
    expect(guide).toContain('How a plan is written:')
    expect(guide).toContain('The node catalogue.')
  })
})
