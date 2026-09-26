/**
 * The gallery's Skeletons carry each selected cell's row — what a 3D View colours by — and say so
 * before anything runs, so its colour picker offers `layer` and the typing on an idle graph.
 */

import { describe, expect, it } from 'vitest'

import '../../nodes'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import { inferGraph, nodeTypes } from '../../core/inference'
import type { CodaType } from '../../core/types'
import { columnNames } from '../../core/types'
import { registerBuiltinSources } from '../../data/builtins'
import { node } from '../../test/graph'

registerBuiltinSources()

describe('the gallery’s skeletons', () => {
  it('promise the selected cells’ columns, the key once', () => {
    let g = emptyGraph('gallery')
    g = addNode(g, node('ds', 'dataset.minnie65', { version: '1822' }))
    g = addNode(g, node('gallery', 'cortex:gallery'))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'gallery',
      targetHandle: 'dataset',
    })
    const out = nodeTypes(inferGraph(g), 'gallery').outputs
    const names = (type: CodaType | undefined) =>
      columnNames(type && 'schema' in type ? type.schema : undefined)
    const carried = names(out['skeletons'])
    const selected = names(out['selected'])
    expect(carried).toEqual(expect.arrayContaining(['soma_depth', 'layer']))
    // Every column the selected table has, and the id not twice.
    for (const name of selected) expect(carried, name).toContain(name)
    expect(carried.filter((name) => name === 'neuronId')).toHaveLength(1)
  })
})
