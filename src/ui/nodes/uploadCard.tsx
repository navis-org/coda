/**
 * The three things the two upload cards share: their four states, their size ceiling, and their
 * param rows.
 *
 * Cohesive by *audience* rather than by technology — every export here has exactly the same two
 * consumers and is always imported with the others. `checkUploadSize` looks pure enough to live a
 * layer down, and cannot: it takes DOM `File`s and builds copy through `ui/format`, both of which
 * invariant 1 closes `src/data` and `src/nodes` to.
 *
 * Shared by `UploadBody` and `UploadMeshBody`, which are otherwise different cards — one picks a
 * CSV and asks what its columns mean, the other picks mesh files and asks what units they are in.
 * What they cannot differ on is *this*, and writing it twice is how they would: the subscription
 * is to the uploads store rather than to the graph store, the snapshot is the revision counter
 * rather than the peeked value, and the four states have to stay four.
 *
 * ## The four, and why collapsing any pair is wrong
 *
 * `empty` — nothing picked. `loading` — a reference in the graph whose meta the peek has not
 * answered for. `ready` — it is in this browser. `absent` — it is not, which is what a graph
 * opened on another machine looks like and the only one that needs a sentence. Collapsing
 * `loading` into `absent` puts "not in this browser" on every card for the first frame after
 * every reload, which is how a real message stops being read.
 *
 * ## The kind is asked for, not discovered
 *
 * Both cards store their reference in a `dataId` param, and the two ids are indistinguishable
 * strings. So a caller says which kind it can draw and a meta of the other kind reads as
 * `absent` — the state whose sentence is "pick the file again", which is the right instruction
 * for a node pointed at somebody else's upload.
 */

import { useSyncExternalStore } from 'react'

import { getNodeDef } from '../../core/registry'
import { ParamField } from '../params/ParamField'
import { cardParams } from '../params/paramGroups'
import type { NodeBodyProps } from './nodeBodies'

import type { UploadMeta } from '../../data/uploads'
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_WARN_BYTES,
  peekUploadMeta,
  subscribeUploadLearned,
  uploadMissingReason,
  uploadPeekSettled,
  uploadRevision,
} from '../../data/uploads'
import { formatBytes, plural } from '../format'

type UploadState = 'empty' | 'loading' | 'ready' | 'absent'

export function useUploadState<K extends UploadMeta['kind']>(
  dataId: string,
  kind: K,
): { meta: Extract<UploadMeta, { kind: K }> | undefined; state: UploadState } {
  /*
   * The snapshot is the **revision counter**, not the peeked value, and that is load-bearing:
   * `loading` and `absent` both peek to `undefined`, so a value snapshot never changes when the
   * read lands and the card never leaves "looking…". See `uploadRevision`.
   */
  useSyncExternalStore(subscribeUploadLearned, uploadRevision)
  const known = peekUploadMeta(dataId)
  const meta = known?.kind === kind ? (known as Extract<UploadMeta, { kind: K }>) : undefined
  const state: UploadState = !dataId
    ? 'empty'
    : meta
      ? 'ready'
      : uploadPeekSettled(dataId)
        ? 'absent'
        : 'loading'
  return { meta, state }
}

/**
 * Whether these files are small enough to read, saying so either way.
 *
 * Checked against the files' own sizes, **before a byte is read** — the same call `pivotTable`
 * makes about shape rather than about the array it is about to allocate, and the only point at
 * which the check is still cheap. Two tiers: the refusal is where the parse would run the tab out
 * of memory, and below it a large pick is announced and read, because "large for a spreadsheet"
 * and "too large for a browser" are two orders of magnitude apart.
 *
 * Summed over the selection rather than asked per file, because what the parse holds at once is
 * the whole of what was picked — one 300 MB file and six 50 MB ones cost the same.
 *
 * `remedy` is the caller's, since the way out differs: a table is filtered, a mesh is decimated.
 */
export function checkUploadSize(
  files: readonly File[],
  remedy: string,
  onError: (message: string) => void,
): boolean {
  const bytes = files.reduce((sum, file) => sum + file.size, 0)
  const one = files.length === 1
  // Both halves of the number agree in person, which sounds like fussing and is not: "3 files is
  // 60 MB. Reading it anyway" reads as one file whose name got lost.
  const what = one ? `"${files[0]!.name}" is` : `${plural(files.length, 'file')} come to`
  const them = one ? 'it' : 'them'
  if (bytes > MAX_UPLOAD_BYTES) {
    onError(
      `${what} ${formatBytes(bytes)}, past the ${formatBytes(MAX_UPLOAD_BYTES)} a browser can ` +
        `parse without running out of memory. ${remedy}`,
    )
    return false
  }
  if (bytes > UPLOAD_WARN_BYTES) {
    onError(
      `${what} ${formatBytes(bytes)} — parsing will take a moment and the tab will be ` +
        `unresponsive while it does. Reading ${them} anyway.`,
    )
  }
  return true
}

/**
 * The param rows an upload card draws once it has something to be about.
 *
 * Byte-identical in both cards before this, down to the class names — and it is the block whose
 * comment says why it must render *every* non-advanced param: a generic card renders them all and
 * a body replaces that area outright, so a control a body forgot is reachable only from the
 * inspector, which on screen is indistinguishable from one never added. That rule is worth having
 * in one place.
 *
 * No `useMemo` around `cardParams`, and not for the reason that first looked obvious: `params`
 * does *not* change identity on every render — `updateNode` spreads the node and keeps it across
 * drags, selection and edge pruning, so a memo would have hit on most renders. It is unnecessary
 * because the work is nothing: `withDefaults` is already memoised on the params object, and what
 * is left is two filters over a handful of declared params. The eight other node bodies that call
 * `cardParams` do not wrap it either.
 */
export function UploadFields({
  node,
  ctx,
  setParam,
}: Pick<NodeBodyProps, 'node' | 'ctx' | 'setParam'>) {
  return (
    <div className="upload-body__fields">
      {cardParams(getNodeDef(node.type), node.params).map((param) => (
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
  )
}

/**
 * The one state that needs a sentence, drawn the same way on both cards.
 *
 * The words are `data/uploads.ts`', where the noun and the remedy are declared once — see
 * `uploadMissingReason`. What is here is the mark and the class, because a warning triangle is a
 * drawing rather than a sentence.
 */
export function UploadAbsent({
  fileName,
  kind,
}: {
  fileName: string
  kind: UploadMeta['kind']
}) {
  return (
    <span className="upload-body__absent">⚠ {uploadMissingReason(fileName, kind, 'card')}</span>
  )
}
