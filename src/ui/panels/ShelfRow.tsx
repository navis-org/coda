/**
 * A browser shelf on screen: `ShelfList`, the list with its filter, and `ShelfRow`, one entry.
 *
 * Shared by the workflow library (the Open menu) and the recipe shelf (Manage Recipes), which
 * store different things under the same rules (`store/shelf.ts`) — so each is one component
 * rather than two that drift on how a rename asks or how a long shelf behaves.
 *
 * The three are siblings rather than nested buttons, and both destructive-ish actions ask in
 * place — a rename opens an input over the row, a delete swaps the row for a confirm. Neither
 * uses `window.confirm`: jsdom does not implement it, and browser chrome for "delete this
 * bookmark" is heavier than the action deserves.
 */

import type { ReactNode } from 'react'
import { Fragment, useState } from 'react'

import { normalizeName } from '../../store/shelf'

/** From how many entries the filter is offered — below it, the whole shelf is on screen anyway. */
export const SHELF_FILTER_FROM = 6

/**
 * The entries, filtered from `SHELF_FILTER_FROM` of them, in a box that is **the one thing that
 * scrolls**: the surface around it (a dialog's note and Import, the Open menu's heading and file
 * picker) stays put, where a surface scrolling as one pushed its last control below the fold once
 * the shelf grew. The caller's container has to be a flex column with a capped height for the box
 * to have something to shrink inside (a `column` Dropdown, Manage Recipes' body).
 *
 * The filter matches the name as the shelf compares names (`normalizeName`) — a substring, not
 * the palette's `fuzzyRank`, so the list keeps its newest-first order as it narrows.
 */
export function ShelfList<T extends { id: string; name: string }>({
  entries,
  noun,
  autoFocus = true,
  children,
}: {
  entries: readonly T[]
  /** Singular, for the placeholder and the no-match line: "recipe", "workflow". */
  noun: string
  /**
   * Focus the filter when it appears. Off in a menu: a menu is opened to click a row, and a
   * focused field pops a phone's keyboard and takes the canvas shortcuts until clicked away.
   */
  autoFocus?: boolean
  /** One row per entry; keyed here by `id`. */
  children: (entry: T) => ReactNode
}) {
  const [query, setQuery] = useState('')
  const filterable = entries.length >= SHELF_FILTER_FROM
  // Gated on `filterable`, so a query cannot go on narrowing a list whose filter has gone.
  const wanted = filterable ? normalizeName(query) : ''
  const shown = wanted
    ? entries.filter((entry) => normalizeName(entry.name).includes(wanted))
    : entries
  return (
    <>
      {filterable && (
        <input
          type="search"
          className="field shelf-list__filter"
          aria-label={`Filter ${noun}s`}
          placeholder={`Filter ${entries.length} ${noun}s`}
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="shelf-list">
        {shown.length === 0 && wanted && (
          <p className="shelf-list__none">
            No {noun} matches “{query.trim()}”.
          </p>
        )}
        {shown.map((entry) => (
          <Fragment key={entry.id}>{children(entry)}</Fragment>
        ))}
      </div>
    </>
  )
}

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
