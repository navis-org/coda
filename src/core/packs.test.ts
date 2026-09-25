/**
 * What a switched-off pack leaves offered: built-in types always, a pack's types when it is on or
 * when the open workflow uses it — and no filter at all while nothing is off.
 */

import { describe, expect, it } from 'vitest'

import '../nodes'
import { emptyGraph } from './graph'
import type { CodaGraph } from './graph'
import {
  effectiveOff,
  offeredType,
  packDependencies,
  packsHiding,
  packsIn,
  packsOffByDefault,
  packsNeeding,
} from './packs'
import { listableNodeDefs, nodeDefsByCategory, registerPack } from './registry'
import { DATASET_FAMILIES, offeredFamilies } from '../nodes/lib/datasetFamilies'

function graphOf(...types: string[]): CodaGraph {
  return {
    ...emptyGraph('t'),
    nodes: types.map((type, i) => ({
      id: `n${i}`,
      type,
      position: { x: 0, y: 0 },
      params: {},
    })),
  }
}

/** A switched-off set as a reader's begins: the packs off by default, plus these. */
const offByDefaultPlus = (...ids: string[]) => new Set([...packsOffByDefault(), ...ids])

describe('packsIn', () => {
  it("names each pack a graph's nodes come from, once, and no built-in family", () => {
    expect(packsIn(graphOf('zapbench:traces', 'core.filterTable', 'zapbench:neurons'))).toEqual(
      ['zapbench'],
    )
    expect(packsIn(graphOf('core.filterTable'))).toEqual([])
  })
})

describe('offeredType', () => {
  it('is no filter at all while nothing is switched off', () => {
    expect(offeredType(new Set())).toBeUndefined()
  })

  it("hides a switched-off pack's types and keeps built-in ones", () => {
    const offered = offeredType(new Set(['zapbench']))!
    expect(offered('zapbench:traces')).toBe(false)
    expect(offered('core.filterTable')).toBe(true)
  })

  it('keeps a switched-off pack offered while the open workflow uses it', () => {
    const offered = offeredType(new Set(['zapbench']), ['zapbench'])!
    expect(offered('zapbench:traces')).toBe(true)
  })

  it('reads a pack that keeps built-in ids off the registry, where the id cannot say', () => {
    const offered = offeredType(new Set(['connectome']))!
    expect(offered('neuron.connectivity')).toBe(false)
    expect(offered('neuron.skeletons')).toBe(true)
    expect(packsIn(graphOf('neuron.connectivity', 'neuron.skeletons'))).toEqual(['connectome'])
  })

  it('narrows the registry listings, and only those', () => {
    const offered = offeredType(new Set(['zapbench']))!
    const listed = listableNodeDefs(offered).map((d) => d.type)
    expect(listed).not.toContain('zapbench:traces')
    expect(listed).toContain('core.filterTable')
    expect(listableNodeDefs().map((d) => d.type)).toContain('zapbench:traces')
    const grouped = nodeDefsByCategory(offered).flatMap((g) => g.defs.map((d) => d.type))
    expect(grouped).not.toContain('zapbench:neurons')
  })
})

describe('a pack and its parts', () => {
  it('takes every part off with its parent, and a part off alone', () => {
    expect(
      [...effectiveOff(offByDefaultPlus('connectome'))].filter(
        (id) => !packsOffByDefault().has(id),
      ),
    ).toEqual(['connectome', 'neuprint', 'cave', 'catmaid'])
    expect(
      [...effectiveOff(offByDefaultPlus('neuprint'))].filter(
        (id) => !packsOffByDefault().has(id),
      ),
    ).toEqual(['neuprint'])
  })

  it("switches a part's parent on with it", () => {
    expect(packDependencies('cave')).toEqual(['connectome'])
  })

  it("leaves a switched-off backend's datasets out of the lists new work starts from", () => {
    const offered = offeredType(new Set(['neuprint']))
    const keys = offeredFamilies(DATASET_FAMILIES, offered).map((f) => f.key)
    expect(keys).not.toContain('hemibrain')
    expect(keys).toContain('flywire')
    expect(keys).toContain('mock.opticlobe')
    expect(offeredFamilies(DATASET_FAMILIES, undefined)).toHaveLength(DATASET_FAMILIES.length)
  })

  it('names the switch that hid a dataset: the parent when it is off, else the part', () => {
    const types = ['dataset.hemibrain', 'dataset.flywire', 'dataset.mock.opticlobe']
    const hiding = (off: string[]) =>
      packsHiding(types, effectiveOff(offByDefaultPlus(...off))).map((p) => p.id)
    expect(hiding(['connectome'])).toEqual(['connectome'])
    expect(hiding(['neuprint'])).toEqual(['neuprint'])
    expect(hiding(['neuprint', 'cave'])).toEqual(['neuprint', 'cave'])
    expect(hiding([])).toEqual([])
  })
})

describe('a pack that needs a part of another', () => {
  it('holds the part and its parent on, and names itself as why', () => {
    registerPack({
      id: 'needscave',
      label: 'Needs CAVE',
      description: '',
      requires: ['cave'],
      nodes: [],
    })
    const off = effectiveOff(offByDefaultPlus('connectome'))
    expect(off.has('cave')).toBe(false)
    expect(off.has('connectome')).toBe(false)
    expect(packsNeeding('connectome', off)).toEqual(['needscave'])
    expect(packDependencies('needscave').sort()).toEqual(['cave', 'connectome'])
  })

  it('lets a parent go off when only its own parts need each other', () => {
    registerPack({ id: 'par', label: 'Par', description: '', nodes: [] })
    registerPack({ id: 'kida', label: 'Kid A', description: '', parent: 'par', nodes: [] })
    registerPack({
      id: 'kidb',
      label: 'Kid B',
      description: '',
      parent: 'par',
      requires: ['kida'],
      nodes: [],
    })
    expect(packsNeeding('par', new Set())).toEqual([])
    expect(packsNeeding('kida', new Set())).toEqual(['kidb'])
    expect([...effectiveOff(new Set(['par']))].sort()).toEqual(['kida', 'kidb', 'par'])
  })
})
