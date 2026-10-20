/**
 * A VFB or FlyBase term id that, rested on, shows what the term is: its name, VFB's definition and
 * a thumbnail (`docs/vfb-plan.md`, G4).
 *
 * The gesture is `useHoverPanel`'s, at the `dense` delay, since a table column is a run of these
 * a pointer crosses on its way elsewhere. The term is asked for **when the panel opens**, never on
 * pointer arrival — a sweep down a column is no requests — and once per term per session
 * (`termInfo`). A table viewer is a widget fetching for itself, like Explore's thumbnail; nothing
 * here runs a node.
 */

import { useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { spansText } from '../../data/vfb/markdown'
import type { Rect } from '../hoverPlacement'
import { HOVER_DELAY_MS, useHoverPanel, usePlacedPanel } from '../useHoverPanel'
import { useTermInfo } from './useTermInfo'

/** How much of a definition the panel shows; VFB's run to several paragraphs. */
const DEFINITION_CHARS = 320

export function TermHover({ id, children }: { id: string; children: ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const { open, handlers } = useHoverPanel({ anchorRef, delayMs: HOVER_DELAY_MS.dense })
  return (
    <span ref={anchorRef} {...handlers}>
      {children}
      {open && createPortal(<TermPanel id={id} anchor={open.anchor} />, open.host)}
    </span>
  )
}

/**
 * The panel itself, mounted only while open. Its height follows what has arrived — a loading
 * line, then a thumbnail and a definition — so it is placed by `usePlacedPanel`, which measures
 * the content, rather than by a guessed size.
 */
function TermPanel({ id, anchor }: { id: string; anchor: Rect }) {
  // Asked for here, so only when the panel opens — never as a pointer crosses the term.
  const loaded = useTermInfo(id)
  const placed = usePlacedPanel(anchor, { prefer: 'right', gap: 8, margin: 8 }, loaded)
  const info = loaded?.info
  const definition = info && spansText(info.definition)
  return (
    <div
      ref={placed.ref}
      className="hover-panel term-hover"
      role="tooltip"
      style={placed.style}
    >
      <div className="term-hover__name">{info?.label ?? id}</div>
      <div className="term-hover__id">
        {info && info.name !== info.label ? `${info.name} · ${id}` : id}
      </div>
      {!loaded && <div className="term-hover__muted">Asking Virtual Fly Brain…</div>}
      {loaded?.error && <div className="term-hover__muted">{loaded.error}</div>}
      {info?.thumbnail && (
        <img className="term-hover__image" src={info.thumbnail} alt="" draggable={false} />
      )}
      {definition && (
        <div className="term-hover__text">
          {definition.length > DEFINITION_CHARS
            ? `${definition.slice(0, DEFINITION_CHARS).trimEnd()}…`
            : definition}
        </div>
      )}
    </div>
  )
}
