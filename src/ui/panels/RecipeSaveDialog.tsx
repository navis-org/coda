/**
 * Save as Recipe: name the cards, see what they will attach to, and choose what not to keep.
 *
 * Opened by the node menu, the frame menu and the palette, all through `savingRecipe` in the
 * store — `editingHint`'s arrangement, since none of them can reach a dialog mounted here.
 *
 * **The slots are shown before the save**, because they are the part of a recipe nobody chose:
 * every wire crossing the selection's edge becomes one, grouped by the card at its far end. A
 * reader who selected one card too few sees a slot they did not expect, which is the cheapest
 * place to find that out.
 *
 * **Reset is per card and off by default** — the configuration is usually why a set was worth
 * saving, and an id list or a file name is the exception somebody can tick.
 *
 * Saving under a name already on the shelf replaces that recipe, and the button says so before
 * the click rather than after it (`findByName`, the library's rule).
 */

import { useEffect, useId, useMemo, useState } from 'react'

import type { CodaGraph } from '../../core/graph'
import { nodeLabel } from '../../core/graph'
import type { RecipeSlot } from '../../core/recipes'
import { recipeSlots } from '../../core/recipes'
import { useGraphStore } from '../../store/graphStore'
import { findByName } from '../../store/shelf'
import { formatAgo, plural } from '../format'
import { Modal, ModalHeader } from '../Modal'

export function RecipeSaveDialog() {
  const ids = useGraphStore((s) => s.savingRecipe)
  if (!ids) return null
  // No key per opening, unlike `HintEditor`: this is a modal, so nothing reopens it while it is
  // open, and closing it unmounts the panel.
  return <RecipeSavePanel ids={ids} />
}

function close(): void {
  useGraphStore.getState().openRecipeSave(undefined)
}

/** The title of the frame that is exactly these cards, which is what the recipe is usually called. */
function frameTitle(graph: CodaGraph, ids: readonly string[]): string {
  const wanted = new Set(ids)
  const frame = graph.groups?.find(
    (g) => g.nodeIds.length === wanted.size && g.nodeIds.every((id) => wanted.has(id)),
  )
  return frame?.title ?? ''
}

/** One slot in words: what it is, and which way its wires run. */
function slotLine(slot: RecipeSlot): string {
  const reads = slot.wires.filter((w) => w.dir === 'in').length
  const feeds = slot.wires.length - reads
  const how = [
    reads && `reads ${plural(reads, 'wire')}`,
    feeds && `feeds ${plural(feeds, 'wire')}`,
  ]
    .filter(Boolean)
    .join(', ')
  return `${slot.label} — ${how}`
}

function RecipeSavePanel({ ids }: { ids: readonly string[] }) {
  const graph = useGraphStore((s) => s.graph)
  const recipes = useGraphStore((s) => s.recipes)
  const saveRecipe = useGraphStore((s) => s.saveRecipe)
  const titleId = useId()

  const [name, setName] = useState(() => frameTitle(graph, ids))
  const [reset, setReset] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void useGraphStore.getState().refreshRecipes()
  }, [])

  const cards = useMemo(() => {
    const wanted = new Set(ids)
    return graph.nodes.filter((n) => wanted.has(n.id))
  }, [graph, ids])
  const slots = useMemo(() => recipeSlots(graph, ids), [graph, ids])

  // The cards can go out from under the dialog — deleted, or a different document switched in.
  const gone = cards.length === 0
  useEffect(() => {
    if (gone) close()
  }, [gone])
  if (gone) return null

  const conflict = name.trim() ? findByName(recipes, name) : undefined
  const canSave = name.trim() !== '' && !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    const result = await saveRecipe(ids, { name, reset: [...reset], id: conflict?.id })
    setSaving(false)
    if (result.ok) close()
    else setError(result.error)
  }

  const toggle = (id: string) =>
    setReset((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <Modal className="overlay__panel recipe-dialog" labelledBy={titleId} onClose={close}>
      <ModalHeader titleId={titleId} onClose={close}>
        Save as Recipe
      </ModalHeader>
      <div className="sources__body recipe-dialog__body">
        <label className="sources__field">
          <span>Name</span>
          <input
            className="field"
            value={name}
            autoFocus
            placeholder="What this set of cards is for"
            onChange={(e) => {
              setName(e.target.value)
              setError(undefined)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
          />
        </label>

        <p className="sources__note">
          {plural(cards.length, 'card')}
          {slots.length === 0
            ? ', wired to nothing outside the selection.'
            : '. With one card selected, an inserted recipe attaches to it through the first of these that fits:'}
        </p>
        {slots.length > 0 && (
          <ul className="recipe-save__slots">
            {slots.map((slot, index) => (
              <li key={index}>{slotLine(slot)}</li>
            ))}
          </ul>
        )}

        <details className="recipe-save__reset">
          <summary>
            Reset parameters to their defaults
            {reset.size > 0 ? ` (${reset.size})` : ''}
          </summary>
          <p className="sources__note sources__note--tight">
            For values that belong to this workflow rather than to the recipe — an id list, a
            file name. Everything unticked is saved as it is.
          </p>
          {cards.map((card) => (
            <label key={card.id} className="share__check">
              <input
                type="checkbox"
                checked={reset.has(card.id)}
                onChange={() => toggle(card.id)}
              />
              <span>{nodeLabel(card)}</span>
            </label>
          ))}
        </details>

        {conflict && (
          <p className="sources__result" data-tone="warn">
            Replaces the recipe “{conflict.name}”, saved {formatAgo(conflict.savedAt)}.
          </p>
        )}
        {error && (
          <p className="sources__result" data-tone="error">
            {error}
          </p>
        )}
        <p className="sources__note sources__note--tight">
          Kept in this browser, and cleared with the site data.
        </p>

        <div className="sources__actions recipe-save__actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSave}
            onClick={() => void save()}
          >
            {conflict ? 'Replace' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
