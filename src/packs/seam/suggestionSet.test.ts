/**
 * The suggestion set's manifest.
 *
 * Most of what this parser does is refuse, and the reason is that the thing a reader is most
 * likely to have done is paste the wrong address — a model manifest, a directory listing, a
 * sign-in page that happened to parse. Each refusal names the field, so the sentence says which
 * kind of JSON arrived rather than "could not read the set".
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { fileUrl, loadSuggestionSet, parseSuggestionSet } from './suggestionSet'

const URL_ = 'https://example.invalid/coda_rv2/fixture.json'
const RAW = JSON.parse(
  readFileSync('src/packs/seam/__fixtures__/fixture.json', 'utf8'),
) as Record<string, unknown> & { neurons: string[] }

const parse = (patch: Record<string, unknown> = {}) =>
  parseSuggestionSet({ ...RAW, ...patch }, URL_)

describe('a manifest', () => {
  it('reads SEAM’s own fixture.json unchanged', () => {
    const set = parse()
    expect(set.datastack).toBe('wclee_aedes_brain')
    expect(set.neurons.length).toBe(5)
    expect(set.snapshot).toContain('2026-11-04')
    expect(set.commit).toMatch(/^[0-9a-f]{7,}/)
  })

  /**
   * The cutoff is read, never written down. SEAM refits it whenever a stage changes, so a
   * hard-coded 0.2084 would be right today and quietly wrong after the next run.
   */
  it('takes the cutoff from the file', () => {
    expect(parse().cutoff).toBeCloseTo(0.20844381820362515, 12)
  })

  it('resolves the set’s files against its own address', () => {
    expect(fileUrl(parse(), 'tips.parquet')).toBe(
      'https://example.invalid/coda_rv2/tips.parquet',
    )
  })

  /** Invariant 8, at the one place a set could hand over a number. */
  it('refuses a neuron list holding anything but text', () => {
    // Written through `Number` rather than as a literal, which is the mistake itself: the
    // literal would be a different neuron before the test even ran, and lint says so.
    expect(() => parse({ neurons: [Number(RAW.neurons![0])] })).toThrow(/different neuron/)
    expect(() => parse({ neurons: 'all' })).toThrow(/list of root ids as text/)
  })

  it('names the field that is missing, rather than the file', () => {
    expect(() => parse({ counts: undefined })).toThrow(/`counts`/)
    expect(() => parse({ pipeline: undefined })).toThrow(/`pipeline`/)
    expect(() => parse({ snapshot: '' })).toThrow(/`snapshot`/)
    expect(() => parse({ commit: 42 })).toThrow(/`commit`/)
  })

  /** A set that cannot say what it holds is a set this node cannot check itself against. */
  it('refuses counts that are not numbers', () => {
    expect(() => parse({ counts: { tips: 'many', shown: 1, candidates: 1 } })).toThrow(
      /`counts.tips`/,
    )
  })
})

/**
 * The loader normalises its own address.
 *
 * Three callers forgot to, each getting the host's `403` for a directory request and reading it
 * as "the set is unreachable". Idempotent, so a caller that has already normalised loses
 * nothing — the point is that one that has not can no longer be wrong.
 */
describe('loading a set', () => {
  it('fills in the index file for a directory, rather than fetching the directory', async () => {
    const asked: string[] = []
    const fetched = globalThis.fetch
    globalThis.fetch = (input: RequestInfo | URL) => {
      asked.push(String(input))
      return Promise.resolve(new Response('{}', { status: 403 }))
    }
    try {
      await loadSuggestionSet('https://example.invalid/seam/aedes/').catch(() => undefined)
      await loadSuggestionSet('https://example.invalid/seam/aedes/index.json').catch(
        () => undefined,
      )
    } finally {
      globalThis.fetch = fetched
    }
    expect(asked).toEqual([
      'https://example.invalid/seam/aedes/index.json',
      'https://example.invalid/seam/aedes/index.json',
    ])
  })
})
