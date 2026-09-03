/**
 * The hint boxes docked to a card's top and bottom borders.
 *
 * **A sibling of the card, not a child**, for the reason `NodeRunRing` and `NodeResizer` are:
 * `.coda-node` clips with `overflow: hidden`, so anything drawn outside its border would be cut
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
 * **The × is the whole interaction.** Dismissing is not an edit — see `ui/hints.ts` — so there is
 * no store action here, no undo step and nothing to lock: a hint can be put away on a locked
 * canvas exactly as it can on an unlocked one, because nothing about the document changes.
 *
 * `nodrag` on the stack. A hint sticking out into empty canvas that drags the card when grabbed
 * is a surprise, and a × that sometimes starts a drag instead of dismissing is worse — the Text
 * note's drag-everywhere trade goes the other way for a box that exists to be read once.
 */

import { memo } from 'react'

import type { GraphNode, HintSide, NodeHint } from '../../core/graph'
import { HINT_SIDES } from '../../core/graph'
import { MarkdownView } from '../MarkdownView'
import { dismissHint, hintKey, splitHints, useDismissedHints } from '../hints'

export interface NodeHintsProps {
  node: GraphNode
}

function Stack({ side, hints }: { side: HintSide; hints: NodeHint[] }) {
  if (hints.length === 0) return null
  return (
    <div className="node-hints nodrag" data-side={side}>
      {hints.map((hint) => (
        /*
         * Keyed by the digest rather than by index: dismissing the first of two stacked hints
         * must leave the second drawing the same box rather than re-mounting it as the first.
         */
        <div
          key={hintKey(hint)}
          className="node-hint"
          /*
           * `role="note"` rather than an `<aside>` element, which is what this was. Both say the
           * same thing to a screen reader; the element does not, to a `querySelector`. A default
           * canvas draws three of these, and `panels.test.tsx` proves the inspector is absent by
           * counting `aside`s — so shipping the element would have made a wizard hint read as an
           * open panel in a test about something else entirely.
           */
          role="note"
          data-tone={hint.tone ?? 'note'}
        >
          <MarkdownView source={hint.text} className="node-hint__text" />
          <button
            type="button"
            className="node-hint__close"
            title="Dismiss this hint. It will not come back — the ? menu has it if you want it."
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
        </div>
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
        <Stack key={side} side={side} hints={unread[side]} />
      ))}
    </>
  )
}

export const NodeHints = memo(NodeHintsImpl)
