/**
 * The hint boxes docked to a card's top and bottom borders.
 *
 * **A sibling of the card, not a child**, for the reason `NodeRunRing` and `NodeResizer` are:
 * `.coda-node` clips its content, so anything drawn outside its border would be cut
 * off at it. React Flow's wrapper is the positioned ancestor and is sized by the card alone —
 * these are absolutely positioned, so they contribute nothing to what the library measures and a
 * hint can neither move a wire nor change what `placeGuards` checks.
 *
 * That is also the whole layout: `bottom: 100%` and `top: 100%` against the wrapper put a stack
 * immediately above and below the card, at the card's own width, with no measurement, no
 * `ResizeObserver` and no `ViewportPortal`. A card that grows a preview takes its bottom stack
 * down with it for free.
 *
 * **One component for both sides, and one subscription with it.** `splitHints` partitions the
 * node's list in a single pass, so a card pays one `useSyncExternalStore` rather than one per
 * side — which matters because `CodaNodeView` mounts this per card, and that file's note on
 * `draggable` records the rule: a subscription here costs a selector call on every store write,
 * per card. A side with nothing to show renders no element at all.
 *
 * **Outside the card rather than in it**, which is the distinction worth defending. The card
 * already draws a band for what the *machine* has to say — `nodeIssues.ts` ranks an inference
 * error over a run warning over a type warning, one at a time, inside the border. A hint is what
 * an *author* has to say, and the two read as one thing the moment they share a band: a reader
 * who cannot tell "the graph is broken" from "here is where to start" will act on neither.
 *
 * **Two buttons, and they are two different kinds of act.** The × dismisses, which is not an edit
 * — see `ui/hints.ts` — so it has no store action, no undo step and nothing to lock: it puts the
 * hint away *for this reader*. The ✎ opens the hint editor (`panels/HintEditor.tsx`), whose Save
 * and Delete *are* edits and reach everybody who opens the workflow. Side by side because an
 * author tidying a workflow will otherwise reach for the × to delete their own sentence, see it
 * vanish, and share a file that still carries it.
 *
 * `nodrag` on the stack. A hint sticking out into empty canvas that drags the card when grabbed
 * is a surprise, and a × that sometimes starts a drag instead of dismissing is worse — the Text
 * note's drag-everywhere trade goes the other way for a box that exists to be read once.
 */

import { memo } from 'react'
import type { ReactNode } from 'react'

import type { GraphNode, HintSide, NodeHint } from '../../core/graph'
import { DEFAULT_HINT_TONE, HINT_SIDES } from '../../core/graph'
import { useGraphStore } from '../../store/graphStore'
import { MarkdownView } from '../MarkdownView'
import { dismissHint, hintKey, splitHints, useDismissedHints } from '../hints'

export interface NodeHintsProps {
  node: GraphNode
}

/**
 * One hint's box — what a card docks, and what the hint editor previews, so the preview is the
 * box rather than a copy of its markup.
 */
export function HintBox({ hint, children }: { hint: NodeHint; children?: ReactNode }) {
  return (
    <div
      className="node-hint"
      /*
       * `role="note"` rather than an `<aside>` element, which is what this was. Both say the
       * same thing to a screen reader; the element does not, to a `querySelector`. A default
       * canvas draws three of these, and `panels.test.tsx` proves the inspector is absent by
       * counting `aside`s — so shipping the element would have made a wizard hint read as an
       * open panel in a test about something else entirely.
       */
      role="note"
      data-tone={hint.tone ?? DEFAULT_HINT_TONE}
    >
      <MarkdownView source={hint.text} className="node-hint__text" />
      {children}
    </div>
  )
}

function Stack({ nodeId, side, hints }: { nodeId: string; side: HintSide; hints: NodeHint[] }) {
  if (hints.length === 0) return null
  return (
    <div className="node-hints nodrag" data-side={side}>
      {hints.map((hint) => (
        /*
         * Keyed by the digest rather than by index: dismissing the first of two stacked hints
         * must leave the second drawing the same box rather than re-mounting it as the first.
         */
        <HintBox key={hintKey(hint)} hint={hint}>
          <button
            type="button"
            className="node-hint__edit"
            title="Edit or delete this hint, for everybody who opens the workflow"
            aria-label="Edit hint"
            onClick={(event) => {
              event.stopPropagation()
              // The object itself — `splitHints` hands back the node's own — see `HintTarget`.
              useGraphStore.getState().editHint({ nodeId, hint })
            }}
          >
            ✎
          </button>
          <button
            type="button"
            className="node-hint__close"
            title="Hide this hint for yourself. It stays in the workflow — Show Hints brings it back."
            aria-label="Dismiss hint"
            onClick={(event) => {
              // The canvas turns a click into a selection and a double-click into "add a node
              // here"; neither is what pressing this means.
              event.stopPropagation()
              dismissHint(hint)
            }}
          >
            ×
          </button>
        </HintBox>
      ))}
    </div>
  )
}

function NodeHintsImpl({ node }: NodeHintsProps) {
  const seen = useDismissedHints()
  const { unread } = splitHints(node, seen)
  return (
    <>
      {HINT_SIDES.map((side) => (
        <Stack key={side} nodeId={node.id} side={side} hints={unread[side]} />
      ))}
    </>
  )
}

export const NodeHints = memo(NodeHintsImpl)
