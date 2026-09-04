/**
 * The Copy IDs card: the node's three settings, the button, and the count only the card knows.
 *
 * A body rather than plain param rows for the two reasons `DownloadBody` is one. The **copy
 * itself** cannot live in `evaluate` — `src/nodes` is headless, and a cache hit means `evaluate`
 * never runs, so a copy performed there would happen on the first Run and silently not on the
 * second. And **how many ids there are** is decided from the *value*, so `validate`, which runs
 * at edit time with types only, cannot say it; the count is also the honest disabled state for
 * the button, since a press that copies an empty string looks exactly like a press that worked.
 *
 * The write is a real click handler and not a run hook, deliberately: every engine but Chrome
 * refuses `clipboard.writeText` outside a user gesture. See the node's own note.
 */

import { useEffect, useMemo, useState } from 'react'

import { errorMessage } from '../../core/errors'
import { getNodeDef } from '../../core/registry'
import { isTableValue } from '../../core/values'
import { copyIds, copyIdsSettings, joinIds } from '../../nodes/lib/copyIds'
import { useGraphStore } from '../../store/graphStore'
import { copyText } from '../export'
import { plural } from '../format'
import { ParamField } from '../params/ParamField'
import type { NodeBodyProps } from './nodeBodies'

/** How long "Copied" stays up. ShareDialog's number, because it is the same gesture. */
const COPIED_MS = 1600

/** One array for every card with nothing wired, so the memo below has a stable identity. */
const NO_IDS: string[] = []

export function CopyIdsBody({ node, ctx, setParam, onError }: NodeBodyProps) {
  const def = getNodeDef(node.type)
  /*
   * A press *count* rather than a boolean, so pressing again while "Copied" is still up
   * restarts the timer: the effect is keyed on it, and its cleanup cancels the one in flight.
   * A boolean would already be `true`, the effect would not re-run, and the second press would
   * be acknowledged for whatever was left of the first one's 1.6s.
   */
  const [presses, setPresses] = useState(0)
  useEffect(() => {
    if (presses === 0) return
    const timer = window.setTimeout(() => setPresses(0), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [presses])

  const value = useGraphStore((s) => {
    void s.runVersion
    return s.nodeInputs(node.id)['neurons']
  })

  const { separator, dedupe, quoted } = copyIdsSettings(node.params)

  /*
   * One walk of the column, shared by the count and the press. The ids are counted rather than
   * the rows, and that is not the same number: `copyIds` drops nulls and — with `Deduplicate`
   * on, which is the default — collapses repeats. A card reading "1,204 ids" off `numRows`
   * while the clipboard got 900 of them is a card that lies in exactly the case the control
   * exists for.
   *
   * `separator` and `quoted` are deliberately not deps: they change the text, never the count,
   * and a re-walk per keystroke in a dropdown is what the memo is here to avoid.
   */
  const ids = useMemo(
    () => (isTableValue(value) ? copyIds(value, dedupe) : NO_IDS),
    [value, dedupe],
  )

  // A body replaces the generic rows outright, so it renders the same set in declaration order
  // — a control a body forgets is reachable only from the inspector, which on screen is
  // indistinguishable from one that was never added.
  const fields = (def?.params ?? []).filter(
    (p) => !p.advanced && (!p.visibleIf || p.visibleIf(node.params)),
  )

  const copy = () => {
    void copyText(joinIds(ids, { separator, quoted })).then(
      () => setPresses((n) => n + 1),
      (err: unknown) => onError(errorMessage(err)),
    )
  }

  return (
    <div className="list-body nodrag">
      <div className="list-body__fields">
        {fields.map((param) => (
          <label key={param.id} className="list-body__field">
            <span className="param__label" title={param.help ?? param.label}>
              {param.label}
            </span>
            <ParamField
              param={param}
              value={node.params[param.id]}
              ctx={ctx}
              onChange={(v) => setParam(param.id, v)}
            />
          </label>
        ))}
      </div>

      {/*
       * No title on the disabled state, unlike Download's: a disabled control dispatches no
       * mouse events, so the browser never shows one — and the foot below is on screen
       * unconditionally and says strictly more, since it tells the two absences apart.
       */}
      <button
        type="button"
        className="list-body__go"
        onClick={copy}
        disabled={ids.length === 0}
        title="Put these ids on the clipboard"
      >
        {presses > 0 ? 'Copied' : 'Copy to clipboard'}
      </button>

      <div className="list-body__foot">
        {ids.length === 0 ? (
          <span className="list-body__foot--empty">
            {isTableValue(value) ? 'No ids in this table.' : 'Not run yet.'}
          </span>
        ) : (
          <span>{plural(ids.length, 'id')}</span>
        )}
      </div>
    </div>
  )
}
