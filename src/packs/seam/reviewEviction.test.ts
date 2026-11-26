/**
 * How much review work a card keeps (`reviewEviction.ts`): the full work of the last
 * `KEPT_NEURONS` neurons worked on, decided from the params at a write.
 */

import { describe, expect, it } from 'vitest'

import { decodePicks, encodePicks } from './handPicks'
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

  /**
   * Only what the list names is a neuron (user, 2026-11-22): work it does not name — from before
   * it existed, or on a piece Auto-extend took — is never counted, and never cleared on its own.
   */
  it('never counts or clears work the list does not name', () => {
    const ids = range(KEPT_NEURONS + 2)
    const params = { ...workOn(ids), recent: neuron(5) }
    const done = withRecentWork(params, neuron(KEPT_NEURONS + 2), {})
    expect(done.evicted).toEqual([])
    expect(decodeRecent(done.write['recent'])).toEqual([neuron(5), neuron(KEPT_NEURONS + 2)])
    // Past ten listed, the oldest listed goes, and the unnamed work stays.
    const listed = { ...params, recent: range(KEPT_NEURONS).map(neuron).join(';') }
    const next = withRecentWork(listed, neuron(KEPT_NEURONS + 2), {})
    expect(next.evicted).toEqual([neuron(1)])
    const after = { ...listed, ...next.write }
    expect(judgedNeurons(after).has(neuron(1))).toBe(false)
    expect(judgedNeurons(after).has(neuron(KEPT_NEURONS + 1))).toBe(true)
  })

  /** A neuron can be another's candidate: rejected there, it is still a neuron (review, 2026-11-22). */
  it('keeps a listed neuron listed, where another neuron rejected it as a candidate', () => {
    const ids = range(KEPT_NEURONS)
    const work = workOn(ids)
    const params = {
      ...work,
      verdicts: encodeVerdicts(
        new Map([...decodeVerdicts(work.verdicts), [`${neuron(2)}/${neuron(1)}`, 'reject']]),
      ),
      recent: ids.map(neuron).join(';'),
    }
    const write = {
      verdicts: encodeVerdicts(
        new Map([
          ...decodeVerdicts(params.verdicts),
          [`${neuron(2)}/${piece(2, 9)}`, 'reject'],
        ]),
      ),
    }
    const done = withRecentWork(params, neuron(2), write)
    expect(done.evicted).toEqual([])
    expect(decodeRecent(done.write['recent'] ?? params.recent)).toContain(neuron(1))
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
    // An eleventh neuron drops neuron 1, and neuron 10's waiting verdicts stay with it. Its first
    // work is added to what is there, as the card writes it: never a rewrite of other neurons'.
    const eleventh = workOn([11])
    const write = {
      verdicts: encodeVerdicts(
        new Map([...decodeVerdicts(back.verdicts), ...decodeVerdicts(eleventh.verdicts)]),
      ),
      extend: `${back.extend};${eleventh.extend}`,
      autoRoots: `${back.autoRoots};${eleventh.autoRoots}`,
      autoRefused: `${back.autoRefused};${eleventh.autoRefused}`,
    }
    const next = withRecentWork({ ...back, ...done.write }, neuron(11), write)
    expect(next.evicted).toEqual([neuron(1)])
    const after = decodeVerdicts(next.write['verdicts'])
    expect(after.get(`${piece(10, 1)}/${piece(10, 2)}`)).toBe('accept')
  })

  /**
   * A piece Auto-extend took has no stored pair: its accept is the search's, not a verdict. With
   * verdicts on its own candidates it looked like a neuron, so ten of them filled the card, and a
   * first verdict on an eleventh was cleared in the edit that wrote it (user, 2026-11-22).
   */
  describe('a piece Auto-extend took', () => {
    const n = neuron(1)
    const taken = range(KEPT_NEURONS + 1).map((j) => piece(1, j + 10))
    // A verdict on a candidate of each of the first ten, and the neuron listed alone.
    const params = {
      ...workOn([1]),
      verdicts: encodeVerdicts(
        new Map([
          ...decodeVerdicts(workOn([1]).verdicts),
          ...taken
            .slice(0, -1)
            .map((id): [string, 'reject'] => [`${id}/${piece(9, 9)}`, 'reject']),
        ]),
      ),
      recent: n,
    }
    const last = taken.at(-1)!
    const press = {
      verdicts: encodeVerdicts(
        new Map([...decodeVerdicts(params.verdicts), [`${last}/${piece(9, 8)}`, 'reject']]),
      ),
    }
    const known = taken.map((id) => `${n}/${id}`)

    it('is the neuron’s, told by the card, and never one of its own', () => {
      const done = withRecentWork(params, n, press, known)
      expect(done.evicted).toEqual([])
      expect(decodeRecent(done.write['recent'] ?? params.recent)).toEqual([n])
    })

    it('keeps the verdict being written, even where the card cannot say whose it is', () => {
      // As the user's card had it: the list full of pieces earlier writes put there as neurons,
      // so the piece judged now was the one id it did not name — and was cleared first.
      const full = { ...params, recent: [...taken.slice(0, KEPT_NEURONS - 1), n].join(';') }
      const done = withRecentWork(full, n, press)
      expect(done.evicted).not.toContain(last)
      const after = decodeVerdicts(done.write['verdicts'] ?? press.verdicts)
      expect(after.get(`${last}/${piece(9, 8)}`)).toBe('reject')
      expect(decodeRecent(done.write['recent'])).not.toContain(last)
    })

    it('leaves the list, where a write put it in as a neuron', () => {
      const listed = { ...params, recent: [...taken.slice(0, 3), n].join(';') }
      const done = withRecentWork(listed, n, press, known)
      expect(decodeRecent(done.write['recent'])).toEqual([n])
    })
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

describe('hand picks', () => {
  it('go with their neuron, on it or on a piece of it, and stay with a kept one', () => {
    const ids = range(KEPT_NEURONS + 1)
    const pick = (i: number, root: string, n: number) => ({
      n,
      seed: neuron(i),
      root,
      candidateId: piece(i, 7),
      contactNm: [1, 2, 3] as const,
      gapUm: 0.1,
      l2Chunks: undefined,
    })
    const params = {
      ...workOn(ids),
      recent: ids.slice(0, KEPT_NEURONS).map(neuron).join(';'),
      picks: encodePicks([
        pick(1, neuron(1), 1),
        pick(1, piece(1, 1), 2),
        pick(2, piece(2, 1), 3),
      ]),
    }
    const done = withRecentWork(params, neuron(KEPT_NEURONS + 1), {})
    expect(done.evicted).toEqual([neuron(1)])
    expect(decodePicks(done.write['picks']).map((one) => one.n)).toEqual([3])
  })
})
