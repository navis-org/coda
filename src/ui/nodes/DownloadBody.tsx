/**
 * The Download card: the node's fields, a button, and the two things only the card can know.
 *
 * A body rather than plain param rows, because two of the things worth saying here cannot be
 * said anywhere else. **Which files this would write** is decided from the *value*, so
 * `validate` — which runs at edit time with types only — cannot know it. And the auto-run
 * warning depends on a **store** setting, which a node definition must never read.
 */

import { useMemo, useState } from 'react'

import { getNodeDef } from '../../core/registry'
import { useGraphStore } from '../../store/graphStore'
import type { ExportFormat } from '../exportValue'
import { planExport } from '../exportValue'
import { downloadBaseName, runDownload, upstreamNodeId } from '../useDownloads'
import { exportSourceFor } from '../viewers/exportRegistry'
import { ParamField } from '../params/ParamField'
import type { NodeBodyProps } from './nodeBodies'

/** Past this many, the file list is counted rather than named. */
const MAX_LISTED = 3

/**
 * One shape rather than a union, with every branch supplying every field.
 *
 * A union would be tidier and does not narrow through the JSX below — `chart: true` is a
 * discriminant TS can follow, but the `truncated` reads sit inside a branch it has already
 * left. Explicit optionals cost nothing and cannot be rendered wrongly, since the JSX tests
 * `chart` and `files.length` before it reaches them.
 */
interface DownloadPreview {
  /** Names of the files a press would write, in order. */
  files: string[]
  /** Whether the button can do anything right now. */
  ready: boolean
  /** True when the format reads a rendered viewer rather than the wire. */
  chart: boolean
  truncated?: { kept: number; total: number }
}

export function DownloadBody({ node, ctx, compact, setParam, onError }: NodeBodyProps) {
  const def = getNodeDef(node.type)
  const [busy, setBusy] = useState(false)

  const value = useGraphStore((s) => {
    void s.runVersion
    return s.nodeInputs(node.id)['in']
  })
  const autoRun = useGraphStore((s) => s.autoRun)
  const graphName = useGraphStore((s) => s.graph.meta?.name)
  const sourceId = useGraphStore((s) => upstreamNodeId(s.graph, node.id))

  const format = String(node.params.format ?? 'auto') as ExportFormat
  const onRun = node.params.onRun !== false

  /**
   * What pressing the button would produce, named rather than described.
   *
   * The date is fixed at render rather than taken inside `planExport`, so the preview does not
   * disagree with itself between two renders a minute apart — and so a test can pin it.
   */
  const preview: DownloadPreview = useMemo(() => {
    const base = downloadBaseName(node, graphName, new Date())
    if (format === 'svg' || format === 'png') {
      // A picture belongs to the upstream viewer and exists only while that card is drawing,
      // so what is reported is the *availability*, not a plan.
      const ready = Boolean(exportSourceFor(sourceId)?.svg?.())
      return { files: [`${base}.${format}`], ready, chart: true }
    }
    if (!value) return { files: [], ready: false, chart: false }
    const plan = planExport(value, format, base)
    return {
      files: plan.files.map((f) => f.name),
      ready: plan.files.length > 0,
      chart: false,
      ...(plan.truncated ? { truncated: plan.truncated } : {}),
    }
  }, [node, graphName, format, value, sourceId])

  // A body replaces the generic rows outright, so it renders the same set in declaration order
  // — a control a body forgets is reachable only from the inspector, which on screen is
  // indistinguishable from one that was never added.
  const fields = (def?.params ?? []).filter(
    (p) => !p.advanced && (!p.visibleIf || p.visibleIf(node.params)),
  )

  const download = async () => {
    setBusy(true)
    try {
      const outcome = await runDownload(node, value, useGraphStore.getState().graph)
      if (outcome.error) onError(outcome.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="list-body nodrag">
      <div className="list-body__fields">
        {fields.map((param) => (
          <label key={param.id} className="list-body__field">
            <span className="param__label" title={param.help ?? param.label}>
              {param.label}
            </span>
            <ParamField
              param={param}
              value={node.params[param.id]}
              ctx={ctx}
              onChange={(v) => setParam(param.id, v)}
            />
          </label>
        ))}
      </div>

      {/*
       * The warning only the card can give. `On run` alone is bounded by the provenance key —
       * a Run over an unchanged graph re-executes nothing and writes nothing — but auto-run
       * turns every upstream edit into a full pass, and each of those does write. A node
       * definition cannot see the store, so this cannot live in `validate`.
       */}
      {onRun && autoRun && (
        <div className="list-body__foot list-body__missing">
          ⚠ Auto-run is on, so this writes a file on every upstream edit.
        </div>
      )}

      <button
        type="button"
        className="download-body__go"
        onClick={() => void download()}
        disabled={busy || !preview.ready}
        title={
          preview.ready
            ? `Write ${preview.files.join(', ')}`
            : 'Nothing to write yet — run the graph, or connect something'
        }
      >
        {busy ? 'Writing…' : 'Download now'}
      </button>

      <div className="list-body__foot">
        {preview.chart && !preview.ready ? (
          /*
           * The one failure worth spelling out, because it depends on the *canvas* rather than
           * on the graph and so has no other way of being discovered.
           */
          <span className="list-body__missing">
            ⚠ No chart drawn upstream — SVG and PNG read a rendered viewer.
          </span>
        ) : preview.files.length === 0 ? (
          <span className="list-body__foot--empty">
            {value ? `${format.toUpperCase()} does not apply to this value` : 'Not run yet.'}
          </span>
        ) : (
          <>
            <span title={preview.files.join(', ')}>
              {compact && preview.files.length > MAX_LISTED
                ? `${preview.files.length} files`
                : preview.files.join(', ')}
            </span>
            {preview.truncated && (
              <span
                className="list-body__missing"
                title="A browser stops honouring downloads past about this many"
              >
                ⚠ first {preview.truncated.kept} of {preview.truncated.total}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
