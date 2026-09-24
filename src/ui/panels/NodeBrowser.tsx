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
import { createPortal } from 'react-dom'

import type { NodeCategory, NodeDefinition } from '../../core/node'
import type { Socket } from '../../core/sockets'
import { socketLabel } from '../../core/sockets'
import type { Rect } from '../hoverPlacement'
import { HOVER_DELAY_MS, useHoverPanel, usePlacedPanel } from '../useHoverPanel'
import { useListNav } from '../useListNav'
import { fuzzyRank } from './fuzzy'
import { NodeThumbnail } from './NodeThumbnail'
import { Highlight } from './Highlight'
import { CATEGORY_LABELS } from './categoryLabels'
import { defaultInputPorts, defaultOutputPorts } from '../../core/ports'
import { useGraphStore } from '../../store/graphStore'
import { Modal } from '../Modal'
import { useOfferedNodeDefsByCategory } from '../packSwitches'

export interface NodeBrowserProps {
  onPick: (nodeType: string) => void
  onClose: () => void
}

export function NodeBrowser({ onPick, onClose }: NodeBrowserProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<NodeCategory | 'all'>('all')
  const openPlugins = useGraphStore((s) => s.openPlugins)

  /** Registry order, grouped by category — the order rows appear in with no query. */
  const groups = useOfferedNodeDefsByCategory()
  const ordered = useMemo(() => groups.flatMap((group) => group.defs), [groups])

  const counts = useMemo(() => {
    const map = new Map<NodeCategory | 'all', number>([['all', ordered.length]])
    for (const { category: cat, defs } of groups) map.set(cat, defs.length)
    return map
  }, [groups, ordered])

  const ranked = useMemo(() => {
    const scoped = category === 'all' ? ordered : ordered.filter((d) => d.category === category)
    return fuzzyRank(query, scoped, (def) => [
      def.label,
      def.description ?? '',
      def.type,
      `${CATEGORY_LABELS[def.category]} ${def.label}`,
    ])
  }, [query, category, ordered])

  // The reset on a new result set, the scroll-into-view and the wrapping step were all written
  // out here first; `useListNav` is where they live now that three modals want them.
  const nav = useListNav(ranked.length, ranked)

  const commit = (index: number) => {
    const entry = ranked[index]
    if (entry) onPick(entry.item.type)
  }

  return (
    <Modal className="overlay__panel node-browser" label="Add a node" onClose={onClose}>
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
        {(['all', ...groups.map((g) => g.category)] as Array<NodeCategory | 'all'>).map(
          (value) => (
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
          ),
        )}
      </div>

      <div className="node-browser__list" ref={nav.listRef} role="listbox" aria-label="Nodes">
        {ranked.map((entry, index) => (
          <NodeRow
            key={entry.item.type}
            def={entry.item}
            matches={entry.matches}
            selected={index === nav.activeIndex}
            onHover={() => nav.setActiveIndex(index)}
            onPick={() => commit(index)}
          />
        ))}

        {ranked.length === 0 && <div className="add-menu__empty">No nodes match “{query}”</div>}
      </div>

      <div className="node-browser__footer">
        <span>↑↓ navigate</span>
        <span>⏎ add</span>
        <span>esc close</span>
        <span>Space opens the command palette instead</span>
        <span className="toolbar__spacer" />
        <button
          type="button"
          className="node-browser__guide node-browser__plugins"
          onClick={() => {
            onClose()
            openPlugins()
          }}
        >
          Plugins
        </button>
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
    </Modal>
  )
}

/** The tip's width, and so the width of the text in it. */
const TIP_W = 320

/** Gap between the row and the tip, and how close to the window's edge it may sit. */
const TIP_GAP = 12
const TIP_MARGIN = 8

/**
 * One row, and the guide it shows on a rest.
 *
 * A component per row rather than a loop body, because `useHoverPanel` is per anchor — the same
 * shape `HoverMark` takes in Explore, for the same reason. The row is the anchor: a pointer at
 * rest is somewhere along 1,066px of row and the thumbnail it happens to be near is not what it is
 * resting on.
 */
function NodeRow({
  def,
  matches,
  selected,
  onHover,
  onPick,
}: {
  def: NodeDefinition
  matches: number[]
  selected: boolean
  onHover: () => void
  onPick: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const blurb = guideText(def)
  /*
   * A row is a target a pointer *crosses* on the way to the one it wants — a hundred of them down
   * one list — so this is the dense delay, the sockets' rather than the thumbnail's. `canOpen`
   * declines where the node has neither guide nor description: a panel repeating the row's own
   * words, or an empty one, is worse than nothing.
   */
  const { open, handlers } = useHoverPanel({
    anchorRef: ref,
    delayMs: HOVER_DELAY_MS.dense,
    canOpen: () => blurb !== undefined,
  })
  return (
    <button
      ref={ref}
      type="button"
      className="node-row"
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      onClick={onPick}
      onDoubleClick={onPick}
      {...handlers}
    >
      <NodeThumbnail def={def} />
      <span className="node-row__text">
        <span className="node-row__name">
          <Highlight text={def.label} matches={matches} />
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
      {open &&
        blurb !== undefined &&
        createPortal(
          /*
           * Portalled for the mark preview's reason: `.node-browser__list` scrolls, which clips
           * both axes, and `.overlay__panel` is `overflow: hidden`. The host is the fullscreen
           * root where there is one, or ⛶ would leave the tip built and invisible.
           */
          <NodeGuideTip def={def} text={blurb} anchor={open.anchor} />,
          open.host,
        )}
    </button>
  )
}

/**
 * What the tip says: the node's `guide`, else its `description`.
 *
 * **`guide`, not the `?` document.** The document is markdown in its own lazy chunk — hundreds of
 * words, and a chunk fetched per row somebody's pointer crossed — where `guide` is the two or
 * three sentences already in memory, written for exactly the question a hover here asks: is this
 * the node at all. That is the same prose `nodes.html` prints, so the browser's footer link and
 * the tip cannot say different things about one node.
 *
 * The fallback is `guideData`'s — the node guide page spells it `def.guide ?? def.description ??
 * ''` — so the two surfaces cannot disagree about a node that has only the one line. Every
 * listable node carries a `guide` today and the test holds that; the `??` is what stops a node
 * registered next month offering a hover that opens nothing, and it earns its keep either way,
 * since `.node-row__desc` is a single ellipsised line and a long description on a narrow modal
 * is cut off with nowhere else to read it.
 */
function guideText(def: NodeDefinition): string | undefined {
  return def.guide ?? def.description
}

/**
 * The tip itself.
 *
 * Opens **right**, which is `hoverPlacement`'s rule rather than a preference: open into the empty
 * half. What the reader is comparing against is the rows above and below and this row's own name,
 * all of which are inside the modal — so the side that costs least is the gutter beyond it. On a
 * window with no gutter to spare the box clamps back over the row's meta column rather than
 * flipping, which `hoverPlacement` argues out.
 *
 * Not the `?` button, which `docs/help.md` keeps out of this surface because a row is a `<button>`
 * and nesting an interactive element in one is invalid markup. A hover panel is not interactive —
 * `.hover-panel` is `pointer-events: none` — so that rule does not reach it.
 */
function NodeGuideTip({
  def,
  text,
  anchor,
}: {
  def: NodeDefinition
  text: string
  anchor: Rect
}) {
  const { ref, style } = usePlacedPanel(
    anchor,
    { prefer: 'right', gap: TIP_GAP, margin: TIP_MARGIN },
    text,
  )
  return (
    <div
      ref={ref}
      className="hover-panel node-guide-tip"
      style={{ ...style, width: TIP_W }}
      role="tooltip"
    >
      <div className="node-guide-tip__head">
        <span className="node-guide-tip__name">{def.label}</span>
        <span className="node-guide-tip__category">{CATEGORY_LABELS[def.category]}</span>
      </div>
      <p className="node-guide-tip__text">{text}</p>
    </div>
  )
}

/** "Dataset + Neurons → Table" — the node's port signature, in type names. */
function signatureOf(def: NodeDefinition): string {
  const inputs = defaultInputPorts(def).map(shortType)
  const outputs = defaultOutputPorts(def).map(shortType)
  const left = inputs.length ? inputs.join(' + ') : '—'
  const right = outputs.length ? outputs.join(' + ') : '—'
  return `${left} → ${right}`
}

/**
 * Type name without the column list, which is unknown before wiring anyway.
 *
 * `socketLabel` rather than `typeLabel`, so the four geometry passthroughs read
 * `Geometries → Geometries` here as they do on the card. This surface describes a node *type*
 * with nothing wired, which is precisely the case a declared kind set exists to name.
 */
function shortType(port: Socket): string {
  return socketLabel(port).replace(/\{.*\}$/, '')
}
