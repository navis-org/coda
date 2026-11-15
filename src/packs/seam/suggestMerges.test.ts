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
import { MERGE_ASSESSOR_MODELS, MERGE_RANKER_MODELS, NO_ASSESSOR } from './models'
import { SEARCH_CANDIDATE_FIELDS } from './searchTips'
import { schemaOf } from './suggestionTables'
import { SECONDS_PER_END, secondsPerEnd } from './suggestMerges'
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
    const out = infer({ assessor: NO_ASSESSOR }, {})
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

describe('the assessor param', () => {
  /**
   * **Off by default**, which is the whole shape of the decision: the search alone is two
   * seconds an end, and the assessor is a 133 MB download and several seconds more. A node that
   * reached for both the moment it was dropped on a canvas would be answering a question nobody
   * had asked yet.
   */
  it('runs no assessor unless one is picked', () => {
    const param = findParam(def, 'assessor')
    expect(param?.default).toBe(NO_ASSESSOR)
    const options = param?.kind === 'enum' ? param.options : undefined
    const values = (typeof options === 'function' ? [] : (options ?? [])).map(
      (one) => one.value,
    )
    expect(values[0]).toBe(NO_ASSESSOR)
    expect(values.slice(1)).toEqual(MERGE_ASSESSOR_MODELS.map((model) => model.id))
  })

  /**
   * `NO_ASSESSOR` is the one string that must never be a model id, and its docstring in
   * `models.ts` says so — a row called `none` would be unreachable and nothing on the node could
   * see why. This is what makes that claim true rather than merely stated.
   */
  it('reserves the none value, so no row can ever shadow it', () => {
    for (const list of [MERGE_ASSESSOR_MODELS, MERGE_RANKER_MODELS]) {
      expect(list.map((model) => model.id)).not.toContain(NO_ASSESSOR)
    }
  })

  /** Both controls are about a model, so neither is drawn where there is none to run. */
  it('hides the download tick and the cap while no assessor is picked', () => {
    for (const id of ['download', 'assessTop']) {
      const param = findParam(def, id)
      expect(
        param?.visibleIf?.({ ...defaultParams(def), assessor: NO_ASSESSOR } as ParamValues),
      ).toBe(false)
      expect(
        param?.visibleIf?.({
          ...defaultParams(def),
          assessor: MERGE_ASSESSOR_MODELS[0]!.id,
        } as ParamValues),
      ).toBe(true)
    }
  })

  /**
   * A saved graph naming an assessor this build no longer carries keeps its value, so the card
   * says which is missing rather than falling back to the first row — which would score with a
   * different checkpoint under a different set of fits.
   */
  it('names an assessor this build does not have', () => {
    const issues = validate({ assessor: 'gone', datastack: 'wclee_aedes_brain:1' })
    expect(issues.join(' ')).toMatch(/does not have an assessor called `gone`/)
  })

  /**
   * **The eleven columns appear before anything runs** — invariant 2's reason. A column picker
   * on a Filter Table below cannot wait for a neuron's worth of boxes, and the choice that
   * decides them is a param rather than a measurement.
   */
  it('promises the stage-6 columns as soon as an assessor is picked', () => {
    const out = infer({ assessor: MERGE_ASSESSOR_MODELS[0]!.id }, {})
    for (const name of ['score_s0', 'logit', 'p_cand', 'conf', 'filled']) {
      expect(columnNames(out.candidates!.schema!), name).toContain(name)
    }
    for (const name of ['segclr', 'p_tip', 'p_top', 'q', 'r', 'shown']) {
      expect(columnNames(out.tips!.schema!), name).toContain(name)
    }
  })
})

describe('the wait it prices', () => {
  /** How many ends of each kind it takes to cross the wait the node may stay silent about. */
  const endsBeforeWarning = (assessed: boolean, top = 0) =>
    WAIT_WARN_SECONDS / secondsPerEnd(assessed, top)

  /**
   * A guard rail warns and runs anyway (`docs/limits.md`), so what matters is *when*. One end is
   * a box over the network and a Pyodide measure; a handful should pass in silence and a whole
   * neuron's worth should not.
   */
  it('says nothing about a handful of ends and does about a neuron’s worth', () => {
    expect(20 * secondsPerEnd(false, 0)).toBeLessThan(WAIT_WARN_SECONDS)
    expect(500 * secondsPerEnd(false, 0)).toBeGreaterThan(WAIT_WARN_SECONDS)
  })

  /**
   * **The relationship, not the ratio.** An assessed end reads a second box and runs a network
   * over every candidate, so it must cost meaningfully more and must therefore warn sooner —
   * but *how much* more is a measurement that has already moved once: the hand-written WebGPU
   * runtime took a patch from 136 ms to 26.5, which dropped an assessed end from about 4x a
   * searched one to about 2x. Pinning the ratio would have made that a test failure to be
   * edited past rather than a fact to be read.
   */
  it('prices an assessed end above a searched one, and warns sooner for it', () => {
    expect(secondsPerEnd(true, 0)).toBeGreaterThan(secondsPerEnd(false, 0))
    expect(endsBeforeWarning(true)).toBeLessThan(endsBeforeWarning(false) / 1.5)
    // And a neuron is hundreds of ends, so an assessed whole neuron is always worth a word.
    expect(endsBeforeWarning(true)).toBeLessThan(500)
  })

  /** The cap is a lever on the price, so it has to move it — and only downwards. */
  it('prices a capped run below an uncapped one, and never below the search itself', () => {
    expect(secondsPerEnd(true, 10)).toBeLessThan(secondsPerEnd(true, 0))
    expect(secondsPerEnd(true, 10)).toBeGreaterThan(SECONDS_PER_END)
    // A cap longer than a list costs what no cap costs: there is nothing left to leave out.
    expect(secondsPerEnd(true, 1000)).toBe(secondsPerEnd(true, 0))
  })

  /**
   * **What the cap can be worth at all**, which is the half of the measurement that moved.
   *
   * Three of an assessed end's four seconds are the two box reads, and no cap touches them — so
   * the *ceiling* on what any cap can save is about a quarter of a run, and a cap of 10 saves a
   * fifth. Through ONNX Runtime at 136 ms a patch the same cap saved about half. The cap costs
   * exactly what it always did in answers, so what changed is only what it buys.
   *
   * The bound below is therefore a bound on the **runtime**, not on the cap: it fails only if a
   * patch regresses past 50 ms, which is 1.9x the measured 26.5 and which ONNX Runtime misses
   * comfortably. That is the thing worth catching.
   */
  it('does not let the cap promise more than a fraction of a run', () => {
    const saved = 1 - secondsPerEnd(true, 10) / secondsPerEnd(true, 0)
    expect(saved).toBeGreaterThan(0)
    expect(saved).toBeLessThan(0.3)
  })
})
