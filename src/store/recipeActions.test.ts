/**
 * The store's recipe actions: saving a selection, and putting a recipe back attached to it.
 *
 * `core/recipes.test.ts` owns what a slot is and which one attaches; `store/recipes.test.ts` owns
 * the shelf. What is pinned here is the seam between them — that the selection is what a recipe
 * attaches to, that the arrival is one undo step and selected, and that each way it can fail says
 * so in `notice` rather than inserting nothing in silence.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addNode, edgeInto } from '../core/graph'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { findAndFilter, node } from '../test/graph'
import { useGraphStore } from './graphStore'
import { recipeFileText, resetRecipes } from './recipes'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  globalThis.indexedDB = new IDBFactory()
  resetRecipes()
  useGraphStore.setState({ locked: false, recipes: [], recipesLoaded: false })
  useGraphStore.getState().newGraph()
  useGraphStore.getState().loadGraph(findAndFilter())
})

const store = () => useGraphStore.getState()
const graph = () => useGraphStore.getState().graph

async function saved(name = 'Find and filter'): Promise<string> {
  expect(await store().saveRecipe(['find', 'filter'], { name })).toEqual({ ok: true })
  return store().recipes[0]!.id
}

describe('saving a recipe', () => {
  it('puts it on the shelf and says so', async () => {
    await saved()
    expect(store().recipes.map((r) => r.name)).toEqual(['Find and filter'])
    expect(store().notice).toMatch(/Saved the recipe “Find and filter”/)
  })

  it('refuses cards that are no longer there, without writing anything', async () => {
    expect(await store().saveRecipe(['gone'], { name: 'x' })).toMatchObject({ ok: false })
    await store().refreshRecipes()
    expect(store().recipes).toEqual([])
  })

  it('is allowed on a locked canvas, like copying', async () => {
    useGraphStore.setState({ locked: true })
    await saved()
    expect(store().recipes).toHaveLength(1)
  })
})

describe('inserting a recipe', () => {
  it('attaches to the one selected node, and selects what arrived', async () => {
    const id = await saved()
    store().setSelection(['ds'])
    expect(await store().insertRecipe(id, { x: 0, y: 500 })).toBe(2)

    const arrived = store().selection
    expect(arrived).toHaveLength(2)
    expect(arrived).not.toContain('find')
    const find = graph().nodes.find((n) => n.id === arrived[0])!
    expect(find.type).toBe('neuron.findNeurons')
    expect(edgeInto(graph(), find.id, 'dataset')?.source).toBe('ds')
    expect(store().notice).toMatch(/Attached “Find and filter”/)
  })

  it('attaches nothing without a single selected node', async () => {
    const id = await saved()
    store().setSelection([])
    await store().insertRecipe(id)
    const find = graph().nodes.find((n) => n.id === store().selection[0])!
    expect(edgeInto(graph(), find.id, 'dataset')).toBeUndefined()
  })

  it('says why when the selection fits no slot', async () => {
    const id = await saved()
    let g = graph()
    g = addNode(g, node('url', 'core.tableFromUrl'))
    store().setGraph(g)
    store().setSelection(['url'])
    await store().insertRecipe(id)
    expect(store().notice).toMatch(/could not attach to the selection/)
  })

  it('is one undo step', async () => {
    const id = await saved()
    const before = graph().nodes.length
    store().setSelection(['ds'])
    await store().insertRecipe(id)
    store().undo()
    expect(graph().nodes).toHaveLength(before)
    expect(graph().edges).toHaveLength(2)
  })

  it('steps a repeat at the same point rather than stacking it', async () => {
    const id = await saved()
    await store().insertRecipe(id, { x: 0, y: 500 })
    const first = graph().nodes.find((n) => n.id === store().selection[0])!.position
    await store().insertRecipe(id, { x: 0, y: 500 })
    const second = graph().nodes.find((n) => n.id === store().selection[0])!.position
    expect(second).not.toEqual(first)
  })

  it('says so when the recipe has gone', async () => {
    expect(await store().insertRecipe('missing')).toBe(0)
    expect(store().notice).toMatch(/no longer in this browser/)
  })
})

describe('attaching to a given node', () => {
  it('attaches to the node it is told, whatever is selected', async () => {
    const id = await saved()
    store().setSelection(['filter'])
    await store().insertRecipe(id, undefined, { node: 'ds' })
    const find = graph().nodes.find((n) => n.id === store().selection[0])!
    expect(edgeInto(graph(), find.id, 'dataset')?.source).toBe('ds')
  })
})

describe('importing a recipe file', () => {
  it('adds it under a free name, renaming the frame with it', async () => {
    const id = await saved('Search')
    await store().importRecipe(await recipeFileText(id))
    expect(
      store()
        .recipes.map((r) => r.name)
        .sort(),
    ).toEqual(['Search', 'Search (2)'])
    expect(store().notice).toMatch(/Added the recipe “Search \(2\)”/)

    const copy = store().recipes.find((r) => r.name === 'Search (2)')!
    await store().insertRecipe(copy.id)
    const frame = graph().groups?.find((g) => g.nodeIds.includes(store().selection[0]!))
    expect(frame?.title).toBe('Search (2)')
  })

  it('stores the file as it is, keeping a card this build cannot read', async () => {
    const id = await saved('Search')
    const doc = JSON.parse(await recipeFileText(id))
    doc.nodes.push({
      id: 'future',
      type: 'from.the.future',
      position: { x: 0, y: 0 },
      params: {},
    })
    await store().importRecipe(JSON.stringify(doc))
    const copy = store().recipes.find((r) => r.name === 'Search (2)')!
    expect(await recipeFileText(copy.id)).toContain('from.the.future')
  })

  it('says so when the text is not a recipe', async () => {
    await store().importRecipe('{"nodes": [], "edges": []}')
    expect(store().notice).toBe('That file is not a Coda recipe')
    expect(store().recipes).toEqual([])
  })
})

describe('the rest of the shelf', () => {
  it('renames and deletes through the store', async () => {
    const id = await saved()
    await store().renameRecipe(id, 'Search')
    expect(store().recipes.map((r) => r.name)).toEqual(['Search'])
    await store().deleteRecipe(id)
    expect(store().recipes).toEqual([])
  })
})
