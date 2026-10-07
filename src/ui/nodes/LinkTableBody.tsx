/**
 * The Link Table card: pick a file or name a URL, then see what is in it.
 *
 * A body for Upload Table's reason — a button and a state, neither of which the generic renderer
 * can draw — and built from its parts (`UploadFields`, `SchemaListing`, the `upload-body` classes),
 * since the two cards are the same gesture over different storage. What differs is where the file
 * goes: nowhere. The picked `File` (and, in Chromium, the handle it came through) is handed to
 * `data/files/registry.ts` and only its id and name are written into the node; the bytes stay on
 * disk and are read a block at a time.
 *
 * ## Five states
 *
 *  - **empty** — nothing chosen.
 *  - **missing** — a local file this browser does not have (a graph somebody sent, or a browser
 *    that cannot remember files across a reload), named so it can be chosen again — or one it
 *    remembers but may not read until asked, which is a button: only a click can grant it.
 *  - **reading** — a file or URL whose footer has not been read yet (the peek starts a URL's), or
 *    a remembered file still being looked for.
 *  - **failed** — the footer could not be read: the file named here, and the reason (not Parquet
 *    or Feather, a codec, a server refusing range requests) on the card's warning line.
 *  - **ready** — the format, the size, and the columns.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from 'react'

import { errorMessage } from '../../core/errors'
import { describeTableFile, tableFileName } from '../../core/values'
import {
  TABLE_FILE_EXTENSIONS,
  grantLocalFile,
  holdLocalFile,
  localFileState,
  readTableFileSummary,
} from '../../data/files/registry'
import { hasFileHandles } from '../../data/files/remembered'
import { subscribeUploadLearned, uploadRevision } from '../../data/uploads'
import { useGraphStore } from '../../store/graphStore'
import { peekEntry, tableFileSchema } from '../../nodes/table/linkTable'
import { formatBytes } from '../../style/format'
import { CacheAge, RefreshButton } from './CacheAge'
import type { NodeBodyProps, NodeFooterProps } from './nodeBodies'
import { SchemaListing, UploadFields, localSourceLine } from './uploadCard'

const ACCEPT = TABLE_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(',')

export function LinkTableBody({ node, ctx, compact, setParam, onError }: NodeBodyProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  // The registry announces a landed footer on the upload channel; its revision is the snapshot.
  useSyncExternalStore(subscribeUploadLearned, uploadRevision)

  const { ref, entry } = peekEntry(ctx.params)
  const summary = entry?.summary

  /** Hold a chosen file (and the handle it came through), read its footer, then point at it. */
  const open = useCallback(
    (file: File, handle?: FileSystemFileHandle) => {
      const id = holdLocalFile(file, handle)
      setBusy(true)
      // Read before the node is pointed at it, so a CSV is refused on the spot
      // rather than turning the card red a moment later. The node's `evaluate` reuses this read.
      void readTableFileSummary(
        { kind: 'local', id, name: file.name },
        { refresh: Number(ctx.params.refresh) },
      )
        .then(() => {
          setParam('fileName', file.name)
          setParam('fileId', id)
        })
        .catch((err: unknown) => onError(errorMessage(err)))
        .finally(() => setBusy(false))
    },
    [ctx.params.refresh, onError, setParam],
  )

  const onPick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      // Cleared, or choosing the same file again fires no change event.
      event.target.value = ''
      if (file) open(file)
    },
    [open],
  )

  /**
   * Chromium's own picker where there is one, because it hands back a *handle* the registry can
   * remember across a reload; the plain file input everywhere else, which hands back only a file.
   */
  const choose = useCallback(async () => {
    if (!hasFileHandles()) return inputRef.current?.click()
    try {
      const [handle] = await window.showOpenFilePicker!({
        types: [
          {
            description: 'Parquet or Feather',
            accept: { 'application/octet-stream': ACCEPT.split(',') },
          },
        ],
      })
      if (handle) open(await handle.getFile(), handle)
    } catch (err) {
      // Closing the picker is not an error.
      if (!(err instanceof DOMException && err.name === 'AbortError'))
        onError(errorMessage(err))
    }
  }, [onError, open])

  /** Ask the browser for a remembered file back — a click being the only thing that may. */
  const allow = async (id: string, name: string) => {
    try {
      if (!(await grantLocalFile(id))) return onError(`Reading "${name}" was not allowed.`)
      // Inference hears of the file on its own; the card's red run state does not, until it runs.
      void useGraphStore.getState().runNode(node.id)
    } catch (err) {
      onError(errorMessage(err))
    }
  }

  const forget = useCallback(() => {
    setParam('fileId', '')
    setParam('fileName', '')
  }, [setParam])

  /** The card's state and its line, decided once, so each branch has what it needs in hand. */
  const status = ((): { state: string; line: React.ReactNode } => {
    if (busy) return { state: 'reading', line: 'Reading the footer…' }
    if (!ref) return { state: 'empty', line: 'No file yet — choose one, or paste a URL.' }
    // A local file's own states first: a wait, a button (only a click may grant a read), or the
    // sentence naming the file to choose again.
    if (ref.kind === 'local') {
      const local = localSourceLine(
        localFileState(ref.id),
        ref.name,
        () => void allow(ref.id, ref.name),
      )
      if (local) return local
    }
    // The name alone, as for an absent file: `validate` puts the error on the card's warning
    // line, which wraps, and a second copy here ran off the card.
    if (entry?.error) {
      return {
        state: 'failed',
        line: <span className="upload-body__absent">{tableFileName(ref)}</span>,
      }
    }
    if (!summary) return { state: 'reading', line: 'Reading the footer…' }
    const where = tableFileName(ref)
    return {
      state: 'ready',
      line: (
        <>
          <strong title={where}>{where}</strong>
          <span>
            {describeTableFile(summary)} · {formatBytes(summary.bytes)}
          </span>
        </>
      ),
    }
  })()

  return (
    <div className="upload-body nodrag">
      <div className="upload-body__actions">
        <button type="button" onClick={() => void choose()} disabled={busy}>
          {ref?.kind === 'local' ? 'Replace…' : 'Choose file…'}
        </button>
        {ref?.kind === 'local' && (
          <button type="button" onClick={forget} disabled={busy}>
            Use URL
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          className="upload-body__file"
          accept={ACCEPT}
          aria-label="Choose a Parquet or Feather file"
          onChange={onPick}
        />
      </div>

      <div className="upload-body__status" data-state={status.state}>
        {status.line}
      </div>

      {ref?.kind !== 'local' && <UploadFields node={node} ctx={ctx} setParam={setParam} />}

      {!compact && summary && (
        <SchemaListing schema={tableFileSchema(summary, ctx.params, ctx.columns)} />
      )}
    </div>
  )
}

/**
 * The card's foot for a Link Table: how long ago the file's footer was read, and the control that
 * reads it again — `CacheAge`, the clause a dataset card's cache speaks, and here the one way to a
 * new `refresh` nonce. A file rewritten since its footer was read is refused by every reader until
 * this is pressed, and the refusal says to press it. A read that failed has no age, so the same
 * control offers to read again.
 */
export function LinkTableFooter({ ctx, setParam }: NodeFooterProps) {
  useSyncExternalStore(subscribeUploadLearned, uploadRevision)
  const { ref, entry } = peekEntry(ctx.params)
  if (!ref) return null
  const again = () => setParam('refresh', Number(ctx.params.refresh) + 1)
  if (entry?.summary) {
    return (
      <CacheAge
        fetchedAt={entry.readAt}
        onRefresh={again}
        title="The file’s footer: its columns and blocks"
      />
    )
  }
  if (!entry?.error) return null
  return (
    <RefreshButton title="Read the file’s footer again" onRefresh={again}>
      read again
    </RefreshButton>
  )
}
