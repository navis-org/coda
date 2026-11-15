/**
 * The card: what it promises before anything runs, and the two things it must refuse.
 *
 * `evaluate` is unreachable from vitest — it needs a CAVE token, a real segmentation volume and
 * Pyodide — so the run belongs to `pnpm probe:candidate-search`, which drives `searchEnds`
 * directly against SEAM's own published list. What this node adds above that layer is tables,
 * and `searchTips.test.ts` covers those.
 *
 * What is left here is the shape, and the property it shares with `seam:suggestions` and must go
 * on sharing: **the two tables they publish are the same two tables**, because that is what lets
 * `seam:review` take either. It cannot be checked by reading one file.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, findParam, makeInferContext } from '../../core/node'
import type { ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, columnNames } from '../../core/types'
import type { CodaType, TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import '../../nodes'
import { seam } from './index'
import { MERGE_RANKER_MODELS } from './models'
import { SEARCH_CANDIDATE_FIELDS } from './searchTips'
import { schemaOf } from './suggestionTables'
import { SECONDS_PER_END } from './suggestMerges'
import { WAIT_WARN_SECONDS } from '../../core/limits'

const def = requireNodeDef('seam:suggestMerges')

function infer(params: Partial<ParamValues>, inputs: Record<string, CodaType | undefined>) {
  const ctx = makeInferContext(def, { ...defaultParams(def), ...params } as ParamValues, inputs)
  return def.inferOutputs!(ctx) as Record<string, { schema?: TableSchema }>
}

const validate = (params: Partial<ParamValues> = {}) =>
  def.validate!(
    makeInferContext(def, { ...defaultParams(def), ...params } as ParamValues, {
      tips: T.table(),
    }),
  )

describe('the card', () => {
  /** Invariant 6: `cheap` would read a box of segmentation per keystroke, at a shared server. */
  it('is expensive', () => {
    expect(def.cost).toBe('expensive')
  })

  it('is listed in the pack, which is what registers it', () => {
    expect(seam.nodes.map((node) => node.type)).toContain('seam:suggestMerges')
  })

  /**
   * **Deliberately not `seam:suggestions`' shape** (2026-11-15, user). That node reads a run of
   * an earlier SEAM pipeline and its output is going to change, so pinning this node's columns
   * to it would pin them to something about to move. What holds instead is that this node
   * publishes exactly what the search measures — `seam:review` reads every column by name and
   * answers `undefined` for one that is not there, so it takes either.
   */
  it('publishes only the columns the search fills', () => {
    const out = infer({}, {})
    expect(columnNames(out.candidates!.schema!)).toEqual(
      columnNames(schemaOf(SEARCH_CANDIDATE_FIELDS)),
    )
    for (const absent of ['p_cand', 'conf', 'logit', 'shown', 'filled']) {
      expect(columnNames(out.candidates!.schema!), absent).not.toContain(absent)
    }
  })

  /**
   * A tip carries whatever Find Open Ends gave it, and a reader may have folded more on. Dropping
   * those columns here would empty a picker downstream of a node that only *adds* to the table.
   */
  it('keeps a column the incoming tips table brought', () => {
    const incoming = tableSchema(
      column('neuronId', 'str'),
      column('e_tip', 'f64'),
      column('mine', 'f64'),
    )
    const out = infer({}, { tips: T.table(incoming) })
    expect(columnNames(out.tips!.schema!)).toContain('mine')
  })
})

describe('what it refuses before a run', () => {
  it('asks for a datastack when none is wired or typed', () => {
    expect(validate().join(' ')).toMatch(/datastack/i)
  })

  it('is content once a datastack is named', () => {
    expect(validate({ datastack: 'wclee_aedes_brain:1' })).toEqual([])
  })

  /**
   * A graph saved against a ranker this build no longer carries loads as itself — the param
   * keeps its value (`core/persistence`) — so the card has to say which one is missing rather
   * than silently falling back to the first row, which would rank with a different pipeline.
   */
  it('names a ranker this build does not have', () => {
    const issues = validate({ model: 'gone', datastack: 'wclee_aedes_brain:1' })
    expect(issues.join(' ')).toMatch(/does not have a ranker called `gone`/)
  })
})

describe('the ranker param', () => {
  it('offers every model in the pack’s list, and defaults to one of them', () => {
    const param = findParam(def, 'model')
    const ids = MERGE_RANKER_MODELS.map((model) => model.id)
    expect(param?.kind).toBe('enum')
    expect(ids).toContain(String(param?.default))
    const options = param?.kind === 'enum' ? param.options : undefined
    expect(
      (typeof options === 'function' ? [] : (options ?? [])).map((option) => option.value),
    ).toEqual(ids)
  })
})

describe('the wait it prices', () => {
  /**
   * A guard rail warns and runs anyway (`docs/limits.md`), so what matters is *when*. One end is
   * a box over the network and a Pyodide measure; a handful should pass in silence and a whole
   * neuron's worth should not.
   */
  it('says nothing about a handful of ends and does about a neuron’s worth', () => {
    expect(20 * SECONDS_PER_END).toBeLessThan(WAIT_WARN_SECONDS)
    expect(500 * SECONDS_PER_END).toBeGreaterThan(WAIT_WARN_SECONDS)
  })
})
