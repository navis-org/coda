/**
 * One output port: its label, its socket, and the hover that previews what is on it.
 *
 * A component rather than markup inside `CodaNodeView`'s port-row loop because the hover needs
 * state, a ref and two effects, and a hook cannot live inside that `Array.from` callback. The
 * input side stays inline for that reason and not by oversight — it holds no state, and it is
 * not the mirror of this side anyway, carrying `data-unconnected` and `data-error` that an
 * output has never had. It also renders the empty side, so a row with no output on it still has
 * one home for that element and its class.
 *
 * **The preview is silent where there is no cached value, and that is the decision the whole
 * component is shaped around.** A port's value exists only once its node has run. Hovering must
 * never cause a fetch or a run (invariant 6 — a request per keystroke at a shared production
 * server is the failure this class of feature has already caused once), and a panel offering to
 * make one is a Run button an inch from every socket on the canvas. So the store is asked at the
 * moment the delay elapses, and where it answers nothing the hover does nothing at all — the
 * socket's own `title` is what the reader gets, and it carries a line saying a Run would change
 * that. A hint costs nothing and refuses nothing, where a control would be the button this rule
 * exists to keep off the canvas.
 *
 * That read is also why nothing here subscribes: `getState()` at open time rather than a
 * selector per port. A sixty-node graph has a couple of hundred sockets and the value behind
 * each is a scheduler-cache lookup; subscribing them all would put that walk on every run tick
 * to serve the one socket a pointer is over. See `CodaNodeView`'s note on `previewVersion` for
 * the same arithmetic on the other side of the card.
 *
 * **The hover target is the whole side, not the disc.** A socket is 11px with a 20px hit box
 * (`editor.css`), which is a fine target for a wire and a poor one for a pointer at rest; the
 * label beside it is what a reader is already looking at. The socket is still the *anchor* — the
 * panel opens beside the disc, not beside the label — which is the distinction `useHoverPanel`
 * takes two references for.
 *
 * Everything about when it opens and the four ways it ends is `useHoverPanel`'s, shared with
 * Explore's thumbnail preview.
 */

import { Handle, Position } from '@xyflow/react'
import { useRef } from 'react'
import { createPortal } from 'react-dom'

import type { PortDef } from '../../core/node'
import type { CodaType } from '../../core/types'
import { typeLabel } from '../../core/types'
import { useGraphStore } from '../../store/graphStore'
import { useHoverPanel } from '../useHoverPanel'
import { PortPreviewPanel } from './PortPreviewPanel'
import type { SocketStyle } from '../socketStyle'

/**
 * How long the pointer rests before a panel opens.
 *
 * Longer than the thumbnail preview's 130ms, because the two gestures differ: a thumbnail is
 * hovered deliberately, where a pointer crosses several sockets on its way to the one it wants —
 * a card has up to eight — and a panel that opened on each would strobe down the side of the
 * card. Long enough that crossing is free, short enough that resting is not a wait.
 */
const PREVIEW_DELAY_MS = 260

export interface OutputPortProps {
  nodeId: string
  /** Absent on a row whose input side is the only one filled. */
  port: PortDef | undefined
  /** What the port is inferred to carry, falling back to what it declares. */
  outputType: CodaType | undefined
  style: SocketStyle | undefined
  /** Dimmed because a drag from an input cannot land here. */
  dimmed: boolean
  /**
   * Whether a Run would give this node a result it does not have.
   *
   * Passed down rather than read here, because the card already subscribes to it — this file's
   * whole arrangement is that a couple of hundred sockets subscribe to nothing.
   */
  needsRun: boolean
}

export function OutputPort({
  nodeId,
  port,
  outputType,
  style,
  dimmed,
  needsRun,
}: OutputPortProps) {
  const socketRef = useRef<HTMLDivElement | null>(null)
  const { open, handlers } = useHoverPanel({
    anchorRef: socketRef,
    delayMs: PREVIEW_DELAY_MS,
    // Asked here rather than subscribed to, and asked *now* rather than when the pointer
    // arrived: a run may have filled this port during the delay.
    canOpen: () => port !== undefined && !!useGraphStore.getState().nodeOutput(nodeId, port.id),
    // A press on a socket is a connection starting, and a panel over the canvas is covering the
    // port being dragged to.
    dismissOnPress: true,
  })

  if (!port) return <div className="port-row__side port-row__side--out" />
  const label = port.label ?? port.id

  return (
    <div className="port-row__side port-row__side--out" {...handlers}>
      <span className="port-label">{label}</span>
      <Handle
        type="source"
        position={Position.Right}
        id={port.id}
        ref={socketRef}
        className="socket"
        data-family={style?.family}
        data-shape={style?.shape}
        data-compatible={dimmed ? 'false' : undefined}
        /*
         * Dropped while the panel is up, or the browser's own tooltip arrives on top of a panel
         * that already says everything it does.
         *
         * **The second line is what the silence is otherwise missing.** A port with nothing
         * cached says nothing on hover, deliberately — but a reader who has seen a preview
         * elsewhere and gets none here has no way to tell "this node has not run" from "this
         * feature does not work on this port". The native tooltip is the right place for it and
         * costs nothing: a panel opens at 260ms where a tooltip appears at about a second, so on
         * a port that *has* a value the tooltip is dropped before it is ever seen, and this line
         * is read almost only where it is true.
         *
         * `needsRun` rather than "is there a value": it is the card's own word for what a Run
         * would change, it is already subscribed, and it excludes annotation nodes — which have
         * nothing to compute, so telling somebody to run one is telling them to do the one thing
         * that cannot help.
         */
        title={
          open
            ? undefined
            : `${label}: ${typeLabel(outputType)}` +
              (needsRun ? '\nRun this node to preview its output' : '')
        }
      />
      {open &&
        createPortal(
          <PortPreviewPanel
            nodeId={nodeId}
            portId={port.id}
            label={label}
            anchor={open.anchor}
          />,
          open.host,
        )}
    </div>
  )
}
