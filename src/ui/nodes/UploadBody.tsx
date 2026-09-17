/**
 * The Upload Table card: pick a file or paste rows, then say what the columns mean.
 *
 * A body rather than param fields, because the two things that matter here are a *button* and
 * a *state*, and neither is a value the generic renderer can draw. `dataId` and `fileName` are
 * written from here and never typed.
 *
 * ## Four states, and telling them apart is the point
 *
 * `useUploadState`'s, shared with the Upload Mesh card, which is where the four are described
 * and why none of them may be folded into another.
 *
 * ## The file is read here, not in the node
 *
 * `FileReader` and `File` are DOM, and `src/nodes` is headless. So this reads the text, parses
 * it through `data/csv.ts`, and hands the finished table to `putUpload`; the node only ever
 * loads what is already stored. That is also why the size ceiling is enforced here — it is
 * checked against `file.size` *before* a byte is read, which is the only place that check is
 * still cheap.
 */

import { useCallback, useRef, useState } from 'react'

import { parseDelimited } from '../../data/csv'
import { putUpload } from '../../data/uploads'
import { formatBytes, formatNumber } from '../format'
import type { NodeBodyProps } from './nodeBodies'
import { UploadAbsent, UploadFields, checkUploadSize, useUploadState } from './uploadCard'

/** Big enough that a header and a few rows are legible; small enough not to own the card. */
const PASTE_ROWS = 4

export function UploadBody({ node, ctx, compact, setParam, onError }: NodeBodyProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)

  const dataId = String(node.params.dataId ?? '')
  const fileName = String(node.params.fileName ?? '')

  const { meta, state } = useUploadState(dataId, 'table')

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
      if (!checkUploadSize([file], 'Split it, or filter it before uploading.', onError)) return
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
        {!busy && state === 'absent' && <UploadAbsent fileName={fileName} kind="table" />}
      </div>

      {state === 'ready' && <UploadFields node={node} ctx={ctx} setParam={setParam} />}

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
