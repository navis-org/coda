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
  'dataset.catmaid.fafb':
    'A CATMAID project rather than a neuPrint dataset. The natverse has `catmaid` (rcatmaid), ' +
    'which is the R counterpart of pymaid and would map as cleanly, but no emitter has been ' +
    'written for either language \u2014 see the Python note.',
  'dataset.catmaid.l1':
    'A second CATMAID instance \u2014 see `dataset.catmaid.fafb`. Which server a project lives ' +
    'on is a constructor argument to rcatmaid, not a different translation.',
  'dataset.catmaid':
    'A CATMAID instance named by hand \u2014 see `dataset.catmaid.fafb`. Naming the server ' +
    'changes nothing about the translation: there is no emitter in either language.',
  'dataset.cave':
    'A CAVE datastack named by hand, so it has the same reason as `dataset.flywire`: this ' +
    'document is built on neuprintr and there is no fafbseg/CAVE emitter yet.',
  'cave.updateRootIds': 'A CAVE chunkedgraph repair \u2014 see the Python note.',
  'cave.tables':
    'A listing of a CAVE datastack\u2019s annotation tables. The Python notebook emits this ' +
    'through caveclient; R has no CAVE client of its own \u2014 fafbseg reaches one through ' +
    'reticulate, which would put a Python dependency in the middle of an R document to answer a ' +
    'question this one cannot use, since every node downstream of it is a TODO here anyway.',
  'cave.tableInfo':
    'What one CAVE table is \u2014 see cave.tables. The same four caveclient calls, blocked on ' +
    'the same absent client.',
  'dataset.ngsource':
    'A neuroglancer datasource. `fafbseg::read_cloudvolume_meshes` is the R counterpart of the ' +
    'cloudvolume route named in the Python note, and it is blocked on the same thing rather ' +
    'than on the language: this document is built on neuprintr, so the Meshes node downstream ' +
    'has nothing to emit against a bucket either.',
  'neuron.mirror':
    '`nat.templatebrains::mirror_brain` is the exact counterpart of the function Python emits, ' +
    'and the obstacle is the *template*, not the verb. Python has one registry \u2014 ' +
    '`import flybrains` binds every fly template navis can mirror about, which is why the ' +
    'emitter can pass Coda\u2019s space id straight through. The natverse spreads the same five ' +
    'across a package each: FAFB14 is in nat.flybrains, FlyWire is in fafbseg, MANC is in ' +
    'malevnc, MaleCNS is in malecns, and the hemibrain has no templatebrain object in R at all. ' +
    'A faithful emitter therefore needs a space-to-package table, and an unfaithful one emits a ' +
    'bare symbol that does not resolve \u2014 which is the `navis.interfaces` failure ' +
    'check-export.py was written for, in a language whose equivalent check cannot run here ' +
    'because the packages are not installed. Refusing is the smaller lie.',
  'annotation.caveTable':
    'An annotation source. It has no neuPrint counterpart at all — neuPrint carries its cell ' +
    'typing as properties on the neuron, so there is nothing for a generated chunk to fetch ' +
    'separately. It reaches a document when the CAVE emitters do.',
  'annotation.flyTable':
    'An annotation source — see annotation.caveTable. The notebook exporter emits this one ' +
    'through `sea-serpent`; the natverse\u2019s `fafbseg::flytable_*` is the R equivalent and ' +
    'no emitter has been written for it. Moot until a CAVE dataset can be emitted here at all, ' +
    'since a graph holding one is refused before the walk starts.',
  'annotation.seaTable': 'An annotation source \u2014 see annotation.flyTable.',
  'dataset.flywire':
    'A CAVE datastack rather than a neuPrint one. This document is built on neuprintr, and a ' +
    'faithful translation needs fafbseg or a CAVE client plus a materialization version — see ' +
    'src/data/cave. Until that is written it degrades to a TODO, which is the honest outcome: ' +
    'emitting neuPrint code against a dataset neuPrint has never heard of would produce a ' +
    'document that runs and answers nothing.',
  'note.text': 'An annotation. It becomes a markdown block, which the walk does directly.',
  'flow.forEach':
    'A loop, and the one refusal here that is about the *shape* of the output rather than about ' +
    'a backend. Every other node becomes one cell; a loop has to put the cells of its region ' +
    'inside itself, which is a change to how the walk assembles a document rather than an ' +
    'emitter that could be written beside the others. It is also the most ' +
    'straightforward thing in R there is \u2014 a `for` over a list of ids, or a `purrr::map` ' +
    '\u2014 so this is worth doing; it is simply not a chunk.',
  'flow.collect':
    'The exit of a `flow.forEach`, so it shares that reason exactly: it is the line that ' +
    'appends to a list *after* the loop body, which only means anything once the walk can emit ' +
    'a loop at all.',
  'dataset.mock.opticlobe':
    'Synthetic, so a graph holding one is refused before the walk starts. An emitter here ' +
    'would be unreachable code claiming the case is handled.',
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
