/**
 * Edge data: the shelf of imported edge sets, and attaching one to a dataset.
 *
 * A modal rather than a card control, and mounted at the top level rather than inside the node
 * body, because a dataset card lives inside React Flow's transformed pane — where a
 * `position: fixed` descendant takes the *transform* as its containing block and lands nowhere
 * near the viewport. The chart tooltips document the same trap from the other side.
 *
 * The shape follows `SourcesPanel`: it is the same kind of object, a dialog about something
 * outside the document, so it reuses that stylesheet outright rather than growing a second set
 * of near-identical rules for a header, a note and a field row.
 *
 * **The catalogue is the reason this is a panel at all.** An edge set is a hundred megabytes; a
 * feature that could import one but never list, rename or delete it would repeat `uploads.ts`'
 * own recorded limit — *nothing collects orphans* — at a thousand times the size.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from 'react'

import { errorMessage } from '../../core/errors'
import {
  deleteEdgeSet,
  edgeSetsRevision,
  peekEdgeSets,
  renameEdgeSet,
  saveEdgeSet,
  subscribeEdgeSetsLearned,
} from '../../data/edges/store'
import type { EdgeSetMeta } from '../../data/edges/store'
import type { EdgeSourcePreview } from '../../data/edges/importer'
import { importEdges, previewEdgeSource } from '../../data/edges/importer'
import type { EdgeColumnChoice } from '../../data/edges/read'
import { useGraphStore } from '../../store/graphStore'
import { useDismissOnOutside } from '../useDismiss'
import { formatBytes, formatNumber } from '../format'

/** What the panel is doing. Anything but `idle` owns the lower half of the dialog. */
type Stage =
  | { at: 'idle' }
  | { at: 'reading' }
  | { at: 'mapping'; preview: EdgeSourcePreview; source: Source; name: string }
  | { at: 'importing'; fraction: number; note?: string }

interface Source {
  file?: File
  url?: string
  label: string
}

export function EdgeSetPanel() {
  const nodeId = useGraphStore((s) => s.edgePanelNode)
  return nodeId ? <Dialog nodeId={nodeId} /> : null
}

/** The catalogue, re-read whenever anything changes it. */
function useEdgeSets(): EdgeSetMeta[] | undefined {
  const revision = useSyncExternalStore(subscribeEdgeSetsLearned, edgeSetsRevision, () => 0)
  // The revision is the snapshot — a primitive, so the subscription is stable by identity
  // (invariant 7). The value itself is read fresh, because both "not looked yet" and "nothing
  // here" peek to undefined and a snapshot of the value could not tell them apart.
  void revision
  return peekEdgeSets()
}

function Dialog({ nodeId }: { nodeId: string }) {
  const close = useGraphStore((s) => s.closeEdgePanel)
  const attach = useGraphStore((s) => s.attachEdgeSet)
  const attachedId = useGraphStore((s) => {
    const node = s.graph.nodes.find((n) => n.id === nodeId)
    return String(node?.params?.edgeSetId ?? '')
  })
  const title = useGraphStore((s) => {
    const node = s.graph.nodes.find((n) => n.id === nodeId)
    return node?.title ?? node?.type.replace(/^dataset\./, '') ?? 'this dataset'
  })

  const sets = useEdgeSets()
  const [stage, setStage] = useState<Stage>({ at: 'idle' })
  const [error, setError] = useState<string | undefined>()
  const abort = useRef<AbortController | undefined>(undefined)

  /*
   * Escape *and* a click outside, through one handler — an import in flight is cancelled with
   * either rather than left running against a dialog nobody can see.
   *
   * The backdrop had its own `onPointerDown={close}`, which bypassed the abort: the worker went
   * on to finish, write a hundred megabytes and attach the result to a dialog that was no longer
   * open, while Escape and Cancel stopped it. One handler is the fix rather than passing the
   * same callback to two places, because two places can drift apart again.
   */
  const panel = useRef<HTMLDivElement>(null)
  const dismiss = useCallback(() => {
    abort.current?.abort()
    close()
  }, [close])
  useDismissOnOutside(panel, dismiss, { onEscape: true })

  const preview = useCallback(async (source: Source) => {
    setError(undefined)
    setStage({ at: 'reading' })
    try {
      const read = await previewEdgeSource(source)
      setStage({ at: 'mapping', preview: read, source, name: defaultName(source.label) })
    } catch (err) {
      setError(errorMessage(err))
      setStage({ at: 'idle' })
    }
  }, [])

  const run = useCallback(
    async (
      source: Source,
      columns: EdgeColumnChoice,
      preview: EdgeSourcePreview,
      name: string,
    ) => {
      const controller = new AbortController()
      abort.current = controller
      setError(undefined)
      setStage({ at: 'importing', fraction: 0 })
      try {
        const encoded = await importEdges({
          ...(source.file ? { file: source.file } : {}),
          ...(source.url ? { url: source.url } : {}),
          format: preview.format,
          columns,
          ...(preview.format === 'delimited'
            ? {
                text: {
                  delimiter: preview.delimiter ?? ',',
                  hasHeader: preview.hasHeader ?? true,
                },
              }
            : {}),
          onProgress: (fraction, note) =>
            setStage({ at: 'importing', fraction, ...(note ? { note } : {}) }),
          signal: controller.signal,
        })
        const meta = await saveEdgeSet(encoded, { name, origin: source.label })
        // Attached on import, because importing one and then having to pick it is a second act
        // for a decision already made.
        attach(nodeId, { id: meta.id, name: meta.name })
        setStage({ at: 'idle' })
      } catch (err) {
        // A cancel is not a failure, so it clears the stage and says nothing.
        if (!(err instanceof Error && err.name === 'AbortError')) setError(errorMessage(err))
        setStage({ at: 'idle' })
      } finally {
        abort.current = undefined
      }
    },
    [attach, nodeId],
  )

  return (
    <div className="overlay" role="presentation">
      <div
        ref={panel}
        className="overlay__panel sources edges"
        role="dialog"
        aria-modal="true"
        aria-label="Edge data"
      >
        <header className="sources__header">
          <h2>Edge data</h2>
          <button type="button" className="btn btn--ghost" onClick={close} aria-label="Close">
            ✕
          </button>
        </header>

        <p className="sources__privacy">
          An edge set replaces every connectivity answer for {title} — Connectivity, Adjacency,
          Paths and Neuron Profile all read it. It is kept in this browser and never travels in
          a saved graph; what travels is its name and a content id, so the same file opened
          elsewhere matches.
        </p>

        {error && (
          <p className="sources__result" data-tone="error">
            {error}
          </p>
        )}

        <Shelf sets={sets} attachedId={attachedId} onAttach={(set) => attach(nodeId, set)} />

        <Importer
          stage={stage}
          onPreview={preview}
          onImport={run}
          onCancel={() => abort.current?.abort()}
          onStage={setStage}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

function Shelf({
  sets,
  attachedId,
  onAttach,
}: {
  sets: EdgeSetMeta[] | undefined
  attachedId: string
  onAttach: (set: { id: string; name: string } | undefined) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>()
  // Inline, never `window.prompt`. jsdom does not implement it, and — the reason that matters —
  // browser chrome thrown in front of a page explaining the app reads as an error. The same call
  // the workflow library's replace-confirm makes.
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | undefined>()

  const commitRename = async () => {
    const pending = renaming
    setRenaming(undefined)
    const name = pending?.draft.trim()
    if (!pending || !name) return
    const renamed = await renameEdgeSet(pending.id, name)
    // The node stores the name too, for the message it shows when the set is *not* here — so a
    // rename has to reach it, or a graph would go on naming a set by a name nothing uses.
    if (attachedId === pending.id) onAttach({ id: renamed.id, name: renamed.name })
  }

  return (
    <section className="sources__source">
      <h3 className="edges__heading">Attached</h3>
      <ul className="edges__list">
        <li className="edges__row">
          <label className="edges__pick">
            <input
              type="radio"
              name="edge-set"
              checked={attachedId === ''}
              onChange={() => onAttach(undefined)}
            />
            <span className="edges__name">None — use this dataset’s own connectivity</span>
          </label>
        </li>
        {sets === undefined && <li className="sources__note">Looking…</li>}
        {sets?.map((set) => (
          <li key={set.id} className="edges__row">
            <label className="edges__pick">
              <input
                type="radio"
                name="edge-set"
                checked={attachedId === set.id}
                onChange={() => onAttach({ id: set.id, name: set.name })}
              />
              {renaming?.id === set.id ? (
                <input
                  className="edges__rename"
                  autoFocus
                  aria-label={`Name for ${set.name}`}
                  value={renaming.draft}
                  onChange={(event) => setRenaming({ id: set.id, draft: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRenaming(undefined)
                    if (event.key === 'Enter') void commitRename()
                  }}
                  onBlur={() => void commitRename()}
                />
              ) : (
                <span className="edges__name">{set.name}</span>
              )}
            </label>
            <span className="edges__facts">{describe(set)}</span>
            <span className="edges__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setRenaming({ id: set.id, draft: set.name })}
              >
                Rename
              </button>
              {confirmDelete === set.id ? (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={async () => {
                    await deleteEdgeSet(set.id)
                    setConfirmDelete(undefined)
                    if (attachedId === set.id) onAttach(undefined)
                  }}
                >
                  Really delete?
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setConfirmDelete(set.id)}
                >
                  Delete
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {sets?.length === 0 && (
        <p className="sources__note sources__note--tight">
          Nothing imported yet. An edge list is a table of two neuron ids and a weight — CSV,
          TSV, Parquet or Feather.
        </p>
      )}
    </section>
  )
}

/** What a stored set says about itself, in the order somebody scans for. */
function describe(set: EdgeSetMeta): string {
  const parts = [
    `${formatNumber(set.edges)} edges`,
    `${formatNumber(set.neurons)} neurons`,
    formatBytes(set.bytes),
  ]
  // Both counted at import and both mean the file was not quite what somebody thought.
  if (set.report.merged > 0) parts.push(`${formatNumber(set.report.merged)} merged`)
  if (set.report.nonNumericIds > 0) {
    parts.push(`${formatNumber(set.report.nonNumericIds)} ids are not numbers`)
  }
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

function Importer({
  stage,
  onPreview,
  onImport,
  onCancel,
  onStage,
}: {
  stage: Stage
  onPreview: (source: Source) => void
  onImport: (
    source: Source,
    columns: EdgeColumnChoice,
    preview: EdgeSourcePreview,
    name: string,
  ) => void
  onCancel: () => void
  onStage: (stage: Stage) => void
}) {
  const [url, setUrl] = useState('')

  if (stage.at === 'importing') {
    return (
      <section className="sources__source">
        <h3 className="edges__heading">Importing</h3>
        <progress className="edges__progress" value={stage.fraction} max={1} />
        <p className="sources__note sources__note--tight">{stage.note ?? 'Reading…'}</p>
        <div className="sources__actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    )
  }

  if (stage.at === 'mapping') {
    return (
      <Mapping
        preview={stage.preview}
        name={stage.name}
        onName={(name) => onStage({ ...stage, name })}
        onBack={() => onStage({ at: 'idle' })}
        onImport={(columns) => onImport(stage.source, columns, stage.preview, stage.name)}
      />
    )
  }

  return (
    <section className="sources__source">
      <h3 className="edges__heading">Import an edge list</h3>
      <div className="sources__actions">
        <label className="btn">
          Choose a file…
          <input
            type="file"
            className="edges__file"
            accept=".csv,.tsv,.txt,.parquet,.feather,.arrow"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onPreview({ file, label: file.name })
            }}
          />
        </label>
      </div>
      <label className="sources__field">
        <span>or a URL</span>
        <input
          type="url"
          value={url}
          placeholder="https://…/edges.parquet"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <div className="sources__actions">
        <button
          type="button"
          className="btn"
          disabled={!url.trim() || stage.at === 'reading'}
          onClick={() => onPreview({ url: url.trim(), label: url.trim() })}
        >
          {stage.at === 'reading' ? 'Reading…' : 'Read'}
        </button>
      </div>
    </section>
  )
}

function Mapping({
  preview,
  name,
  onName,
  onBack,
  onImport,
}: {
  preview: EdgeSourcePreview
  name: string
  onName: (name: string) => void
  onBack: () => void
  onImport: (columns: EdgeColumnChoice) => void
}) {
  const [pre, setPre] = useState(preview.suggestion?.pre ?? 0)
  const [post, setPost] = useState(preview.suggestion?.post ?? 1)
  const [weight, setWeight] = useState<number | undefined>(preview.suggestion?.weight)

  const options = preview.columns.map((column, at) => (
    <option key={at} value={at}>
      {column}
      {preview.types?.[at] ? ` (${preview.types[at]})` : ''}
    </option>
  ))
  const same = pre === post

  return (
    <section className="sources__source">
      <h3 className="edges__heading">Which column is which</h3>
      <p className="sources__note sources__note--tight">
        {preview.format}
        {preview.rowCount !== undefined ? ` · ${formatNumber(preview.rowCount)} rows` : ''}
        {` · ${preview.columns.length} columns`}
      </p>

      <label className="sources__field">
        <span>Presynaptic</span>
        <select value={pre} onChange={(e) => setPre(Number(e.target.value))}>
          {options}
        </select>
      </label>
      <label className="sources__field">
        <span>Postsynaptic</span>
        <select value={post} onChange={(e) => setPost(Number(e.target.value))}>
          {options}
        </select>
      </label>
      <label className="sources__field">
        <span>Weight</span>
        <select
          value={weight ?? ''}
          onChange={(e) =>
            setWeight(e.target.value === '' ? undefined : Number(e.target.value))
          }
        >
          {/* An unweighted edge list is an ordinary shape, so "none" is an answer rather than a
              missing selection — every edge then weighs 1. */}
          <option value="">none — every edge weighs 1</option>
          {options}
        </select>
      </label>

      {preview.rows.length > 0 && (
        <table className="edges__sample">
          <tbody>
            {preview.rows.slice(0, 5).map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} data-role={j === pre ? 'pre' : j === post ? 'post' : undefined}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <label className="sources__field">
        <span>Name</span>
        <input type="text" value={name} onChange={(e) => onName(e.target.value)} />
      </label>

      {same && (
        <p className="sources__result" data-tone="error">
          The two ends are the same column, so every edge would be a self-connection.
        </p>
      )}

      <div className="sources__actions">
        <button type="button" className="btn btn--ghost" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={same || !name.trim()}
          onClick={() => onImport({ pre, post, ...(weight === undefined ? {} : { weight }) })}
        >
          Import
        </button>
      </div>
    </section>
  )
}

/** A first name for a set, from whatever it was read out of. */
function defaultName(label: string): string {
  return label.replace(/^.*[/\\]/, '').replace(/\.[a-z0-9]+$/i, '') || 'edge set'
}
