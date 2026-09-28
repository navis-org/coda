import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPython } from './engine'
import { runDotMotif } from './dotmotif'
import type { DotMotifRequest, DotMotifResult } from './dotmotif'

vi.mock('./engine', () => ({ callPython: vi.fn() }))

const request: DotMotifRequest = {
  directed: true,
  nodes: { id: ['720575940600000001', '720575940600000002'], type: ['A', null] },
  edges: { source: ['720575940600000001'], target: ['720575940600000002'], weight: [4] },
  query: 'A -> B',
  maxMatches: 3,
}
const result: DotMotifResult = {
  matchId: [1, 1],
  variable: ['A', 'B'],
  nodeId: ['720575940600000001', '720575940600000002'],
  count: 1,
  limitReached: false,
}

beforeEach(() => {
  vi.mocked(callPython).mockReset()
})

describe('DotMotif worker seam', () => {
  it('preserves attributes and wide string IDs, and passes cancellation and progress through', async () => {
    vi.mocked(callPython).mockResolvedValue({ ...result })
    const options = { signal: new AbortController().signal, onProgress: vi.fn() }
    const before = structuredClone(request)
    expect(await runDotMotif(request, options)).toEqual(result)
    expect(callPython).toHaveBeenCalledWith(
      { module: 'dotmotif', fn: 'coda_dotmotif_run', args: [request] },
      options,
    )
    expect(request).toEqual(before)
  })

  it('accepts an empty match table', async () => {
    const empty = { matchId: [], variable: [], nodeId: [], count: 0, limitReached: false }
    vi.mocked(callPython).mockResolvedValue(empty)
    expect(await runDotMotif(request)).toEqual(empty)
  })

  it.each([
    { nodeId: [Number('720575940600000001'), Number('720575940600000002')] },
    { variable: ['A'] },
    { matchId: [0, 0] },
    { count: -1 },
    { count: 1.5 },
    { count: 4 },
    { count: 0 },
    { limitReached: true },
  ])('rejects a malformed response: %j', async (overrides) => {
    vi.mocked(callPython).mockResolvedValue({ ...result, ...overrides })
    await expect(runDotMotif(request)).rejects.toThrow('invalid match table')
  })

  it('does not turn a cancellation or query failure into an empty successful result', async () => {
    const error = new DOMException('Cancelled', 'AbortError')
    vi.mocked(callPython).mockRejectedValue(error)
    await expect(runDotMotif(request)).rejects.toBe(error)
  })
})
