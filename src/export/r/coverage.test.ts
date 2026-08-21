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
  'dataset.cave':
    'A CAVE datastack named by hand, so it has the same reason as `dataset.flywire`: this ' +
    'document is built on neuprintr and there is no fafbseg/CAVE emitter yet.',
  'annotation.caveTable':
    'An annotation source. It has no neuPrint counterpart at all — neuPrint carries its cell ' +
    'typing as properties on the neuron, so there is nothing for a generated chunk to fetch ' +
    'separately. It reaches a document when the CAVE emitters do.',
  'annotation.flyTable':
    'An annotation source — see annotation.caveTable. Its API is SeaTable\u2019s, which no ' +
    'package in this document\u2019s stack speaks.',
  'annotation.seaTable': 'An annotation source \u2014 see annotation.flyTable.',
  'dataset.flywire':
    'A CAVE datastack rather than a neuPrint one. This document is built on neuprintr, and a ' +
    'faithful translation needs fafbseg or a CAVE client plus a materialization version — see ' +
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
