// @vitest-environment jsdom

/**
 * Who is told what's new. The card and the dot are thin readers of `decideWhatsNew`; the
 * decision is where the three kinds of visit are told apart, so it is what is pinned here.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { ChangelogEntry } from '../changelog/entries'
import { loadChangelogSeen, saveChangelogSeen } from '../changelog/seen'
import { clearStorage, installStorageStub } from '../test/jsdomStubs'
import { decideWhatsNew } from './whatsNew'

const entry = (date: string, highlight: boolean): ChangelogEntry => ({
  date,
  title: date,
  summary: 'Something changed.',
  highlight,
})

const ENTRIES = [
  entry('2026-10-20', false),
  entry('2026-10-10', true),
  entry('2026-10-01', true),
]

describe('decideWhatsNew', () => {
  /* A first visit records today's date at load; this is the case where storage refused it. */
  it('announces nothing on a first visit', () => {
    expect(decideWhatsNew(ENTRIES, undefined, false)).toEqual({ announce: [], unseen: false })
  })

  /* Everyone who used Coda before the changelog existed has no record, and is not new. */
  it('treats a returning reader with no record as having seen nothing', () => {
    const d = decideWhatsNew(ENTRIES, undefined, true)
    expect(d.announce.map((e) => e.date)).toEqual(['2026-10-10', '2026-10-01'])
    expect(d.unseen).toBe(true)
  })

  it('announces only highlighted updates newer than the last one seen', () => {
    const d = decideWhatsNew(ENTRIES, '2026-10-05', true)
    expect(d.announce.map((e) => e.date)).toEqual(['2026-10-10'])
  })

  /* A quiet update earns the dot and not the card. */
  it('marks an unhighlighted update as unseen without announcing it', () => {
    const d = decideWhatsNew(ENTRIES, '2026-10-10', true)
    expect(d.announce).toEqual([])
    expect(d.unseen).toBe(true)
  })

  it('is quiet once everything has been seen', () => {
    expect(decideWhatsNew(ENTRIES, '2026-10-20', true)).toEqual({ announce: [], unseen: false })
    expect(decideWhatsNew([], undefined, true)).toEqual({ announce: [], unseen: false })
  })
})

describe('the seen date', () => {
  beforeEach(() => {
    installStorageStub()
    clearStorage()
  })

  /* A stale tab closing an old card must not un-see what a newer tab recorded. */
  it('never moves backwards', () => {
    saveChangelogSeen('2026-10-10')
    saveChangelogSeen('2026-10-01')
    expect(loadChangelogSeen()).toBe('2026-10-10')
    saveChangelogSeen('2026-10-20')
    expect(loadChangelogSeen()).toBe('2026-10-20')
  })

  it('reads anything that is not a date as never recorded', () => {
    localStorage.setItem('coda.changelog.v1', 'yesterday')
    expect(loadChangelogSeen()).toBeUndefined()
  })
})
