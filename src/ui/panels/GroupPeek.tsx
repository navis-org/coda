/**
 * Looking inside a folded group without unfolding it.
 *
 * A folded frame draws one box; reading what is in it meant expanding it on a canvas where its
 * cards land wherever they were, over whatever has since been put there. This is that read with
 * the move taken out: a modal panel holding a **second React Flow** with the group's own cards
 * and the wires among them, framed by `fitView`.
 *
 * ## The cards are the real ones
 *
 * `CodaNodeView` reads the store by node id, so a card drawn here is the card — its params, its
 * run state, its ports and its issues, live. `subgraphOf` gives the fragment (members plus the
 * edges with both ends inside), which is the same helper copy, duplicate and the clipboard use,
 * so "what belongs to this group" has one answer.
 *
 * **Live params, fixed layout.** Nothing here writes a position: `nodesDraggable`,
 * `nodesConnectable`, `elementsSelectable` and `deleteKeyCode` are all off, and no
 * `onNodesChange` is passed — a peek is for reading and for the odd threshold, not for editing a
 * graph through a window. The canvas's selection is left alone for the same reason: a click in
 * here must not change what ⌘D or ⌫ would act on out there.
 *
 * **No previews.** A viewer card draws its controls and not its result (`previews: false` in the
 * node data). Two reasons, and the second is the real one: a peek is opened to see *what is in
 * the group*, and mounting several live viewers — three WebGL contexts, in the measurement
 * `CodaNodeView.showPreview` records — is a heavy answer to a glance. The cards are mounted
 * nowhere else while the group is folded, so this is a choice rather than a constraint.
 *
 * ## The one thing that would have gone wrong silently
 *
 * `measureCardSizes` and `useArrange`'s port measurement read `.react-flow__node[data-id]` out
 * of the *document*. A second flow puts elements carrying the same ids into the page — and while
 * a group is folded those copies are the only ones, so ELK would have sized the graph from cards
 * drawn in a modal, and `structureKey` would have changed the moment a peek opened: with
 * auto-layout on, opening one re-arranged the canvas behind it. Both queries are scoped to
 * `.canvas-area` now. Nothing here needs measuring — React Flow measures its own flow through
 * its own store.
 *
 * The keyboard is the same shape of problem, and the fix here is deliberately *local*: bare keys
 * are stopped, modified ones are not. The deeper version — the two canvas listeners asking "is a
 * dialog open" beside `isTourActive()` — would close the same hole in the thirteen other
 * `.overlay` surfaces, and it is a change to what every one of them does with every shortcut:
 * eleven tests across five files currently assert that `i`, `Space`, `Tab` and `p` still fire
 * with a dialog up. That is a decision about the app, not a cleanup, and it is written down here
 * rather than taken quietly.
 */

import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'
import { useCallback, useEffect, useMemo } from 'react'

import { subgraphOf } from '../../core/clipboard'
import type { GraphNode } from '../../core/graph'
import { referenceEdgeIds } from '../../core/graph'
import { groupById } from '../../core/groups'
import { FIT_VIEW_OPTIONS } from '../fitView'
import type { CodaNodeData } from '../nodes/CodaNodeView'
import { CARD_TYPES, cardShape } from '../nodes/cardNode'
import { CARD_POINTERS } from '../nodes/cardPointers'
import { EDGE_TYPES } from '../CodaEdge'
import { useGraphStore } from '../../store/graphStore'
import { wireStyle } from '../socketStyle'

/**
 * The peeked card's data, cached per node as the canvas caches its own.
 *
 * Its own map rather than `dataFor`'s: that one hands back `{ node }`, and sharing it would
 * carry `previews: false` back to the card behind this panel. What the cache buys is that a
 * keystroke in one card does not hand React Flow a fresh object for every other one.
 */
const peekCache = new WeakMap<GraphNode, CodaNodeData>()
function peekData(node: GraphNode): CodaNodeData {
  const seen = peekCache.get(node)
  if (seen) return seen
  const data: CodaNodeData = { node, previews: false }
  peekCache.set(node, data)
  return data
}

/**
 * The gate, which is all that is mounted while nothing is being looked at.
 *
 * `App` renders this unconditionally, so the subscriptions belong on the *panel* rather than
 * here: `graph` and `inference` both take a new identity on every commit — every frame of a
 * drag — and a closed panel that re-ran three memos and rebuilt an empty edge array on each of
 * them would be paying for a dialog nobody opened. Closed, this costs one identity comparison.
 */
export function GroupPeek() {
  const groupId = useGraphStore((s) => s.peekGroupId)
  if (!groupId) return null
  return <PeekPanel groupId={groupId} />
}

function PeekPanel({ groupId }: { groupId: string }) {
  const peekGroup = useGraphStore((s) => s.peekGroup)
  const graph = useGraphStore((s) => s.graph)
  const inference = useGraphStore((s) => s.inference)

  const close = useCallback(() => peekGroup(undefined), [peekGroup])
  const group = groupById(graph, groupId)

  // Escape closes, on the capture phase and standing aside for a popover — `ViewerOverlay`'s
  // arrangement, and for the reason written there: a card's own menu owns the key first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (document.querySelector('.context-menu')) return
        event.stopPropagation()
        close()
        return
      }
      /*
       * Unmodified keys stop here too, and only unmodified ones.
       *
       * The canvas's shortcuts are `window` listeners taking *bare* letters, and
       * `isTypingTarget` exempts fields rather than buttons — so a `d`, `m` or `h` pressed at
       * this panel opened the dashboard, muted the selection or collapsed it behind the dialog.
       * The fields inside get their keys first (they are below `window` in the DOM), so what is
       * cut off is exactly what would have fallen through.
       *
       * The modified ones are deliberately let past: ⌘Z, ⌘C and the rest belong to the history
       * and clipboard listeners, and a panel showing live cards has no business deciding those
       * on their behalf.
       */
      if (event.metaKey || event.ctrlKey || event.altKey) return
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [close])

  const fragment = useMemo(
    () => (group ? subgraphOf(graph, group.nodeIds) : undefined),
    [graph, group],
  )

  const nodes = useMemo<Node<CodaNodeData>[]>(
    () =>
      (fragment?.nodes ?? []).map((node) => ({
        id: node.id,
        // Which renderer and what size — `cardShape`, shared with the canvas.
        ...cardShape(node),
        position: node.position,
        data: peekData(node),
        // Not draggable and not selectable, which is what makes React Flow withhold the pointer
        // from the whole card — see `CARD_POINTERS`. Without it the params here are decoration:
        // a click never reaches a field, and the keystrokes meant for it land on the canvas's
        // shortcuts behind the dialog. Found by typing into one.
        style: CARD_POINTERS,
      })),
    [fragment],
  )

  const edges = useMemo<Edge[]>(() => {
    if (!fragment) return []
    // A wire that names a node rather than carrying its output is drawn dotted here too: the
    // canvas's rule, asked of this fragment. Written without it, a reference wire and a muted
    // node's wires looked live in the panel and ordinary on the canvas.
    const references = referenceEdgeIds(fragment)
    const muted = new Set(fragment.nodes.filter((n) => n.disabled).map((n) => n.id))
    return fragment.edges.map((edge) => ({
      id: edge.id,
      type: 'coda',
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
      data: {},
      selectable: false,
      focusable: false,
      deletable: false,
      reconnectable: false,
      ...(references.has(edge.id) ? { className: 'coda-edge--reference' } : {}),
      style: wireStyle(
        inference.nodes[edge.source]?.outputs[edge.sourceHandle],
        muted.has(edge.source),
      ),
    }))
  }, [fragment, inference])

  if (!group || nodes.length === 0) return null
  const title = group.title || 'Group'

  return (
    <div className="overlay" role="presentation" onPointerDown={close}>
      <div
        className="overlay__panel group-peek"
        role="dialog"
        aria-modal="true"
        aria-label={`Inside ${title}`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {/* The dialog header every other panel wears — `.overlay__title` is already `flex: 1`,
            which is what pushes the close button right without a spacer of our own. */}
        <div className="overlay__header">
          <div className="overlay__title">
            <strong>{title}</strong>
            <span>
              {nodes.length} node{nodes.length === 1 ? '' : 's'}
            </span>
          </div>
          <button type="button" className="btn btn--ghost" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="group-peek__flow">
          {/*
           * Its own provider, so this flow's store, viewport and measurements are its own and
           * the canvas behind it is untouched. `key` on the group, so opening a second peek
           * frames its own cards rather than inheriting the last one's camera.
           */}
          <ReactFlowProvider key={groupId}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={CARD_TYPES}
              edgeTypes={EDGE_TYPES}
              fitView
              fitViewOptions={FIT_VIEW_OPTIONS}
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable={false}
              elementsSelectable={false}
              edgesFocusable={false}
              deleteKeyCode={null}
              selectionKeyCode={null}
              multiSelectionKeyCode={null}
              zoomOnDoubleClick={false}
              proOptions={{ hideAttribution: true }}
            />
          </ReactFlowProvider>
        </div>
      </div>
    </div>
  )
}
