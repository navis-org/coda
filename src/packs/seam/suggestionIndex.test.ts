/**
 * A directory of suggestion sets.
 *
 * The index exists because **a browser cannot list an HTTP directory** — there is no portable
 * way, so a pipeline depositing sets has to say what it deposited. What is worth pinning is the
 * part a reader cannot see go wrong: that two sets sharing an id is refused rather than resolving
 * to whichever came first, and that an address is recognised by what the document *is* rather
 * than by what it is called, so one field takes either kind.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  entryById,
  entryLabel,
  parseSuggestionIndex,
  suggestionsAddress,
} from './suggestionIndex'

const URL_ = 'https://example.invalid/seam/index.json'
const RAW = JSON.parse(
  readFileSync('src/packs/seam/__fixtures__/index.json', 'utf8'),
) as Record<string, unknown>

describe('an index', () => {
  it('reads every set, with what the picker needs to tell them apart', () => {
    const index = parseSuggestionIndex(RAW, URL_)
    expect(index.sets.map((s) => s.id)).toEqual(['rv2', 'rv2-mismatched'])
    const first = index.sets[0]!
    expect(first.path).toBe('fixture.json')
    expect(first.datastack).toBe('wclee_aedes_brain')
    expect([first.tips, first.shown, first.neurons]).toEqual([25, 10, 5])
  })

  /** A set's manifest resolves against the index's own address, as a model's files do. */
  it('resolves a set’s manifest against the index', () => {
    const index = parseSuggestionIndex(RAW, URL_)
    expect(new URL(entryById(index, 'rv2')!.path, index.url).toString()).toBe(
      'https://example.invalid/seam/fixture.json',
    )
  })

  /**
   * A card stores the id, so two sets sharing one make a pinned card ambiguous — and it would
   * resolve to whichever came first, silently, for as long as the index kept its order.
   */
  it('refuses two sets with one id', () => {
    const sets = [...(RAW.sets as unknown[]), { id: 'rv2', path: 'other/fixture.json' }]
    expect(() => parseSuggestionIndex({ sets }, URL_)).toThrow(/two sets are called "rv2"/)
  })

  it('names the set that is missing a field, by position', () => {
    expect(() => parseSuggestionIndex({ sets: [{ id: 'a' }] }, URL_)).toThrow(
      /set 1 needs an `id` and a `path`/,
    )
  })

  it('refuses a document with no sets list at all', () => {
    expect(() => parseSuggestionIndex({ pipeline: {} }, URL_)).toThrow(/needs a `sets` list/)
  })

  /** The dropdown's line: a set is chosen by what it covers, not by a path. */
  it('labels a set with what it holds', () => {
    const [first, second] = parseSuggestionIndex(RAW, URL_).sets
    expect(entryLabel(first!)).toContain('wclee_aedes_brain')
    expect(entryLabel(first!)).toContain('10 of 25 tips shown')
    expect(entryLabel(first!)).toContain('2026-11-04')
    // Everything but the label is optional; a sparse entry still draws a usable line.
    expect(entryLabel({ ...second!, datastack: undefined, tips: undefined })).toBe(
      'Aedes rv2, with counts that disagree · 2026-11-04',
    )
  })
})

/**
 * What somebody pastes is a directory, because the directory is what the card points at — it is
 * what their browser's address bar holds after they have looked at it. The index file's name is
 * Coda's convention rather than part of the address, so it is filled in rather than being a rule
 * every reader has to be told.
 */
describe('an address', () => {
  const BASE = 'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/suggestions/aedes'

  it('adds the index file to a directory, with or without the trailing slash', () => {
    expect(suggestionsAddress(`${BASE}/`)).toBe(`${BASE}/index.json`)
    expect(suggestionsAddress(BASE)).toBe(`${BASE}/index.json`)
    expect(suggestionsAddress(`  ${BASE}/  `)).toBe(`${BASE}/index.json`)
  })

  /** A segment with a dot is taken at its word — an index named something else still works. */
  it('leaves a file alone, whatever it is called', () => {
    expect(suggestionsAddress(`${BASE}/index.json`)).toBe(`${BASE}/index.json`)
    expect(suggestionsAddress(`${BASE}/rv2/fixture.json`)).toBe(`${BASE}/rv2/fixture.json`)
    expect(suggestionsAddress(`${BASE}/sets-2026.json`)).toBe(`${BASE}/sets-2026.json`)
  })

  it('keeps a query and a fragment where one is pasted with the directory', () => {
    expect(suggestionsAddress(`${BASE}/?v=2`)).toBe(`${BASE}/index.json?v=2`)
  })

  /** Not a URL is `validate`'s to complain about; rewriting it would only requote the nonsense. */
  it('leaves something that is not a URL as it is', () => {
    expect(suggestionsAddress('suggestions/aedes')).toBe('suggestions/aedes')
    expect(suggestionsAddress('   ')).toBe('')
  })
})
