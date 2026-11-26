/**
 * The split gallery's write (`splitWrite.ts`) against faked servers — never a chunkedgraph
 * (`src/test/writeGuard.ts` fails a test that reaches one). Pinned: the checks before a send stop
 * it; a one-edge cut is sent as it is, each edge from side `a`; a longer one as the server's own
 * min-cut between its sides, and only where the preview of that cut agrees with the tile; one new
 * root, or the sides' ends under one root, is reported as the edit to undo; a lost reply is never
 * resent.
 */

import { describe, expect, it, vi } from 'vitest'

import type { ConfirmedSplit, DoneEdit, EditOutcome } from '../../data/cave/edits'
import type { MergeEnd } from '../../data/cave/merge'
import { parseGrapheneSource } from '../../data/cave/graphene'
import { toy, TWO_NEURONS, withNodeIds } from './__fixtures__/splitToy'
import type { SplitCandidate } from './splitGallery'
import { splitCandidates } from './splitGallery'
import type { SplitStep, SplitWriteServices } from './splitWrite'
import { writeSplit } from './splitWrite'

const GRAPHENE = parseGrapheneSource(
  'graphene://https://cave.fanc-fly.com/segmentation/table/mar2021_test',
)!
const ROOT = '720575940000000001'
const INPUT = withNodeIds(toy({ ...TWO_NEURONS, svs: 24 }))
const CANDIDATE: SplitCandidate = [...splitCandidates(INPUT)].find(Boolean)!
/** The two neurons joined at two contacts: a cut of two edges, sent as a min-cut. */
const TWICE = withNodeIds(
  toy({
    ...TWO_NEURONS,
    contacts: [
      ['A2', 'B2', 0.1],
      ['A3', 'B3', 0.1],
    ],
    svs: 24,
  }),
)
const TWO_EDGES: SplitCandidate = [...splitCandidates(TWICE)].find(
  (c) => c !== undefined && c.cut.length === 2,
)!
/** The supervoxels of each chain in `TWICE`, as a preview would list the two pieces. */
const chain = (input: typeof TWICE, name: string) =>
  [...input.members].filter(([chunk]) => chunk.startsWith(name)).flatMap(([, svs]) => svs)
const AS = { deployment: 'https://global.daf-apis.com' }

const done = (...newRootIds: string[]): DoneEdit => ({
  kind: 'done',
  operationId: '4219',
  newRootIds,
})

/**
 * Servers that may edit, with the root current, which split as `answer` says, and afterwards put
 * each end under `after(sv, side)` — by default the source side under `A`, the sink side under `B`.
 */
function servers(
  answer: EditOutcome = done('A', 'B'),
  after: (side: 'source' | 'sink') => string = (side) => (side === 'source' ? 'A' : 'B'),
) {
  const sent: ConfirmedSplit[] = []
  const services = {
    permission: vi.fn(() =>
      Promise.resolve({ dataset: 'fanc', mayEdit: true, termsPending: false }),
    ),
    latest: vi.fn(() => Promise.resolve([true])),
    roots: vi.fn((_: unknown, svs: readonly string[]) => {
      const sources = new Set(sent.flatMap((s) => s.sources.map((end) => end.supervoxel)))
      return Promise.resolve(svs.map((sv) => after(sources.has(sv) ? 'source' : 'sink')))
    }),
    // The server's cut as the tile's: chain A with the sources, chain B with the sinks.
    preview: vi.fn((_: unknown, sources: readonly MergeEnd[]) => {
      const aFirst = chain(TWICE, 'A').includes(sources[0]!.supervoxel)
      const [a, b] = [chain(TWICE, 'A'), chain(TWICE, 'B')]
      return Promise.resolve({ pieces: aFirst ? [a, b] : [b, a], illegal: false })
    }),
    send: vi.fn((split: ConfirmedSplit) => {
      sent.push(split)
      return Promise.resolve(answer)
    }),
    undo: vi.fn(() => Promise.resolve(done('C'))),
  } satisfies SplitWriteServices
  return { services, sent }
}

const write = (services: SplitWriteServices, steps: SplitStep[] = []) =>
  writeSplit(
    { graphene: GRAPHENE, root: ROOT, input: INPUT, candidate: CANDIDATE },
    AS,
    (step) => steps.push(step),
    services,
  )

describe('writeSplit', () => {
  it('checks, then sends the cut once, each edge from side a, and names the kept root', async () => {
    const { services, sent } = servers()
    const steps: SplitStep[] = []
    const result = await write(services, steps)

    expect(steps).toEqual(['checking', 'splitting', 'reading'])
    expect(services.send).toHaveBeenCalledTimes(1)
    // One edge: sent as it is, the min-cut off, no preview asked.
    expect(CANDIDATE.cut).toHaveLength(1)
    expect(sent[0]!.mincut).toBe(false)
    expect(services.preview).not.toHaveBeenCalled()
    const pairs = sent[0]!.sources.map((end, i) =>
      [end.supervoxel, sent[0]!.sinks[i]!.supervoxel].sort(),
    )
    const cut = CANDIDATE.cut.map((e) => [e.source, e.sink].sort())
    expect(pairs).toEqual(cut)
    // Each end placed at its chunk's point: only logged by the server, but a real place.
    for (const end of sent[0]!.sources) expect(end.positionNm).toHaveLength(3)
    const keptSide = CANDIDATE.sizes.a >= CANDIDATE.sizes.b ? 'A' : 'B'
    expect(result).toMatchObject({ kind: 'split', kept: keptSide })
    expect(result.kind === 'split' && result.taken).toEqual([keptSide === 'A' ? 'B' : 'A'])
  })

  const writeTwo = (services: SplitWriteServices) =>
    writeSplit(
      { graphene: GRAPHENE, root: ROOT, input: TWICE, candidate: TWO_EDGES },
      AS,
      () => undefined,
      services,
    )

  /** pychunkedgraph refuses an exact split of two or more edges (a 500 before writing). */
  it('sends a longer cut as the server’s min-cut between its sides, once the preview agrees', async () => {
    const { services, sent } = servers()
    const result = await writeTwo(services)
    expect(services.preview).toHaveBeenCalledTimes(1)
    expect(sent[0]!.mincut).toBe(true)
    const side = (svs: readonly MergeEnd[]) => new Set(svs.map((end) => end.supervoxel))
    const ends = TWO_EDGES.cut.flatMap((e) => [e.source, e.sink])
    expect([...side(sent[0]!.sources), ...side(sent[0]!.sinks)].sort()).toEqual(
      [...new Set(ends)].sort(),
    )
    expect(result.kind).toBe('split')
  })

  it('sends nothing where the server’s min-cut would cut elsewhere, or refuse', async () => {
    const astray = servers()
    // One of chain B's supervoxels on the sources' side.
    astray.services.preview.mockImplementation((_: unknown, sources: readonly MergeEnd[]) => {
      const [a, b] = [chain(TWICE, 'A'), chain(TWICE, 'B')]
      const aFirst = a.includes(sources[0]!.supervoxel)
      const [first, second] = aFirst ? [a, b] : [b, a]
      return Promise.resolve({
        pieces: [[...first, second.at(-1)!], second.slice(0, -1)],
        illegal: false,
      })
    })
    expect(await writeTwo(astray.services)).toMatchObject({
      kind: 'not-sent',
      message: expect.stringMatching(/would differ from this split's by \d+ edges?/),
    })
    // A third piece breaking chain A in two: more edges cut than the tile's.
    const broken = servers()
    broken.services.preview.mockImplementation((_: unknown, sources: readonly MergeEnd[]) => {
      const [a, b] = [chain(TWICE, 'A'), chain(TWICE, 'B')]
      const aFirst = a.includes(sources[0]!.supervoxel)
      const tail = a.filter((sv) => sv.startsWith('7') && a.indexOf(sv) >= a.length - 3)
      const head = a.filter((sv) => !tail.includes(sv))
      return Promise.resolve({
        pieces: aFirst ? [head, b, tail] : [b, head, tail],
        illegal: false,
      })
    })
    expect((await writeTwo(broken.services)).kind).toBe('not-sent')
    // A supervoxel the box never read: nothing there can be checked.
    const beyond = servers()
    beyond.services.preview.mockImplementation((_: unknown, sources: readonly MergeEnd[]) => {
      const [a, b] = [chain(TWICE, 'A'), chain(TWICE, 'B')]
      const aFirst = a.includes(sources[0]!.supervoxel)
      const [first, second] = aFirst ? [a, b] : [b, a]
      return Promise.resolve({
        pieces: [[...first, '73747834149376000'], second],
        illegal: false,
      })
    })
    expect(await writeTwo(beyond.services)).toMatchObject({
      kind: 'not-sent',
      message: expect.stringMatching(/reach past the part of the neuron Coda read/),
    })
    const illegal = servers()
    illegal.services.preview.mockResolvedValue({ pieces: [[], []], illegal: true })
    expect((await writeTwo(illegal.services)).kind).toBe('not-sent')
    const failed = servers()
    failed.services.preview.mockRejectedValue(new Error('Mincut failed'))
    expect(await writeTwo(failed.services)).toMatchObject({
      kind: 'not-sent',
      message: expect.stringMatching(/Mincut failed/),
    })
    for (const { services } of [astray, broken, beyond, illegal, failed])
      expect(services.send).not.toHaveBeenCalled()
  })

  it('sends nothing where the reader may not edit, or the root has moved on', async () => {
    const denied = servers()
    denied.services.permission.mockResolvedValue({
      dataset: 'fanc',
      mayEdit: false,
      termsPending: false,
    })
    expect(await write(denied.services)).toMatchObject({
      kind: 'not-sent',
      message: expect.stringMatching(/may not edit fanc/),
    })
    const stale = servers()
    stale.services.latest.mockResolvedValue([false])
    expect(await write(stale.services)).toMatchObject({
      kind: 'not-sent',
      message: expect.stringMatching(/edited since/),
    })
    const broken = servers()
    broken.services.latest.mockRejectedValue(new Error('503'))
    expect((await write(broken.services)).kind).toBe('not-sent')
    for (const { services } of [denied, stale, broken])
      expect(services.send).not.toHaveBeenCalled()
  })

  it('sends nothing for a cut that does not separate the neuron', async () => {
    const { services } = servers()
    const result = await writeSplit(
      {
        graphene: GRAPHENE,
        root: ROOT,
        input: INPUT,
        candidate: { ...CANDIDATE, cut: CANDIDATE.cut.slice(0, 0) },
      },
      AS,
      () => undefined,
      services,
    )
    expect(result.kind).toBe('not-sent')
    expect(services.send).not.toHaveBeenCalled()
  })

  /** The server writes one root where the edges do not separate: an edit, not a refusal. */
  it('reports one new root as the edit to undo', async () => {
    const { services } = servers(done('A'), () => 'A')
    const result = await write(services)
    expect(result).toMatchObject({
      kind: 'joined',
      message: expect.stringMatching(/one piece/),
    })
    expect(result.kind === 'joined' && result.done.operationId).toBe('4219')
  })

  it('reports both sides’ ends under one root as the edit to undo', async () => {
    const { services } = servers(done('A', 'B'), () => 'A')
    expect((await write(services)).kind).toBe('joined')
  })

  it('does not take success where every end is still under the old root, but keeps the edit to undo', async () => {
    const { services } = servers(done('A', 'B'), () => ROOT)
    expect(await write(services)).toMatchObject({
      kind: 'unknown',
      done: { operationId: '4219' },
    })
  })

  /** A cut that also breaks off a third piece: an end there is on neither side, never its chunk's. */
  it('sends nothing where an end of the cut is on neither side', async () => {
    const { services } = servers()
    const plain = toy({ ...TWO_NEURONS, svs: 24 })
    const edge = (source: string, sink: string) => ({
      source,
      sink,
      affinity: 0,
      area: 0,
      userMerge: false,
    })
    // A4 and the A5 beyond it, cut from A3 as well as A from B: three pieces.
    const cut = [edge('A2.0', 'B2.0'), edge('A3.23', 'A4.0')]
    const result = await writeSplit(
      { graphene: GRAPHENE, root: ROOT, input: plain, candidate: { ...CANDIDATE, cut } },
      AS,
      () => undefined,
      services,
    )
    expect(result).toMatchObject({
      kind: 'not-sent',
      message: expect.stringMatching(/A3\.23–A4\.0 does not run between the two sides/),
    })
    expect(services.send).not.toHaveBeenCalled()
  })

  it('reads a lost reply as not known, and never sends again', async () => {
    const { services } = servers({ kind: 'unknown', message: 'timed out' })
    const result = await write(services)
    expect(result).toMatchObject({
      kind: 'unknown',
      message: expect.stringMatching(/not sent again/),
    })
    expect(services.send).toHaveBeenCalledTimes(1)
  })

  /** No answer within the limit: the gallery is not held for good, and nothing is resent. */
  it('stops waiting for a send that never answers, and reads it as not known', async () => {
    const { services } = servers()
    services.send.mockReturnValue(new Promise(() => undefined))
    const result = await write({ ...services, sendTimeoutMs: 5 })
    expect(result).toMatchObject({
      kind: 'unknown',
      message: expect.stringMatching(/no answer/),
    })
    expect(services.send).toHaveBeenCalledTimes(1)
  })

  it('passes a refusal on in the server’s words', async () => {
    const { services } = servers({ kind: 'refused', status: 400, message: 'Locked' })
    expect(await write(services)).toEqual({ kind: 'refused', message: 'Refused (400): Locked' })
    expect(services.roots).not.toHaveBeenCalled()
  })
})
