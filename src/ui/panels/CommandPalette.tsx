/**
 * Fuzzy command palette.
 *
 * Three ways in:
 *   Space                      everything — commands and node insertions
 *   double-click / right-click prefilled with `Add:`, so only node insertions are listed
 *   drag a link into space     node insertions, filtered to what accepts the dragged type
 *
 * Tab and the toolbar's + Add deliberately open `NodeBrowser` instead — a browsing surface
 * with previews, for when you don't already know the node's name.
 *
 * Rows are breadcrumbs — `Add ▶ Transform ▶ Filter ▶ Keep rows matching…` — with only the name
 * segment in primary ink. That makes every row self-describing, so the list needs no group
 * headers and reads the same whether or not a query is active.
 *
 * The `Action:` prefix is a real filter, not just prefilled text: it narrows the item set
 * and the rest of the input is matched against it. Deleting the prefix widens the search
 * back out, which keeps the two entry points from feeling like separate modes.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { typeLabel } from '../../core/types'
import type { CodaType } from '../../core/types'
import { fuzzyRank } from './fuzzy'
import type { PaletteAction, PaletteItem } from './paletteItems'
import { PALETTE_ACTIONS, paletteSearchText } from './paletteItems'
import { Highlight } from './Highlight'
import { useDismissOnOutside } from '../useDismiss'

export interface CommandPaletteProps {
  items: PaletteItem[]
  screenPosition: { x: number; y: number }
  /** Prefills the search box, e.g. "Add:" to restrict to node insertions. */
  initialQuery?: string
  /** Set when opened by dragging from a socket. */
  filterType?: CodaType
  onPick: (item: PaletteItem) => void
  onClose: () => void
}

const MAX_RESULTS = 60

interface ParsedQuery {
  action: PaletteAction | undefined
  /** Query with the prefix stripped. */
  text: string
}

/** Split a leading `Action:` filter off the query. */
export function parsePaletteQuery(raw: string): ParsedQuery {
  const match = /^\s*([A-Za-z]+)\s*:\s*/.exec(raw)
  if (match) {
    const typed = match[1]!.toLowerCase()
    const action = PALETTE_ACTIONS.find((a) => a.toLowerCase() === typed)
    if (action) return { action, text: raw.slice(match[0].length) }
  }
  return { action: undefined, text: raw }
}

export function CommandPalette({
  items,
  screenPosition,
  initialQuery = '',
  filterType,
  onPick,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery)
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const parsed = useMemo(() => parsePaletteQuery(query), [query])

  const ranked = useMemo(() => {
    const scoped = parsed.action ? items.filter((i) => i.action === parsed.action) : items
    return fuzzyRank(parsed.text, scoped, (item) => [
      item.label,
      item.hint ?? '',
      item.nodeType ?? '',
      paletteSearchText(item),
    ]).slice(0, MAX_RESULTS)
  }, [parsed, items])

  // Land on the first item that can actually be invoked.
  useEffect(() => {
    const firstEnabled = ranked.findIndex((r) => !r.item.disabled)
    setActiveIndex(firstEnabled === -1 ? 0 : firstEnabled)
  }, [ranked])

  useDismissOnOutside(containerRef, onClose)

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  /** Step over disabled rows so arrow keys never park on something inert. */
  const step = (direction: 1 | -1) => {
    setActiveIndex((current) => {
      for (let offset = 1; offset <= ranked.length; offset++) {
        const next = (current + direction * offset + ranked.length * offset) % ranked.length
        if (ranked[next] && !ranked[next]!.item.disabled) return next
      }
      return current
    })
  }

  const commit = (index: number) => {
    const entry = ranked[index]
    if (!entry || entry.item.disabled) return
    onPick(entry.item)
  }

  const width = 460
  const maxHeight = 440
  const left = Math.max(8, Math.min(screenPosition.x, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(screenPosition.y, window.innerHeight - maxHeight - 8))

  return (
    <div
      ref={containerRef}
      className="add-menu add-menu--palette"
      style={{ left, top, width }}
      role="dialog"
      aria-label={filterType ? 'Add a connected node' : 'Command palette'}
    >
      <input
        className="add-menu__search"
        autoFocus
        placeholder={
          parsed.action === 'Add' || filterType ? 'Search nodes…' : 'Search commands and nodes…'
        }
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            step(1)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            step(-1)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            commit(activeIndex)
          } else if (
            e.key === 'Backspace' &&
            parsed.action &&
            parsed.text === '' &&
            e.currentTarget.selectionStart === query.length
          ) {
            // Backspacing into the prefix removes it whole rather than leaving a
            // half-typed "Add" that filters nothing.
            e.preventDefault()
            setQuery('')
          }
        }}
      />

      {filterType && (
        <div className="add-menu__hint">
          Nodes accepting <strong>{typeLabel(filterType)}</strong>
        </div>
      )}

      <div className="add-menu__list" ref={listRef} role="listbox">
        {ranked.map((entry, index) => {
          const item = entry.item
          return (
            <button
              key={item.id}
              type="button"
              className="add-menu__item"
              role="option"
              aria-selected={index === activeIndex}
              disabled={item.disabled}
              onMouseEnter={() => {
                if (!item.disabled) setActiveIndex(index)
              }}
              onClick={() => commit(index)}
            >
              <span className="add-menu__crumb">{item.action}</span>
              <Separator />
              {item.group && (
                <>
                  <span className="add-menu__crumb">{item.group}</span>
                  <Separator />
                </>
              )}
              <span className="add-menu__name">
                <Highlight text={item.label} matches={entry.matches} />
              </span>
              {item.hint && (
                <>
                  <Separator />
                  <span className={item.warn ? 'add-menu__desc add-menu__desc--warn' : 'add-menu__desc'}>
                    {item.warn ? '⚠ ' : ''}
                    {item.hint}
                  </span>
                </>
              )}
              {item.shortcut && <kbd className="add-menu__kbd">{item.shortcut}</kbd>}
            </button>
          )
        })}

        {ranked.length === 0 && (
          <div className="add-menu__empty">
            No matches
            {filterType && (
              <>
                <br />
                nothing accepts {typeLabel(filterType)} yet
              </>
            )}
          </div>
        )}
      </div>

      <div className="add-menu__footer">
        <span>↑↓ navigate</span>
        <span>⏎ run</span>
        <span>esc close</span>
        {!parsed.action && !filterType && <span>Add: nodes only</span>}
      </div>
    </div>
  )
}

function Separator() {
  return (
    <span className="add-menu__sep" aria-hidden="true">
      ▶
    </span>
  )
}
