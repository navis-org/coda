/**
 * The hint editor: write, reword or delete the guidance docked to one card.
 *
 * Opened by the node menu's **Add Hint…** and by the ✎ on a hint box, both through
 * `editingHint` in the store — `editingGroupId`'s arrangement, since a context menu cannot reach
 * into a card and a card cannot reach the editor.
 *
 * **A `ContextMenu` hung under the card, not a centred modal**, because the one thing an author
 * needs while writing is the card the sentence is about — and `ContextMenu` re-clamps as the panel
 * grows, which this one does when the preview appears or the text box is dragged taller.
 *
 * **It does not close on a press elsewhere** (`dismissOnOutside={false}`), unlike every other
 * menu. A menu loses nothing when it closes; this loses a half-written paragraph, and the press
 * that most often lands outside it is the author clicking the card to check what it does.
 * Escape, Cancel and Save are the ways out.
 *
 * **The preview is `HintBox` at the card's own width**, so the author sees where the box wraps
 * before a reader does — a hint is as wide as its card, which is what sets its length.
 *
 * The note under the text states the × / Delete distinction on purpose: the × on a box hides it
 * for the reader who pressed it and changes nothing in the file, so an author who dismisses their
 * own hint and shares the workflow has shared the hint.
 */

import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'

import type { HintSide, HintTone } from '../../core/graph'
import {
  DEFAULT_HINT_SIDE,
  DEFAULT_HINT_TONE,
  HINT_SIDES,
  HINT_TONES,
  sameHints,
} from '../../core/graph'
import { nodeLabel } from '../../export/canExport'
import type { HintTarget } from '../../store/graphStore'
import { useGraphStore } from '../../store/graphStore'
import { cardElement } from '../cardSizes'
import { restoreHints } from '../hints'
import { TONE_TITLE } from '../markdown'
import { ContextMenu } from '../menu/ContextMenu'
import { layoutViewport } from '../menu/placement'
import { HintBox } from '../nodes/NodeHints'

const SIDE_TITLE: Record<HintSide, string> = { bottom: 'Below', top: 'Above' }

/** The gap under the card, and the margin kept from the window's edge. */
const GAP = 8
const MARGIN = 8

/** A key per opening, so a second one starts from its own hint rather than this draft. */
const openings = new WeakMap<HintTarget, number>()
let lastOpening = 0
function openingKey(target: HintTarget): number {
  let key = openings.get(target)
  if (key === undefined) openings.set(target, (key = ++lastOpening))
  return key
}

export function HintEditor() {
  const target = useGraphStore((s) => s.editingHint)
  if (!target) return null
  return <HintEditorPanel key={openingKey(target)} target={target} />
}

function close(): void {
  useGraphStore.getState().editHint(undefined)
}

/**
 * Where the editor opens, read once: under the card, at the card's layout width.
 *
 * The width is `offsetWidth`, unscaled by the canvas zoom — the width a hint box on the card wraps
 * at; zero under jsdom, which leaves the preview at the panel's width. With no card on screen
 * there is nothing to hang from, so it opens a third of the way into the window and `ContextMenu`
 * clamps.
 */
function anchorFor(nodeId: string): { at: { x: number; y: number }; cardWidth?: number } {
  const card = cardElement(nodeId)
  if (!card) {
    const { width, height } = layoutViewport()
    return { at: { x: width / 3, y: height / 3 } }
  }
  const rect = card.getBoundingClientRect()
  return {
    at: { x: rect.left, y: rect.bottom + GAP },
    cardWidth: card.offsetWidth || undefined,
  }
}

function Choices<T extends string>({
  label,
  options,
  titles,
  value,
  onChange,
}: {
  label: string
  options: readonly T[]
  titles: Record<T, string>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="hint-editor__choices" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {titles[option]}
        </button>
      ))}
    </div>
  )
}

function HintEditorPanel({ target }: { target: HintTarget }) {
  const { nodeId, hint: existing } = target
  // `find` hands back the stored object, so this allocates nothing (invariant 7).
  const node = useGraphStore((s) => s.graph.nodes.find((n) => n.id === nodeId))
  const [{ at, cardWidth }] = useState(() => anchorFor(nodeId))
  const [text, setText] = useState(existing?.text ?? '')
  const [tone, setTone] = useState<HintTone>(existing?.tone ?? DEFAULT_HINT_TONE)
  const [side, setSide] = useState<HintSide>(existing?.side ?? DEFAULT_HINT_SIDE)

  /*
   * The hint can go out from under the editor: the card deleted, or an undo or a plan replacing
   * the list. Closing is the honest answer — see `HintTarget` for why this asks by identity.
   */
  const index = existing ? (node?.hints?.indexOf(existing) ?? -1) : undefined
  const gone = !node || index === -1
  useEffect(() => {
    if (gone) close()
  }, [gone])
  if (gone) return null

  // Defaults are dropped by `setNodeHints` on the way into the document, not here.
  const draft = { text: text.trim(), tone, side }
  const canSave = draft.text !== '' && !(existing && sameHints([draft], [existing]))

  const save = () => {
    if (!canSave) return
    const hints = [...(node.hints ?? [])]
    hints[index ?? hints.length] = draft
    useGraphStore.getState().setHints(node.id, hints)
    /*
     * Dismissal is keyed on the text (`ui/hints.ts`), so an author writing a sentence they once
     * dismissed elsewhere would save it and see nothing. They have just written it; it is read.
     */
    restoreHints([draft])
    close()
  }

  const remove = () => {
    const hints = node.hints ?? []
    useGraphStore.getState().setHints(
      node.id,
      hints.filter((h) => h !== existing),
    )
    close()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // Escape is `useOverlayEscape`'s, on the window's capture phase; everything else stops here,
    // since the canvas binds Backspace and Space and this is a place people type both.
    if (event.key === 'Escape') return
    event.stopPropagation()
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      save()
    }
  }

  const heading = existing ? 'Edit hint' : 'Add hint'
  const cardName = nodeLabel(node)

  return (
    <ContextMenu
      at={at}
      onClose={close}
      dismissOnOutside={false}
      className="hint-editor"
      role="dialog"
      label={heading}
      margin={MARGIN}
      onKeyDown={onKeyDown}
    >
      <div className="hint-editor__head">
        <span className="hint-editor__title">{heading}</span>
        <span className="hint-editor__card" title={cardName}>
          {cardName}
        </span>
      </div>
      <textarea
        className="field hint-editor__text"
        aria-label="Hint text"
        rows={3}
        value={text}
        placeholder="What should somebody opening this workflow know about this step? Markdown works."
        autoFocus
        onChange={(event) => setText(event.target.value)}
      />
      <div className="hint-editor__row">
        <Choices
          label="Tone"
          options={HINT_TONES}
          titles={TONE_TITLE}
          value={tone}
          onChange={setTone}
        />
        <Choices
          label="Side of the card"
          options={HINT_SIDES}
          titles={SIDE_TITLE}
          value={side}
          onChange={setSide}
        />
      </div>
      {draft.text && (
        <div
          className="hint-editor__preview"
          aria-label="Preview"
          style={cardWidth ? { width: cardWidth } : undefined}
        >
          <HintBox hint={draft} />
        </div>
      )}
      <p className="hint-editor__note">
        Saved with the workflow. Anyone opening it can hide a hint for themselves with ×; only
        Delete removes it for everybody.
      </p>
      <div className="hint-editor__actions">
        {existing && (
          <button type="button" className="btn btn--ghost hint-editor__delete" onClick={remove}>
            Delete
          </button>
        )}
        <span className="hint-editor__spacer" />
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={!canSave} onClick={save}>
          Save
        </button>
      </div>
    </ContextMenu>
  )
}
