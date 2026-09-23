/**
 * Manage Recipes: the recipe shelf as a list — insert, rename, delete, and to and from a file.
 *
 * The palette's `Add ▸ Recipe` rows and the **+** menu are the quick ways in; this is the one
 * place a recipe can be renamed, deleted or shared. The rows are `ShelfRow`, the Open menu's,
 * because the two shelves keep their entries under one set of rules.
 *
 * **A file is how a recipe leaves this browser**, the shelf being per-profile: the download is the
 * stored text byte for byte (`recipeFileText`), and an import lands under a free name rather than
 * over an entry of the same one (`importRecipe`). A recipe file is also a fragment, so ⌘V of its
 * text places the cards unattached without touching the shelf.
 */

import { useEffect, useId } from 'react'

import type { Point } from '../../core/clipboard'
import { useGraphStore } from '../../store/graphStore'
import { pickTextFile } from '../../store/persistence'
import { recipeFileText } from '../../store/recipes'
import { downloadText, slugify } from '../export'
import { formatAgo, recipeDetail } from '../format'
import { LOCKED_HINT } from '../lockCopy'
import { Modal, ModalHeader } from '../Modal'
import { ShelfRow } from './ShelfRow'

export function RecipesDialog({ insertAt }: { insertAt: () => Point }) {
  const open = useGraphStore((s) => s.recipesOpen)
  if (!open) return null
  return <RecipesPanel insertAt={insertAt} />
}

function close(): void {
  useGraphStore.getState().openRecipes(false)
}

/** The suffix a recipe file is saved with; `.json` so any viewer opens it, as `.coda.json` is. */
const RECIPE_FILE = '.coda-recipe.json'

async function download(id: string, name: string): Promise<void> {
  try {
    downloadText(
      [await recipeFileText(id)],
      `${slugify(name, 'recipe')}${RECIPE_FILE}`,
      'application/json',
    )
  } catch (err) {
    useGraphStore.setState({ notice: (err as Error).message })
  }
}

async function importFile(): Promise<void> {
  const file = await pickTextFile(`${RECIPE_FILE},.json,application/json`)
  if (file) await useGraphStore.getState().importRecipe(file.text)
}

function RecipesPanel({ insertAt }: { insertAt: () => Point }) {
  const recipes = useGraphStore((s) => s.recipes)
  const loaded = useGraphStore((s) => s.recipesLoaded)
  const locked = useGraphStore((s) => s.locked)
  const titleId = useId()

  useEffect(() => {
    void useGraphStore.getState().refreshRecipes()
  }, [])

  return (
    <Modal className="overlay__panel recipe-dialog" labelledBy={titleId} onClose={close}>
      <ModalHeader titleId={titleId} onClose={close}>
        Recipes
      </ModalHeader>
      <div className="sources__body recipe-dialog__body">
        <p className="sources__note">
          Sets of nodes that are frequently used together. To save a recipe, select nodes and
          then choose <strong>Save as Recipe…</strong> from the context menu.
        </p>
        {!loaded && <p className="sources__note">Reading…</p>}
        {loaded && recipes.length === 0 && (
          <p className="sources__note">No recipes saved in this browser yet.</p>
        )}
        {recipes.map((entry) => (
          <ShelfRow
            key={entry.id}
            name={entry.name}
            detail={`${formatAgo(entry.savedAt)} · ${recipeDetail(entry)}`}
            disabled={locked}
            openTitle={locked ? LOCKED_HINT : `Put “${entry.name}” on the canvas`}
            onOpen={() => {
              close()
              void useGraphStore.getState().insertRecipe(entry.id, insertAt())
            }}
            onRename={(name) => void useGraphStore.getState().renameRecipe(entry.id, name)}
            onDelete={() => void useGraphStore.getState().deleteRecipe(entry.id)}
            onDownload={() => void download(entry.id, entry.name)}
          />
        ))}
        <div className="sources__actions recipe-save__actions">
          <button type="button" className="btn" onClick={() => void importFile()}>
            Import a recipe file…
          </button>
        </div>
      </div>
    </Modal>
  )
}
