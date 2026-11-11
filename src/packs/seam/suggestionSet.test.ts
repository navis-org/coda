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

import {
  fileUrl,
  loadSuggestionSet,
  parsePipelineFits,
  parseSuggestionSet,
} from './suggestionSet'

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
   * The cutoff is read, never written down. SEAM refits it whenever a stage changes — and it
   * did: adopting the split stage moved it from 0.2084 to 0.1532, which this test had as a
   * literal and failed on, having warned against exactly that in this comment.
   *
   * So it pins the **path** now rather than the value: that `cutoff` is `pipeline.show.cutoff`
   * and not one of the manifest's other numbers. A literal here only ever tested the fixture.
   */
  it('takes the cutoff from the file', () => {
    const show = (RAW['pipeline'] as { show: { cutoff: number } }).show
    expect(parse().cutoff).toBe(show.cutoff)
    // A real probability, so a parser that picked up an adjacent field would still be caught.
    expect(show.cutoff).toBeGreaterThan(0)
    expect(show.cutoff).toBeLessThan(1)
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

/**
 * The fits, read only when something recomputes.
 *
 * Beside the parser rather than beside `stages.ts`, which is the thing that runs them: a refusal
 * tested away from what refuses is one nobody finds when they change it
 * (`docs/testing-layers.md`). Each case takes a fresh copy of the block, because they mutate it.
 */
describe('the pipeline fits', () => {
  /**
   * A fresh, mutable copy of SEAM's own `pipeline` block, inside a set.
   *
   * The parser takes a `SuggestionSet` so that a block and a URL cannot be mispaired, and every
   * case here mutates the block — so each builds its own set around a deep copy. `any` because
   * these are deliberate malformations of a real manifest.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed on purpose
  const block = (): any => JSON.parse(JSON.stringify(RAW.pipeline))
  const fits = (one: unknown) => parsePipelineFits(parse({ pipeline: one }))

  it('reads SEAM’s own fits, and agrees with the set about the cutoff', () => {
    const read = fits(block())
    expect(read.ref).toHaveLength(3)
    expect(read.split).toHaveLength(5)
    expect(read.cutoff).toBe(parse().cutoff)
    expect(read.steps.q).toHaveLength(read.steps.r.length)
  })

  /**
   * A seed is addressed by its position, so a manifest numbering them `[1, 0, 2]` would score
   * each seed's own column against another seed's weights — and every logit would still be a
   * logit.
   */
  it('refuses a fit whose seeds are listed out of order', () => {
    const one = block()
    const seeds = one.ref.seeds
    one.ref.seeds = [seeds[1], seeds[0], seeds[2]]
    expect(() => fits(one)).toThrow(/another seed’s weights/)
  })

  /** Three weights on two columns is a probability for every tip and the right one for none. */
  it('refuses a p_tip refitted on other columns', () => {
    const one = block()
    one.p_tip.columns = ['segclr', 'e_tip', 'mito']
    expect(() => fits(one)).toThrow(/knows how to compute them/)
  })

  /** `((x − mu) / sd) · w` walks the row, so a short `w` silently drops the last feature. */
  it('refuses a fit of the wrong width', () => {
    const one = block()
    one.ref.seeds[0].w = [1, 2]
    expect(() => fits(one)).toThrow(/a different model/)
  })

  /**
   * A fold with no seeds divides by a count of zero, so every candidate's confidence comes back
   * `NaN`. The same rule covers `ref`, which is where it used to live alone.
   */
  it('refuses an empty list of seeds, in a fold as well as in ref', () => {
    const empty = block()
    empty.ref.seeds = []
    expect(() => fits(empty)).toThrow(/nothing can be scored/)
    const fold = block()
    fold.split.folds[1] = []
    expect(() => fits(fold)).toThrow(/nothing can be scored/)
  })

  /** The refusal names the element, not the list: a reader of eighty numbers needs the index. */
  it('names which number is not a number', () => {
    const one = block()
    one.ref.seeds[1].mu[2] = 'x'
    expect(() => fits(one)).toThrow(/seeds\[1\]\.mu\[2\]/)
  })

  /** A set made before the confidence model: `q_ref` only, and not an error. */
  it('reads a set with no split block', () => {
    const one = block()
    delete one.split
    expect(fits(one).split).toBeUndefined()
  })

  /**
   * A fold scores **the set's** seeds. One with fewer reads another seed's column and weighs
   * less than its neighbours in a flat average; one with more reads past the head's columns.
   * Neither is a shape `seedFits` can see, because a fold is well-formed on its own either way.
   */
  it('refuses a fold whose seeds are not the set’s', () => {
    const short = block()
    short.split.folds[2] = short.split.folds[2].slice(0, 2)
    expect(() => fits(short)).toThrow(/2 seeds and ref's fit has 3/)
  })

  /**
   * `applySteps` binary-searches the edges, and a binary search over an unsorted list answers
   * for every input — a share read at whatever step it lands on.
   */
  it('refuses a staircase whose edges do not ascend', () => {
    const one = block()
    const q = one.r.steps_q
    one.r.steps_q = [q[0], q[2], q[1], ...q.slice(3)]
    expect(() => fits(one)).toThrow(/falls at \[2\]/)
  })

  /**
   * **The clip's own path.** This set declares none, and `stages.test.ts` derives its clip cases
   * from a patched `PipelineFits` — so without these two nothing would read `score_clip` out of
   * a manifest at all, and the first set to carry one would be the test.
   */
  it('reads a score clip where the set declares one, and refuses a bad one', () => {
    expect(fits(block()).scoreClip).toBeUndefined()
    const one = block()
    one.ref.score_clip = 20
    expect(fits(one).scoreClip).toBe(20)
    const bad = block()
    bad.ref.score_clip = '20'
    expect(() => fits(bad)).toThrow(/score_clip/)
  })
})
