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
  'dataset.catmaid.fafb':
    'A CATMAID project rather than a neuPrint dataset. The route in is pymaid, which is a ' +
    'faithful one \u2014 `pymaid.CatmaidInstance` plus `get_neuron`/`get_partners` maps cleanly ' +
    'onto what this backend answers \u2014 but no emitter has been written for it, so it ' +
    'degrades to a TODO rather than emitting neuprint-python against a server neuPrint has ' +
    'never heard of.',
  'dataset.catmaid.l1':
    'The same backend as `dataset.catmaid.fafb` on a second instance, so the same reason: ' +
    'pymaid points at whichever server it is given and would emit both, and nobody has written ' +
    'the emitter for either.',
  'dataset.catmaid':
    'A CATMAID instance named by hand \u2014 the same reason as `dataset.catmaid.fafb`, and no ' +
    'different for being a server this build ships no node for. pymaid would emit it; nobody ' +
    'has written that emitter.',
  'dataset.ngsource':
    'A neuroglancer datasource \u2014 a bucket URL, not a server. `cloudvolume` is the faithful ' +
    'route and navis wraps it (`navis.read_precomputed`), but nothing downstream would use the ' +
    'result yet: the morphology emitters are written against neuprint-python, so a cell binding ' +
    'a CloudVolume would sit above a Meshes cell that is itself a TODO for this backend. One ' +
    'emitter is worth writing when the pair is.',
  'note.text': 'An annotation. It becomes a markdown cell, which the walk does directly.',
  'flow.forEach':
    'A loop, and the one refusal here that is about the *shape* of the output rather than about ' +
    'a backend. Every other node becomes one cell; a loop has to put the cells of its region ' +
    'inside itself, indented, which is a change to how the walk assembles a notebook rather ' +
    'than an emitter that could be written beside the others. A `for` loop is the most natural ' +
    'thing in Python there is, so this is worth doing \u2014 it is simply not a cell.',
  'flow.collect':
    'The exit of a `flow.forEach`, so it shares that reason exactly: it is the line that ' +
    'appends to a list *after* the loop body, which only means anything once the walk can emit ' +
    'a loop at all.',
  'dataset.mock.opticlobe':
    'Synthetic, so a graph holding one is refused before the walk starts. An emitter here ' +
    'would be unreachable code claiming the case is handled.',
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
