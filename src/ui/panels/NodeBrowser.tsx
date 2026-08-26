/**
 * Add-node browser.
 *
 * A large centred modal: fuzzy search on top, category chips under it, then one row per
 * node with a thumbnail. This is the deliberate "what can I add?" surface, distinct from
 * the command palette — which stays a compact keyboard-first list for people who already
 * know the name of the thing they want.
 *
 * Chips and search are mutually exclusive on purpose: typing clears the active chip, and
 * picking a chip clears the query. The alternative (chip as a hard filter that search runs
 * inside) produces the worst failure mode a filtered search has — an empty result with no
 * visible reason, because you forgot a filter was on.
 */

import { useMemo, useRef, useState } from 'react'

import type { NodeCategory, NodeDefinition } from '../../core/node'
import { listableNodeDefs, nodeDefsByCategory } from '../../core/registry'
import { typeLabel } from '../../core/types'
import { useListNav } from '../useListNav'
import { fuzzyRank } from './fuzzy'
import { NodeThumbnail } from './NodeThumbnail'
import { Highlight } from './Highlight'

export interface NodeBrowserProps {
  onPick: (nodeType: string) => void
  onClose: () => void
}

const CATEGORY_LABELS: Record<NodeCategory, string> = {
  dataset: 'Dataset',
  query: 'Query',
  transform: 'Transform',
  analysis: 'Analysis',
  visualisation: 'Visualisation',
  utility: 'Utility',
}

export function NodeBrowser({ onPick, onClose }: NodeBrowserProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<NodeCategory | 'all'>('all')
  const panelRef = useRef<HTMLDivElement>(null)

  /** Registry order, grouped by category — the order rows appear in with no query. */
  const ordered = useMemo(() => nodeDefsByCategory().flatMap((group) => group.defs), [])

  const counts = useMemo(() => {
    const map = new Map<NodeCategory | 'all', number>([['all', listableNodeDefs().length]])
    for (const { category: cat, defs } of nodeDefsByCategory()) map.set(cat, defs.length)
    return map
  }, [])

  const ranked = useMemo(() => {
    const scoped = category === 'all' ? ordered : ordered.filter((d) => d.category === category)
    return fuzzyRank(query, scoped, (def) => [
      def.label,
      def.description ?? '',
      def.type,
      `${CATEGORY_LABELS[def.category]} ${def.label}`,
    ])
  }, [query, category, ordered])

  // Escape, the reset on a new result set, the scroll-into-view and the wrapping step were all
  // written out here first; `useListNav` is where they live now that three modals want them.
  const nav = useListNav(ranked.length, ranked, onClose)

  const commit = (index: number) => {
    const entry = ranked[index]
    if (entry) onPick(entry.item.type)
  }

  return (
    <div className="overlay" role="presentation" onPointerDown={onClose}>
      <div
        ref={panelRef}
        className="overlay__panel node-browser"
        role="dialog"
        aria-modal="true"
        aria-label="Add a node"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="node-browser__search">
          <input
            className="node-browser__input"
            autoFocus
            placeholder="Search nodes…"
            aria-label="Search nodes"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              // Typing widens the search back to every category, so a query can never
              // come up empty because of a chip the user forgot about.
              if (e.target.value) setCategory('all')
            }}
            onKeyDown={(e) => {
              if (nav.onKeyDown(e)) return
              if (e.key === 'Enter') {
                e.preventDefault()
                commit(nav.activeIndex)
              }
            }}
          />
          <span className="node-browser__count">
            {ranked.length} {ranked.length === 1 ? 'node' : 'nodes'}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close node browser"
          >
            ✕
          </button>
        </div>

        <div className="node-browser__chips" role="tablist" aria-label="Node categories">
          {(
            ['all', ...nodeDefsByCategory().map((g) => g.category)] as Array<
              NodeCategory | 'all'
            >
          ).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              className="chip-filter"
              aria-selected={category === value}
              data-category={value === 'all' ? undefined : value}
              onClick={() => {
                setCategory(value)
                // Picking a chip is the other half of the exclusivity rule.
                setQuery('')
              }}
            >
              {value === 'all' ? 'All' : CATEGORY_LABELS[value]}
              <span className="chip-filter__count">{counts.get(value) ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="node-browser__list" ref={nav.listRef} role="listbox" aria-label="Nodes">
          {ranked.map((entry, index) => {
            const def = entry.item
            return (
              <button
                key={def.type}
                type="button"
                className="node-row"
                role="option"
                aria-selected={index === nav.activeIndex}
                onMouseEnter={() => nav.setActiveIndex(index)}
                onClick={() => commit(index)}
                onDoubleClick={() => commit(index)}
              >
                <NodeThumbnail def={def} />
                <span className="node-row__text">
                  <span className="node-row__name">
                    <Highlight text={def.label} matches={entry.matches} />
                  </span>
                  <span className="node-row__desc">{def.description ?? def.type}</span>
                </span>
                <span className="node-row__meta">
                  <span className="node-row__signature">{signatureOf(def)}</span>
                  <span className="node-row__category">
                    {CATEGORY_LABELS[def.category]}
                    {def.cost === 'expensive' && (
                      <span className="node-row__cost" title="Hits the backend — waits for Run">
                        needs run
                      </span>
                    )}
                  </span>
                </span>
              </button>
            )
          })}

          {ranked.length === 0 && (
            <div className="add-menu__empty">No nodes match “{query}”</div>
          )}
        </div>

        <div className="node-browser__footer">
          <span>↑↓ navigate</span>
          <span>⏎ add</span>
          <span>esc close</span>
          <span>Space opens the command palette instead</span>
          <span className="toolbar__spacer" />
          {/*
           * The one place somebody is already choosing a node and may not know what one does.
           * A new tab rather than a route: the browser is modal over a graph, and answering
           * "what is Pivot?" must not cost the canvas behind it.
           */}
          <a
            className="node-browser__guide"
            href={`${import.meta.env.BASE_URL}nodes.html`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Node guide ↗
          </a>
        </div>
      </div>
    </div>
  )
}

/** "Dataset + Neurons → Table" — the node's port signature, in type names. */
function signatureOf(def: NodeDefinition): string {
  const inputs = (def.inputs ?? []).map((p) => shortType(p.type))
  const outputs = (def.outputs ?? []).map((p) => shortType(p.type))
  const left = inputs.length ? inputs.join(' + ') : '—'
  const right = outputs.length ? outputs.join(' + ') : '—'
  return `${left} → ${right}`
}

/** Type name without the column list, which is unknown before wiring anyway. */
function shortType(type: Parameters<typeof typeLabel>[0]): string {
  return typeLabel(type).replace(/\{.*\}$/, '')
}
