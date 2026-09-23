// @vitest-environment jsdom

/**
 * The recipe surfaces: the menu rows that open Save as Recipe, the dialog itself, the palette's
 * `Recipe:` rows and Manage Recipes.
 *
 * The store actions are pinned in `store/recipeActions.test.ts`; what is pinned here is the
 * wiring, and the three things a reader decides from the screen before any action runs — which
 * cards a menu row saves, what the dialog says the recipe will attach to, and that a name already
 * on the shelf is a replace said before the click. Rendered directly, for `nodeMenu.test.tsx`'s
 * reason.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodaGraph } from '../../core/graph'
import { createGroup } from '../../core/groups'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { loadRecipe, resetRecipes } from '../../store/recipes'
import { findAndFilter } from '../../test/graph'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { T } from '../../core/types'
import { AddMenu } from './AddMenu'
import { GroupContextMenu } from './GroupContextMenu'
import { NodeContextMenu } from './NodeContextMenu'
import type { PaletteItem } from './paletteItems'
import { buildCommandItems, buildRecipeItems } from './paletteItems'
import { RecipeSaveDialog } from './RecipeSaveDialog'
import { RecipesDialog } from './RecipesDialog'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  globalThis.indexedDB = new IDBFactory()
  resetRecipes()
  useGraphStore.getState().setAddMenu(false)
  useGraphStore.setState({
    locked: false,
    recipes: [],
    recipesLoaded: false,
    recipesOpen: false,
  })
  useGraphStore.getState().newGraph()
  useGraphStore.getState().loadGraph(chain())
})

afterEach(cleanup)

const store = () => useGraphStore.getState()

/** `findAndFilter`, with the last two in a frame called "Search". */
function chain(): CodaGraph {
  return createGroup(findAndFilter(), ['find', 'filter'], { title: 'Search' })
}

const ctx = () => ({ store: store(), fitView: () => {}, fitSelected: () => {} })
const saveRow = () => buildCommandItems(ctx()).find((i) => i.id === 'recipe:save')

function recipeRows(): PaletteItem[] {
  return buildRecipeItems({ store: store(), fitView: () => {}, fitSelected: () => {} })
}

describe('the menu rows', () => {
  it('saves the whole selection from a selected card, and is live under the lock', () => {
    useGraphStore.setState({ locked: true })
    store().setSelection(['find', 'filter'])
    render(
      <NodeContextMenu
        nodeId="find"
        screenPosition={{ x: 0, y: 0 }}
        onClose={() => undefined}
      />,
    )
    const row = screen.getByText('Save as Recipe…') as HTMLButtonElement
    expect(row.disabled).toBe(false)
    fireEvent.click(row)
    expect(store().savingRecipe).toEqual(['find', 'filter'])
  })

  it('saves only the clicked card when it is not in the selection', () => {
    store().setSelection(['filter'])
    render(
      <NodeContextMenu nodeId="ds" screenPosition={{ x: 0, y: 0 }} onClose={() => undefined} />,
    )
    fireEvent.click(screen.getByText('Save as Recipe…'))
    expect(store().savingRecipe).toEqual(['ds'])
  })

  it('saves a frame’s cards from the frame menu', () => {
    const frame = store().graph.groups![0]!
    render(
      <GroupContextMenu
        groupId={frame.id}
        screenPosition={{ x: 0, y: 0 }}
        onClose={() => undefined}
      />,
    )
    fireEvent.click(screen.getByText('Save as Recipe…'))
    expect(store().savingRecipe).toEqual(['find', 'filter'])
  })
})

describe('Save as Recipe', () => {
  it('offers the frame’s title as the name and lists what it attaches to', () => {
    store().openRecipeSave(['find', 'filter'])
    render(<RecipeSaveDialog />)
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Search')
    expect(screen.getByText(/reads 1 wire/)).toBeTruthy()
  })

  it('saves, closes, and lists the recipe', async () => {
    store().openRecipeSave(['find', 'filter'])
    render(<RecipeSaveDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(store().savingRecipe).toBeUndefined())
    expect(store().recipes.map((r) => r.name)).toEqual(['Search'])
  })

  it('says a name already on the shelf is a replace, before the click', async () => {
    await store().saveRecipe(['find', 'filter'], { name: 'Search' })
    store().openRecipeSave(['find', 'filter'])
    render(<RecipeSaveDialog />)
    expect(await screen.findByRole('button', { name: 'Replace' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(store().savingRecipe).toBeUndefined())
    expect(store().recipes).toHaveLength(1)
  })

  it('will not save without a name', () => {
    store().openRecipeSave(['ds'])
    render(<RecipeSaveDialog />)
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('resets the ticked cards only', async () => {
    store().setParam('find', 'roi', 'ALX(R)')
    const filterParams = store().graph.nodes.find((n) => n.id === 'filter')!.params
    store().openRecipeSave(['find', 'filter'])
    render(<RecipeSaveDialog />)
    fireEvent.click(screen.getByLabelText(requireNodeDef('neuron.findNeurons').label))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(store().savingRecipe).toBeUndefined())

    const { recipe } = await loadRecipe(store().recipes[0]!.id)
    const byType = (type: string) => recipe.graph.nodes.find((n) => n.type === type)!.params
    expect(byType('neuron.findNeurons')).toEqual(
      defaultParams(requireNodeDef('neuron.findNeurons')),
    )
    expect(byType('core.filterTable')).toEqual(filterParams)
  })
})

describe('the palette’s Recipe rows', () => {
  it('offers the save row only with something selected', () => {
    store().setSelection([])
    expect(saveRow()?.disabled).toBe(true)
    store().setSelection(['find'])
    expect(saveRow()?.disabled).toBe(false)
  })

  it('lists each recipe, and disables inserting — not saving — under the lock', async () => {
    await store().saveRecipe(['find', 'filter'], { name: 'Search' })
    store().setSelection(['find'])
    useGraphStore.setState({ locked: true })
    const rows = recipeRows()
    const entry = rows.find((i) => i.label === 'Search')!
    expect(entry.action).toBe('Add')
    expect(entry.disabled).toBe(true)
    expect(saveRow()?.disabled).toBe(false)
  })

  it('inserts the recipe where the palette was opened, not where the pointer went', async () => {
    await store().saveRecipe(['find', 'filter'], { name: 'Search' })
    const before = store().graph.nodes.length
    const rows = buildRecipeItems({
      store: store(),
      fitView: () => {},
      fitSelected: () => {},
      pastePoint: () => ({ x: 9999, y: 9999 }),
      insertPoint: { x: 40, y: 700 },
    })
    rows.find((i) => i.label === 'Search')!.perform!()
    await waitFor(() => expect(store().graph.nodes).toHaveLength(before + 2))
    const arrived = store().graph.nodes.filter((n) => store().selection.includes(n.id))
    expect(Math.min(...arrived.map((n) => n.position.x))).toBe(40)
    expect(Math.min(...arrived.map((n) => n.position.y))).toBe(700)
  })
})

describe('Manage Recipes', () => {
  it('lists the shelf and inserts from it', async () => {
    await store().saveRecipe(['find', 'filter'], { name: 'Search' })
    store().openRecipes(true)
    render(<RecipesDialog insertAt={() => ({ x: 0, y: 600 })} />)
    const before = store().graph.nodes.length
    fireEvent.click(await screen.findByText('Search'))
    await waitFor(() => expect(store().graph.nodes).toHaveLength(before + 2))
    expect(store().recipesOpen).toBe(false)
  })

  it('offers a filter on a long shelf that narrows by name, and none on a short one', async () => {
    await store().saveRecipe(['find', 'filter'], { name: 'Search' })
    store().openRecipes(true)
    const { unmount } = render(<RecipesDialog insertAt={() => ({ x: 0, y: 0 })} />)
    await screen.findByText('Search')
    expect(screen.queryByLabelText('Filter recipes')).toBeNull()
    unmount()

    for (const name of [
      'FlyWire annotations',
      'BANC annotations',
      'Find LC',
      'Paths',
      'Sankey',
    ])
      await store().saveRecipe(['find', 'filter'], { name })
    render(<RecipesDialog insertAt={() => ({ x: 0, y: 0 })} />)
    const filter = await screen.findByLabelText('Filter recipes')
    fireEvent.change(filter, { target: { value: '  ANNOT ' } })
    expect(screen.getByText('FlyWire annotations')).toBeTruthy()
    expect(screen.getByText('BANC annotations')).toBeTruthy()
    expect(screen.queryByText('Search')).toBeNull()
    fireEvent.change(filter, { target: { value: 'nothing like it' } })
    expect(screen.getByText(/No recipe matches “nothing like it”/)).toBeTruthy()
  })

  it('says so when the shelf is empty', async () => {
    store().openRecipes(true)
    render(<RecipesDialog insertAt={() => ({ x: 0, y: 0 })} />)
    expect(await screen.findByText(/No recipes saved/)).toBeTruthy()
  })
})

describe('the palette a dropped wire opens', () => {
  const dropped = (from: 'source' | 'target', type: ReturnType<typeof T.any>) =>
    buildRecipeItems(
      {
        store: store(),
        fitView: () => {},
        fitSelected: () => {},
        insertPoint: { x: 0, y: 900 },
      },
      { filter: { from, type }, nodeId: 'ds', portId: 'dataset' },
    )

  it('lists only the recipes that take the wire, and no save or manage rows', async () => {
    await store().saveRecipe(['find', 'filter'], { name: 'Search' })
    expect(dropped('source', T.dataset()).map((i) => i.label)).toEqual(['Search'])
    expect(dropped('source', T.number())).toEqual([])
  })

  it('attaches to the node the wire came from, not the selection', async () => {
    await store().saveRecipe(['find', 'filter'], { name: 'Search' })
    store().setSelection(['filter'])
    dropped('source', T.dataset())[0]!.perform!()
    await waitFor(() => expect(store().notice).toMatch(/Attached “Search”/))
  })
})

describe('the + menu’s recipes', () => {
  const menu = (onAddRecipe = vi.fn()) => {
    render(
      <AddMenu locked={false} onBrowse={() => {}} onAdd={() => {}} onAddRecipe={onAddRecipe} />,
    )
    return onAddRecipe
  }

  it('shows no Recipes button until something is saved', async () => {
    menu()
    fireEvent.click(screen.getByRole('button', { name: 'Add a node' }))
    await waitFor(() => expect(store().recipesLoaded).toBe(true))
    expect(screen.queryByRole('button', { name: 'Saved recipes' })).toBeNull()
  })

  it('opens a band of saved recipes, and inserts the one picked', async () => {
    await store().saveRecipe(['find', 'filter'], { name: 'Search' })
    const onAddRecipe = menu()
    fireEvent.click(screen.getByRole('button', { name: 'Add a node' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Saved recipes' }))
    fireEvent.click(await screen.findByText('Search'))
    expect(onAddRecipe).toHaveBeenCalledWith(store().recipes[0]!.id)
    expect(store().addMenuOpen).toBe(false)
  })
})

describe('recipe files', () => {
  it('offers a download on each Manage Recipes row', async () => {
    await store().saveRecipe(['find', 'filter'], { name: 'Search' })
    store().openRecipes(true)
    render(<RecipesDialog insertAt={() => ({ x: 0, y: 0 })} />)
    expect(await screen.findByRole('button', { name: 'Download Search' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Import a recipe file…' })).toBeTruthy()
  })
})
