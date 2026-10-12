import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvalContext } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { isNetworkValue, isTableValue, tableFromRows } from '../../core/values'
import { runDotMotif } from '../../pyodide/dotmotif'
import { MAX_DOTMOTIF_MATCHES, dotmotifSchema, maxRolesFor } from '../lib/dotmotifOps'
import './dotmotif'

vi.mock('../../pyodide/dotmotif', () => ({ runDotMotif: vi.fn() }))

const def = requireNodeDef('net.dotmotif')
const ids = ['720575940600000001', '720575940600000002', 'unmatched'] as const
const network: NetworkValue = {
  kind: 'network',
  directed: true,
  nodes: tableFromRows(tableSchema(column('id', 'str'), column('type', 'str')), [
    { id: ids[0], type: 'sensory' },
    { id: ids[1], type: 'motor' },
    { id: ids[2], type: 'other' },
  ]),
  edges: tableFromRows(
    tableSchema(column('source', 'str'), column('target', 'str'), column('weight', 'f64')),
    [
      { source: ids[0], target: ids[1], weight: 8 },
      { source: ids[1], target: ids[0], weight: 3 },
      { source: ids[1], target: ids[2], weight: 1 },
    ],
  ),
}

function context(params: Record<string, string | number> = {}) {
  const signal = new AbortController().signal
  return {
    params: { ...defaultParams(def), ...params },
    input: () => network,
    signal,
    progress: vi.fn(),
    warn: vi.fn(),
  } as unknown as EvalContext
}

beforeEach(() => {
  vi.mocked(runDotMotif).mockReset()
  vi.mocked(runDotMotif).mockResolvedValue({
    count: 1,
    roles: ['A', 'B'],
    keys: new Int32Array([0, 1]),
    refused: false,
  })
})

describe('DotMotif node', () => {
  it('runs only on demand and advertises its fixed table without running Python', () => {
    expect(def.cost).toBe('expensive')
    const inferred = def.inferOutputs!(
      makeInferContext(def, {}, { in: T.network(network.nodes.schema, network.edges.schema) }),
    )
    expect(inferred).toEqual({
      matches: T.table(dotmotifSchema()),
      network: T.network(network.nodes.schema, network.edges.schema),
    })
    expect(runDotMotif).not.toHaveBeenCalled()
    expect(() => def.inferOutputs!(makeInferContext(def, {}, {}))).not.toThrow()
  })

  it('keeps role membership, lossless IDs, and the full induced union distinct', async () => {
    const ctx = context({ query: 'A -> B', maxMatches: 20 })
    const original = structuredClone(network)
    const out = await def.evaluate!(ctx)
    expect(runDotMotif).toHaveBeenCalledWith(
      {
        directed: true,
        query: 'A -> B',
        maxMatches: 20,
        maxRoles: maxRolesFor(20),
        // Keys are ranks in id order; these rows happen to arrive in it already.
        keyOfRow: new Int32Array([0, 1, 2]),
        sources: new Int32Array([0, 1, 1]),
        targets: new Int32Array([1, 0, 2]),
        linkRows: new Int32Array([0, 1, 2]),
        // The query names no attribute, so no column is cloned to the worker.
        nodes: {},
        edges: {},
      },
      { signal: ctx.signal, onProgress: ctx.progress },
    )
    if (!isTableValue(out.matches) || !isNetworkValue(out.network))
      throw new Error('wrong outputs')
    expect(out.matches.schema).toEqual(dotmotifSchema())
    expect(out.matches.data).toEqual({
      matchId: [1, 1],
      variable: ['A', 'B'],
      nodeId: ids.slice(0, 2),
    })
    expect(out.matches.length).toBe(2)
    expect(out.network.nodes.data.id).toEqual(ids.slice(0, 2))
    expect(out.network.nodes.data.type).toEqual(['sensory', 'motor'])
    expect(out.network.edges.data.weight).toEqual([8, 3]) // Includes the extra reverse link.
    expect(out.network.edges.schema).toEqual(network.edges.schema)
    expect(network).toEqual(original)
    expect(ctx.warn).not.toHaveBeenCalled()
  })

  it('returns typed empty outputs when nothing matches', async () => {
    vi.mocked(runDotMotif).mockResolvedValue({
      count: 0,
      roles: ['A', 'B'],
      keys: new Int32Array(0),
      refused: false,
    })
    const out = await def.evaluate!(context())
    if (!isTableValue(out.matches) || !isNetworkValue(out.network))
      throw new Error('wrong outputs')
    expect(out.matches.length).toBe(0)
    expect(out.matches.schema).toEqual(dotmotifSchema())
    expect(out.network.nodes.length).toBe(0)
    expect(out.network.edges.length).toBe(0)
  })

  it('warns at the cap without claiming a proven total or truncation', async () => {
    const ctx = context({ maxMatches: 1 })
    await def.evaluate!(ctx)
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringMatching(/1 match; there may be more/))
  })

  it('clones to the worker only the columns the query names', async () => {
    await def.evaluate!(context({ query: 'A -> B [weight >= 5]\nA.type = "sensory"' }))
    const [request] = vi.mocked(runDotMotif).mock.calls[0]!
    expect(Object.keys(request.nodes)).toEqual(['type'])
    expect(Object.keys(request.edges)).toEqual(['weight'])
  })

  it('says on the card when Max matches is more than a tab can hold, and not at the ceiling', () => {
    const issues = (maxMatches: number) =>
      def.validate!(makeInferContext(def, { maxMatches }, {})).join(' ')
    expect(issues(50_000_000)).toMatch(/^Refused: Up to 50,000,000 matches would allocate/)
    expect(issues(MAX_DOTMOTIF_MATCHES)).toBe('')
  })

  it('refuses a stored Max matches past the ceiling before the worker is asked', async () => {
    await expect(def.evaluate!(context({ maxMatches: 50_000_000 }))).rejects.toThrow(
      'Lower `Max matches`',
    )
    expect(runDotMotif).not.toHaveBeenCalled()
  })

  it('refuses when the parsed query has more roles than Max matches can afford', async () => {
    vi.mocked(runDotMotif).mockResolvedValue({
      count: 0,
      roles: ['A', 'B', 'C'],
      keys: new Int32Array(0),
      refused: true,
    })
    // Within the two-role cap, past what three roles can afford: only the parse can tell.
    await expect(def.evaluate!(context({ maxMatches: 1_800_000 }))).rejects.toThrow(
      /^Refused: Up to 1,800,000 matches of 3 roles would allocate/,
    )
  })

  it('refuses a network with parallel links before Python is asked', async () => {
    const parallel: NetworkValue = {
      ...network,
      edges: tableFromRows(network.edges.schema, [
        { source: ids[0], target: ids[1], weight: 8 },
        { source: ids[0], target: ids[1], weight: 2 },
      ]),
    }
    const ctx = { ...context(), input: () => parallel } as unknown as EvalContext
    await expect(def.evaluate!(ctx)).rejects.toThrow('Merge parallel links')
    expect(runDotMotif).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, NaN, Infinity])(
    'rejects invalid result caps at edit time: %s',
    (maxMatches) => {
      expect(def.validate!(makeInferContext(def, { maxMatches }, {}))).toContain(
        'Max matches must be a positive whole number.',
      )
    },
  )

  it('catches an empty query without booting Python', () => {
    expect(def.validate!(makeInferContext(def, { query: ' \n ' }, {}))).toContain(
      'Enter a DotMotif pattern.',
    )
  })
})
