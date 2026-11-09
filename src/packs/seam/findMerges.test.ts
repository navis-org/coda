/**
 * The card: the schemas it promises before anything runs, the consent gate, and the cutoff.
 *
 * `evaluate` is unreachable from vitest — it needs WebGPU, a real `Worker`, Pyodide and 71 MB of
 * weights — so the run itself belongs to the probes (`pnpm probe:seam-model`,
 * `pnpm probe:seam-windows`). What is here is everything that holds without them.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, findParam, makeInferContext } from '../../core/node'
import type { ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, tableSchema } from '../../core/types'
import type { CodaType, TableSchema } from '../../core/types'
import '../../nodes'
import { fragmentName, neuronSummarySchema } from './mergeTables'
import { MERGE_WINDOW_MODELS } from './models'

const def = requireNodeDef('seam:findMerges')
const NEURONS = tableSchema(column('neuronId', 'str'), column('type', 'str'))

function infer(
  params: Partial<ParamValues> = {},
  inputs: Record<string, CodaType | undefined> = { in: T.meshes(NEURONS) },
) {
  const ctx = makeInferContext(def, { ...defaultParams(def), ...params } as ParamValues, inputs)
  return def.inferOutputs!(ctx) as Record<string, { schema?: TableSchema }>
}

const validate = (params: Partial<ParamValues> = {}) =>
  def.validate!(
    makeInferContext(def, { ...defaultParams(def), ...params } as ParamValues, {
      in: T.meshes(NEURONS),
    }),
  )

describe('the card', () => {
  /** Invariant 6: a `cheap` node would fire a 71 MB download and a GPU run on every keystroke. */
  it('is expensive', () => {
    expect(def.cost).toBe('expensive')
  })

  it('promises the window table before anything has run', () => {
    expect(columnNames(infer().windows!.schema!)).toEqual([
      'neuronId',
      'cell',
      'score',
      'logit',
      'points',
      'balance',
      'x',
      'y',
      'z',
    ])
  })

  it('folds the per-neuron summary onto the meshes, keeping their own columns', () => {
    const out = infer()
    expect(columnNames(out.meshes!.schema!)).toEqual(columnNames(neuronSummarySchema(NEURONS)))
    expect(columnNames(out.meshes!.schema!)).toContain('type')
    expect(columnNames(out.meshes!.schema!)).toContain('maxScore')
  })

  it('promises the drawn points’ columns', () => {
    expect(columnNames(infer().points!.schema!)).toEqual([
      'neuronId',
      'cell',
      'score',
      'fragment',
    ])
  })

  /** Invariant 2: inference runs on every graph mutation and may not throw. */
  it('infers with nothing wired', () => {
    expect(() => infer({}, { in: undefined })).not.toThrow()
  })
})

describe('the consent gate', () => {
  it('asks before the weights are allowed to be fetched', () => {
    expect(validate().join(' ')).toContain('Download the model')
  })

  it('stops asking once the box is ticked', () => {
    expect(validate({ download: true })).toEqual([])
  })

  it('says so when the chosen model is not in this build', () => {
    expect(validate({ download: true, model: 'gone' }).join(' ')).toContain('gone')
  })
})

describe('the cutoff', () => {
  /**
   * Empty is "no line", and that is why the param is a `string`. `0` is a real line — it counts
   * everything *and says so* — so a numeric param could not express the difference at all.
   */
  it('is empty by default, which is a decision rather than a missing value', () => {
    expect(defaultParams(def).cutoff).toBe('')
    expect(validate({ download: true })).toEqual([])
  })

  /**
   * **The reason moving it is free.** `normalizeParams` drops `presentational` params from the
   * provenance key, so a nudge of the line does not retire the result — which on this node means
   * not re-tiling and re-scoring a mesh for minutes to change a comparison the card does in a
   * frame. It is only allowed to be presentational because `evaluate` does not read it: every
   * cell, its score and its bipartition are published whatever the line says, and the card
   * applies the line to the table afterwards.
   */
  it('is presentational, so it is out of the provenance key', () => {
    expect(findParam(def, 'cutoff')?.presentational).toBe(true)
  })

  it('takes a probability', () => {
    expect(validate({ download: true, cutoff: '0.9' })).toEqual([])
    expect(validate({ download: true, cutoff: '0' })).toEqual([])
  })

  it('refuses one outside 0..1, which would silently keep or drop everything', () => {
    expect(validate({ download: true, cutoff: '1.5' }).join(' ')).toContain('between 0 and 1')
    expect(validate({ download: true, cutoff: '-1' }).join(' ')).toContain('between 0 and 1')
  })

  it('refuses text', () => {
    expect(validate({ download: true, cutoff: 'high' }).join(' ')).toContain('not a number')
  })
})

describe('the whole neuron, by default', () => {
  /**
   * The user's call, and the reason is in the node's header: a merge missed because its part of
   * the arbour was never sampled is worse than a longer wait, and a capped run reads the neuron
   * in tiling order — one sweep of it — rather than a thinner version of all of it.
   */
  it('caps nothing unless asked', () => {
    expect(defaultParams(def).maxWindows).toBe(0)
  })

  it('thins only what is drawn, never what is scored', () => {
    expect(defaultParams(def).drawEvery).toBeGreaterThan(1)
  })
})

describe('the model registry', () => {
  it('offers the merge-window models, not the affinity one', () => {
    const param = (def.params ?? []).find((p) => p.id === 'model')
    const options = param?.kind === 'enum' && Array.isArray(param.options) ? param.options : []
    const values = options.map((o) => o.value)
    expect(values).toEqual(MERGE_WINDOW_MODELS.map((m) => m.id))
    expect(values).not.toContain('affinity-flywire')
  })
})

describe('the fragment labelling', () => {
  it('names a cell’s two pieces, each carrying its cell', () => {
    expect(fragmentName(7, 0)).toBe('7a')
    expect(fragmentName(7, 1)).toBe('7b')
  })

  /** Labels from different cells are not comparable, so they must not collide. */
  it('never gives two cells the same fragment name', () => {
    expect(fragmentName(1, 1)).not.toBe(fragmentName(11, 0))
  })
})
