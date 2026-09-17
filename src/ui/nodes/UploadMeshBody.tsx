/**
 * The Upload Mesh card: pick mesh files, then say what units they are in.
 *
 * `UploadBody`'s sibling — same four states through `useUploadState`, same reason for being a
 * body rather than param fields (a *button* and a *state*, neither of which the generic renderer
 * can draw), same rule that `dataId` and `fileName` are written from here and never typed.
 *
 * ## The files are read here, not in the node
 *
 * `File` is DOM and `src/nodes` is headless, so this reads the bytes, parses them through
 * `data/meshFile.ts` and hands finished geometry to `putMeshUpload`; the node only ever loads
 * what is already stored. That is also where the size ceiling is enforced — against the files'
 * own sizes, before a byte is read.
 *
 * ## Several files, one mesh each
 *
 * A region set is a directory, so the picker is `multiple` and each file becomes one item named
 * after its own stem. A file holding several objects merges to one mesh, which is `parseObj`'s
 * standing rule and the right one for a shell exported in pieces; somebody who wants them apart
 * has them apart on disk already.
 *
 * Picking **replaces** rather than adds, because `dataId` is the content address of the whole
 * set: adding would mean reading the stored geometry back to re-hash it, and the gesture that
 * does the same thing without that is picking the files together.
 */

import { useCallback, useRef, useState } from 'react'

import {
  MESH_FILE_EXTENSIONS,
  meshFileProblem,
  parseMeshFile,
  stemOf,
} from '../../data/meshFile'
import { putMeshUpload } from '../../data/uploads'
import type { StoredMesh } from '../../data/uploads'
import { formatBytes, formatNumber, plural } from '../format'
import type { NodeBodyProps } from './nodeBodies'
import { UploadAbsent, UploadFields, checkUploadSize, useUploadState } from './uploadCard'

/** How the card names a pick of several. One file keeps its own name. */
function labelFor(files: readonly File[]): string {
  return files.length === 1 ? files[0]!.name : plural(files.length, 'file')
}

export function UploadMeshBody({ node, ctx, compact, setParam, onError }: NodeBodyProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const dataId = String(node.params.dataId ?? '')
  const fileName = String(node.params.fileName ?? '')
  const { meta, state } = useUploadState(dataId, 'meshes')

  /**
   * Read, store, then point the node at the result.
   *
   * The two params are written as a pair rather than a batch, which is two undo steps — accepted
   * for `Upload Table`'s reason, the alternative being a store API for "several params at once"
   * that nothing else wants. `dataId` goes last so a graph caught between the two writes names
   * the new files rather than the old geometry.
   */
  const ingest = useCallback(
    async (files: readonly File[]) => {
      setBusy(true)
      try {
        const label = labelFor(files)
        // The sum `checkUploadSize` already took off `file.size`, rather than a third accumulator
        // counting the same bytes a second time as each buffer arrives.
        const bytes = files.reduce((sum, file) => sum + file.size, 0)
        const meshes: StoredMesh[] = []
        const skipped: string[] = []
        for (const file of files) {
          const buffer = new Uint8Array(await file.arrayBuffer())
          const parsed = parseMeshFile(file.name, buffer)
          const problem = meshFileProblem(parsed, file.name)
          if (problem) {
            // Counted, not thrown: a directory of shells with one stray file in it should import
            // the shells and say what it left, which is `fetchRoiMeshSet`'s rule for a region the
            // server has no shape for.
            skipped.push(problem)
            continue
          }
          meshes.push({
            name: stemOf(file.name),
            file: file.name,
            positions: parsed.positions,
            indices: parsed.indices,
          })
        }

        if (meshes.length === 0) {
          throw new Error(skipped[0] ?? `Nothing in ${label} was a mesh Coda can read.`)
        }
        const id = await putMeshUpload(label, meshes, bytes)
        setParam('fileName', label)
        setParam('dataId', id)
        // Said once, here, rather than as a permanent badge: it is a fact about the import, not
        // about the node's configuration.
        if (skipped.length > 0) onError(skipped.join(' '))
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
      const files = [...(event.target.files ?? [])]
      // Clear it, or picking the same file twice in a row fires no change event at all.
      event.target.value = ''
      if (files.length === 0) return
      if (!checkUploadSize(files, 'Decimate the mesh, or import fewer at once.', onError))
        return
      void ingest(files)
    },
    [ingest, onError],
  )

  // A `reduce` over at most a few dozen items, on a render that only happens when the meta
  // changes. The memo this replaced also carried a vertex total nothing drew.
  const triangles = meta ? meta.items.reduce((n, item) => n + item.triangles, 0) : 0

  return (
    <div className="upload-body nodrag">
      <div className="upload-body__actions">
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
          {state === 'empty' ? 'Choose meshes…' : 'Replace…'}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="upload-body__file"
          // Extensions rather than media types: none of the three has a registered one, and a
          // browser handed a type it does not know hides every file.
          accept={MESH_FILE_EXTENSIONS.join(',')}
          aria-label="Choose mesh files"
          onChange={onPick}
        />
      </div>

      <div className="upload-body__status" data-state={state}>
        {busy && 'Reading…'}
        {!busy && state === 'empty' && 'No mesh yet — choose OBJ, STL or PLY files.'}
        {!busy && state === 'loading' && 'Looking for the stored meshes…'}
        {!busy && state === 'ready' && meta && (
          <>
            <strong title={meta.name}>{meta.name}</strong>
            <span>
              {plural(meta.items.length, 'mesh', 'meshes')} · {plural(triangles, 'triangle')} ·{' '}
              {formatBytes(meta.bytes)}
            </span>
          </>
        )}
        {!busy && state === 'absent' && <UploadAbsent fileName={fileName} kind="meshes" />}
      </div>

      {state === 'ready' && <UploadFields node={node} ctx={ctx} setParam={setParam} />}

      {/*
       * The overlay's half, exactly as the table card's schema listing is: which regions came in
       * is what somebody expands this to check, and on a 300px card it would not fit.
       */}
      {!compact && state === 'ready' && meta && (
        <table className="upload-body__schema">
          <thead>
            <tr>
              <th>Region</th>
              <th>Vertices</th>
              <th>Triangles</th>
            </tr>
          </thead>
          <tbody>
            {meta.items.map((item) => (
              <tr key={item.file}>
                <td title={item.file}>{item.name}</td>
                <td>{formatNumber(item.vertices)}</td>
                <td>{formatNumber(item.triangles)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
