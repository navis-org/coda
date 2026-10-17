/**
 * The Load Recording card: pick a recording, then say which part of it to keep.
 *
 * Upload Table's card, for a binary file: the four states are `useUploadState`'s, and the file is
 * read here because `File` is DOM and `src/packs` is headless. Its header is read too, before it is
 * stored — a file no reader recognises is refused on the card, naming what this build reads, rather
 * than stored and refused on every run — and the summary that comes back is what is stored beside
 * the bytes, for the card's readout and the node's controls.
 */

import { useCallback, useRef, useState } from 'react'

import {
  RECORDING_EXTENSIONS,
  readRecording,
  rememberRecording,
} from '../../data/ephys/recording'
import type { RecordingSummary } from '../../data/ephys/recording'
import { putRecordingUpload } from '../../data/uploads'
import { recordingColumns } from '../../packs/biophys/recordingOps'
import { formatBytes, formatNumber, plural } from '../../style/format'
import type { NodeBodyProps } from '../nodes/nodeBodies'
import {
  UploadAbsent,
  UploadFields,
  checkUploadSize,
  useUploadState,
} from '../nodes/uploadCard'

/** "12 sweeps × 3.2 s at 10 kHz": a recording's shape in one line. */
function recordingShape(summary: RecordingSummary): string {
  const seconds = summary.sweepSamples / summary.rate
  const rate =
    summary.rate >= 1000
      ? `${formatNumber(summary.rate / 1000)} kHz`
      : `${formatNumber(summary.rate)} Hz`
  const sweeps = summary.mode === 'gap-free' ? 'gap-free' : plural(summary.sweeps, 'sweep')
  return `${sweeps} × ${formatNumber(seconds)} s at ${rate}`
}

export function RecordingBody({ node, ctx, compact, setParam, onError }: NodeBodyProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const dataId = String(node.params.dataId ?? '')
  const fileName = String(node.params.fileName ?? '')
  const { meta, state } = useUploadState(dataId, 'recording')

  const onPick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      // Cleared, or picking the same file twice in a row fires no change event.
      event.target.value = ''
      if (!file) return
      if (!checkUploadSize([file], 'Split the recording, or save fewer sweeps.', onError))
        return
      setBusy(true)
      void file
        .arrayBuffer()
        .then(async (bytes) => {
          const recording = readRecording(bytes, file.name)
          const id = await putRecordingUpload(file.name, bytes, recording.summary)
          // What was just parsed serves the node's first run, which would otherwise read it back.
          rememberRecording(id, recording, bytes.byteLength)
          setParam('fileName', file.name)
          setParam('dataId', id)
        })
        .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false))
    },
    [onError, setParam],
  )

  return (
    <div className="upload-body nodrag">
      <div className="upload-body__actions">
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
          {state === 'empty' ? 'Choose recording…' : 'Replace…'}
        </button>
        <input
          ref={inputRef}
          type="file"
          className="upload-body__file"
          accept={RECORDING_EXTENSIONS}
          aria-label="Choose a recording"
          onChange={onPick}
        />
      </div>

      <div className="upload-body__status" data-state={state}>
        {busy && 'Reading…'}
        {!busy && state === 'empty' && 'No recording yet: choose an ABF file.'}
        {!busy && state === 'loading' && 'Looking for the stored recording…'}
        {!busy && state === 'ready' && meta && (
          <>
            <strong title={meta.name}>{meta.name}</strong>
            <span>
              {recordingShape(meta.summary)} · {formatBytes(meta.bytes)}
            </span>
          </>
        )}
        {!busy && state === 'absent' && <UploadAbsent fileName={fileName} kind="recording" />}
      </div>

      {state === 'ready' && <UploadFields node={node} ctx={ctx} setParam={setParam} />}

      {!compact && state === 'ready' && meta && <RecordingListing summary={meta.summary} />}
    </div>
  )
}

/** The full-size card's account of the file: format, protocol, and every column it can give. */
function RecordingListing({ summary }: { summary: RecordingSummary }) {
  return (
    <div className="recording-listing">
      <p>
        {summary.format}
        {summary.protocol && <> · protocol {summary.protocol}</>}
        {summary.startedAt && (
          <> · recorded {summary.startedAt.replace('T', ' ').slice(0, 16)}</>
        )}
      </p>
      <ul>
        {recordingColumns(summary).map((c) => (
          <li key={c.name}>
            <code>{c.name}</code> {c.unit && <span>{c.unit}</span>}{' '}
            <span className="recording-listing__source">
              {c.source === 'channel' ? 'recorded' : 'command, rebuilt from the protocol'}
            </span>
          </li>
        ))}
      </ul>
      {summary.notes.map((note) => (
        <p key={note} className="recording-listing__note">
          {note}
        </p>
      ))}
    </div>
  )
}
