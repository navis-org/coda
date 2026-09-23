/**
 * One row of a browser shelf: open it, rename it, delete it.
 *
 * Shared by the workflow library (the Open menu) and the recipe shelf (Manage Recipes), which
 * store different things under the same rules (`store/shelf.ts`) — so the row is one component
 * rather than two that drift on how a rename or a delete asks.
 *
 * The three are siblings rather than nested buttons, and both destructive-ish actions ask in
 * place — a rename opens an input over the row, a delete swaps the row for a confirm. Neither
 * uses `window.confirm`: jsdom does not implement it, and browser chrome for "delete this
 * bookmark" is heavier than the action deserves.
 */

import { useState } from 'react'

export interface ShelfRowProps {
  name: string
  /** The line under the name — when it was saved, and what it holds. */
  detail: string
  onOpen: () => void
  /** Called only with a changed, non-blank name. */
  onRename: (name: string) => void
  onDelete: () => void
  /** What the open button says on hover, when the name alone is not it. */
  openTitle?: string
  /** Disables opening, not renaming or deleting — a locked canvas can still tidy its shelf. */
  disabled?: boolean
  /** Save the entry as a file. Absent, the row offers no download. */
  onDownload?: () => void
}

export function ShelfRow({
  name,
  detail,
  onOpen,
  onRename,
  onDelete,
  openTitle,
  disabled,
  onDownload,
}: ShelfRowProps) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'delete'>('idle')
  const [draft, setDraft] = useState(name)

  if (mode === 'rename') {
    const commit = () => {
      if (draft.trim() && draft !== name) onRename(draft)
      setMode('idle')
    }
    return (
      <div className="library-row library-row--editing">
        <input
          data-owns-escape
          className="library-row__input"
          value={draft}
          autoFocus
          aria-label={`Rename ${name}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(name)
              setMode('idle')
            }
          }}
        />
        <button type="button" className="btn btn--primary library-row__btn" onClick={commit}>
          Rename
        </button>
      </div>
    )
  }

  if (mode === 'delete') {
    return (
      <div className="library-row library-row--editing">
        <span className="library-row__ask">Delete “{name}”?</span>
        <button
          type="button"
          className="btn library-row__btn"
          data-tone="danger"
          onClick={onDelete}
        >
          Delete
        </button>
        <button type="button" className="btn library-row__btn" onClick={() => setMode('idle')}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="library-row">
      <button
        type="button"
        className="dropdown__item library-row__open"
        title={openTitle}
        disabled={disabled}
        onClick={onOpen}
      >
        <strong>{name}</strong>
        <span>{detail}</span>
      </button>
      {onDownload && (
        <button
          type="button"
          className="library-row__act"
          title={`Download ${name} as a file`}
          aria-label={`Download ${name}`}
          onClick={onDownload}
        >
          ⤓
        </button>
      )}
      <button
        type="button"
        className="library-row__act"
        title={`Rename ${name}`}
        aria-label={`Rename ${name}`}
        onClick={() => {
          setDraft(name)
          setMode('rename')
        }}
      >
        ✎
      </button>
      <button
        type="button"
        className="library-row__act"
        title={`Delete ${name}`}
        aria-label={`Delete ${name}`}
        onClick={() => setMode('delete')}
      >
        ✕
      </button>
    </div>
  )
}
