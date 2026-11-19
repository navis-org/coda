/**
 * How much review work a card keeps (`reviewEviction.ts`): the full work of the last
 * `KEPT_NEURONS` neurons worked on, decided from the params at a write.
 */

import { describe, expect, it } from 'vitest'

import { KEPT_NEURONS, decodeRecent, withRecentWork } from './reviewEviction'
import { decodeExtend, decodeVerdicts, encodeVerdicts } from './reviewQueue'

/** Neuron `i`'s id, and a piece of it. */
const neuron = (i: number) => `72057594000000${String(i).padStart(4, '0')}`
const piece = (i: number, j: number) => `64851834600${String(i).padStart(4, '0')}${j}`

/** One accepted, extended piece per neuron, a verdict on that piece's own candidate, a refusal. */
function workOn(ids: readonly number[]): {
  verdicts: string
  extend: string
  autoRoots: string
  autoRefused: string
} {
  const verdicts = new Map<string, 'accept' | 'reject'>()
  const extend: string[] = []
  const refused: string[] = []
  for (const i of ids) {
    verdicts.set(`${neuron(i)}/${piece(i, 1)}`, 'accept')
    verdicts.set(`${piece(i, 1)}/${piece(i, 2)}`, 'accept')
    verdicts.set(`${neuron(i)}/${piece(i, 3)}`, 'reject')
    extend.push(`${neuron(i)}/${piece(i, 1)}`)
    refused.push(`${neuron(i)}/${piece(i, 3)}`)
  }
  return {
    verdicts: encodeVerdicts(verdicts),
    extend: extend.join(';'),
    autoRoots: extend.join(';'),
    autoRefused: refused.join(';'),
  }
}

/** The neurons whose verdicts a write leaves. */
const judgedNeurons = (params: Record<string, unknown>) =>
  new Set([...decodeVerdicts(params['verdicts']).keys()].map((key) => key.split('/')[0]))

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

describe('the work a review card keeps', () => {
  it('lists the neuron a write is for, last, and takes nothing while there is room', () => {
    const params = { ...workOn([1, 2]), recent: neuron(1) }
    const write = { verdicts: params.verdicts }
    const done = withRecentWork(params, neuron(2), write)
    expect(decodeRecent(done.write['recent'])).toEqual([neuron(1), neuron(2)])
    expect(done.evicted).toEqual([])
    expect(done.write['verdicts']).toBe(params.verdicts)
  })

  it('writes nothing more where the neuron is already the last', () => {
    const params = { ...workOn([1]), recent: neuron(1) }
    const write = { verdicts: params.verdicts }
    expect(withRecentWork(params, neuron(1), write).write).toEqual(write)
  })

  it(`clears the oldest neuron's work, pieces and all, past ${KEPT_NEURONS}`, () => {
    const ids = range(KEPT_NEURONS + 1)
    const params = {
      ...workOn(ids),
      recent: ids.slice(0, KEPT_NEURONS).map(neuron).join(';'),
    }
    const done = withRecentWork(params, neuron(KEPT_NEURONS + 1), {})
    expect(done.evicted).toEqual([neuron(1)])
    const after = { ...params, ...done.write }
    // Neuron 1's verdicts go, the one on its piece's own candidate too.
    expect(judgedNeurons(after).has(neuron(1))).toBe(false)
    expect(judgedNeurons(after).has(piece(1, 1))).toBe(false)
    expect(judgedNeurons(after).has(neuron(2))).toBe(true)
    for (const id of ['extend', 'autoRoots', 'autoRefused']) {
      expect(
        [...decodeExtend(after[id as keyof typeof after])].some((key) =>
          key.startsWith(neuron(1)),
        ),
      ).toBe(false)
      expect(decodeExtend(after[id as keyof typeof after]).size).toBe(KEPT_NEURONS)
    }
    expect(decodeRecent(after.recent)).toEqual(
      range(KEPT_NEURONS + 1)
        .slice(1)
        .map(neuron),
    )
  })

  it('keeps a neuron worked on again, and clears the next oldest instead', () => {
    const ids = range(KEPT_NEURONS)
    const params = { ...workOn(ids), recent: ids.map(neuron).join(';') }
    const again = withRecentWork(params, neuron(1), {})
    expect(again.evicted).toEqual([])
    const next = { ...params, ...again.write }
    // The first verdict on an eleventh neuron.
    const done = withRecentWork(next, neuron(KEPT_NEURONS + 1), workOn(range(KEPT_NEURONS + 1)))
    expect(done.evicted).toEqual([neuron(2)])
  })

  /** Work from before the list existed is older than anything it names. */
  it('counts a neuron the list does not name as older than every one it does', () => {
    const ids = range(KEPT_NEURONS + 2)
    const params = { ...workOn(ids), recent: neuron(5) }
    const done = withRecentWork(params, neuron(KEPT_NEURONS + 2), {})
    expect(done.evicted).toEqual([neuron(1), neuron(2)])
    expect(decodeRecent(done.write['recent'])).toContain(neuron(5))
  })

  it('keeps a pair a kept neuron reaches, whoever it was given on', () => {
    const ids = range(KEPT_NEURONS + 1)
    const params = { ...workOn(ids), recent: ids.slice(0, KEPT_NEURONS).map(neuron).join(';') }
    // Neuron 2 also took neuron 1's piece, and extended it.
    const shared = {
      ...params,
      extend: `${params.extend};${neuron(2)}/${piece(1, 1)}`,
      verdicts: encodeVerdicts(
        new Map([
          ...decodeVerdicts(params.verdicts),
          [`${neuron(2)}/${piece(1, 1)}`, 'accept'],
        ]),
      ),
    }
    const after = { ...shared, ...withRecentWork(shared, neuron(KEPT_NEURONS + 1), {}).write }
    expect(decodeVerdicts(after.verdicts).get(`${piece(1, 1)}/${piece(1, 2)}`)).toBe('accept')
    expect(decodeVerdicts(after.verdicts).has(`${neuron(1)}/${piece(1, 1)}`)).toBe(false)
  })

  /** Its accept taken back, a piece leaves `extend`; the verdicts naming it say it is a piece. */
  it('never counts a piece taken back as a neuron, and keeps what waits on it', () => {
    const ids = range(KEPT_NEURONS)
    const params = { ...workOn(ids), recent: ids.map(neuron).join(';') }
    // Neuron 10's piece is rejected now: out of the extended pairs, its own verdicts waiting.
    const back = {
      ...params,
      verdicts: encodeVerdicts(
        new Map([
          ...decodeVerdicts(params.verdicts),
          [`${neuron(10)}/${piece(10, 1)}`, 'reject'],
        ]),
      ),
      extend: [...decodeExtend(params.extend)]
        .filter((key) => !key.startsWith(neuron(10)))
        .join(';'),
      autoRoots: [...decodeExtend(params.autoRoots)]
        .filter((key) => !key.startsWith(neuron(10)))
        .join(';'),
    }
    const done = withRecentWork(back, neuron(10), {})
    expect(done.evicted).toEqual([])
    expect(decodeRecent(done.write['recent'] ?? back.recent)).not.toContain(piece(10, 1))
    // An eleventh neuron drops neuron 1, and neuron 10's waiting verdicts stay with it.
    const next = withRecentWork({ ...back, ...done.write }, neuron(11), workOn([...ids, 11]))
    expect(next.evicted).toEqual([neuron(1)])
    const after = decodeVerdicts(next.write['verdicts'])
    expect(after.get(`${piece(10, 1)}/${piece(10, 2)}`)).toBe('accept')
  })

  it('leaves the write alone where no neuron is picked', () => {
    const params = workOn(range(KEPT_NEURONS + 3))
    const write = { verdicts: 'x' }
    expect(withRecentWork(params, undefined, write)).toEqual({
      write,
      evicted: [],
    })
  })

  it('takes the write it is given into account, before deciding', () => {
    const ids = range(KEPT_NEURONS)
    const params = { ...workOn(ids), recent: ids.map(neuron).join(';') }
    // A first verdict on an eleventh neuron, written by this very press.
    const write = workOn([...ids, KEPT_NEURONS + 1])
    const done = withRecentWork(params, neuron(KEPT_NEURONS + 1), write)
    expect(done.evicted).toEqual([neuron(1)])
    expect(judgedNeurons({ ...params, ...done.write }).has(neuron(KEPT_NEURONS + 1))).toBe(true)
  })
})
