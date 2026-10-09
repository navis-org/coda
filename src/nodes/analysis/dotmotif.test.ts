import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvalContext } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { isNetworkValue, isTableValue, tableFromRows } from '../../core/values'
import { runDotMotif } from '../../pyodide/dotmotif'
import { dotmotifSchema } from '../lib/dotmotifOps'
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
    matchId: [1, 1],
    variable: ['A', 'B'],
    nodeId: ids.slice(0, 2),
    count: 1,
    limitReached: false,
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
        nodes: network.nodes.data,
        edges: network.edges.data,
        query: 'A -> B',
        maxMatches: 20,
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
    expect(out.matches.kind).toBe('table') // Group IDs are not necessarily neuron IDs.
    expect(out.network.nodes.data.id).toEqual(ids.slice(0, 2))
    expect(out.network.nodes.data.type).toEqual(['sensory', 'motor'])
    expect(out.network.edges.data.weight).toEqual([8, 3]) // Includes the extra reverse link.
    expect(out.network.edges.schema).toEqual(network.edges.schema)
    expect(network).toEqual(original)
    expect(ctx.warn).not.toHaveBeenCalled()
  })

  it('returns typed empty outputs when nothing matches', async () => {
    vi.mocked(runDotMotif).mockResolvedValue({
      matchId: [],
      variable: [],
      nodeId: [],
      count: 0,
      limitReached: false,
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
    vi.mocked(runDotMotif).mockResolvedValue({
      matchId: [1, 1],
      variable: ['A', 'B'],
      nodeId: ids.slice(0, 2),
      count: 1,
      limitReached: true,
    })
    const ctx = context({ maxMatches: 1 })
    await def.evaluate!(ctx)
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringMatching(/1 matches; there may be more/))
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

  it('propagates errors and cancellation rather than publishing partial matches', async () => {
    const error = new DOMException('Cancelled', 'AbortError')
    vi.mocked(runDotMotif).mockRejectedValue(error)
    await expect(def.evaluate!(context())).rejects.toBe(error)
  })
})
