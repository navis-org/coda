/**
 * When Suggest Merges reads each neuron (`momentsOf`): the moment each neuron is kept at in
 * `Searched at`, the present for one it has not met, the record written back before anything is
 * measured, and the run going on at moments it knows when the chunkedgraph cannot be asked. The
 * chunkedgraph calls are faked; `rootLives` and `momentWithin` have tests of their own.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EvalContext } from '../../core/node'
import { grapheneFor, rootLives } from '../../data/cave/rootIds'
import type { RootLife } from '../../data/cave/rootIds'
import type * as RootIds from '../../data/cave/rootIds'
import { DEFAULT_CAVE_SERVER } from '../../data/cave/deployments'
import { readSearchedAt } from './rootMoment'
import type { TipRow } from './searchTips'
import { momentsOf } from './suggestMerges'

vi.mock('../../data/cave/rootIds', async (importOriginal) => ({
  ...(await importOriginal<typeof RootIds>()),
  grapheneFor: vi.fn(),
  rootLives: vi.fn(),
}))
const graphene = vi.mocked(grapheneFor)
const lives = vi.mocked(rootLives)

const KEPT = Date.parse('2026-11-17T08:40:12.000Z')
const OLD = '648518347585551219'
const NEW = '720575940621039145'
const current = (made: number): RootLife => ({ made, last: Date.now(), current: true })

function ask(at: string, roots: string[] = [OLD]) {
  const warnings: string[] = []
  const recorded: Array<[string, unknown]> = []
  const ctx = {
    params: { at },
    signal: new AbortController().signal,
    warn: (text: string) => warnings.push(text),
    record: (param: string, value: unknown) => recorded.push([param, value]),
  } as unknown as EvalContext
  const target = {
    deployment: DEFAULT_CAVE_SERVER,
    datastack: 'wclee_aedes_brain',
    version: 564,
  }
  const rows = roots.map((neuronId) => ({ neuronId })) as TipRow[]
  return {
    warnings,
    recorded,
    moments: momentsOf(ctx, target, rows, { deployment: DEFAULT_CAVE_SERVER }),
  }
}

beforeEach(() => {
  graphene.mockReset()
  lives.mockReset()
  graphene.mockResolvedValue({ server: 'https://cave.example.org', table: 't', base: 'b' })
})

describe('the moment Suggest Merges searches each neuron at', () => {
  it('keeps a neuron at its moment, and meets a new one at the present, recording it', async () => {
    lives.mockResolvedValueOnce({
      lives: new Map([
        [OLD, current(KEPT - 60_000)],
        [NEW, current(KEPT - 60_000)],
      ]),
      unknown: [],
    })
    const before = Date.now()
    const { moments, recorded } = ask(`${OLD}=2026-11-17T08:40:12.000Z`, [OLD, NEW])
    const got = await moments
    expect(got.get(OLD)).toBe(KEPT)
    // The present, a little behind this clock (`FILL_BEHIND_MS`).
    expect(got.get(NEW)!).toBeLessThanOrEqual(before)
    expect(got.get(NEW)!).toBeGreaterThan(before - 60_000)
    // Written back whole: the old entry kept, the new one added at the moment it was searched.
    expect(recorded).toHaveLength(1)
    const [param, value] = recorded[0]!
    expect(param).toBe('at')
    expect(readSearchedAt(String(value)).moments).toEqual(
      new Map([
        [OLD, KEPT],
        [NEW, got.get(NEW)!],
      ]),
    )
  })

  it('records nothing where every neuron already has its moment', async () => {
    lives.mockResolvedValueOnce({
      lives: new Map([[OLD, current(KEPT - 60_000)]]),
      unknown: [],
    })
    const { recorded, moments } = ask(`${OLD}=2026-11-17T08:40:12.000Z`)
    expect((await moments).get(OLD)).toBe(KEPT)
    expect(recorded).toEqual([])
  })

  /**
   * The document that met this: saved by the first version, which kept one bare moment. Refused,
   * the card failed with a ⟳ it does not show; set aside, the run says so and heals the record.
   */
  it('sets aside what is not an entry, says so, and writes the record back without it', async () => {
    lives.mockResolvedValueOnce({
      lives: new Map([[OLD, current(KEPT - 60_000)]]),
      unknown: [],
    })
    const { moments, warnings, recorded } = ask('2026-11-17T09:57:40.098Z')
    const got = await moments
    expect(warnings.join(' ')).toMatch(
      /held “2026-11-17T09:57:40.098Z”, which is not a `root=moment` entry/,
    )
    expect(recorded).toHaveLength(1)
    expect(readSearchedAt(String(recorded[0]![1]))).toEqual({
      moments: new Map([[OLD, got.get(OLD)!]]),
      unread: [],
    })
  })

  /**
   * The record is enough: an entry the node wrote is inside the root's life and stays there. So a
   * fresh session — nothing asked of the chunkedgraph yet — goes on at it.
   */
  it('goes on at the record’s moments when the chunkedgraph cannot be asked, and says so', async () => {
    lives.mockRejectedValueOnce(new Error('CAVE returned 503'))
    const { moments, warnings, recorded } = ask(`${OLD}=2026-11-17T08:41:00.000Z`)
    expect((await moments).get(OLD)).toBe(Date.parse('2026-11-17T08:41:00.000Z'))
    expect(warnings.join(' ')).toMatch(/could not be asked \(CAVE returned 503\)/)
    expect(recorded).toEqual([])
  })

  it('fails as before where a neuron has no moment in the record', async () => {
    lives.mockRejectedValueOnce(new Error('CAVE returned 503'))
    const ends = ask(`${OLD}=2026-11-17T09:00:00.000Z`, [OLD, NEW]).moments
    await expect(ends).rejects.toThrow(/503/)
  })

  /** Said every run and never healed, the first version's line claimed a write that never came. */
  it('writes a set-aside entry away on the path that cannot ask the chunkedgraph too', async () => {
    lives.mockRejectedValueOnce(new Error('CAVE returned 503'))
    const { moments, recorded } = ask(
      `2026-11-17T09:57:40.098Z ${OLD}=2026-11-17T08:40:12.000Z`,
    )
    expect((await moments).get(OLD)).toBe(KEPT)
    expect(recorded).toEqual([['at', `${OLD}=2026-11-17T08:40:12.000Z`]])
  })

  /**
   * The proofreading loop: a merge mints a root, Update Root IDs brings it in, and the run starts
   * seconds later — after the root was made, but not after a present taken `FILL_BEHIND_MS` back.
   */
  it('says nothing of a new neuron made in the last few seconds', async () => {
    const made = Date.now() - 1_000
    lives.mockResolvedValueOnce({ lives: new Map([[NEW, current(made)]]), unknown: [] })
    const { moments, warnings } = ask('', [NEW])
    expect((await moments).get(NEW)).toBe(made + 1)
    expect(warnings).toEqual([])
  })

  /**
   * A moment before the root was made can only be typed by hand; the root is searched from when
   * it was made, and the record says so, so the run that cannot ask goes on at the same moment.
   */
  it('says a neuron was made after its moment, and records the moment it was searched at', async () => {
    lives.mockResolvedValueOnce({
      lives: new Map([[OLD, current(KEPT + 60_000)]]),
      unknown: [],
    })
    const { moments, warnings, recorded } = ask(`${OLD}=2026-11-17T08:40:12.000Z`)
    expect((await moments).get(OLD)).toBe(KEPT + 60_001)
    expect(warnings.join(' ')).toMatch(/made after its moment in `Searched at`/)
    expect(readSearchedAt(String(recorded[0]![1])).moments.get(OLD)).toBe(KEPT + 60_001)
  })

  it('says a neuron edited after its moment was searched at it, before the edit', async () => {
    const edited = { made: KEPT - 60_000, last: KEPT + 10_000, current: false }
    lives.mockResolvedValueOnce({ lives: new Map([[OLD, edited]]), unknown: [] })
    const { warnings, moments } = ask(`${OLD}=2026-11-17T08:40:12.000Z`)
    expect((await moments).get(OLD)).toBe(KEPT)
    expect(warnings.join(' ')).toMatch(
      /searched at the moment in `Searched at`, before that edit/,
    )
  })
})
