/**
 * Right-hand panel for the selected node: every param including advanced ones, the
 * resolved types on each port, any validation issues, and a full-size view of the result.
 *
 * The node body shows the common params; this is where the long tail lives, so nodes stay
 * compact on canvas without hiding functionality.
 */

import { useMemo } from 'react'

import { makeInferContext } from '../../core/node'
import { getNodeDef } from '../../core/registry'
import { typeLabel } from '../../core/types'
import { describeValue } from '../../core/values'
import { useGraphStore, useSelectedNode } from '../../store/graphStore'
import { exportBaseName } from '../export'
import { formatDuration } from '../format'
import { ParamField } from '../params/ParamField'
import { familyColorVar, socketStyle } from '../socketStyle'
import { ValuePreview } from '../viewers/ValuePreview'

export function Inspector() {
  const open = useGraphStore((s) => s.panels.inspector)
  const togglePanel = useGraphStore((s) => s.togglePanel)
  const node = useSelectedNode()
  const selectionCount = useGraphStore((s) => s.selection.length)
  const inference = useGraphStore((s) => s.inference)
  const setParam = useGraphStore((s) => s.setParam)
  const runNode = useGraphStore((s) => s.runNode)
  const invalidateNode = useGraphStore((s) => s.invalidateNode)
  const clearNodeCache = useGraphStore((s) => s.clearNodeCache)
  const expandNode = useGraphStore((s) => s.expandNode)
  const nodeInputs = useGraphStore((s) => s.nodeInputs)
  const setNotice = useGraphStore((s) => s.setNotice)
  const graphName = useGraphStore((s) => s.graph.meta?.name)

  const info = useGraphStore((s) => {
    void s.runVersion
    return node ? s.nodeInfo(node.id) : undefined
  })
  const outputValue = useGraphStore((s) => {
    void s.runVersion
    if (!node) return undefined
    const port = (getNodeDef(node.type)?.outputs ?? [])[0]
    return port ? s.nodeOutput(node.id, port.id) : undefined
  })

  const def = node ? getNodeDef(node.type) : undefined
  const types = node ? inference.nodes[node.id] : undefined
  const ctx = useMemo(
    () => (def && node ? makeInferContext(def, node.params, types?.inputs ?? {}) : undefined),
    [def, node, types],
  )

  /*
   * Closed: render nothing at all rather than a zero-width panel. The grid column collapses,
   * so the canvas gets the space back, and there is no invisible element left to catch clicks
   * along the right edge. Every hook above has already run, so this early return is stable.
   */
  if (!open) return null

  if (!node || !def || !ctx) {
    return (
      <aside className="inspector">
        <div className="inspector__header">
          <div className="inspector__heading">
            <div className="inspector__title">Inspector</div>
          </div>
          <CollapseButton onCollapse={() => togglePanel('inspector')} />
        </div>
        <div className="inspector__empty">
          {selectionCount > 1 ? (
            <>
              {selectionCount} nodes selected.
              <br />
              Select a single node to edit it.
            </>
          ) : (
            <>
              Nothing selected.
              <br />
              Click a node to see its parameters and results.
            </>
          )}
        </div>
      </aside>
    )
  }

  const params = (def.params ?? []).filter((p) => !p.visibleIf || p.visibleIf(node.params))
  const issues = types?.issues ?? []
  /*
   * An annotation has no ports and is never evaluated, so the Ports and Result sections would be
   * an empty list, an empty viewer and two buttons that do nothing. Its params are still shown —
   * for the Text note that is a full-width editor for the same string the card holds, which is
   * the more comfortable place to write more than a sentence.
   */
  const dataflow = def.annotation !== true

  return (
    <aside className="inspector">
      <div className="inspector__header">
        <div className="inspector__heading">
          <div className="inspector__title">{node.title ?? def.label}</div>
          <div className="inspector__subtitle">
            {def.type} · {def.cost}
          </div>
        </div>
        <CollapseButton onCollapse={() => togglePanel('inspector')} />
      </div>

      <div className="inspector__scroll">
        {def.description && (
          <div className="inspector__section">
            <p className="inspector__desc" style={{ margin: 0 }}>
              {def.description}
            </p>
          </div>
        )}

        {issues.length > 0 && (
          <div className="inspector__section">
            <div className="inspector__section-title">Issues</div>
            <div className="issue-list">
              {issues.map((issue, index) => (
                <div key={index} className="issue" data-severity={issue.severity}>
                  <span className="issue__glyph">{issue.severity === 'error' ? '×' : '!'}</span>
                  <span>{issue.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {params.length > 0 && (
          <div className="inspector__section">
            <div className="inspector__section-title">Parameters</div>
            {params.map((param) => (
              <div key={param.id}>
                <div className="param">
                  <span className="param__label">{param.label}</span>
                  <ParamField
                    param={param}
                    value={node.params[param.id]}
                    ctx={ctx}
                    onChange={(value) => setParam(node.id, param.id, value)}
                    variant="inspector"
                  />
                </div>
                {param.help && <div className="inspector__help">{param.help}</div>}
              </div>
            ))}
          </div>
        )}

        {dataflow && (
          <div className="inspector__section">
            <div className="inspector__section-title">Ports</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {(def.inputs ?? []).map((port) => {
                const resolved = types?.inputs[port.id]
                return (
                  <div
                    key={`in-${port.id}`}
                    style={{ display: 'flex', gap: 6, alignItems: 'center' }}
                  >
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 44 }}>
                      in
                    </span>
                    <span style={{ fontSize: 11, flex: 1 }}>{port.label ?? port.id}</span>
                    <TypeChip
                      label={typeLabel(resolved ?? port.type)}
                      type={resolved ?? port.type}
                    />
                  </div>
                )
              })}
              {(def.outputs ?? []).map((port) => {
                const resolved = types?.outputs[port.id] ?? port.type
                return (
                  <div
                    key={`out-${port.id}`}
                    style={{ display: 'flex', gap: 6, alignItems: 'center' }}
                  >
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 44 }}>
                      out
                    </span>
                    <span style={{ fontSize: 11, flex: 1 }}>{port.label ?? port.id}</span>
                    <TypeChip label={typeLabel(resolved)} type={resolved} />
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {dataflow && (
          <div className="inspector__section">
            <div className="inspector__section-title">
              Result
              {outputValue && ` · ${describeValue(outputValue)}`}
              {info?.durationMs !== undefined && ` · ${formatDuration(info.durationMs)}`}
            </div>
            <div className="inspector__viewer">
              <ValuePreview
                node={node}
                value={outputValue}
                ctx={ctx}
                baseName={exportBaseName(graphName, node.title ?? def.label)}
                onExpand={() => expandNode(node.id)}
                onError={setNotice}
                onSelectionChange={(ids) => setParam(node.id, 'selection', ids)}
                onParamChange={(paramId, next) => setParam(node.id, paramId, next)}
                inputValues={nodeInputs(node.id)}
              />
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button type="button" className="btn" onClick={() => void runNode(node.id)}>
                Run this node
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                title="Drop the results here and downstream, so they are computed again"
                onClick={() => invalidateNode(node.id)}
              >
                Invalidate
              </button>
              {/*
                * Only where there is a second cache to clear. `dataCache` is the node's own
                * declaration that it fetches through one *and* honours the flag, so a button
                * cannot appear on a node that would ignore it.
                */}
              {def?.dataCache && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  title="Forget the data this node downloaded, so the next run fetches it again"
                  onClick={() => clearNodeCache(node.id)}
                >
                  Clear Cache
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}

function TypeChip({ label, type }: { label: string; type: Parameters<typeof socketStyle>[0] }) {
  return (
    <span className="type-chip" title={label}>
      <span
        className="type-chip__dot"
        style={{ background: familyColorVar(socketStyle(type).family) }}
      />
      {label}
    </span>
  )
}

/** Closes the panel from inside it — the other half of the toolbar's toggle. */
function CollapseButton({ onCollapse }: { onCollapse: () => void }) {
  return (
    <button
      type="button"
      className="inspector__collapse"
      onClick={onCollapse}
      title="Hide the inspector (I)"
      aria-label="Hide inspector"
    >
      ›
    </button>
  )
}
