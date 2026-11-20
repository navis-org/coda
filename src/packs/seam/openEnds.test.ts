/**
 * The card: what it promises before anything runs, and the three settings that decide what a tip
 * is.
 *
 * `evaluate` is unreachable from vitest — it needs WebGPU, a real `Worker`, Pyodide and the
 * weights — so the run belongs to the probes (`pnpm probe:seam-e-cells` for the parity, and
 * `probe-seam-windows-py.mjs` for the bridge). What is here is everything that holds without
 * them, plus the one property this node shares with `seam:suggestions` and must keep sharing:
 * the table they publish is the same table.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, findParam, makeInferContext } from '../../core/node'
import type { ParamValues } from '../../core/node'
import { inputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { T, columnNames } from '../../core/types'
import type { CodaType, TableSchema } from '../../core/types'
import '../../nodes'
import { OPEN_END_MODELS, OPEN_END_TASK } from './models'
import { SEAM_TIP_RULE } from './tips'
import { askedForNucleus } from './openEnds'
import type { MeshesValue } from '../../core/values'
import { OPEN_END_FIELDS } from './openEndsOps'
import { schemaOf } from './suggestionTables'

const def = requireNodeDef('seam:openEnds')

function infer(
  params: Partial<ParamValues> = {},
  inputs: Record<string, CodaType | undefined> = { meshes: T.meshes() },
) {
  const ctx = makeInferContext(def, { ...defaultParams(def), ...params } as ParamValues, inputs)
  return def.inferOutputs!(ctx) as Record<string, { schema?: TableSchema }>
}

const validate = (params: Partial<ParamValues> = {}) =>
  def.validate!(
    makeInferContext(def, { ...defaultParams(def), ...params } as ParamValues, {
      meshes: T.meshes(),
    }),
  )

describe('the card', () => {
  /** Invariant 6: `cheap` would fire a download and a GPU sweep of a neuron on every keystroke. */
  it('is expensive', () => {
    expect(def.cost).toBe('expensive')
  })

  /** The weights are tens of megabytes, so nothing is fetched until somebody says so. */
  it('does not download the model until asked', () => {
    expect(findParam(def, 'download')?.default).toBe(false)
  })

  it('takes meshes, and skeletons only if you have them', () => {
    // Through `inputPorts`, never by iterating `def.inputs`: a slot can be a group template.
    const ports = inputPorts(def, defaultParams(def))
    expect(ports.find((port) => port.id === 'meshes')?.required).not.toBe(false)
    expect(ports.find((port) => port.id === 'skeletons')?.required).toBe(false)
  })

  /**
   * The schema is a contract rather than a discovery (invariant 2): inference may not fetch, and
   * a schema that only appeared after a minute of scanning would leave every picker below this
   * node empty until then.
   */
  it('promises its columns before it runs', () => {
    expect(infer().tips!.schema).toEqual(schemaOf(OPEN_END_FIELDS))
  })

  /**
   * **Not `seam:suggestions`' shape any more**, and that is the change rather than a regression.
   * This node used to publish `TIP_FIELDS` with every later stage's column null, so the two
   * tables matched column for column. The search is `seam:suggestMerges` downstream now, and
   * `seam:suggestions` is modelled on an earlier SEAM pipeline whose output is going to move —
   * so the coupling was dropped (2026-11-15, user). What holds instead is that this node
   * publishes nothing it cannot fill.
   */
  it('publishes no column it has no way to answer', () => {
    const names = columnNames(infer().tips!.schema!)
    for (const absent of ['p_tip', 'segclr', 'q', 'shown', 'r', 'candidateId', 'p_top']) {
      expect(names, absent).not.toContain(absent)
    }
    expect(names).toEqual(['neuronId', 'end_uid', 'kind', 'x', 'y', 'z', 'e_tip'])
  })
})

describe('the soma mask’s positions', () => {
  /**
   * The node reads the nucleus table itself rather than taking one from a wired CAVE table node,
   * and the reason is units: a plain CAVE query answers in the table's own voxels, while
   * `somataFor` asks at `[1, 1, 1]`. A soma a factor out either masks nothing or masks the whole
   * neuron, and nothing fails either way.
   */
  it('takes a table name, and a Dataset reference to read it from', () => {
    expect(findParam(def, 'nucleusTable')?.default).toBe('')
    const port = inputPorts(def, defaultParams(def)).find((p) => p.id === 'dataset')
    expect(port?.reference).toBe(true)
    expect(port?.required).toBe(false)
  })

  /** Empty means "the dataset's own soma, if it publishes one", which is what it did before. */
  it('asks for no table by default', () => {
    expect(String(defaultParams(def).nucleusTable)).toBe('')
  })
})

describe('the model', () => {
  it('offers the open-end checkpoints and defaults to one of them', () => {
    const param = findParam(def, 'model')
    const options = param?.kind === 'enum' && Array.isArray(param.options) ? param.options : []
    expect(options.map((option) => option.value)).toEqual(OPEN_END_MODELS.map((m) => m.id))
    expect(OPEN_END_MODELS.map((model) => model.id)).toContain(String(param?.default))
  })

  /**
   * A task of its own, not the merge one. The two models are the same network on the same inputs
   * and differ only in what they were trained to answer, so a manifest pointing at the wrong one
   * would load, run and return perfectly shaped numbers about a different question.
   */
  it('is a different task from the merge model', () => {
    expect(OPEN_END_TASK).not.toBe('merge-window')
  })

  /** A saved graph may name a checkpoint this build no longer carries. It says so. */
  it('says so when the graph names a model this build does not have', () => {
    expect(validate({ model: 'E_gone' }).join(' ')).toContain('E_gone')
    expect(validate()).toEqual([])
  })
})

describe('what counts as a tip', () => {
  /**
   * SEAM fitted `p_tip`, the cutoff and `r` on tips taken after a 1 µm non-recursive prune with
   * the soma masked at 10 µm. The defaults are those numbers, so a card nobody touched answers
   * the question SEAM's own thresholds were calibrated against.
   */
  it('defaults to SEAM’s own rule, every number of it', () => {
    expect(findParam(def, 'prune')?.default).toBe(SEAM_TIP_RULE.pruneUm)
    expect(findParam(def, 'heal')?.default).toBe(SEAM_TIP_RULE.healUm)
    expect(findParam(def, 'somaMask')?.default).toBe(SEAM_TIP_RULE.somaUm)
  })

  /**
   * The one default that is a *judgement* rather than a transcription, so it is the one most
   * likely to be flipped by somebody who thinks kinks are simply better. They are 111 of 964
   * candidates and an eighth more run, and 2 of the fixture's 610 clear the cutoff — the help
   * says so, and this is what stops the help and the card drifting apart.
   */
  it('leaves kinks off, which is what the help argues for', () => {
    expect(findParam(def, 'kinks')?.default).toBe(false)
  })

  /** Both are distances somebody may want to switch off, so both allow zero. */
  it('lets either be turned off', () => {
    for (const id of ['prune', 'heal', 'somaMask']) {
      const param = findParam(def, id)
      expect(param?.kind === 'number' && param.min, `${id} allows 0`).toBe(0)
    }
  })

  /**
   * Every setting here changes what `evaluate` returns, so none may be `presentational` —
   * invariant 4: a presentational param is dropped from the provenance key, and a cached run
   * would then be served for a different set of tips.
   */
  it('has no presentational settings, since every one of them changes the answer', () => {
    for (const param of def.params ?? []) {
      expect(param.presentational, `${param.id} is presentational`).not.toBe(true)
    }
  })
})

/**
 * Which meshes the nucleus table is asked about (`askedForNucleus`): a piece's chain asks only
 * about one that could hold a nucleus, by surface area (user, 2026-11-20).
 */
describe('asking the nucleus table', () => {
  /** A flat square of `sideUm` µm, in nanometres: two triangles, `sideUm²` µm² of surface. */
  const square = (id: string, sideUm: number) => {
    const s = sideUm * 1000
    return {
      id,
      positions: Float32Array.from([0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    }
  }
  const meshes = (...items: ReturnType<typeof square>[]) =>
    ({ kind: 'meshes', items, attributes: {}, bounds: {} }) as unknown as MeshesValue
  const BIG = '648518347590381436'
  const SMALL = '648518346846408976'

  it('asks about every neuron at 0, once each, and never about an id that is no root', () => {
    expect(askedForNucleus(meshes(square(BIG, 1), square(BIG, 1), square('x', 50)), 0)).toEqual(
      [BIG],
    )
  })

  it('leaves out a neuron with less surface than a nucleus, summed over its items', () => {
    const set = meshes(square(BIG, 7), square(BIG, 6), square(SMALL, 8))
    // 49 + 36 = 85 µm² against 64: only the first reaches 75.
    expect(askedForNucleus(set, 75)).toEqual([BIG])
    expect(askedForNucleus(meshes(square(SMALL, 8)), 75)).toEqual([])
  })
})
