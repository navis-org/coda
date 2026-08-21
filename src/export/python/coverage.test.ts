/**
 * The drift tripwire.
 *
 * Emitters live in their own registry rather than on the `NodeDefinition`, which is what lets
 * a viewer's emitter reach the UI palette and a new node type degrade to a TODO instead of
 * failing to compile. The cost of that choice is that nothing ties the two registries
 * together — so this does.
 *
 * A type with no emitter is not a failure; it is a decision, and `NO_EMITTER` is where the
 * decision is written down. What fails is a type that is in neither list, because that is the
 * case nobody chose.
 */

import { describe, expect, it } from 'vitest'

import { allNodeDefs, isAnnotation } from '../../core/registry'
import '../../nodes'
import './exporter'
import { getEmitter, registeredEmitterTypes } from './registry'

/**
 * Types that deliberately emit nothing, and why.
 *
 * Every entry here has to be a reason a reader would accept, because the alternative reading
 * of a long list is that the exporter is unfinished.
 */
const NO_EMITTER: Record<string, string> = {
  'dataset.cave':
    'A CAVE datastack named by hand, so it has the same reason as `dataset.flywire`: this ' +
    'notebook is built on neuprint-python and there is no caveclient emitter yet.',
  'annotation.caveTable':
    'An annotation source. It has no neuPrint counterpart at all — neuPrint carries its cell ' +
    'typing as properties on the neuron, so there is nothing for a generated cell to fetch ' +
    'separately. It reaches a notebook when the CAVE emitters do.',
  'annotation.flyTable':
    'An annotation source — see annotation.caveTable. Its API is SeaTable\u2019s, which no ' +
    'library in this notebook\u2019s stack speaks.',
  'annotation.seaTable': 'An annotation source \u2014 see annotation.flyTable.',
  'dataset.flywire':
    'A CAVE datastack rather than a neuPrint one. This notebook is built on neuprint-python, ' +
    'and a faithful translation needs caveclient plus a materialization version — see ' +
    'src/data/cave. Until that is written it degrades to a TODO, which is the honest outcome: ' +
    'emitting neuPrint code against a dataset neuPrint has never heard of would produce a ' +
    'document that runs and answers nothing.',
  'note.text': 'An annotation. It becomes a markdown cell, which the walk does directly.',
  'dataset.mock.hemibrain':
    'Synthetic, so a graph holding one is refused before the walk starts. An emitter here ' +
    'would be unreachable code claiming the case is handled.',
  'dataset.mock.opticlobe': 'Synthetic — see dataset.mock.hemibrain.',
}

describe('emitter coverage', () => {
  const types = allNodeDefs()
    .map((d) => d.type)
    .filter((t) => !isAnnotation(t))

  it('every registered node type is either emitted or explicitly excused', () => {
    const missing = types.filter((t) => !getEmitter(t) && !(t in NO_EMITTER))
    expect(missing).toEqual([])
  })

  it('every excused type is still registered, so the list cannot rot', () => {
    const all = new Set(allNodeDefs().map((d) => d.type))
    expect(Object.keys(NO_EMITTER).filter((t) => !all.has(t))).toEqual([])
  })

  it('no emitter is registered for a type that does not exist', () => {
    const all = new Set(allNodeDefs().map((d) => d.type))
    expect(registeredEmitterTypes().filter((t) => !all.has(t))).toEqual([])
  })
})
