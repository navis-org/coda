/**
 * The recipe shelf — saved sets of nodes, kept in the browser.
 *
 * The workflow library's rules, for the workflow library's reasons, and each is stated once in
 * `library.ts` rather than again here: IndexedDB and not `localStorage` (a recipe holding an
 * Explore select-all is most of a megabyte), **writes reject and reads resolve** (a save that
 * silently did not save is data loss), no in-memory fallback, and identity by normalised name
 * (`shelf.ts`, shared). Summaries are stored apart from the text, so listing the shelf for a
 * palette does not read every recipe.
 *
 * **Its own database**, not a third store in `coda-library`: two modules opening one database
 * with different version numbers race on the upgrade, which `data/idb.ts` records as the reason
 * each module there keeps its own.
 *
 * What is stored is exactly the text `recipeText` produces — the same bytes a recipe file will
 * hold — and what is read goes back through `readRecipe`, so a recipe on the shelf gets the
 * renames and the drops a file gets. A rename goes through `renamedRecipeText`, never through a
 * read-and-rewrite, for the reason given there.
 */

import type { Recipe } from '../core/recipes'
import { readRecipe, recipeSockets, recipeText, renamedRecipeText } from '../core/recipes'
import type { Socket } from '../core/sockets'
import { newId } from '../core/graph'
import type { RefusalWords } from '../data/idb'
import { attempt, commit, database, readKey } from '../data/idb'
import { newestFirst } from './shelf'

const DB_NAME = 'coda-recipes'
const DB_VERSION = 1
/** Summaries, read on their own so listing the shelf does not parse every recipe. */
const META_STORE = 'meta'
/** The recipe text, keyed by the same id. */
const TEXT_STORE = 'recipes'

/** What the shelf shows for one stored recipe. */
export interface RecipeSummary {
  id: string
  /** As saved. Identity for an overwrite is the normalised form — see `findByName` in `shelf.ts`. */
  name: string
  /** Epoch ms of the most recent save. */
  savedAt: number
  /** Epoch ms of the first save; survives an overwrite and a rename. */
  createdAt: number
  /** Node types in fragment order, for a tile drawn from the glyph table. */
  nodeTypes: string[]
  /** Each slot's label, in order — what a palette row can say the recipe attaches to. */
  slots: string[]
  /** The sockets a dropped wire can attach it by — see `recipeSockets`. */
  reads: Socket[]
  feeds: Socket[]
}

const db = database({ name: DB_NAME, version: DB_VERSION, stores: [META_STORE, TEXT_STORE] })

const REFUSAL: RefusalWords = {
  unavailable:
    'This browser is not storing data for Coda — a private window does this. Recipes need browser storage.',
  rolledBack: 'Saving the recipe was rolled back',
  failed: 'Saving the recipe failed',
  quota: 'No room left in browser storage. Delete a recipe or a stored workflow and try again.',
}

const GONE = 'That recipe is no longer in this browser'
const UNREADABLE = 'Could not read the stored recipe'

function write(run: (meta: IDBObjectStore, texts: IDBObjectStore) => void): Promise<void> {
  return commit(
    db,
    [META_STORE, TEXT_STORE],
    (tx) => run(tx.objectStore(META_STORE), tx.objectStore(TEXT_STORE)),
    REFUSAL,
  )
}

const summaryOf = (id: string) =>
  readKey<RecipeSummary | undefined>(db, META_STORE, id, undefined)
const textOf = (id: string) => readKey<string | undefined>(db, TEXT_STORE, id, undefined)

/** Everything on the shelf, in `newestFirst` order. */
export async function listRecipes(): Promise<RecipeSummary[]> {
  const rows = await attempt<RecipeSummary[]>(
    db,
    META_STORE,
    'readonly',
    (tx) => tx.objectStore(META_STORE).getAll() as IDBRequest<RecipeSummary[]>,
    [],
  )
  return newestFirst([...rows])
}

/**
 * Put a recipe on the shelf, or over the entry `id` names.
 *
 * The caller resolves a name to an id with `findByName`, as `saveWorkflow`'s does, because
 * whether an overwrite needs confirming is the UI's question. Rejects on any failure.
 */
export function saveRecipe(
  recipe: Recipe,
  options: { id?: string } = {},
): Promise<RecipeSummary> {
  return saveRecipeText(recipeText(recipe), options)
}

/**
 * Put a recipe file's text on the shelf **as it is**, the summary read from it once.
 *
 * The import's path, and the reason it exists: saving a *read* recipe would store what
 * `readRecipe` healed — a card from a newer build dropped — which is the loss `renamedRecipeText`
 * is written to avoid. Rejects text that is not a recipe.
 */
export async function saveRecipeText(
  text: string,
  options: { id?: string } = {},
): Promise<RecipeSummary> {
  const recipe = readRecipe(text)?.recipe
  if (!recipe) throw new Error(UNREADABLE)
  const previous = options.id ? await summaryOf(options.id) : undefined
  const now = Date.now()
  const summary: RecipeSummary = {
    id: options.id ?? newId('r'),
    name: recipe.name,
    savedAt: now,
    createdAt: previous?.createdAt ?? now,
    nodeTypes: recipe.graph.nodes.map((n) => n.type),
    slots: recipe.slots.map((s) => s.label),
    ...recipeSockets(recipe),
  }
  await write((meta, texts) => {
    meta.put(summary, summary.id)
    texts.put(text, summary.id)
  })
  return summary
}

/**
 * Read a stored recipe back, or throw — an entry that has gone, or no longer reads, has to say
 * so rather than insert nothing and leave the gesture looking like it did not happen.
 */
export async function loadRecipe(id: string): Promise<{ recipe: Recipe; warnings: string[] }> {
  const read = readRecipe(await recipeFileText(id))
  if (!read) throw new Error(UNREADABLE)
  return read
}

/** The entry exactly as stored — the bytes a recipe file holds — or throw if it has gone. */
export async function recipeFileText(id: string): Promise<string> {
  const text = await textOf(id)
  if (text === undefined) throw new Error(GONE)
  return text
}

/** Rename the entry and the frame the name was copied into, in one committed write. */
export async function renameRecipe(id: string, name: string): Promise<RecipeSummary> {
  const [previous, text] = await Promise.all([summaryOf(id), textOf(id)])
  if (!previous || text === undefined) throw new Error(GONE)
  const renamed = renamedRecipeText(text, name)
  if (!renamed) throw new Error(UNREADABLE)
  const summary: RecipeSummary = { ...previous, name: renamed.name }
  await write((meta, texts) => {
    meta.put(summary, id)
    texts.put(renamed.text, id)
  })
  return summary
}

/** Rejects rather than degrading: a delete that silently did not happen is its own surprise. */
export async function deleteRecipe(id: string): Promise<void> {
  await write((meta, texts) => {
    meta.delete(id)
    texts.delete(id)
  })
}

/** Test seam: forget the open database so a fresh `indexedDB` is picked up. */
export function resetRecipes(): void {
  db.reset()
}
