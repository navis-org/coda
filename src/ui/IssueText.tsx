/**
 * A message a reader may need to act on: selectable, with its links followable.
 *
 * One component for the three places a refusal is shown — a node card's issue band, the
 * inspector's list, the Connections dialog's alert — because those three had drifted into three
 * different amounts of "can I do anything with this". What it adds over a bare string is small
 * and was all missing at once:
 *
 *  - **Links are links.** `splitLinks` decides where they are and why the text is the href.
 *  - **The text can be selected.** React Flow puts `user-select: none` on every node, which is
 *    right for a card you drag and wrong for the one part of it somebody wants to send to a
 *    colleague — so the card's copy carries `nodrag` too, or the drag that starts a selection
 *    moves the node instead.
 *  - **Copy, where there is room for a button.** Selecting 10px text inside a draggable card is a
 *    fiddly way to do something that is one click everywhere else in this app.
 */

import { useState } from 'react'

import { copyText } from './export'
import { splitLinks } from './linkify'

export interface IssueTextProps {
  message: string
  /**
   * Offer a copy button beside the message.
   *
   * Off by default because the node card cannot spare the width, and the inspector — which can —
   * is one click away and holds the same sentence, ranked identically by `nodeIssues`.
   */
  copyable?: boolean
}

export function IssueText({ message, copyable }: IssueTextProps) {
  const [copied, setCopied] = useState(false)
  return (
    <>
      {/* `nodrag` is React Flow's, and harmless everywhere else: it only means anything to a
          pointer gesture that started inside a node. */}
      <span className="issue__text nodrag">
        {splitLinks(message).map((span, index) =>
          span.href ? (
            <a
              key={index}
              href={span.href}
              target="_blank"
              rel="noreferrer noopener"
              // Or the click reaches the canvas, which selects the node and — on a card that is
              // already selected — starts a drag from under the pointer.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {span.text}
            </a>
          ) : (
            // A bare string needs no key and no element of its own; the wrapper carries the
            // styling for both.
            span.text
          ),
        )}
      </span>
      {copyable && (
        <button
          type="button"
          className="btn btn--ghost issue__copy nodrag"
          title="Copy this message"
          aria-label="Copy this message"
          onClick={() => {
            // Swallowed for `CopyIdsBody`'s reason: the button is the whole feedback, and a
            // browser that refuses clipboard access simply never says "Copied".
            void copyText(message)
              .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              })
              .catch(() => undefined)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </>
  )
}
