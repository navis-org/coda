/**
 * One node, drawn full size — header, presentational controls, body, styling sidebar.
 *
 * Lifted out of `ViewerOverlay` when the pinned dock arrived, because everything below the
 * backdrop was already generic: which component draws the node, whether its presentational
 * params come as a flat rail or a tabbed sidebar, what the subtitle says about the value. Two
 * copies of that would drift on the next param kind that needs a special case in the rail —
 * `out.table`'s filter-row toggle is already one (see `variant="inspector"` below).
 *
 * What the three callers keep for themselves is the *frame*: the overlay owns a modal backdrop,
 * Escape, the per-node width cap and the Fullscreen API; the dock owns a grid column and a drag
 * grip; a dashboard cell owns its place in the grid and the two gestures that change it. None of
 * that is anything this component can have an opinion about, so the header's trailing buttons
 * arrive as `actions` rather than as a mode flag.
 *
 * The **one** thing the frame is allowed to say about the inside is which controls it has room
 * for, and that is `controls`. It names the property rather than the caller, so a dock somebody
 * has dragged to its 360px floor can ask for the same treatment without a `variant: 'dock-narrow'`
 * being invented for it. Density is *not* on that list: a frame wears `.viewer-surface` and has a
 * class of its own, so it can select its own header — see `.dash-cell__panel` in `editor.css`.
 *
 * The controls expose the node's *presentational* params only. Those are excluded from the
 * provenance key, so fiddling with a colour scale here re-renders instantly and never marks the
 * graph stale — which is what makes this usable as an inspection surface rather than a thing
 * you're afraid to touch.
 *
 * They arrive in one of two shapes. A node declaring `paramGroups` gets a **tabbed styling
 * sidebar**, Cytoscape's Style panel being the reference: a tab per half of the thing being
 * drawn, and one row per visual property rather than one per param. Everything else keeps the
 * flat horizontal rail. The split is opt-in per node, so adding the sidebar changed nothing for
 * any node that has not asked for it.
 *
 * The class names stay `overlay__*` rather than becoming `viewer-surface__*`. They are already
 * the selector for a dozen rules about how a table, an Explore list and a caption sit inside a
 * full-size view, and renaming them to say "not only the overlay" would be a rename of every one
 * of those for no behaviour. The dock adds itself to the three rules that were written with
 * `.overlay` as an *ancestor*; those are the only ones that could not be shared.
 */

import { useMemo, useState, type ReactNode } from 'react'

import type { GraphNode } from '../../core/graph'
import type { NodeDefinition } from '../../core/node'
import { makeInferContext } from '../../core/node'
import { firstOutputPort } from '../../core/ports'
import { getNodeDef } from '../../core/registry'
import { describeValue } from '../../core/values'
import { hasHelp } from '../../help/registry'
import { useGraphStore } from '../../store/graphStore'
import { exportBaseName } from '../export'
import { formatDuration } from '../format'
import { nodeBody } from '../nodes/nodeBodies'
import { ParamField } from '../params/ParamField'
import { ParamRows } from '../params/ParamRows'
import { groupParams, paramsForPanel } from '../params/paramGroups'
import { ValuePreview } from '../viewers/ValuePreview'

/**
 * The node a full-size surface is drawing, and its definition.
 *
 * One subscription, not three. Both callers need to know whether to render their *frame* — a
 * backdrop, a grid column — before this component gets a chance to return null, and the overlay
 * additionally needs the title for its `aria-label` and the type for its width cap. Asking for
 * each of those as its own primitive selector looked like it was obeying invariant 7 and was in
 * fact the expensive way round: zustand runs every selector on every `set`, so three selectors
 * each doing `graph.nodes.find` is three linear scans per store tick — on a *closed* overlay,
 * and the hot ticks are node dragging, which fires per pointer sample.
 *
 * What invariant 7 actually forbids is *allocating* in the selector. `s.graph` is a stored
 * reference that changes only when the graph does, so subscribing to it and deriving in a
 * `useMemo` is both cheaper and the shape the rest of the app already uses.
 */
export interface ViewerNode {
  node: GraphNode
  def: NodeDefinition
}

export function useViewerNode(nodeId: string | undefined): ViewerNode | undefined {
  const graph = useGraphStore((s) => s.graph)
  return useMemo(() => {
    if (!nodeId) return undefined
    const node = graph.nodes.find((n) => n.id === nodeId)
    const def = node ? getNodeDef(node.type) : undefined
    return node && def ? { node, def } : undefined
  }, [graph, nodeId])
}

export function ViewerSurface({
  nodeId,
  actions,
  leading,
  controls = 'auto',
}: {
  nodeId: string
  /** Buttons for the right-hand end of the header — close, fullscreen, unpin, remove. */
  actions?: ReactNode
  /**
   * The left-hand end of the header, before the title. Only the dashboard uses it, for its drag
   * grip — which has to be *in* the header rather than floated over it, because the header is
   * the one part of a cell that is reliably not an `<iframe>` or a WebGL canvas, and an
   * absolutely-positioned grip over a neuroglancer embed is a grip the embed swallows the
   * pointer for.
   */
  leading?: ReactNode
  /**
   * Which presentational controls this frame has room for, and who owns the disclosure.
   *
   * Three states, named after what is shown rather than after which caller is asking:
   *
   *  - `auto` — whatever the node declares. A node with `paramGroups` gets the tabbed styling
   *    sidebar and the `Style` button that opens it (state in `panels.style`, one flag for the
   *    one such surface that can be up at a time); everything else gets the flat rail. The
   *    overlay and the dock.
   *  - `rail` / `hidden` — the flat rail for **every** node, shown or not, with the *frame*
   *    owning the disclosure. A dashboard cell may be a sixth of a window, where a 268px sidebar
   *    is the panel plus a strip and *n* of them is a screen of controls with no view; and the
   *    state has to be per cell, since a grid sharing `panels.style` would open every rail at
   *    once. The full sidebar stays one ⤢ away.
   *
   * The rail is one component in all three, so a grouped node's presentational params are the
   * same controls wherever they appear rather than a second spelling of them.
   *
   * This was two props — a `variant` naming the caller, plus a `railOpen` documented as ignored
   * for two of the three callers, with `full` + open unreachable. One prop with three states is
   * the same information without the corner that could not happen.
   */
  controls?: 'auto' | 'rail' | 'hidden'
}) {
  const inference = useGraphStore((s) => s.inference)
  const setParam = useGraphStore((s) => s.setParam)
  const setNotice = useGraphStore((s) => s.setNotice)
  const nodeInputs = useGraphStore((s) => s.nodeInputs)
  // Subscribed to *and* read, for `CodaNodeView`'s reason: `nodeInputs(id)` is called during
  // render, so a scene streaming in behind a full-size viewer moves nothing this component
  // selects. Without it the card fills in and the surface over it does not. It is also what
  // tells the memo below that the inputs may have changed.
  const previewVersion = useGraphStore((s) => s.previewVersion)
  // A primitive, not `s.panels` — that object is minted fresh on every toggle, so selecting
  // the whole thing would change identity on every unrelated tick. See invariant 7.
  const styleOpen = useGraphStore((s) => s.panels.style)
  const togglePanel = useGraphStore((s) => s.togglePanel)
  const openHelp = useGraphStore((s) => s.openHelp)

  const info = useGraphStore((s) => {
    void s.runVersion
    return s.nodeInfo(nodeId)
  })
  const [tabId, setTabId] = useState<string | undefined>(undefined)

  const found = useViewerNode(nodeId)
  const node = found?.node
  const def = found?.def
  const graphName = useGraphStore((s) => s.graph.meta?.name)
  const value = useGraphStore((s) => {
    void s.runVersion
    const port = def && node ? firstOutputPort(def, node.params) : undefined
    return port ? s.nodeOutput(nodeId, port.id) : undefined
  })
  /*
   * The values on this node's input ports, memoised.
   *
   * `nodeInputs` walks the node list and then the edge list once per input port, and mints a
   * fresh object — so calling it in the body meant every viewer re-reconciled on every render
   * even when nothing it draws had moved. That was affordable while at most one of these was
   * mounted; the dashboard mounts one per cell, and `previewVersion` ticks per streaming mesh
   * fragment. `found` stands in for the graph here: it is re-derived whenever `s.graph` changes.
   */
  const inputValues = useMemo(() => {
    // Read, not just listed: `nodeInputs` closes over mutable scheduler state, so these two are
    // the only things that say the answer may have moved — and a dep nothing in the body touches
    // is a dep the next person deletes. The same `void` idiom the store selectors above use.
    void found
    void previewVersion
    return nodeInputs(nodeId)
  }, [nodeInputs, nodeId, found, previewVersion])
  const types = inference.nodes[nodeId]
  // Memoised, and every hook here runs before the guard below — a fresh `ctx` on each render
  // re-renders the body it is handed to, which for a 3D scene is the frame budget.
  const ctx = useMemo(
    () => (def && node ? makeInferContext(def, node.params, types?.inputs ?? {}) : undefined),
    [def, node, types],
  )

  if (!node || !def || !ctx) return null

  const body = nodeBody(node.type)
  const railParams = (def.params ?? []).filter(
    (p) => p.presentational && (!p.visibleIf || p.visibleIf(node.params)),
  )
  // Grouped nodes take the sidebar; everything else keeps the rail it has always had. Neither the
  // sidebar nor the tab strip that opens it fits a frame that asked for the rail — see `controls`.
  const tabs =
    controls === 'auto' && def.paramGroups?.length
      ? groupParams(def, node.params, paramsForPanel(def))
      : []
  const showRail =
    railParams.length > 0 && (controls === 'auto' ? tabs.length === 0 : controls === 'rail')
  // Falling back to the first tab rather than storing a reset makes an id that no longer
  // exists — a different node, or a tab whose params are all hidden — harmless.
  const activeTab = tabs.find((t) => t.id === tabId) ?? tabs[0]
  const baseName = exportBaseName(graphName, node.title ?? def.label)

  return (
    <>
      <div className="overlay__header">
        {leading}
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
           * when used cannot be undone — the same rule the minimap's rail button follows.
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
        {actions}
      </div>

      {showRail && (
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
              inputValues={inputValues}
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
              inputValues={inputValues}
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
    </>
  )
}
