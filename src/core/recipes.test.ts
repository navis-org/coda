/**
 * Recipes: what a saved set records about the wires it was cut from, and how it is put back.
 *
 * The slots are the half worth pinning, because every way of getting them wrong is silent — a
 * recipe that forgets a crossing wire comes back as cards attached to nothing, one that splits a
 * dataset's three wires into three slots can be bound to three datasets, and one that attaches
 * half a slot reads a datastack and feeds nothing. The annotation chain is the fixture that has
 * all three shapes at once: two reference wires in, one wire out, all at one node.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import '../nodes'
import { registerBuiltinSources } from '../data/builtins'
import { chainLinks } from '../nodes/lib/annotationChain'
import { datasetFamily } from '../nodes/lib/datasetFamilies'
import { readFragment } from './clipboard'
import type { CodaGraph } from './graph'
import { addEdge, addNode, edgeInto, emptyGraph } from './graph'
import { groupOf } from './groups'
import { defaultParams } from './node'
import { node } from '../test/graph'
import type { Recipe } from './recipes'
import {
  RECIPE_MARKER,
  insertRecipe,
  readRecipe,
  recipeFrom,
  recipeSockets,
  recipeTakesWire,
  recipeText,
  renamedRecipeText,
} from './recipes'
import { T } from './types'
import { requireNodeDef } from './registry'

beforeAll(() => registerBuiltinSources())

function wire(g: CodaGraph, from: string, fromPort: string, to: string, toPort: string) {
  return addEdge(g, { source: from, sourceHandle: fromPort, target: to, targetHandle: toPort })
}

/** dataset → findNeurons → filter → table. */
function chain(): CodaGraph {
  let g = emptyGraph('test')
  g = addNode(g, node('ds', 'neuron.dataset'))
  g = addNode(g, node('find', 'neuron.findNeurons'))
  g = addNode(g, node('filter', 'core.filterTable'))
  g = addNode(g, node('view', 'out.table'))
  g = wire(g, 'ds', 'dataset', 'find', 'dataset')
  g = wire(g, 'find', 'neurons', 'filter', 'in')
  g = wire(g, 'filter', 'out', 'view', 'in')
  return g
}

/** A FlyWire dataset with its annotation chain wired in, the way the wizard builds it. */
function flywire(): { graph: CodaGraph; members: string[] } {
  const declared = datasetFamily('flywire')!.annotationChain!
  let g = emptyGraph('test')
  g = addNode(g, node('fw', 'dataset.flywire'))
  for (const member of declared.nodes)
    g = addNode(g, node(member.id, member.type, member.params))
  for (const [from, fromPort, to, toPort] of chainLinks(declared, 'fw')) {
    g = wire(g, from, fromPort, to, toPort)
  }
  return { graph: g, members: declared.nodes.map((n) => n.id) }
}

function recipe(g: CodaGraph, ids: string[], name = 'test'): Recipe {
  const made = recipeFrom(g, ids, { name })
  if (!made) throw new Error('expected a recipe')
  return made
}

describe('what a saved recipe records', () => {
  it('turns each wire crossing the selection into a slot, and keeps the inside ones as edges', () => {
    const r = recipe(chain(), ['find', 'filter'])
    expect(r.graph.nodes.map((n) => n.id)).toEqual(['find', 'filter'])
    expect(r.graph.edges).toHaveLength(1)
    expect(r.slots).toEqual([
      {
        label: requireNodeDef('neuron.dataset').label,
        wires: [{ dir: 'in', node: 'find', port: 'dataset', outer: 'dataset' }],
      },
      {
        label: requireNodeDef('out.table').label,
        wires: [{ dir: 'out', node: 'filter', port: 'out', outer: 'in' }],
      },
    ])
  })

  it('gives one outside node one slot, whichever way its wires run', () => {
    /*
     * The case the grouping exists for: two reference wires from the dataset and the output back
     * into its `annotations` port. Three slots would ask for one dataset three times, and allow
     * three different answers.
     */
    const { graph, members } = flywire()
    const r = recipe(graph, members)
    expect(r.slots).toHaveLength(1)
    expect(r.slots[0]!.label).toBe(requireNodeDef('dataset.flywire').label)
    expect(r.slots[0]!.wires.map((w) => w.dir).sort()).toEqual(['in', 'in', 'out'])
  })

  it('uses a renamed card’s title as the slot label', () => {
    let g = chain()
    g = { ...g, nodes: g.nodes.map((n) => (n.id === 'ds' ? { ...n, title: 'My data' } : n)) }
    expect(recipe(g, ['find']).slots[0]!.label).toBe('My data')
  })

  it('keeps params verbatim, except on the nodes asked to reset', () => {
    let g = chain()
    g = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === 'find' || n.id === 'filter'
          ? { ...n, title: 'kept', params: { ...n.params, limit: 7 } }
          : n,
      ),
    }
    const r = recipeFrom(g, ['find', 'filter'], { name: 'x', reset: ['find'] })!
    const byId = new Map(r.graph.nodes.map((n) => [n.id, n]))
    expect(byId.get('find')!.params).toEqual(
      defaultParams(requireNodeDef('neuron.findNeurons')),
    )
    // A reset is of the params alone: the title somebody typed is not configuration.
    expect(byId.get('find')!.title).toBe('kept')
    expect(byId.get('filter')!.params.limit).toBe(7)
  })

  it('falls back to a name when given only whitespace, and says nothing with nothing selected', () => {
    expect(recipe(chain(), ['find'], '   ').name).toBe('Untitled recipe')
    expect(recipeFrom(chain(), [], { name: 'x' })).toBeUndefined()
  })
})

describe('reading a recipe back', () => {
  it('round-trips through its own text', () => {
    const r = recipe(chain(), ['find', 'filter'], 'Find and filter')
    const read = readRecipe(recipeText(r))!
    expect(read.warnings).toEqual([])
    expect(read.recipe.name).toBe('Find and filter')
    expect(read.recipe.slots).toEqual(r.slots)
    expect(read.recipe.graph.nodes.map((n) => n.id)).toEqual(['find', 'filter'])
  })

  it('is also a fragment, so pasting the file places its cards, framed', () => {
    const text = recipeText(recipe(chain(), ['find', 'filter'], 'Find and filter'))
    expect(JSON.parse(text).coda).toBe(RECIPE_MARKER)
    const pasted = readFragment(text)!.graph
    expect(pasted.nodes).toHaveLength(2)
    // The frame is in the fragment, so ⌘V of the file and an insert arrive the same way.
    expect(pasted.groups?.map((g) => g.title)).toEqual(['Find and filter'])
  })

  it('refuses a plain fragment, prose and a recipe whose every node was dropped', () => {
    expect(readRecipe(JSON.stringify({ nodes: [], edges: [] }))).toBeUndefined()
    expect(readRecipe('LC4, LPLC2')).toBeUndefined()
    const foreign = JSON.stringify({
      coda: RECIPE_MARKER,
      recipe: { name: 'x', slots: [] },
      version: 1,
      nodes: [{ id: 'a', type: 'from.the.future', position: { x: 0, y: 0 }, params: {} }],
      edges: [],
    })
    expect(readRecipe(foreign)).toBeUndefined()
  })

  it('follows a port renamed since the save, as an edge would', () => {
    // `core.stack`'s inputs were a fixed `top`/`bottom` pair; `formerIds` carries them.
    let g = emptyGraph('test')
    g = addNode(g, node('src', 'core.filterTable'))
    g = addNode(g, node('stack', 'core.stack'))
    g = wire(g, 'src', 'out', 'stack', 'in1')
    const text = recipeText(recipe(g, ['stack'])).replace('"port": "in1"', '"port": "top"')
    expect(text).toContain('"port": "top"')
    expect(readRecipe(text)!.recipe.slots[0]!.wires[0]!.port).toBe('in1')
  })

  it('drops a wire whose port is gone, and a slot left with none, with a warning', () => {
    const text = recipeText(recipe(chain(), ['find'])).replace(
      '"port": "dataset"',
      '"port": "nowhere"',
    )
    const read = readRecipe(text)!
    // `find`'s other neighbour, the Filter it feeds, keeps its slot.
    expect(read.recipe.slots.map((s) => s.label)).toEqual([
      requireNodeDef('core.filterTable').label,
    ])
    expect(read.warnings.join('\n')).toContain('no port "nowhere"')
  })
})

describe('putting a recipe back', () => {
  it('re-identifies the cards and frames them under the recipe’s name', () => {
    const r = recipe(chain(), ['find', 'filter'], 'Find and filter')
    const { graph, nodeIds } = insertRecipe(chain(), r, { at: { x: 0, y: 800 } })
    expect(nodeIds).toHaveLength(2)
    expect(nodeIds.some((id) => id === 'find' || id === 'filter')).toBe(false)
    const frame = groupOf(graph, nodeIds[0]!)
    expect(frame?.title).toBe('Find and filter')
    expect(frame?.nodeIds).toEqual(nodeIds)
  })

  it('leaves a recipe’s own frames alone rather than nesting them', () => {
    const { graph, members } = flywire()
    const folded = { ...graph, groups: [{ id: 'g1', nodeIds: members, title: 'Chain' }] }
    const r = recipe(folded, members)
    const { graph: out, nodeIds } = insertRecipe(emptyGraph(), r)
    expect(out.groups).toHaveLength(1)
    expect(out.groups![0]!.title).toBe('Chain')
    expect(out.groups![0]!.nodeIds).toEqual(nodeIds)
  })

  it('attaches nothing when nothing is selected', () => {
    const r = recipe(chain(), ['find', 'filter'])
    const before = chain().edges.length
    const result = insertRecipe(chain(), r)
    expect(result.attached).toBeUndefined()
    // Only the recipe's one internal edge is new.
    expect(result.graph.edges).toHaveLength(before + 1)
  })

  it('wires the whole annotation chain to a selected dataset', () => {
    const { graph, members } = flywire()
    const r = recipe(graph, members, 'FlyWire annotations')
    let g = emptyGraph('fresh')
    g = addNode(g, node('other', 'dataset.flywire'))
    const result = insertRecipe(g, r, { attach: 'other' })
    expect(result.attached).toBe(r.slots[0])
    const touching = result.graph.edges.filter(
      (e) => e.source === 'other' || e.target === 'other',
    )
    expect(touching).toHaveLength(3)
    expect(edgeInto(result.graph, 'other', 'annotations')).toBeDefined()
  })

  it('attaches a slot whole or not at all', () => {
    /*
     * The dataset's `annotations` port is already fed, so the output wire cannot be made — and
     * the two reference wires, which could, must not be made without it. Half a chain reads the
     * datastack and feeds nothing under cards that all look configured.
     */
    const { graph, members } = flywire()
    const r = recipe(graph, members)
    let g = emptyGraph('fresh')
    g = addNode(g, node('other', 'dataset.flywire'))
    g = addNode(g, node('mine', 'core.filterTable'))
    g = wire(g, 'mine', 'out', 'other', 'annotations')
    const result = insertRecipe(g, r, { attach: 'other' })
    expect(result.attached).toBeUndefined()
    expect(result.refusals.join('\n')).toMatch(/already wired/)
    // The existing wire is untouched and nothing new touches the dataset.
    expect(edgeInto(result.graph, 'other', 'annotations')!.source).toBe('mine')
    expect(result.graph.edges.filter((e) => e.source === 'other')).toHaveLength(0)
  })

  it('prefers the slot the recipe reads from over one it only feeds', () => {
    /*
     * Selecting a dataset for a find → filter recipe must wire the dataset *into* Find Neurons.
     * The other slot fed a Table viewer, and a dataset has a table-taking `annotations` input —
     * trying that slot first would hang the filter's output on the dataset instead.
     */
    const r = recipe(chain(), ['find', 'filter'])
    let g = emptyGraph('fresh')
    g = addNode(g, node('d2', 'neuron.dataset'))
    const result = insertRecipe(g, r, { attach: 'd2' })
    expect(result.attached).toBe(r.slots[0])
    expect(edgeInto(result.graph, 'd2', 'annotations')).toBeUndefined()
    const find = result.nodeIds[0]!
    expect(edgeInto(result.graph, find, 'dataset')!.source).toBe('d2')
  })

  it('attaches a dropped wire through the port it was dragged from, not the saved one', () => {
    // Saved feeding a Stack's first input; dropped from a fresh Stack's second.
    let g = emptyGraph('test')
    g = addNode(g, node('src', 'core.tableFromUrl'))
    g = addNode(g, node('filter', 'core.filterTable'))
    g = addNode(g, node('stack', 'core.stack'))
    g = wire(g, 'src', 'out', 'filter', 'in')
    g = wire(g, 'filter', 'out', 'stack', 'in1')
    const r = recipe(g, ['filter'])

    let fresh = emptyGraph('fresh')
    fresh = addNode(fresh, node('st', 'core.stack'))
    // Selected, the Stack is read from — reads first, and a Stack's output fits the Filter.
    const selected = insertRecipe(fresh, r, { attach: 'st' })
    expect(edgeInto(selected.graph, selected.nodeIds[0]!, 'in')?.source).toBe('st')
    // Dragged out of its second input, the question is what the recipe feeds, and through which.
    const dropped = insertRecipe(fresh, r, {
      attach: 'st',
      via: { port: 'in2', from: 'target' },
    })
    expect(edgeInto(dropped.graph, 'st', 'in2')?.source).toBe(dropped.nodeIds[0])
    expect(edgeInto(dropped.graph, 'st', 'in1')).toBeUndefined()
  })

  it('falls through to a slot that does fit', () => {
    const r = recipe(chain(), ['find', 'filter'])
    let g = emptyGraph('fresh')
    g = addNode(g, node('v2', 'out.table'))
    const result = insertRecipe(g, r, { attach: 'v2' })
    expect(result.attached).toBe(r.slots[1])
    const filter = result.nodeIds[1]!
    expect(edgeInto(result.graph, 'v2', 'in')!.source).toBe(filter)
  })

  it('says why when the selected node fits no slot', () => {
    const r = recipe(chain(), ['find'])
    let g = emptyGraph('fresh')
    // Publishes a table, which is not a Dataset, and takes nothing a neuron table could feed.
    g = addNode(g, node('n', 'core.tableFromUrl'))
    const result = insertRecipe(g, r, { attach: 'n' })
    expect(result.attached).toBeUndefined()
    expect(result.refusals.length).toBeGreaterThan(0)
    expect(result.graph.edges.filter((e) => e.source === 'n' || e.target === 'n')).toEqual([])
  })
})

describe('renaming a recipe', () => {
  it('renames the frame the name was copied into, along with the recipe', () => {
    const text = recipeText(recipe(chain(), ['find', 'filter'], 'Find and filter'))
    const renamed = renamedRecipeText(text, '  Search  ')!
    expect(renamed.name).toBe('Search')
    const read = readRecipe(renamed.text)!.recipe
    expect(read.name).toBe('Search')
    expect(read.graph.groups?.map((g) => g.title)).toEqual(['Search'])
  })

  it('leaves a frame of another name alone', () => {
    const { graph, members } = flywire()
    const framed = { ...graph, groups: [{ id: 'g1', nodeIds: members, title: 'Chain' }] }
    const renamed = renamedRecipeText(recipeText(recipe(framed, members, 'FlyWire')), 'Types')!
    expect(readRecipe(renamed.text)!.recipe.graph.groups?.map((g) => g.title)).toEqual([
      'Chain',
    ])
  })

  it('keeps a card this build does not know, rather than healing it away', () => {
    /*
     * `readRecipe` drops an unknown node type, which is right for placing it and wrong for
     * writing it back: a rename in an older tab would delete the card for the build that has it.
     */
    const doc = JSON.parse(recipeText(recipe(chain(), ['find', 'filter'], 'x')))
    doc.nodes.push({
      id: 'future',
      type: 'from.the.future',
      position: { x: 0, y: 0 },
      params: {},
    })
    const renamed = renamedRecipeText(JSON.stringify(doc), 'y')!
    expect(JSON.parse(renamed.text).nodes.map((n: { id: string }) => n.id)).toContain('future')
  })

  it('falls back to a name, and refuses text that is not a recipe', () => {
    const text = recipeText(recipe(chain(), ['find'], 'x'))
    expect(renamedRecipeText(text, '   ')!.name).toBe('Untitled recipe')
    expect(renamedRecipeText('{"nodes": [], "edges": []}', 'y')).toBeUndefined()
    expect(renamedRecipeText('not json', 'y')).toBeUndefined()
  })
})

describe('which wires a recipe takes', () => {
  it('records the sockets its slot wires land on, by direction', () => {
    const sockets = recipeSockets(recipe(chain(), ['find', 'filter']))
    // Find Neurons reads a Dataset; the Filter feeds a table viewer through its passthrough.
    expect(sockets.reads.map((s) => s.type.kind)).toEqual(['dataset'])
    expect(sockets.feeds).toHaveLength(1)
  })

  it('takes a wire dragged from an output only where a read port accepts it', () => {
    const sockets = recipeSockets(recipe(chain(), ['find', 'filter']))
    expect(recipeTakesWire(sockets, { from: 'source', type: T.dataset() })).toBe(true)
    expect(recipeTakesWire(sockets, { from: 'source', type: T.number() })).toBe(false)
  })

  it('takes a wire dragged from an input only where a fed port fits it', () => {
    const sockets = recipeSockets(recipe(chain(), ['find']))
    // Find Neurons' own output is a neuron table, which a table input takes and a Dataset does not.
    expect(recipeTakesWire(sockets, { from: 'target', type: T.table() })).toBe(true)
    expect(recipeTakesWire(sockets, { from: 'target', type: T.dataset() })).toBe(false)
  })

  it('takes nothing with no slots', () => {
    const lone = recipe(chain(), ['ds', 'find', 'filter', 'view'])
    expect(recipeTakesWire(recipeSockets(lone), { from: 'source', type: T.any() })).toBe(false)
  })
})
