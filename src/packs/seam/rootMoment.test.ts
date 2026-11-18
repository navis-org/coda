/**
 * When a SEAM node reads each neuron (`momentsFrom`, over `momentWithin`), and how it says so.
 *
 * The moments are measured facts about one server (Aedes, 2026-11-17): a root is not current at
 * its own creation time and is a millisecond after, and `RootLife.last` is already a moment it
 * was current. A rule that read either edge one millisecond wrong would ask about a root that did
 * not exist, which the live services answer with nothing at all.
 */

import { describe, expect, it } from 'vitest'

import type { RootLife } from '../../data/cave/rootIds'
import { momentWithin } from '../../data/cave/rootIds'
import {
  editedSince,
  momentsFrom,
  notRoots,
  readSearchedAt,
  utcMinute,
  writeSearchedAt,
} from './rootMoment'

const MADE = 1_794_901_115_922
const LAST = 1_794_903_754_257
const life = (over: Partial<RootLife> = {}): RootLife => ({
  made: MADE,
  last: LAST,
  current: true,
  ...over,
})

describe('the moment a root is read at', () => {
  it('is the wanted moment where the root was current then', () => {
    expect(momentWithin(life(), MADE + 5000)).toBe(MADE + 5000)
  })

  it('is a millisecond after it was made, where it was made later', () => {
    expect(momentWithin(life(), MADE - 60_000)).toBe(MADE + 1)
    expect(momentWithin(life(), MADE)).toBe(MADE + 1)
  })

  it('is its last current moment, where it was replaced before the wanted one', () => {
    expect(momentWithin(life({ current: false }), LAST + 60_000)).toBe(LAST)
  })
})

describe('each neuron’s moment, and what is said about it', () => {
  const lives = new Map([
    ['current', life({ made: MADE - 10_000 })],
    ['madeLater', life({ made: MADE + 5_000 })],
    ['replacedBefore', life({ made: MADE - 10_000, last: MADE - 1_000, current: false })],
    ['replacedAfter', life({ made: MADE - 10_000, last: MADE + 9_000, current: false })],
  ])

  it('moves the wanted moment into each root’s life, and lists the two a reader is told of', () => {
    const { moments, editedBefore, editedAfter, later } = momentsFrom(lives, () => MADE)
    expect(Object.fromEntries(moments)).toEqual({
      current: MADE,
      madeLater: MADE + 5_001,
      replacedBefore: MADE - 1_000,
      // Replaced after the wanted moment: read at it, but the neuron has changed since.
      replacedAfter: MADE,
    })
    expect([...editedBefore.keys()]).toEqual(['replacedBefore'])
    expect([...editedAfter.keys()]).toEqual(['replacedAfter'])
    expect(later).toEqual(['madeLater'])
  })
})

describe('the wording', () => {
  it('names a moment to the minute, in UTC, as CAVE stamps read', () => {
    expect(utcMinute(Date.UTC(2026, 10, 17, 7, 37, 49, 71))).toBe('2026-11-17 07:37 UTC')
  })

  it('agrees with one neuron and with several', () => {
    const at = Date.UTC(2026, 10, 17, 7, 37)
    expect(editedSince(new Map([['1', at]]))).toBe(
      'This neuron has been edited since: 1 (current until 2026-11-17 07:37 UTC).',
    )
    expect(
      editedSince(
        new Map([
          ['1', at],
          ['2', at],
        ]),
      ),
    ).toMatch(/^These neurons have/)
    expect(notRoots(['1'], 'ds')).toBe('1 is not a root ds’s chunkedgraph knows')
    expect(notRoots(['1', '2'], 'ds')).toBe('1, 2 are not roots ds’s chunkedgraph knows')
  })
})

describe('the record of each neuron’s moment', () => {
  it('reads back what it writes, to the millisecond, in order', () => {
    const moments = new Map([
      ['648518347585551219', Date.UTC(2026, 10, 17, 8, 40, 12, 345)],
      ['648518347558097460', Date.UTC(2026, 10, 17, 7, 37, 49, 71)],
    ])
    const text = writeSearchedAt(moments)
    expect(text).toBe(
      '648518347585551219=2026-11-17T08:40:12.345Z, 648518347558097460=2026-11-17T07:37:49.071Z',
    )
    expect(readSearchedAt(text)).toEqual({ moments, unread: [] })
    expect(readSearchedAt('')).toEqual({ moments: new Map(), unread: [] })
  })

  /**
   * The node keeps it, so a malformed entry was edited by hand or written by an older build — a
   * document from 2026-11-17 holds a single bare moment. Handed back to be said and dropped, not
   * thrown: a failed card has no ⟳ to press.
   */
  it.each(['2026-11-17T08:40:12Z', '1=yesterday', '1=2026-11-17T08:40:12Z=2', '=2026-11-17'])(
    'sets aside “%s”, which is not a root=moment entry, and reads the rest',
    (bad) => {
      expect(readSearchedAt(`${bad}, 7=2026-11-17T08:40:12.000Z`)).toEqual({
        moments: new Map([['7', Date.parse('2026-11-17T08:40:12.000Z')]]),
        unread: [bad],
      })
    },
  )

  /** The help says UTC, and a moment typed without an offset is read as one, not as local time. */
  it('reads a moment that names no offset as UTC', () => {
    expect(readSearchedAt('7=2026-11-17T08:40').moments.get('7')).toBe(
      Date.UTC(2026, 10, 17, 8, 40),
    )
  })
})
