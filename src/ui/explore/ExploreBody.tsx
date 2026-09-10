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
import { datasetRef, isNumericDType } from '../../core/types'
import { isDatasetValue } from '../../core/values'
import { narrowPopulation } from '../../data/neuronFilter'
import { SELECT_ALL_WARN, excludedFromSearch } from '../../nodes/query/explore'
import {
  completeSearch,
  parseSearch,
  runSearch,
  searchIndexFor,
  SEARCH_PLACEHOLDER,
  SEARCH_SYNTAX_HELP,
} from '../../nodes/lib/neuronSearch'
import type { NodeBodyProps } from '../nodes/nodeBodies'
import { formatCell, formatNumber } from '../format'
import { copyText } from '../export'
import { errorMessage } from '../../core/errors'
import { joinIds } from '../../nodes/lib/copyIds'
import { NeuronRow, rowTemplate } from './NeuronRow'
import { distributionsFor, plotSpec } from './rowPlots'
import type { Layout } from './rowColumns'
import {
  automaticLayout,
  columnLabel,
  columnTitle,
  encodeLayout,
  hideField,
  isEmptyLayout,
  isMark,
  moveColumn,
  offerableFields,
  placeAsChip,
  placeAsColumn,
  placeOf,
  removeColumn,
  resolveLayout,
  rowSpecFor,
  setColumn,
  soleFieldOf,
  spreadsRead,
} from './rowColumns'
import { ColumnEditor } from './ColumnEditor'
import { AddFieldMenu } from './AddFieldMenu'
import { capabilityOf, getSource } from '../../data/source'
import { regionShares } from './rowRois'
import { clearRowRoiCache, useRowRois } from './useRowRois'
import { useThemeMode } from '../useThemeMode'
import { RowContextMenu } from './RowContextMenu'
import { rowFields } from './rowFields'
import { useNeuronIndex } from '../useNeuronIndex'

/**
 * Long enough that a burst of typing is one search, short enough to feel live. The search
 * itself is ~6–45 ms, so this is about not thrashing React and the store, not about the scan.
 */
const DEBOUNCE_MS = 140

/** One identity for "nothing stored", so the layout memo is not rebuilt by a fresh `[]`. */
const NO_ENTRIES: readonly string[] = []

/** Where a popover hangs: the left and bottom edges of the control that opened it. */
const anchorOf = (event: React.MouseEvent<HTMLElement>) => {
  const rect = event.currentTarget.getBoundingClientRect()
  return { left: rect.left, bottom: rect.bottom }
}

/** A memo key of joined names, back into the names. */
const keyList = (key: string) => (key ? key.split('\u0000') : [])

export function ExploreBody({
  node,
  ctx,
  compact,
  inputValues,
  setParam,
  onError,
}: NodeBodyProps) {
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

  /*
   * The dataset's population checkboxes, read off the **type** rather than the value.
   *
   * This card loads independently of any Run — that is its whole point — so the value is absent
   * until somebody presses it, and reading the filters there would list every `:Neuron` on a
   * fresh session and the narrowed set afterwards. The same widget answering differently before
   * and after a run is the disagreement the live-widget split exists to avoid.
   *
   * Narrowed here rather than in the shared entry: the entry is keyed by dataset and chain and
   * is shared by every card on them, so two Explore nodes reading one dataset two ways must not
   * be able to hand each other a narrowed table. One download, one cached copy, two views — and
   * `narrowPopulation`'s own cache is what keeps the *narrowed* copy shared with the node, so
   * both search the one 24 MB haystack `searchIndexFor` builds per table identity.
   */
  const loaded = state.status === 'ready' ? state.table : undefined
  // No `useMemo`: `narrowPopulation` caches per (index, population) itself, so this is a Map
  // lookup after the first call and hands back the *same object* every render — which a memo
  // here could not do anyway, since inference rebuilds the type and with it the filter array.
  const table = loaded ? narrowPopulation(loaded, datasetRef(type)?.population) : undefined

  // Through `ctx.column`, like every picker: a tag column the current dataset does not have must
  // drop out rather than draw an empty row.
  const tagColumn = ctx.column('tagColumn') ?? ''
  /** Once for the page, not once per mark per row — see `RowMarks`. */
  const mode = useThemeMode()

  /*
   * The automatic row spec: what the list shows while nobody has edited it, and what the first edit
   * starts from. The table is handed over only in the expanded view, which is what splits the
   * annotations into aligned columns and a chip tail — a card has no width to align in. Memoised on
   * the table identity, so the fill-rate pass runs once per dataset rather than per keystroke.
   */
  const fields = useMemo(
    () => rowFields(table?.schema, [], tagColumn, compact ? undefined : table),
    [table, tagColumn, compact],
  )

  /*
   * The same exclusion `evaluate` applies, through the one function that states it — or the
   * live list would show rows `Hits` does not carry, which is precisely the disagreement the
   * live-widget / committed-param split exists to avoid rather than to create.
   */
  const excluded = excludedFromSearch(ctx.params, tagColumn)
  const result = useMemo(() => {
    if (!table) return { rows: [] as number[], fuzzy: false }
    return runSearch(
      table,
      searchIndexFor(table, excluded ? [excluded] : []),
      parseSearch(applied),
    )
  }, [table, applied, excluded])

  const completions = useMemo(() => {
    if (!table || !completionOpen) return { from: 0, to: 0, items: [] }
    return completeSearch(table, text, caret)
  }, [table, completionOpen, text, caret])

  const pageSize = Math.max(1, Number(node.params.pageSize ?? 25))
  const pageCount = Math.max(1, Math.ceil(result.rows.length / pageSize))
  // Clamped rather than stored-and-corrected: a query that shrinks the hit set would otherwise
  // leave the node parked on a page that no longer exists, showing nothing.
  const page = Math.min(Math.max(0, Number(node.params.page ?? 0)), pageCount - 1)
  /*
   * Memoised, or every hook downstream of it re-runs on each render: `pageIds` and
   * `selectVisible` both key on this array, and a fresh `slice` each time made both of them
   * stability theatre.
   */
  const visible = useMemo(
    () => result.rows.slice(page * pageSize, page * pageSize + pageSize),
    [result.rows, page, pageSize],
  )

  const selection = useMemo(
    () =>
      new Set((Array.isArray(node.params.selection) ? node.params.selection : []).map(String)),
    [node.params.selection],
  )

  /**
   * Whether this dataset can answer a region breakdown at all.
   *
   * Read here rather than where the query is issued, because the *track* is reserved from it —
   * see `PlotSpec.regions`. `capabilityOf` and not `source.capabilities`, so the per-dataset
   * override is honoured.
   */
  const roiSupported =
    !compact &&
    !!ref?.sourceId &&
    capabilityOf(getSource(ref.sourceId), ref.datasetId, 'roiCounts')

  /**
   * The marks this dataset draws by default.
   *
   * Derived from the whole table and memoised on it, never on the hits — like the columns.
   * Expanded only: a card has no room for a mark.
   */
  const spec = useMemo(() => {
    if (compact || !table) return undefined
    const names = new Set(table.schema.columns.map((c) => c.name))
    // The region slot is reserved on the *capability*, so the track is the right width before the
    // query answers.
    return plotSpec((name) => names.has(name), roiSupported)
  }, [table, compact, roiSupported])

  const stored = Array.isArray(node.params.layout) ? node.params.layout : NO_ENTRIES

  /*
   * The list against this dataset: what it can draw (`layout`, undefined for the automatic list) and
   * what it cannot (`unseen`, which every edit writes back verbatim) — see `resolveLayout`.
   */
  const resolved = useMemo(
    () => resolveLayout(stored, table?.schema, spec, tagColumn),
    [stored, table, spec, tagColumn],
  )
  const listed = resolved.layout
  const explicit = listed !== undefined

  /*
   * The list as it stands — the stored one, or the automatic one it is about to become. What every
   * edit starts from, and through `automaticLayout` exactly what was drawn, so the first edit moves
   * nothing on screen.
   */
  const current = useMemo(() => listed ?? automaticLayout(fields, spec), [listed, fields, spec])
  /** The expanded view's columns; a card has none. */
  const columns = compact || !table ? undefined : current.columns

  /*
   * The spread the ranks and bars are read against — of the *whole table*, never the hits, for the
   * reason a percentile needs: a neuron's place is in its dataset, and recomputing it per search
   * would move it as somebody types. Keyed on *which* fields are measured rather than on the
   * columns, because each is a pass over every row: a rename, a move or a new chip measures nothing
   * again, and a rank pays only for its sample, a bar only for its maximum.
   */
  const spreads = columns ? spreadsRead(columns) : undefined
  const rankedKey = spreads?.ranked.join('\u0000')
  const barredKey = spreads?.barred.join('\u0000')
  const distributions = useMemo(
    () =>
      table && rankedKey !== undefined && barredKey !== undefined
        ? distributionsFor(table, keyList(rankedKey), keyList(barredKey))
        : undefined,
    [table, rankedKey, barredKey],
  )

  /*
   * What every row of the page draws in its columns: one object, so `NeuronRow`'s memo holds, and
   * one grid template, built once for the page and its header rather than once per row.
   */
  const rowLayout = useMemo(
    () =>
      columns && distributions
        ? { columns, distributions, style: rowTemplate(columns) }
        : undefined,
    [columns, distributions],
  )

  /** The row spec as drawn — the list's rule, and the card's half of it, are `rowSpecFor`'s. */
  const rowSpec = useMemo(() => rowSpecFor(fields, listed, compact), [fields, listed, compact])

  /*
   * The open column editor: which column (`null` to add one) and where its header cell sat when
   * it was clicked — read then, since the editor belongs to the cell it was opened from.
   */
  const [editing, setEditing] = useState<{
    index: number | null
    anchor: { left: number; bottom: number }
  } | null>(null)
  const openEditor = (index: number | null, event: React.MouseEvent<HTMLElement>) =>
    setEditing({ index, anchor: anchorOf(event) })

  /*
   * Every edit writes the *whole* list — columns, chips, and the entries this dataset cannot draw —
   * so the first one turns the automatic list into a stored one exactly as it was drawn, and an edit
   * made while pointed at hemibrain keeps a fish2 column. One param, so one write and one undo step.
   * `encodeLayout` refuses an empty list, which would read back as "automatic".
   */
  const commit = (next: Layout) => {
    const encoded = encodeLayout(next, resolved.unseen)
    if (encoded) setParam('layout', encoded)
  }
  /**
   * Whether an edit may be written — everything but one leaving the list empty. Asked of the
   * result, by every control that could produce it, so a click `commit` would refuse is a
   * disabled control rather than a silent one.
   */
  const allowed = (next: Layout) => !isEmptyLayout(next)

  const numericFields = useMemo(
    () =>
      new Set(table?.schema.columns.filter((c) => isNumericDType(c.dtype)).map((c) => c.name)),
    [table],
  )
  /** The fields both popovers offer, so they cannot offer two different lists. */
  const offered = useMemo(() => offerableFields(table?.schema, tagColumn), [table, tagColumn])

  /** The `+` menu, and the header cell it hangs from. */
  const [adding, setAdding] = useState<{ left: number; bottom: number } | null>(null)

  /** The one field a column being edited shows, where it shows exactly one. */
  const editedColumn = editing && editing.index !== null ? columns?.[editing.index] : undefined
  const editedField = editedColumn && soleFieldOf(editedColumn)

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

  /*
   * The region bar's one query, for the neurons on screen.
   *
   * Everything else on a row came out of the index; `roiInfo` is suppressed from that table as a
   * JSON blob, so this is the only thing here that reaches a server. A page at a time, settled,
   * and cached by the ids themselves — see `useRowRois`.
   */
  const pageIds = useMemo(
    () => visible.map((row) => neuronIdAt(row)).filter((id): id is string => !!id),
    [visible, neuronIdAt],
  )
  /*
   * Asked only while a column draws it: a header somebody took the region donut out of has no
   * reader for the one query on this surface that reaches a server.
   */
  const wantsRegions = columns?.some((c) => c.render === 'regions') ?? false
  const roiData = useRowRois(ref?.sourceId, ref?.datasetId, pageIds, wantsRegions)
  const regions = useMemo(() => regionShares(roiData?.rows, roiData?.primaryRois), [roiData])

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
  /*
   * Every match, however many that is — with a sentence in the status bar when it is a number
   * that will be felt. It used to be a disabled button above ten thousand, which told somebody
   * asking for "every VPN in the dataset" that the answer was too big to be had; the cost is
   * real (every id lands in every downstream cache key) but it is a cost, not an impossibility.
   */
  /**
   * Tick a set of rows, saying so when the number is one that will be felt.
   *
   * Shared by the foot's Select-all and the row menu's Select-all-of-this-type, or the two
   * disagree about when a selection is worth warning about — and the menu's is the one that can
   * surprise, since "every LC4" is a number nobody typed.
   */
  const selectMatching = useCallback(
    (rows: readonly number[]) => {
      if (rows.length > SELECT_ALL_WARN) {
        onError(
          `Selecting ${formatNumber(rows.length)} neurons. Every id travels in the saved ` +
            `file and in the cache key of every node downstream, so editing this graph will feel ` +
            `slower — narrow the search and select again if that is not what you meant.`,
        )
      }
      selectRowsInto(rows)
    },
    [selectRowsInto, onError],
  )

  const selectAll = useCallback(
    () => selectMatching(result.rows),
    [selectMatching, result.rows],
  )

  /*
   * The row a right-click landed on, or nothing.
   *
   * Held as a row *index* rather than the resolved id and type: the index is what reaches every
   * column, and resolving at open time would mean the menu kept showing a label from before the
   * search that has since moved under it.
   */
  const [menu, setMenu] = useState<{
    at: { x: number; y: number }
    row: number
    /** The chip the right-click landed on, if any — see `RowContextMenu.chip`. */
    chip: string | undefined
  } | null>(null)

  const openMenu = useCallback(
    (row: number, at: { x: number; y: number }, chip: string | undefined) =>
      setMenu({ at, row, chip }),
    [],
  )

  /**
   * Everything the menu needs about the row under the pointer.
   *
   * Computed only while it is open, which is what makes the `sharing` count affordable — it is a
   * scan of every hit, and on male-CNS that is 165,122 rows. Once per right-click is nothing;
   * per render it would be a scan on every keystroke.
   */
  const menuRow = useMemo(() => {
    if (!menu || !table) return null
    const id = neuronIdAt(menu.row)
    if (!id) return null
    const column = fields.primary ? table.data[fields.primary] : undefined
    const raw = column?.[menu.row] ?? null
    // The label as the row draws it, so the menu names what is on screen rather than the stored
    // cell — they differ wherever `formatCell` does anything.
    const type = raw === null || raw === '' ? null : formatCell(raw, fields.primary)
    const sharing =
      type === null || !column ? [] : result.rows.filter((row) => column[row] === raw)
    return { id, type, sharing }
  }, [menu, table, fields.primary, neuronIdAt, result.rows])

  const copyOrReport = useCallback(
    (text: string) => {
      void copyText(text).catch((error) => onError(errorMessage(error)))
    },
    [onError],
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
          placeholder={compact ? 'Search neurons…' : `Search: ${SEARCH_PLACEHOLDER}`}
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
            // The region pages too. A reload that re-downloaded the index and left every row's
            // region donut on the answers from before it is a reload that did not reload.
            clearRowRoiCache()
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
            Downloaded once, then cached. Shouldn't be more than a few seconds.
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
          {/*
            The header, which shares `rowTemplate` with every row below it or it sits half a column
            off the values it labels. Every cell is a button opening that column's editor, and the
            `+` in the last track opens the field menu — drawn even over no columns at all, since it is
            then the only way to get one.
          */}
          {rowLayout && (
            <div className="explore-head" style={rowLayout.style}>
              {/* The checkbox, tile and name-block tracks, named by nothing. */}
              <span />
              <span />
              <span />
              {rowLayout.columns.map((column, at) => (
                <button
                  type="button"
                  // Position is the key: a header cell holds no state of its own.
                  key={at}
                  className={
                    'explore-head__cell' +
                    (column.render === 'number' ? ' explore-head__cell--stat' : '') +
                    (isMark(column) ? ' explore-head__cell--mark' : '')
                  }
                  title={columnTitle(column, table.schema)}
                  aria-haspopup="dialog"
                  onClick={(event) => openEditor(at, event)}
                >
                  {columnLabel(column)}
                </button>
              ))}
              <button
                type="button"
                className="explore-head__add"
                title="Add a field, as a column or a chip — or combine several into one column"
                aria-label="Add a field"
                aria-haspopup="dialog"
                onClick={(event) => setAdding(anchorOf(event))}
              >
                +
              </button>
            </div>
          )}
          {columns && editing && (
            <ColumnEditor
              // Keyed on the column, so opening a second one starts from that column's own state.
              key={editing.index ?? 'add'}
              anchor={editing.anchor}
              column={editing.index === null ? undefined : columns[editing.index]}
              schema={table.schema}
              offered={offered}
              numeric={numericFields}
              canMoveLeft={editing.index !== null && editing.index > 0}
              canMoveRight={editing.index !== null && editing.index < columns.length - 1}
              canRemove={
                editing.index !== null && allowed(removeColumn(current, editing.index))
              }
              explicit={explicit}
              onApply={(column) => commit(setColumn(current, editing.index, column))}
              onMove={(delta) =>
                editing.index !== null && commit(moveColumn(current, editing.index, delta))
              }
              {...(editedField
                ? {
                    onShowAsChip: () => commit(placeAsChip(current, editedField)),
                  }
                : {})}
              onRemove={() =>
                editing.index !== null && commit(removeColumn(current, editing.index))
              }
              onReset={() => setParam('layout', [])}
              onClose={() => setEditing(null)}
            />
          )}

          {columns && adding && (
            <AddFieldMenu
              anchor={adding}
              fields={offered.map((name) => ({
                name,
                numeric: numericFields.has(name),
                place: placeOf(current, name),
              }))}
              canHide={(name) => allowed(hideField(current, name))}
              onColumn={(name) => commit(placeAsColumn(current, name, numericFields.has(name)))}
              onChip={(name) => commit(placeAsChip(current, name))}
              onHide={(name) => commit(hideField(current, name))}
              onCombine={() => {
                setAdding(null)
                setEditing({ index: null, anchor: adding })
              }}
              onClose={() => setAdding(null)}
            />
          )}

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
                    fields={rowSpec}
                    sourceId={ref?.sourceId}
                    datasetId={ref?.datasetId}
                    selected={selection.has(neuronId)}
                    onToggle={toggle}
                    compact={compact}
                    // The menu is the overlay's, and it is now the only thing that is: the hover
                    // preview used to be gated the same way and runs on a card too. What still
                    // divides them is that a menu wants a pointer the canvas has already claimed
                    // for panning and selection, where a preview only wants somewhere to draw.
                    onContextMenu={compact ? undefined : openMenu}
                    mode={mode}
                    {...(rowLayout ? { layout: rowLayout } : {})}
                    {...(regions.size ? { regions } : {})}
                  />
                )
              })
            )}
          </div>

          {menu && menuRow && (
            <RowContextMenu
              at={menu.at}
              caption={`${menuRow.type ?? 'untyped'} · ${menuRow.id}`}
              type={menuRow.type}
              selected={selection.size}
              sharing={menuRow.sharing.length}
              onCopyId={() => copyOrReport(menuRow.id)}
              // `joinIds`' own default, so the menu and the Copy IDs node cannot put ids on the
              // clipboard two different ways.
              onCopySelected={() => copyOrReport(joinIds([...selection]))}
              onCopyType={() => menuRow.type && copyOrReport(menuRow.type)}
              onSelectSharing={() => selectMatching(menuRow.sharing)}
              onSearchType={() => menuRow.type && setText(menuRow.type)}
              chip={menu.chip}
              onChipToColumn={() =>
                menu.chip &&
                commit(placeAsColumn(current, menu.chip, numericFields.has(menu.chip)))
              }
              onChipHide={() => menu.chip && commit(hideField(current, menu.chip))}
              canHideChip={menu.chip !== undefined && allowed(hideField(current, menu.chip))}
              onClose={() => setMenu(null)}
            />
          )}

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
               * Never truncated and no longer refused. "+ all" that quietly selected the best
               * 10,000 of 165,122 would be a lie told by a button, which is why the disabled
               * state existed; but a button that refuses the whole of a dataset is a different
               * lie — that the selection cannot be had — and the honest third option is to say
               * what it will cost in the title and again in the status bar on the way past.
               */
              <button
                type="button"
                className="explore__link"
                title={
                  hits > SELECT_ALL_WARN
                    ? `Select all ${formatNumber(hits)} matching neurons — a selection this size travels in every downstream cache key and will make editing feel slower`
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
