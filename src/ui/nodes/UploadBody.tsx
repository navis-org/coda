/**
 * The Upload Table card: pick a file or paste rows, then say what the columns mean.
 *
 * A body rather than param fields, because the two things that matter here are a *button* and
 * a *state*, and neither is a value the generic renderer can draw. `dataId` and `fileName` are
 * written from here and never typed.
 *
 * ## Four states, and telling them apart is the point
 *
 * `empty` — nothing picked yet. `loading` — a reference in the graph whose meta the peek has
 * not answered for. `ready` — the rows are in this browser. `absent` — they are not, which is
 * what a graph opened on another machine looks like and the only one that needs a sentence
 * rather than a number. Collapsing `loading` into `absent` would put "not in this browser" on
 * every card for the first frame after every reload, which is how a real message stops being
 * read.
 *
 * ## The file is read here, not in the node
 *
 * `FileReader` and `File` are DOM, and `src/nodes` is headless. So this reads the text, parses
 * it through `data/csv.ts`, and hands the finished table to `putUpload`; the node only ever
 * loads what is already stored. That is also why the size ceiling is enforced here — it is
 * checked against `file.size` *before* a byte is read, which is the only place that check is
 * still cheap.
 */

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { getNodeDef } from '../../core/registry'
import { parseDelimited } from '../../data/csv'
import {
  MAX_UPLOAD_BYTES,
  peekUploadMeta,
  putUpload,
  subscribeUploadLearned,
  uploadPeekSettled,
  uploadRevision,
} from '../../data/uploads'
import { formatNumber } from '../format'
import { ParamField } from '../params/ParamField'
import type { NodeBodyProps } from './nodeBodies'

/** Big enough that a header and a few rows are legible; small enough not to own the card. */
const PASTE_ROWS = 4

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function UploadBody({ node, ctx, compact, setParam, onError }: NodeBodyProps) {
  const def = getNodeDef(node.type)
  const inputRef = useRef<HTMLInputElement>(null)
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)

  const dataId = String(node.params.dataId ?? '')
  const fileName = String(node.params.fileName ?? '')

  /*
   * Subscribed to the uploads store directly, not to the graph store.
   *
   * The learned signal does re-infer the graph, so reading this off a graph-store tick would
   * *work* — and would make this card's ability to stop saying "looking…" depend on a
   * re-inference happening elsewhere for an unrelated reason. Here the dependency is the one
   * that is actually true.
   *
   * The snapshot is the **revision counter**, not the peeked value, and that is load-bearing:
   * `loading` and `absent` both peek to `undefined`, so a value snapshot never changes when
   * the read lands and the card never leaves "looking…". See `uploadRevision`.
   */
  useSyncExternalStore(subscribeUploadLearned, uploadRevision)
  const meta = peekUploadMeta(dataId)
  const settled = uploadPeekSettled(dataId)

  const state: 'empty' | 'loading' | 'ready' | 'absent' = !dataId
    ? 'empty'
    : meta
      ? 'ready'
      : settled
        ? 'absent'
        : 'loading'

  /**
   * Parse and store, then point the node at the result.
   *
   * The two params are written in one `setParam` pair rather than a batch, which is two undo
   * steps — accepted, because the alternative is a store API for "several params at once" that
   * nothing else wants. `dataId` goes last so a graph caught between the two writes names the
   * new file rather than the old rows.
   */
  const ingest = useCallback(
    async (name: string, text: string) => {
      setBusy(true)
      try {
        const parsed = parseDelimited(text)
        if (parsed.table.schema.columns.length === 0 || parsed.table.length === 0) {
          throw new Error(`"${name}" has no rows to read.`)
        }
        const id = await putUpload(name, parsed.table, text.length)
        setParam('fileName', name)
        setParam('dataId', id)
        // A ragged file parses fine and is worth mentioning once, here, rather than as a
        // permanent badge: it is a fact about the import, not about the node's configuration.
        if (parsed.raggedRows > 0) {
          onError(
            `${name}: ${formatNumber(parsed.raggedRows)} row(s) did not have ${parsed.table.schema.columns.length} fields — padded with blanks.`,
          )
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [onError, setParam],
  )

  const onPick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      // Clear it, or picking the same file twice in a row fires no change event at all.
      event.target.value = ''
      if (!file) return
      // Checked against the file's own size, before a byte is read — the same call
      // `pivotTable` makes about shape rather than about the array it is about to allocate.
      if (file.size > MAX_UPLOAD_BYTES) {
        onError(
          `"${file.name}" is ${formatBytes(file.size)}, over the ${formatBytes(MAX_UPLOAD_BYTES)} limit for an upload.`,
        )
        return
      }
      void file.text().then(
        (text) => ingest(file.name, text),
        (err: unknown) => onError(`Could not read "${file.name}": ${String(err)}`),
      )
    },
    [ingest, onError],
  )

  const commitPaste = useCallback(() => {
    const text = pasted.trim()
    if (!text) return
    setPasting(false)
    setPasted('')
    void ingest('Pasted rows', text)
  }, [ingest, pasted])

  // The generic card renders every non-advanced param; a body replaces that area outright, so
  // it renders the same set rather than a chosen few — a control a body forgot is reachable
  // only from the inspector, which on screen is indistinguishable from one never added.
  const fields = useMemo(
    () =>
      (def?.params ?? []).filter(
        (p) => !p.advanced && (!p.visibleIf || p.visibleIf(node.params)),
      ),
    [def, node.params],
  )

  return (
    <div className="upload-body nodrag">
      <div className="upload-body__actions">
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
          {state === 'empty' ? 'Choose CSV…' : 'Replace…'}
        </button>
        <button
          type="button"
          onClick={() => setPasting((open) => !open)}
          aria-pressed={pasting}
          disabled={busy}
        >
          Paste
        </button>
        <input
          ref={inputRef}
          type="file"
          className="upload-body__file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
          aria-label="Choose a CSV file"
          onChange={onPick}
        />
      </div>

      {pasting && (
        <div className="upload-body__paste">
          <textarea
            rows={PASTE_ROWS}
            value={pasted}
            aria-label="Paste delimited rows"
            placeholder={'neuronId,cellType\n1234,LC4\n5678,LC6'}
            onChange={(e) => setPasted(e.target.value)}
          />
          <button type="button" onClick={commitPaste} disabled={!pasted.trim() || busy}>
            Use these rows
          </button>
        </div>
      )}

      <div className="upload-body__status" data-state={state}>
        {busy && 'Reading…'}
        {!busy && state === 'empty' && 'No file yet — choose one, or paste rows.'}
        {!busy && state === 'loading' && 'Looking for the stored rows…'}
        {!busy && state === 'ready' && meta && (
          <>
            <strong title={meta.name}>{meta.name}</strong>
            <span>
              {formatNumber(meta.rows)} × {meta.schema.columns.length} ·{' '}
              {formatBytes(meta.bytes)}
            </span>
          </>
        )}
        {/*
         * The one state that needs a sentence. It names the file, says where the rows went and
         * what to do — this is what a colleague opening a shared graph sees, so it has to read
         * as an instruction rather than as a fault.
         */}
        {!busy && state === 'absent' && (
          <span className="upload-body__absent">
            ⚠ “{fileName || 'This upload'}” is not stored in this browser. Uploaded rows stay on
            the machine that uploaded them — choose the file again.
          </span>
        )}
      </div>

      {state === 'ready' && (
        <div className="upload-body__fields">
          {fields.map((param) => (
            <label key={param.id} className="upload-body__field">
              <span className="param__label" title={param.help ?? param.label}>
                {param.label}
              </span>
              <ParamField
                param={param}
                value={node.params[param.id]}
                ctx={ctx}
                onChange={(value) => setParam(param.id, value)}
              />
            </label>
          ))}
        </div>
      )}

      {!compact && state === 'ready' && meta && (
        <table className="upload-body__schema">
          <thead>
            <tr>
              <th>Column</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {meta.schema.columns.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td>{c.dtype}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
