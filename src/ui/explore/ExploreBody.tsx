/**
 * The Explore node's body: a search bar and a paginated list of neurons.
 *
 * The point of this widget is that it answers "what is in this dataset?" before you know what to
 * ask for, which a regex field cannot. So the interaction rules are:
 *
 *  - **An empty search shows everything.** All 165,122 male-CNS neurons, paged.
 *  - **Typing filters immediately** — the list comes from the widget's own copy of the index, so
 *    a keystroke costs a local scan (~6 ms over 165k rows) and never a query or a graph run.
 *  - **The graph stays honest.** The committed query lands on the node as a param after a short
 *    debounce, which marks the node stale; the output ports still wait for Run.
 *
 * That last split is the one worth defending. Making the node `cheap` would re-run every
 * downstream node on every keystroke; searching only on Run would make the list feel dead. Doing
 * both, in the two places that each suit, is why this reads as a browser rather than a form.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { idText } from '../../core/ids'
import { datasetRef } from '../../core/types'
import { isDatasetValue } from '../../core/values'
import { MAX_SELECT_ALL, excludedFromSearch } from '../../nodes/query/explore'
import {
  completeSearch,
  parseSearch,
  runSearch,
  searchIndexFor,
  SEARCH_SYNTAX_HELP,
} from '../../nodes/lib/neuronSearch'
import type { NodeBodyProps } from '../nodes/nodeBodies'
import { formatNumber } from '../format'
import { NeuronRow } from './NeuronRow'
import { rowFields } from './rowFields'
import { useNeuronIndex } from '../useNeuronIndex'

/**
 * Long enough that a burst of typing is one search, short enough to feel live. The search
 * itself is ~6–45 ms, so this is about not thrashing React and the store, not about the scan.
 */
const DEBOUNCE_MS = 140

export function ExploreBody({ node, ctx, compact, inputValues, setParam }: NodeBodyProps) {
  /*
   * The value's dataset id when there is one, the type's otherwise — never one paired with the
   * other's chain. A dataset node on "Latest" publishes no id until its listing lands, so the
   * type's can be absent or older than the value's, and an index fetched for one while carrying
   * the other's labels would be cached under a key claiming a pairing that never existed. Same
   * reasoning as `datasetRequest`, which exists so a call site cannot supply one without the
   * other.
   */
  const value = inputValues?.dataset
  const ref = isDatasetValue(value) ? value : datasetRef(ctx.inputs.dataset)
  /*
   * The chain comes off the *value*, not the type.
   *
   * A dataset **type** carries the annotation chain's schema; only the `DatasetValue` carries its
   * table, because that table is a fetch somebody's Run paid for. On a datastack that publishes a
   * neuron table this is a labelling improvement — the list shows the chain's names instead of
   * the backend's. On one that publishes none it is the difference between working and not, since
   * there the chain *is* the neuron list.
   *
   * That is a real departure from "this widget loads independently of any run", and it is bounded
   * to what cannot be had otherwise: with nothing wired, or before a run, it behaves exactly as
   * it always did.
   */
  const annotations = isDatasetValue(value) ? value.annotations : undefined

  /*
   * **A chain wired but not yet run means wait, not load.**
   *
   * The *type* says a chain is there the moment the wire is drawn; only the value carries its
   * table. Loading anyway downloads the whole index under the unannotated key and then a second
   * time under the annotated one the instant a Run lands — on FlyWire that is 139,255 rows and
   * about seven seconds thrown away, and both tables are then retained for the life of the tab,
   * since the shared entry map is never evicted. It is also the *wrong* list to show: the labels
   * are the backend's, which is the gap the chain was wired to close.
   *
   * Read off the type rather than off the source's refusal. It used to match the text of
   * `CaveSource`'s "publishes no table listing its neurons", which coupled this empty state to
   * the wording of a sentence in `src/data` and recognised only CAVE's phrasing.
   */
  const type = ctx.inputs.dataset
  const chainWired = type?.kind === 'dataset' && type.annotations !== undefined
  const awaitingRun = chainWired && !annotations
  const { state, reload } = useNeuronIndex(
    awaitingRun ? undefined : ref?.sourceId,
    awaitingRun ? undefined : ref?.datasetId,
    annotations,
  )

  const committed = String(node.params.query ?? '')
  const [text, setText] = useState(committed)
  // What the list is actually filtered by. Separate from `text` so a keystroke re-renders the
  // input immediately without waiting for a scan of the whole dataset.
  const [applied, setApplied] = useState(committed)
  const [completionOpen, setCompletionOpen] = useState(false)
  const [completionIndex, setCompletionIndex] = useState(0)
  const [caret, setCaret] = useState(committed.length)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  /**
   * The last value this widget itself committed.
   *
   * Without it, the debounced write comes straight back as a changed `committed` and the effect
   * below "adopts" it — overwriting anything typed in the meantime. The window is small but the
   * failure is losing the user's keystrokes, so the echo is recognised and ignored instead.
   */
  const ownCommit = useRef(committed)

  // Adopt a query changed from outside: undo, a loaded file, the inspector's own field.
  useEffect(() => {
    if (committed === ownCommit.current) return
    ownCommit.current = committed
    setText(committed)
    setApplied(committed)
  }, [committed])

  useEffect(() => {
    if (text === applied) return
    const timer = setTimeout(() => {
      setApplied(text)
      // Marks the node stale, so downstream waits for Run. Paging does not do this.
      if (text !== committed) {
        ownCommit.current = text
        setParam('query', text)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, applied, committed, setParam])

  const table = state.status === 'ready' ? state.table : undefined

  // Through `ctx.columns`, never `ctx.params.chips`: that is what filters the stored list
  // against the schema actually arriving, so a graph repointed at another dataset drops the
  // fields it no longer has instead of showing a column of blanks.
  // Joined into a key rather than kept as an array: `ctx.columns` mints a fresh one on every
  // render, so an identity-keyed memo would rebuild the row spec on every keystroke.
  const chosenKey = ctx.columns('chips').join('\u0000')
  // Resolved the same way, and for the same reason: a tag column the current dataset does not
  // have must drop out rather than draw an empty row.
  const tagColumn = ctx.column('tagColumn') ?? ''
  const fields = useMemo(
    () => rowFields(table?.schema, chosenKey ? chosenKey.split('\u0000') : [], tagColumn),
    [table, chosenKey, tagColumn],
  )

  /*
   * The same exclusion `evaluate` applies, through the one function that states it — or the
   * live list would show rows `Hits` does not carry, which is precisely the disagreement the
   * live-widget / committed-param split exists to avoid rather than to create.
   */
  const excludedKey = excludedFromSearch(ctx).join('\u0000')
  const result = useMemo(() => {
    if (!table) return { rows: [] as number[], fuzzy: false }
    const excluded = excludedKey ? excludedKey.split('\u0000') : []
    return runSearch(table, searchIndexFor(table, excluded), parseSearch(applied))
  }, [table, applied, excludedKey])

  const completions = useMemo(() => {
    if (!table || !completionOpen) return { from: 0, to: 0, items: [] }
    return completeSearch(table, text, caret)
  }, [table, completionOpen, text, caret])

  const pageSize = Math.max(1, Number(node.params.pageSize ?? 25))
  const pageCount = Math.max(1, Math.ceil(result.rows.length / pageSize))
  // Clamped rather than stored-and-corrected: a query that shrinks the hit set would otherwise
  // leave the node parked on a page that no longer exists, showing nothing.
  const page = Math.min(Math.max(0, Number(node.params.page ?? 0)), pageCount - 1)
  const visible = result.rows.slice(page * pageSize, page * pageSize + pageSize)

  const selection = useMemo(
    () =>
      new Set((Array.isArray(node.params.selection) ? node.params.selection : []).map(String)),
    [node.params.selection],
  )

  const setPage = useCallback(
    (next: number) => setParam('page', Math.min(Math.max(0, next), pageCount - 1)),
    [setParam, pageCount],
  )

  /*
   * The selection is read through a ref so this handler keeps one identity for the widget's
   * lifetime. Closing over `selection` re-minted it on every tick, which changed a prop on
   * all 25 memoised rows and re-rendered every thumbnail whenever anything was ticked.
   */
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const toggle = useCallback(
    (neuronId: string) => {
      const next = new Set(selectionRef.current)
      if (next.has(neuronId)) next.delete(neuronId)
      else next.add(neuronId)
      setParam('selection', [...next])
    },
    [setParam],
  )

  /**
   * A row's neuron id, as **text**.
   *
   * Invariant 8, and this widget broke it: it was `Number(cell)`, so an eighteen-digit CAVE root
   * id was rounded on its way into the `selection` param — `720575940628857210` stored as
   * `…200`, which `rowsWithIds` then matched against nothing. The symptom is precise and was
   * reported as such: `Hits` works and `Selected` is empty, because `Hits` never goes through
   * the selection. Worse, the *checkbox* looked right, since the widget compared its own rounded
   * id against its own rounded id and only the value crossing to `evaluate` was wrong.
   *
   * neuPrint's nine-to-eleven-digit ids are exact as doubles, which is why it survived this long.
   */
  const neuronIdAt = useCallback(
    (row: number) => idText(table?.data['neuronId']?.[row] ?? null),
    [table],
  )

  const selectRowsInto = useCallback(
    (rows: readonly number[]) => {
      const next = new Set(selection)
      for (const row of rows) {
        const id = neuronIdAt(row)
        // A row whose id is null or unreadable is skipped rather than added as "null" — the
        // grammar's job, and `idText` is the one place that decides it.
        if (id) next.add(id)
      }
      setParam('selection', [...next])
    },
    [selection, neuronIdAt, setParam],
  )

  const selectVisible = useCallback(() => selectRowsInto(visible), [selectRowsInto, visible])
  const selectAll = useCallback(
    () => selectRowsInto(result.rows),
    [selectRowsInto, result.rows],
  )

  const accept = useCallback(
    (index: number) => {
      const item = completions.items[index]
      if (!item) return
      const next = text.slice(0, completions.from) + item.text + text.slice(completions.to)
      setText(next)
      setCompletionOpen(false)
      // Caret goes after the inserted text, so typing continues where you would expect.
      const at = completions.from + item.text.length
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(at, at)
        setCaret(at)
      })
    },
    [completions, text],
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    /*
     * Every key stops here. The canvas binds Space to the command palette and Backspace/Delete
     * to node deletion, so without this, typing a search term with a space in it opens the
     * palette and a correction deletes the node you are typing into.
     */
    event.stopPropagation()

    const open = completionOpen && completions.items.length > 0
    if (event.key === 'ArrowDown' && open) {
      event.preventDefault()
      setCompletionIndex((i) => (i + 1) % completions.items.length)
    } else if (event.key === 'ArrowUp' && open) {
      event.preventDefault()
      setCompletionIndex((i) => (i - 1 + completions.items.length) % completions.items.length)
    } else if ((event.key === 'Tab' || event.key === 'Enter') && open) {
      event.preventDefault()
      accept(completionIndex)
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault()
        setCompletionOpen(false)
      }
    }
  }

  const total = table?.length ?? 0
  const hits = result.rows.length

  return (
    <div className="explore nodrag">
      <div className="explore__search">
        <input
          ref={inputRef}
          className="explore__input"
          type="text"
          value={text}
          placeholder={
            compact ? 'Search neurons…' : 'Search: DNp01   class==sensory   post>1000'
          }
          title={SEARCH_SYNTAX_HELP}
          aria-label="Search neurons"
          aria-describedby={listId}
          spellCheck={false}
          autoComplete="off"
          disabled={!table}
          onChange={(event) => {
            setText(event.target.value)
            setCaret(event.target.selectionStart ?? event.target.value.length)
            setCompletionOpen(true)
            setCompletionIndex(0)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setCompletionOpen(false)}
        />
        {text && (
          <button
            type="button"
            className="explore__clear"
            title="Clear the search"
            aria-label="Clear search"
            onClick={() => {
              setText('')
              inputRef.current?.focus()
            }}
          >
            ✕
          </button>
        )}
        <button
          type="button"
          className="explore__reload"
          title="Re-download this dataset's index"
          aria-label="Reload index"
          onClick={() => {
            reload()
            // Bumps the provenance nonce so downstream re-runs against the new index rather
            // than surviving on a cached result built from the old one.
            setParam('refresh', Number(node.params.refresh ?? 0) + 1)
          }}
        >
          ⟳
        </button>

        {completionOpen && completions.items.length > 0 && (
          <ul className="explore__completions" role="listbox">
            {completions.items.map((item, index) => (
              <li key={item.text} role="option" aria-selected={index === completionIndex}>
                <button
                  type="button"
                  className="explore__completion"
                  data-active={index === completionIndex || undefined}
                  // Pointer-down, not click: the input's blur would close the list first.
                  onPointerDown={(event) => {
                    event.preventDefault()
                    accept(index)
                  }}
                >
                  <span>{item.label}</span>
                  {item.detail && (
                    <span className="explore__completion-detail">{item.detail}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {state.status === 'none' && (
        <div className="explore__empty">Connect a Dataset to browse its neurons.</div>
      )}
      {state.status === 'loading' && (
        <div className="explore__empty">
          <span className="explore__spinner" aria-hidden="true" />
          Loading this dataset&rsquo;s neurons{state.note ? ` — ${state.note}` : '…'}
          <span className="explore__hint">
            Downloaded once, then cached. male-CNS is ~7&nbsp;MB and takes a few seconds.
          </span>
        </div>
      )}
      {awaitingRun && (
        /*
         * A state rather than a fault, so it reads as an instruction. The chain's table is a
         * fetch a Run pays for; until then there is either nothing to list (a datastack with no
         * neuron table of its own) or only the backend's labels, which is the list the chain was
         * wired to replace.
         */
        <div className="explore__empty">
          Press Run to load this dataset&rsquo;s neurons.
          <span className="explore__hint">
            An Annotations source is wired, and its labels are this list — they arrive with the
            first Run.
          </span>
        </div>
      )}
      {state.status === 'error' && <div className="explore__error">{state.message}</div>}

      {table && (
        <>
          {/* `nowheel` lets the list scroll instead of zooming the canvas under it. */}
          <div className="explore__list nowheel">
            {visible.length === 0 ? (
              <div className="explore__empty">
                Nothing matches. {applied ? 'Try fewer terms.' : ''}
              </div>
            ) : (
              visible.map((row) => {
                const neuronId = neuronIdAt(row) ?? ''
                return (
                  <NeuronRow
                    key={neuronId || row}
                    table={table}
                    row={row}
                    fields={fields}
                    sourceId={ref?.sourceId}
                    datasetId={ref?.datasetId}
                    selected={selection.has(neuronId)}
                    onToggle={toggle}
                    compact={compact}
                  />
                )
              })
            )}
          </div>

          <div className="explore__foot" id={listId}>
            <span className="explore__count">
              {applied
                ? `${formatNumber(hits)} of ${formatNumber(total)}`
                : `${formatNumber(total)} neurons`}
              {/* Said out loud, because silently widening a search is how a hit count starts
                  lying about what it counted. */}
              {result.fuzzy && (
                <span className="explore__fuzzy"> · no exact match, showing similar</span>
              )}
            </span>

            {selection.size > 0 && (
              <button
                type="button"
                className="explore__link"
                title="Clear the selection"
                onClick={() => setParam('selection', [])}
              >
                {formatNumber(selection.size)} selected ✕
              </button>
            )}
            {visible.length > 0 && (
              <button
                type="button"
                className="explore__link"
                title="Select every neuron on this page"
                onClick={selectVisible}
              >
                + page
              </button>
            )}
            {hits > 0 && (
              /*
               * Offered but refused above the ceiling, rather than hidden: a button that
               * vanishes on a big result reads as a missing feature, where a disabled one with
               * a reason reads as a limit and says how to get under it. And it is refused
               * rather than truncated — "+ all" that quietly selected the best 10,000 of
               * 165,122 would be a lie told by a button.
               */
              <button
                type="button"
                className="explore__link"
                disabled={hits > MAX_SELECT_ALL}
                title={
                  hits > MAX_SELECT_ALL
                    ? `Too many to select at once: ${formatNumber(hits)} match, and a selection is capped at ${formatNumber(MAX_SELECT_ALL)}. Narrow the search first.`
                    : `Select all ${formatNumber(hits)} matching neurons`
                }
                onClick={selectAll}
              >
                + all
              </button>
            )}

            <span className="explore__pager">
              <button
                type="button"
                className="explore__page-btn"
                disabled={page <= 0}
                aria-label="Previous page"
                onClick={() => setPage(page - 1)}
              >
                ‹
              </button>
              <span className="explore__page-label">
                {page + 1} / {formatNumber(pageCount)}
              </span>
              <button
                type="button"
                className="explore__page-btn"
                disabled={page >= pageCount - 1}
                aria-label="Next page"
                onClick={() => setPage(page + 1)}
              >
                ›
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  )
}
