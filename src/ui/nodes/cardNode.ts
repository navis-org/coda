/**
 * A document node as React Flow wants it: which component draws it, and how big it is.
 *
 * Three facts with one answer each, extracted at the second surface — the canvas
 * (`Editor.rfNodes`) and the panel a folded group opens (`GroupPeek`). Each caller adds its own
 * fields on top: the canvas its selection, measurement, hidden flag and arrange overrides; the
 * peek its `previews: false` and `CARD_POINTERS`. What is shared is only what is *about the
 * document node*, which is what kept drifting: the peek's copy had no comment on the height rule
 * and would have been the one nobody looked at when a third card renderer arrived.
 */

import type { GraphNode } from '../../core/graph'
import { getNodeDef, isAnnotation } from '../../core/registry'
import { CodaNodeView } from './CodaNodeView'
import { NoteCard } from './NoteCard'

/**
 * The two renderers a document node can have.
 *
 * A text note has no header, no sockets and no run state, so it is a different component rather
 * than a branch inside `CodaNodeView` — that one's hooks all subscribe to run state, and a card
 * with none would pay for every one of them on every scheduler tick. The canvas adds the
 * collapsed group's box to this set; nothing else does.
 */
export const CARD_TYPES = { coda: CodaNodeView, note: NoteCard }

export interface CardShape {
  type: 'coda' | 'note'
  width?: number
  height?: number
}

export function cardShape(node: GraphNode): CardShape {
  // `node.size` is a decision someone made; `defaultSize` is the definition's ask. Read as a
  // fallback rather than stamped at creation, so every path that makes a node gets it and only a
  // real resize lands in the file.
  const size = node.size ?? getNodeDef(node.type)?.defaultSize
  return {
    type: isAnnotation(node.type) ? 'note' : 'coda',
    /*
     * Width always, height only while the card is showing something. A collapsed card is a
     * header, and pinning the wrapper to a 620px Profile box leaves it floating in the top-left
     * of an empty rectangle — with `.coda-node::before` inset against the *wrapper*, so the state
     * bar hangs 570px below it as a coloured line with nothing beside it. Letting the height go
     * auto also makes the wrapper actually shrink, which is what re-measures the handles now that
     * collapsing moves them.
     */
    ...(size ? { width: size.width, ...(node.collapsed ? {} : { height: size.height }) } : {}),
  }
}
