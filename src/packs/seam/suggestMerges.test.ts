/**
 * The card: what it promises before anything runs, and the two things it must refuse.
 *
 * `evaluate` is unreachable from vitest — it needs a CAVE token, a real segmentation volume and
 * Pyodide — so the run belongs to `pnpm probe:candidate-search`, which drives `searchEnds`
 * directly against SEAM's own published list. What this node adds above that layer is tables,
 * and `searchTips.test.ts` covers those.
 *
 * What is left here is the shape, and the property it shares with `seam:loadMergeCandidates` and must go
 * on sharing: **the two tables they publish are the same two tables**, because that is what lets
 * `seam:proofreadMerges` take either. It cannot be checked by reading one file.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, findParam, makeInferContext } from '../../core/node'
import type { ParamValues } from '../../core/node'
import { inputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { T, columnNames } from '../../core/types'
import type { CodaType, TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import '../../nodes'
import { seam } from './index'
import { MERGE_ASSESSOR_MODELS, MERGE_RANKER_MODELS, NO_ASSESSOR } from './models'
import { LINEAGE_FIELDS, SEARCH_CANDIDATE_FIELDS } from './searchTips'
import { schemaOf } from './suggestionTables'

const def = requireNodeDef('seam:findMergeCandidates')

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
    expect(seam.nodes.map((node) => node.type)).toContain('seam:findMergeCandidates')
  })

  /**
   * **Deliberately not `seam:loadMergeCandidates`' shape** (2026-11-15, user). That node reads a run of
   * an earlier SEAM pipeline and its output is going to change, so pinning this node's columns
   * to it would pin them to something about to move. What holds instead is that this node
   * publishes exactly what the search measures — `seam:proofreadMerges` reads every column by name and
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

describe('the organelle flag', () => {
  it('promises both columns on Candidates, and the first candidate’s flag on Tips', () => {
    const out = infer({}, { tips: T.table() })
    const names = (schema: TableSchema | undefined) => (schema ? columnNames(schema) : [])
    expect(names(out.candidates!.schema)).toEqual(
      expect.arrayContaining(['organelle_score', 'organelle']),
    )
    expect(names(out.tips!.schema)).toContain('organelle')
    // The score stays on Candidates, as SEAM's tips file carries the flag alone.
    expect(names(out.tips!.schema)).not.toContain('organelle_score')
  })
})

describe('Searched at', () => {
  /**
   * A record the run keeps of each neuron's moment (`docs/seam-live-plan.md`): out of the key,
   * or writing it mid-run would re-run the node and the review card for a record of what they
   * had just done; unrecorded, or undo would take it back; internal, or the card would offer it
   * for editing, and an edit by hand re-runs nothing; advanced, so it is drawn in the inspector
   * and never on the card.
   */
  it('is a run record, out of the key, kept off the card and out of undo', () => {
    expect(findParam(def, 'at')).toMatchObject({
      runRecord: true,
      presentational: true,
      unrecorded: true,
      internal: true,
      advanced: true,
      absentMeans: '',
    })
  })
})

describe('extending a neuron', () => {
  it('takes what to extend by reference, so it waits for nothing below it', () => {
    // Proofread Merges sits below this node. An ordinary input from it would be a cycle.
    const port = inputPorts(def, defaultParams(def)).find((one) => one.id === 'review')
    expect(port?.reference).toBe(true)
    expect(port?.required).toBe(false)
  })

  it('may run the chain above Tips again, which only an expensive node may', () => {
    expect(def.rerunsInputs).toBe(true)
  })

  it('promises the lineage columns before anything has run', () => {
    // With the port unwired too: the shape does not depend on whether anything is extended.
    const out = infer({}, { tips: T.table(tableSchema(column('neuronId', 'str'))) })
    for (const name of LINEAGE_FIELDS.map((one) => one.name)) {
      expect(columnNames(out['tips']!.schema!)).toContain(name)
    }
    expect(columnNames(out['candidates']!.schema!)).toContain('seed')
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
