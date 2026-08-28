/**
 * Full-size viewer overlay.
 *
 * A modal panel over the canvas rather than a browser-fullscreen takeover, so the graph
 * stays one keypress away — but with a button that hands the panel to the Fullscreen API
 * when someone genuinely wants no chrome (a projector, a screenshot).
 *
 * The controls expose the node's *presentational* params only. Those are excluded from the
 * provenance key, so fiddling with a colour scale here re-renders instantly and never
 * marks the graph stale — which is what makes this usable as an inspection surface rather
 * than a thing you're afraid to touch.
 *
 * They arrive in one of two shapes. A node declaring `paramGroups` gets a **tabbed styling
 * sidebar**, Cytoscape's Style panel being the reference: a tab per half of the thing being
 * drawn, and one row per visual property rather than one per param. Everything else keeps
 * the flat horizontal rail. The split is opt-in per node, so adding the sidebar changed
 * nothing for any node that has not asked for it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { makeInferContext } from '../../core/node'
import { getNodeDef } from '../../core/registry'
import { describeValue } from '../../core/values'
import { hasHelp } from '../../help/registry'
import { useGraphStore } from '../../store/graphStore'
import { exportBaseName } from '../export'
import { formatDuration } from '../format'
import { exitFullscreen, toggleFullscreen, useIsFullscreen } from '../fullscreen'
import { expandedWidth } from './expandedWidth'
import { nodeBody } from '../nodes/nodeBodies'
import { ParamField } from '../params/ParamField'
import { ParamRows } from '../params/ParamRows'
import { groupParams, paramsForPanel } from '../params/paramGroups'
import { ValuePreview } from '../viewers/ValuePreview'
import { firstOutputPort } from '../../core/ports'

export function ViewerOverlay() {
  const nodeId = useGraphStore((s) => s.expandedNodeId)
  const expandNode = useGraphStore((s) => s.expandNode)
  const graph = useGraphStore((s) => s.graph)
  const inference = useGraphStore((s) => s.inference)
  const setParam = useGraphStore((s) => s.setParam)
  const setNotice = useGraphStore((s) => s.setNotice)
  const nodeInputs = useGraphStore((s) => s.nodeInputs)
  // Subscribed to, not read, for `CodaNodeView`'s reason: `nodeInputs(id)` is called during
  // render, so a scene streaming in behind a fullscreen viewer moves nothing this component
  // selects. Without it the card fills in and the overlay over it does not.
  void useGraphStore((s) => s.previewVersion)
  // A primitive, not `s.panels` — that object is minted fresh on every toggle, so selecting
  // the whole thing would change identity on every unrelated tick. See invariant 7.
  const styleOpen = useGraphStore((s) => s.panels.style)
  const togglePanel = useGraphStore((s) => s.togglePanel)
  const openHelp = useGraphStore((s) => s.openHelp)

  const info = useGraphStore((s) => {
    void s.runVersion
    return nodeId ? s.nodeInfo(nodeId) : undefined
  })
  const value = useGraphStore((s) => {
    void s.runVersion
    if (!nodeId) return undefined
    const node = s.graph.nodes.find((n) => n.id === nodeId)
    const vdef = node ? getNodeDef(node.type) : undefined
    const port = vdef && node ? firstOutputPort(vdef, node.params) : undefined
    return port ? s.nodeOutput(nodeId, port.id) : undefined
  })

  const panelRef = useRef<HTMLDivElement>(null)
  const [tabId, setTabId] = useState<string | undefined>(undefined)
  const isFullscreen = useIsFullscreen(panelRef.current)

  const close = useCallback(() => {
    // Only *this panel's* fullscreen, never "whatever is fullscreen": the app itself can be
    // fullscreen underneath, and closing a viewer has no business dropping the whole window
    // out of it. The API keeps a stack, so leaving the panel lands back there.
    if (document.fullscreenElement === panelRef.current) exitFullscreen()
    expandNode(undefined)
  }, [expandNode])

  // Escape closes. The browser consumes Escape itself while the *panel* is fullscreen, which
  // exits fullscreen first and leaves the overlay up — that's the behaviour people expect.
  // A fullscreen *app* underneath is not that case: the overlay is an ordinary dialog on top
  // of it, and Escape closes it like any other.
  useEffect(() => {
    if (!nodeId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement !== panelRef.current) {
        event.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [nodeId, close])

  const node = nodeId ? graph.nodes.find((n) => n.id === nodeId) : undefined
  const def = node ? getNodeDef(node.type) : undefined
  const types = nodeId ? inference.nodes[nodeId] : undefined
  const ctx = useMemo(
    () => (def && node ? makeInferContext(def, node.params, types?.inputs ?? {}) : undefined),
    [def, node, types],
  )

  if (!nodeId || !node || !def || !ctx) return null

  const body = nodeBody(node.type)
  const railParams = (def.params ?? []).filter(
    (p) => p.presentational && (!p.visibleIf || p.visibleIf(node.params)),
  )
  // Grouped nodes take the sidebar; everything else keeps the rail it has always had.
  const tabs = def.paramGroups?.length ? groupParams(def, node.params, paramsForPanel(def)) : []
  // Falling back to the first tab rather than storing a reset makes an id that no longer
  // exists — a different node, or a tab whose params are all hidden — harmless.
  const activeTab = tabs.find((t) => t.id === tabId) ?? tabs[0]
  const baseName = exportBaseName(graph.meta?.name, node.title ?? def.label)
  /*
   * A number CSS cannot know, so it goes on the element: the panel is one component drawing
   * every expandable node, and what it is drawing is the only thing that decides whether a
   * wider screen should make it wider. `.viewer-panel` uncaps it; this puts the cap back for
   * the surfaces that are worse for the room. Dropped entirely in fullscreen — a cap there
   * would letterbox the panel that was asked for precisely to lose the chrome.
   */
  const width = expandedWidth(node.type)

  const onToggleFullscreen = () => {
    const panel = panelRef.current
    if (!panel) return
    void toggleFullscreen(panel).then((now) => {
      if (!isFullscreen && !now) setNotice('This browser refused fullscreen for the viewer')
    })
  }

  return (
    <div className="overlay" role="presentation" onPointerDown={close}>
      <div
        ref={panelRef}
        className="overlay__panel viewer-panel"
        style={width === 'full' || isFullscreen ? undefined : { maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-label={`${node.title ?? def.label} output`}
        // Clicks inside must not reach the backdrop's close handler.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="overlay__header">
          <div className="overlay__title">
            <strong>{node.title ?? def.label}</strong>
            <span>
              {def.label !== (node.title ?? def.label) ? `${def.label} · ` : ''}
              {value ? describeValue(value) : 'no result yet'}
              {info?.durationMs !== undefined && ` · ${formatDuration(info.durationMs)}`}
            </span>
          </div>

          {tabs.length > 0 && (
            /*
             * Lives in the header, outside the sidebar it controls. A toggle that vanishes
             * when used cannot be undone — the same rule the minimap's corner button follows.
             */
            <button
              type="button"
              className="btn btn--ghost"
              aria-pressed={styleOpen}
              onClick={() => togglePanel('style')}
              title={styleOpen ? 'Hide the style panel' : 'Show the style panel'}
            >
              Style
            </button>
          )}
          {hasHelp(node.type) && (
            <button
              type="button"
              className="btn btn--ghost"
              title={`What ${def.label} does, and what it assumes`}
              aria-label={`Help for ${def.label}`}
              onClick={() => openHelp(node.type)}
            >
              ?
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onToggleFullscreen}
            title={isFullscreen ? 'Leave fullscreen' : 'Fullscreen'}
            aria-label={isFullscreen ? 'Leave fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? '⛶ Exit' : '⛶ Fullscreen'}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={close}
            title="Close (Esc)"
            aria-label="Close viewer"
          >
            ✕
          </button>
        </div>

        {tabs.length === 0 && railParams.length > 0 && (
          <div className="overlay__rail">
            {railParams.map((param) => (
              <div key={param.id} className="overlay__rail-item">
                <span className="param__label" title={param.help ?? param.label}>
                  {param.label}
                </span>
                {/*
                 * `inspector`, because the rail draws the label itself in the span above.
                 * Under the default `node` variant a checkbox draws its own as well, so a
                 * boolean rail param renders "Show filter row ☑ Show filter row" — the same
                 * double label `SelectOneBody` documents, in the other surface that pairs a
                 * label of its own with a `ParamField`. `out.table`'s filter-row toggle is
                 * the first presentational boolean to reach this rail, which is why it went
                 * unnoticed: every other kind ignores `showLabel`.
                 */}
                <ParamField
                  param={param}
                  value={node.params[param.id]}
                  ctx={ctx}
                  variant="inspector"
                  onChange={(next) => setParam(node.id, param.id, next)}
                />
              </div>
            ))}
          </div>
        )}

        <div className="overlay__main">
          <div className="overlay__body">
            {/* Same component as the card renders, with `compact` off: a node that draws its own
                body is expanded by giving that body room, not by showing a viewer of its output. */}
            {body ? (
              <body.Component
                node={node}
                ctx={ctx}
                compact={false}
                inputValues={nodeInputs(node.id)}
                setParam={(paramId, next) => setParam(node.id, paramId, next)}
                onError={setNotice}
              />
            ) : (
              <ValuePreview
                node={node}
                value={value}
                ctx={ctx}
                baseName={baseName}
                onError={setNotice}
                onSelectionChange={(ids) => setParam(node.id, 'selection', ids)}
                onParamChange={(paramId, next) => setParam(node.id, paramId, next)}
                inputValues={nodeInputs(node.id)}
              />
            )}
          </div>

          {/* Closed means not rendered, not zero-width: a collapsed-but-present sidebar still
              catches clicks along the edge of the view it is meant to have given back. */}
          {styleOpen && activeTab && (
            <aside className="overlay__style" aria-label="Style">
              <div className="style-tabs" role="tablist">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    className="style-tab"
                    aria-selected={tab.id === activeTab.id}
                    onClick={() => setTabId(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="style-scroll" role="tabpanel" aria-label={activeTab.label}>
                {activeTab.affectsData && (
                  /*
                   * Every other tab is presentational, so touching it re-renders and nothing
                   * more. This one does not, and a graph quietly going stale with no visible
                   * cause is exactly the confusion the note exists to prevent.
                   */
                  <p className="style-warning">
                    These change the data, not just the drawing — downstream nodes go stale.
                  </p>
                )}
                <ParamRows
                  rows={activeTab.rows}
                  params={node.params}
                  ctx={ctx}
                  onChange={(paramId, next) => setParam(node.id, paramId, next)}
                />
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
