/**
 * The recipe shelf — saved sets of nodes in the browser.
 *
 * The library's two departures from every other storage path hold here too, and are pinned for
 * the same reason (`library.test.ts` argues each): a failed write **rejects**, because a recipe
 * that silently did not save is gone on the next reload; and identity is the normalised name.
 * What is new is the rename, which has to reach the frame `recipeFrom` copied the name into.
 *
 * Runs against `fake-indexeddb`, a fresh factory per case, and `resetRecipes()` beside it — without
 * the second half every case after the first writes into a dead database.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Recipe } from '../core/recipes'
import { recipeFrom, recipeText } from '../core/recipes'
// Side-effect import: `readRecipe` drops nodes whose type is not registered.
import '../nodes'
import { findAndFilter } from '../test/graph'
import {
  deleteRecipe,
  listRecipes,
  loadRecipe,
  recipeFileText,
  renameRecipe,
  resetRecipes,
  saveRecipe,
} from './recipes'

/** The recipe cut from `findAndFilter`'s last two cards. */
function recipe(name: string): Recipe {
  return recipeFrom(findAndFilter(), ['find', 'filter'], { name })!
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetRecipes()
})

describe('recipe shelf', () => {
  it('round-trips a recipe, slots and all', async () => {
    const original = recipe('Find and filter')
    const saved = await saveRecipe(original)
    const { recipe: back, warnings } = await loadRecipe(saved.id)

    expect(warnings).toEqual([])
    expect(back.name).toBe('Find and filter')
    expect(back.slots).toEqual(original.slots)
    expect(back.graph.nodes.map((n) => n.type)).toEqual([
      'neuron.findNeurons',
      'core.filterTable',
    ])
  })

  it('summarises without the recipe being read back', async () => {
    const saved = await saveRecipe(recipe('Find and filter'))
    expect(saved.nodeTypes).toEqual(['neuron.findNeurons', 'core.filterTable'])
    expect(saved.slots).toEqual([recipe('x').slots[0]!.label])
    expect(await listRecipes()).toEqual([saved])
  })

  it('records the sockets a dropped wire could attach it by', async () => {
    const saved = await saveRecipe(recipe('Find and filter'))
    expect(saved.reads?.map((s) => s.type.kind)).toEqual(['dataset'])
    expect(saved.feeds).toEqual([])
  })

  it('hands back the stored text byte for byte, which is what a download writes', async () => {
    const original = recipe('Find and filter')
    const saved = await saveRecipe(original)
    expect(await recipeFileText(saved.id)).toBe(recipeText(original))
    await deleteRecipe(saved.id)
    await expect(recipeFileText(saved.id)).rejects.toThrow(/no longer in this browser/)
  })

  it('overwrites in place when told which entry, keeping the creation time', async () => {
    const first = await saveRecipe(recipe('Find and filter'))
    const again = await saveRecipe(recipe('Find and filter'), { id: first.id })
    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(first.createdAt)
    expect(await listRecipes()).toHaveLength(1)
  })

  it('renames the entry and the frame it arrives in, keeping the creation time', async () => {
    const saved = await saveRecipe(recipe('Find and filter'))
    const renamed = await renameRecipe(saved.id, 'Search')

    expect(renamed.name).toBe('Search')
    expect(renamed.createdAt).toBe(saved.createdAt)
    expect((await listRecipes()).map((e) => e.name)).toEqual(['Search'])
    const { recipe: back } = await loadRecipe(saved.id)
    // That the frame follows is `renamedRecipeText`'s, pinned in `core/recipes.test.ts`.
    expect(back.name).toBe('Search')
  })

  it('deletes the summary and the recipe together', async () => {
    const saved = await saveRecipe(recipe('doomed'))
    await deleteRecipe(saved.id)
    expect(await listRecipes()).toEqual([])
    await expect(loadRecipe(saved.id)).rejects.toThrow(/no longer in this browser/)
    await expect(renameRecipe(saved.id, 'x')).rejects.toThrow(/no longer in this browser/)
  })

  it('reports a corrupt entry rather than inserting nothing', async () => {
    const saved = await saveRecipe(recipe('fine'))
    await new Promise<void>((resolve) => {
      const request = indexedDB.open('coda-recipes', 1)
      request.onsuccess = () => {
        const tx = request.result.transaction('recipes', 'readwrite')
        tx.objectStore('recipes').put('{ not json', saved.id)
        tx.oncomplete = () => resolve()
      }
    })
    await expect(loadRecipe(saved.id)).rejects.toThrow(/Could not read/)
    await expect(renameRecipe(saved.id, 'x')).rejects.toThrow(/Could not read/)
  })

  describe('with no IndexedDB', () => {
    beforeEach(() => {
      // @ts-expect-error deliberately removing the platform API
      delete globalThis.indexedDB
      resetRecipes()
    })

    it('reads as an empty shelf', async () => {
      expect(await listRecipes()).toEqual([])
    })

    it('refuses to save rather than pretending', async () => {
      await expect(saveRecipe(recipe('nowhere'))).rejects.toThrow(/not storing data/)
    })

    it('retries the next time rather than caching the refusal', async () => {
      await expect(saveRecipe(recipe('nowhere'))).rejects.toThrow()
      globalThis.indexedDB = new IDBFactory()
      await expect(saveRecipe(recipe('somewhere'))).resolves.toBeTruthy()
    })
  })
})
