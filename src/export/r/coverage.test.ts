/**
 * The drift tripwire, held to the same bar as the notebook exporter's.
 *
 * The two exporters share the fixture graph and nothing else, so this is what stops them being
 * held to two different coverage bars — a node type that emits Python and quietly emits nothing
 * in R would show up only as a shorter document.
 */

import { describe, expect, it } from 'vitest'

import { allNodeDefs, isAnnotation } from '../../core/registry'
import '../../nodes'
import './exporter'
import { getEmitter, registeredEmitterTypes } from './registry'

const NO_EMITTER: Record<string, string> = {
  'dataset.flywire':
    'A CAVE datastack rather than a neuPrint one. This notebook is built on neuprint-python, ' +
    'and a faithful translation needs caveclient plus a materialization version — see ' +
    'src/data/cave. Until that is written it degrades to a TODO, which is the honest outcome: ' +
    'emitting neuPrint code against a dataset neuPrint has never heard of would produce a ' +
    'document that runs and answers nothing.',
  'note.text': 'An annotation. It becomes a markdown block, which the walk does directly.',
  'dataset.mock.hemibrain':
    'Synthetic, so a graph holding one is refused before the walk starts. An emitter here ' +
    'would be unreachable code claiming the case is handled.',
  'dataset.mock.opticlobe': 'Synthetic — see dataset.mock.hemibrain.',
}

describe('R emitter coverage', () => {
  const types = allNodeDefs()
    .map((d) => d.type)
    .filter((t) => !isAnnotation(t))

  it('every registered node type is either emitted or explicitly excused', () => {
    expect(types.filter((t) => !getEmitter(t) && !(t in NO_EMITTER))).toEqual([])
  })

  it('no emitter is registered for a type that does not exist', () => {
    const all = new Set(allNodeDefs().map((d) => d.type))
    expect(registeredEmitterTypes().filter((t) => !all.has(t))).toEqual([])
  })
})
