import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPython } from './engine'
import { runDotMotif } from './dotmotif'
import type { DotMotifRequest } from './dotmotif'

vi.mock('./engine', () => ({ callPython: vi.fn() }))

function request(): DotMotifRequest {
  return {
    directed: true,
    query: 'A -> B',
    maxMatches: 3,
    maxRoles: 10,
    keyOfRow: new Int32Array([0, 1]),
    sources: new Int32Array([0]),
    targets: new Int32Array([1]),
    linkRows: new Int32Array([0]),
    nodes: {},
    edges: {},
  }
}

const reply = { count: 1, roles: ['A', 'B'], keys: new Int32Array([0, 1]) }

beforeEach(() => {
  vi.mocked(callPython).mockReset()
})

describe('DotMotif worker seam', () => {
  it('passes the request, cancellation and progress through, and reads the matches back', async () => {
    vi.mocked(callPython).mockResolvedValue({ ...reply })
    const options = { signal: new AbortController().signal, onProgress: vi.fn() }
    const sent = request()
    expect(await runDotMotif(sent, options)).toEqual({ ...reply, refused: false })
    expect(callPython).toHaveBeenCalledWith(
      { module: 'dotmotif', fn: 'coda_dotmotif_run', args: [sent] },
      options,
    )
  })

  it('accepts no matches', async () => {
    const empty = { count: 0, roles: ['A', 'B'], keys: new Int32Array(0) }
    vi.mocked(callPython).mockResolvedValue(empty)
    expect(await runDotMotif(request())).toEqual({ ...empty, refused: false })
  })

  it('passes a refusal through', async () => {
    vi.mocked(callPython).mockResolvedValue({
      ...reply,
      count: 0,
      keys: new Int32Array(0),
      refused: true,
    })
    expect((await runDotMotif(request())).refused).toBe(true)
  })

  it.each([
    ['a key per role per match', { keys: new Int32Array([0]) }],
    ['a key past the last node', { keys: new Int32Array([0, 2]) }],
    ['a negative key', { keys: new Int32Array([-1, 1]) }],
    ['roles that are not names', { roles: ['A', 2] }],
  ])('rejects %s', async (_, overrides) => {
    vi.mocked(callPython).mockResolvedValue({ ...reply, ...overrides })
    await expect(runDotMotif(request())).rejects.toThrow('invalid match table')
  })

  it('names a field that is the wrong kind of thing', async () => {
    vi.mocked(callPython).mockResolvedValue({ ...reply, keys: [0, 1] })
    await expect(runDotMotif(request())).rejects.toThrow('"keys"')
  })

  it('does not turn a cancellation or query failure into an empty successful result', async () => {
    const error = new DOMException('Cancelled', 'AbortError')
    vi.mocked(callPython).mockRejectedValue(error)
    await expect(runDotMotif(request())).rejects.toBe(error)
  })
})
