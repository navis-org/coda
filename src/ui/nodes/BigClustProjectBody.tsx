/**
 * The BigClust Project card: choose a project folder or name its address, then see what is in it.
 *
 * Link Table's card for a folder rather than a file, built from the same parts (`UploadFields`, the
 * `upload-body` classes) and with the same five states — empty, missing, reading, failed, ready —
 * for the same reasons (`LinkTableBody.tsx` has them). What differs is the picker: Chromium's
 * directory picker where there is one, whose handle `data/bigclust/folders.ts` remembers across a
 * reload at the cost of one click; a `webkitdirectory` input everywhere else, which hands over the
 * folder's files for this tab only.
 *
 * Ready, the card says what the project holds — its neurons, each embedding, and which of them
 * bring a k-NN graph or feature vectors — read off `info` and meta's footer, so it is all on the
 * card before anybody presses Run.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from 'react'

import { errorMessage } from '../../core/errors'
import {
  folderState,
  grantFolder,
  holdFolderFiles,
  holdFolderHandle,
  remembersFolders,
} from '../../data/bigclust/folders'
import { readProjectSummary } from '../../data/bigclust/project'
import { subscribeUploadLearned, uploadRevision } from '../../data/uploads'
import { chosenEmbedding, peekNodeProject } from '../../packs/annotation/bigclust'
import { useGraphStore } from '../../store/graphStore'
import { formatNumber } from '../../style/format'
import { RefreshButton } from './CacheAge'
import type { NodeBodyProps, NodeFooterProps } from './nodeBodies'
import { UploadFields, localSourceLine } from './uploadCard'

/** A folder input's one non-standard attribute, which React passes through as written. */
const FOLDER_INPUT = { webkitdirectory: '' } as Record<string, string>

export function BigClustProjectBody({ node, ctx, compact, setParam, onError }: NodeBodyProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  // The project's peek and a remembered folder's restore both announce on the upload channel.
  useSyncExternalStore(subscribeUploadLearned, uploadRevision)

  const { ref, entry } = peekNodeProject(ctx.params)
  const summary = entry?.summary
  const picked = summary && chosenEmbedding(summary.info, ctx.params)

  /**
   * Read the chosen folder before pointing the node at it, so a wrong folder is refused here — and
   * under a new `refresh` nonce: a folder's id is its name and its `info`, so a project whose other
   * files were rewritten comes back under the same id, and choosing it again is choosing to read it
   * again.
   */
  const open = useCallback(
    (id: string, name: string) => {
      const refresh = Number(ctx.params.refresh) + 1
      setBusy(true)
      void readProjectSummary({ kind: 'local', id, name }, { refresh })
        .then(() => {
          setParam('refresh', refresh)
          setParam('folderName', name)
          setParam('folderId', id)
        })
        .catch((err: unknown) => onError(errorMessage(err)))
        .finally(() => setBusy(false))
    },
    [ctx.params.refresh, onError, setParam],
  )

  const onPick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const held = holdFolderFiles(event.target.files ?? [])
      // Cleared, or choosing the same folder again fires no change event.
      event.target.value = ''
      if (!held)
        return onError('That folder has no info file, so it is not a BigClust project.')
      open(held.id, held.name)
    },
    [onError, open],
  )

  const choose = useCallback(async () => {
    if (!remembersFolders()) return inputRef.current?.click()
    try {
      const handle = await window.showDirectoryPicker!({ mode: 'read' })
      open(await holdFolderHandle(handle), handle.name)
    } catch (err) {
      // Closing the picker is not an error.
      if (err instanceof DOMException && err.name === 'AbortError') return
      onError(
        err instanceof DOMException && err.name === 'NotFoundError'
          ? 'That folder has no info file, so it is not a BigClust project.'
          : errorMessage(err),
      )
    }
  }, [onError, open])

  /** Ask the browser for a remembered folder back — a click being the only thing that may. */
  const allow = async (id: string, name: string) => {
    try {
      if (!(await grantFolder(id)))
        return onError(`Reading the folder "${name}" was not allowed.`)
      void useGraphStore.getState().runNode(node.id)
    } catch (err) {
      onError(errorMessage(err))
    }
  }

  const forget = useCallback(() => {
    setParam('folderId', '')
    setParam('folderName', '')
  }, [setParam])

  const status = ((): { state: string; line: React.ReactNode } => {
    if (busy) return { state: 'reading', line: 'Reading the project…' }
    if (!ref)
      return {
        state: 'empty',
        line: 'No project yet — choose its folder, or paste its address.',
      }
    if (ref.kind === 'local') {
      const local = localSourceLine(
        folderState(ref.id),
        ref.name,
        () => void allow(ref.id, ref.name),
      )
      if (local) return local
    }
    const where = ref.kind === 'local' ? ref.name : ref.base
    // The address alone: `validate` puts the reason on the card's warning line.
    if (entry?.error) {
      return { state: 'failed', line: <span className="upload-body__absent">{where}</span> }
    }
    if (!summary) return { state: 'reading', line: 'Reading the project…' }
    const { info, meta } = summary
    return {
      state: 'ready',
      line: (
        <>
          <strong title={info.description ?? where}>{info.name ?? where}</strong>
          <span>
            {meta.rows === undefined ? '' : `${formatNumber(meta.rows)} neurons · `}
            {info.embeddings.length === 1
              ? '1 embedding'
              : `${info.embeddings.length} embeddings`}
          </span>
        </>
      ),
    }
  })()

  return (
    <div className="upload-body nodrag">
      <div className="upload-body__actions">
        <button type="button" onClick={() => void choose()} disabled={busy}>
          {ref?.kind === 'local' ? 'Replace…' : 'Choose folder…'}
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
          aria-label="Choose a BigClust project folder"
          onChange={onPick}
          {...FOLDER_INPUT}
        />
      </div>

      <div className="upload-body__status" data-state={status.state}>
        {status.line}
      </div>

      {/* The URL hides itself while a folder is chosen (its `visibleIf`); the embedding stays. */}
      <UploadFields node={node} ctx={ctx} setParam={setParam} />

      {!compact && summary && picked !== undefined && (
        <table className="upload-body__schema">
          <thead>
            <tr>
              <th>Embedding</th>
              <th>Brings</th>
            </tr>
          </thead>
          <tbody>
            {summary.info.embeddings.map((e, i) => (
              // The one being read, marked: the outputs are its, whatever the others bring.
              <tr key={i} aria-current={e === picked ? 'true' : undefined}>
                <td title={e.file ?? e.columns?.join(', ')}>
                  {e === picked ? <strong>{e.name}</strong> : e.name}
                </td>
                <td>
                  {[
                    e.distances?.knn && 'k-NN',
                    e.distances && !e.distances.knn && 'distances',
                    e.features && 'features',
                  ]
                    .filter(Boolean)
                    .join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Read the project again — its info and every footer — which is the `refresh` nonce. */
export function BigClustProjectFooter({ ctx, setParam }: NodeFooterProps) {
  useSyncExternalStore(subscribeUploadLearned, uploadRevision)
  const { ref, entry } = peekNodeProject(ctx.params)
  if (!ref || !entry) return null
  return (
    <RefreshButton
      title="Read the project again"
      onRefresh={() => setParam('refresh', Number(ctx.params.refresh) + 1)}
    >
      read again
    </RefreshButton>
  )
}
