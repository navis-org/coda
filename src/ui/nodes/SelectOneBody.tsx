/**
 * The Select One card: two arrows, a position, and the one control that touches the graph.
 *
 * Everything here reads the node's **input**, not its output. That is what makes the pager work
 * before the node has committed anything and while `Live` is off: the collection being stepped
 * through is already in hand on the wire, so the count, the position and the element's name cost
 * no run at all. The output would answer a different and much less useful question — "what did
 * you commit last time".
 *
 * The foot line is the whole of the design's honesty. With `Live` off, what is on screen and
 * what is on the port are two different elements for as long as somebody is browsing, and a
 * widget that showed only the first would have the graph disagreeing with the card with nothing
 * saying why. So it always states which element is being emitted, and says plainly when that is
 * nothing — the out-of-range case, which is what an upstream filter shrinking the collection
 * leaves behind.
 */

import { useMemo } from 'react'

import { getNodeDef } from '../../core/registry'
import type { ParamValue } from '../../core/node'
import {
  elementCount,
  elementLabel,
  elementNoun,
  isIterableKind,
  isIterableValue,
} from '../../nodes/lib/iterables'
import { useGraphStore } from '../../store/graphStore'
import { formatNumber } from '../format'
import { ParamField } from '../params/ParamField'
import type { NodeBodyProps } from './nodeBodies'

export function SelectOneBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  const def = getNodeDef(node.type)

  const input = useGraphStore((s) => {
    // `runVersion` ties this read to scheduler ticks; `nodeInputs` hands back the cached value
    // by reference, so the selector allocates nothing — invariant 7.
    void s.runVersion
    return s.nodeInputs(node.id)['in']
  })

  /*
   * Two different questions, answered from two different places, and conflating them printed
   * "Connect a table" on a card that was plainly wired. **Whether something is connected** is a
   * fact about the graph and comes off the inferred *type*, which exists the moment the link is
   * drawn; **what is on the wire** is a fact about the last run and is absent until there has
   * been one. A card that says "connect a table" at a socket with a wire in it sends somebody to
   * fix a link that is already there — the same failure the exporter's unwired/blocked split
   * exists to avoid.
   */
  const connected = Boolean(ctx.inputs['in'])
  const kind = ctx.inputs['in']?.kind
  // The node's own list, not a copy of it: a card offering to step through a kind `validate`
  // refuses is two statements about one fact.
  const steppable = isIterableKind(kind)

  const items = isIterableValue(input) ? input : undefined
  const total = items ? elementCount(items) : 0
  const live = node.params.live === true

  /*
   * Clamped on read rather than corrected in the store, the same call Profile's pager makes: an
   * upstream search that shrinks the collection would otherwise leave the card parked on an
   * element that no longer exists, showing nothing and blaming nothing.
   */
  const raw = Math.floor(Number(node.params.index ?? 0))
  const index = total > 0 ? Math.min(Math.max(0, raw), total - 1) : 0
  const selected = Math.floor(Number(node.params.selected ?? 0))

  const showing = useMemo(
    () => (items && total > 0 ? elementLabel(items, index) : ''),
    [items, index, total],
  )
  const emitting = useMemo(
    () => (items && selected >= 0 && selected < total ? elementLabel(items, selected) : ''),
    [items, selected, total],
  )

  const noun = elementNoun(items)
  const committed = selected === index
  const inRange = selected >= 0 && selected < total

  /** Both indices when Live is on, so the port follows the arrows; otherwise only the view. */
  const step = (next: number) => {
    setParam('index', next as ParamValue)
    if (live) setParam('selected', next as ParamValue)
  }

  // The generic card renders every non-advanced param; a body replaces that area outright, so it
  // renders the same set rather than a chosen few — a control a body forgets is reachable only
  // from the inspector, which on screen is indistinguishable from one that was never added.
  const fields = (def?.params ?? []).filter(
    (p) => !p.advanced && (!p.visibleIf || p.visibleIf(node.params)),
  )

  return (
    <div className="list-body nodrag">
      <div className="step-body__pager">
        <button
          type="button"
          className="step-body__btn"
          aria-label={`Previous ${noun}`}
          title={`Previous ${noun}`}
          disabled={total === 0 || index <= 0}
          onClick={() => step(index - 1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="step-body__btn"
          aria-label={`Next ${noun}`}
          title={`Next ${noun}`}
          disabled={total === 0 || index >= total - 1}
          onClick={() => step(index + 1)}
        >
          ›
        </button>
        <span className="step-body__position">
          {total > 0 ? `${formatNumber(index + 1)} / ${formatNumber(total)}` : '—'}
        </span>
        {showing && (
          <span className="step-body__name" title={showing}>
            {showing}
          </span>
        )}
        <span className="step-body__spacer" />
        <button
          type="button"
          className="step-body__commit"
          /*
           * Rendered while it can do nothing rather than hidden: a disabled control says "this
           * is already emitted", where a missing one says "this node cannot commit", and the
           * second is a different and untrue statement. Same call the Explore select-all makes.
           */
          disabled={live || total === 0 || committed}
          title={
            live
              ? 'Live is on — the arrows already update the output.'
              : committed
                ? 'This element is already what the Item port carries.'
                : 'Emit this element. Unlike stepping, this marks the graph stale.'
          }
          onClick={() => setParam('selected', index as ParamValue)}
        >
          Use this
        </button>
      </div>

      <div className="list-body__fields">
        {fields.map((param) => (
          <label key={param.id} className="list-body__field">
            <span className="param__label" title={param.help ?? param.label}>
              {param.label}
            </span>
            {/*
              `inspector`, for the reason `ParamRows` gives: it suppresses a checkbox's own
              label, and the row beside it already carries one. The generic node card solves the
              same collision in CSS (`.param--wide .param__label { display: none }`), which is
              the wrong half to borrow here — this body's fields share a label column, and a
              boolean that dropped out of it would be the one row not lining up.
            */}
            <ParamField
              param={param}
              value={node.params[param.id]}
              ctx={ctx}
              variant="inspector"
              onChange={(value) => setParam(param.id, value)}
            />
          </label>
        ))}
      </div>

      <div className="list-body__foot">
        {!connected ? (
          <span className="list-body__foot--empty">
            Connect a table, skeletons or meshes.
          </span>
        ) : !steppable ? (
          // Said from the type, so it appears while the graph is being wired rather than after
          // a run. The node's badge carries the same refusal; this is where somebody is looking.
          <span className="list-body__missing">⚠ A {kind} has no elements to step through.</span>
        ) : !items ? (
          <span className="list-body__foot--empty">Not run yet.</span>
        ) : total === 0 ? (
          <span className="list-body__foot--empty">Nothing to step through.</span>
        ) : !inRange ? (
          /*
           * The state an upstream filter leaves behind. It says the number *and* the length,
           * because "emitting nothing" alone reads as a broken node rather than as a choice
           * that has been filtered away.
           */
          <span className="list-body__missing" title={`Item ${selected + 1} is past the end`}>
            ⚠ emitting nothing — {noun} {formatNumber(selected + 1)} of {formatNumber(total)}
          </span>
        ) : live ? (
          <span title="The arrows write the output directly, so each step marks the graph stale.">
            live — arrows feed the output
          </span>
        ) : committed ? (
          <span title="What the Item port carries">emitting this one</span>
        ) : (
          <span title="What the Item port carries — press “Use this” to move it">
            emitting {formatNumber(selected + 1)}
            {emitting && !compact ? ` · ${emitting}` : ''}
          </span>
        )}
      </div>
    </div>
  )
}
