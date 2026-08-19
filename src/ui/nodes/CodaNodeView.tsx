/**
 * The node body.
 *
 * Layout follows ComfyUI more than Blender: sockets in a two-column band at the top
 * (inputs left, outputs right), params inline below, and a footer that always says what
 * the node currently holds. Params live *in* the node rather than only in a sidebar
 * because reading a graph should not require clicking each node to see what it does.
 *
 * The run state appears three times on purpose — a coloured left bar, a glyph badge, and
 * text in the footer — so state is never communicated by colour alone.
 */

import { Handle, NodeResizer, Position, useStore } from '@xyflow/react'
import { memo, useMemo, useState } from 'react'

import type { GraphNode } from '../../core/graph'
import type { InferenceResult, NodeIssue } from '../../core/inference'
import { isViewer, makeInferContext } from '../../core/node'
import { getNodeDef } from '../../core/registry'
import type { NodeRunState } from '../../core/scheduler'
import type { CodaType } from '../../core/types'
import { isAssignable, typeLabel } from '../../core/types'
import { describeValue } from '../../core/values'
import { useGraphStore } from '../../store/graphStore'
import { exportBaseName } from '../export'
import { formatDuration } from '../format'
import { ParamField } from '../params/ParamField'
import { socketStyle } from '../socketStyle'
import { ValuePreview } from '../viewers/ValuePreview'
import { nodeBody } from './nodeBodies'
import { NodeRunRing } from './NodeRunRing'

/**
 * Output nodes render their result inline; everything else shows a one-line summary.
 *
 * Re-exported rather than defined here: the store asks the same question (see
 * `toggleParamRows`) and `src/store` must not import the UI.
 */
export { isViewer }

export interface CodaNodeData {
  [key: string]: unknown
  node: GraphNode
}

const STATE_GLYPH: Record<NodeRunState, string> = {
  ok: '✓',
  stale: '!',
  running: '·',
  error: '×',
  blocked: '–',
  disabled: 'M',
  idle: '',
}

const STATE_TEXT: Record<NodeRunState, string> = {
  ok: 'up to date',
  stale: 'needs run',
  running: 'running',
  error: 'error',
  blocked: 'waiting upstream',
  disabled: 'muted',
  idle: 'not evaluated',
}

/**
 * Floors for the resize handles: below this the header controls and the sockets start
 * colliding, and a card dragged down to nothing cannot be grabbed again.
 */
const MIN_NODE_WIDTH = 220
const MIN_NODE_HEIGHT = 160

/**
 * Viewers that draw from their *inputs* rather than their own output, so they have something
 * to show before — and without — a result of their own.
 *
 * Genuinely a list: nothing on the definition declares it, and it is not derivable from the
 * category the way `isViewer` is.
 */
const SELF_DRAWING_NODE_TYPES = new Set(['out.viewer3d', 'out.neuroglancer', 'out.profile'])

function CodaNodeViewImpl({
  id,
  data,
  selected,
}: {
  id: string
  data: CodaNodeData
  selected?: boolean
}) {
  const node = data.node
  const [renaming, setRenaming] = useState(false)

  const inference = useGraphStore((s) => s.inference)
  const setParam = useGraphStore((s) => s.setParam)
  const renameNode = useGraphStore((s) => s.renameNode)
  const toggleCollapsed = useGraphStore((s) => s.toggleCollapsed)
  const toggleParamRows = useGraphStore((s) => s.toggleParamRows)
  const runNode = useGraphStore((s) => s.runNode)
  const cancelRun = useGraphStore((s) => s.cancelRun)
  const expandNode = useGraphStore((s) => s.expandNode)
  const needsRun = useGraphStore((s) => {
    void s.runVersion
    return s.needsRun(id)
  })
  const busy = useGraphStore((s) => s.busy)
  const setNotice = useGraphStore((s) => s.setNotice)
  const graphName = useGraphStore((s) => s.graph.meta?.name)

  // runVersion is what ties these reads to scheduler ticks.
  const info = useGraphStore((s) => {
    void s.runVersion
    return s.nodeInfo(id)
  })
  const outputValue = useGraphStore((s) => {
    void s.runVersion
    const port = (getNodeDef(node.type)?.outputs ?? [])[0]
    return port ? s.nodeOutput(id, port.id) : undefined
  })
  // Only the multi-input viewers need these, so they are resolved lazily per render rather
  // than subscribed to; `runVersion` above already ties this component to scheduler ticks.
  const nodeInputs = useGraphStore((s) => s.nodeInputs)

  /**
   * Live drag state, used to dim sockets that cannot accept the in-flight connection.
   * Selected as three primitives rather than one object: `useSyncExternalStore` compares
   * snapshots by identity, so returning a fresh object per call would loop.
   */
  const dragNodeId = useStore((s) =>
    s.connection.inProgress ? (s.connection.fromHandle?.nodeId ?? null) : null,
  )
  const dragPortId = useStore((s) =>
    s.connection.inProgress ? (s.connection.fromHandle?.id ?? null) : null,
  )
  const dragHandleType = useStore((s) =>
    s.connection.inProgress ? (s.connection.fromHandle?.type ?? null) : null,
  )
  const dragOrigin = useMemo(
    () =>
      dragNodeId && dragHandleType
        ? { nodeId: dragNodeId, portId: dragPortId, handleType: dragHandleType }
        : undefined,
    [dragNodeId, dragPortId, dragHandleType],
  )

  const def = getNodeDef(node.type)
  const types = inference.nodes[id]
  const ctx = useMemo(
    () => (def ? makeInferContext(def, node.params, types?.inputs ?? {}) : undefined),
    [def, node.params, types],
  )

  if (!def || !ctx) {
    return (
      <div className="coda-node" data-state="error">
        <div className="coda-node__header" data-category="utility">
          <span className="coda-node__title">Unknown node</span>
        </div>
        <div className="coda-node__issue">Type &ldquo;{node.type}&rdquo; is not registered</div>
      </div>
    )
  }

  const inputs = def.inputs ?? []
  const outputs = def.outputs ?? []
  const rowCount = Math.max(inputs.length, outputs.length)
  const issues = types?.issues ?? []
  const errorIssue = issues.find((i) => i.severity === 'error')
  const warningIssue = issues.find((i) => i.severity === 'warning')
  const shownIssue: NodeIssue | undefined =
    info.state === 'error' && info.error
      ? { severity: 'error', message: info.error }
      : (errorIssue ?? warningIssue)

  /*
   * A node with its own body owns the whole area below the sockets. Its params are still real
   * params — reachable in the inspector, saved, part of the provenance key — but rendering them
   * as fields *as well* would put a raw "Search" text box under the search bar that writes it.
   */
  const body = nodeBody(node.type)
  const visibleParams = body
    ? []
    : (def.params ?? []).filter(
        (p) => !p.advanced && (!p.visibleIf || p.visibleIf(node.params)),
      )

  const showPreview =
    isViewer(def) &&
    !node.collapsed &&
    (outputValue !== undefined || SELF_DRAWING_NODE_TYPES.has(node.type))

  /*
   * Only viewers resize, and only while they are showing one. A transform node's height is
   * decided by its params, so a drag handle there would promise a control that does nothing,
   * and a collapsed node is a title bar — stretching that means nothing either.
   */
  const resizable = isViewer(def) && !node.collapsed
  /** True when the card fills an explicit box rather than sizing to its content. */
  const sized = resizable && (node.size !== undefined || def.defaultSize !== undefined)

  /*
   * Whether the param rows can be folded away, and whether they currently are.
   *
   * Viewers only: on a card with a drawing under them, folding hands the space to the drawing,
   * which is the whole point — a widget is configured once and looked at for the rest of the
   * session. On a transform node the rows *are* the card, and `collapsed` already covers "hide
   * this node's middle". `showParams` still checks `visibleParams.length`, so a viewer whose
   * params are all `advanced` never grows a button for a band it does not draw.
   */
  const foldableParams = isViewer(def) && !node.collapsed && visibleParams.length > 0
  const showParams =
    !node.collapsed && visibleParams.length > 0 && !(foldableParams && node.paramsCollapsed)

  // The type being dragged, resolved once per render rather than per socket.
  const draggedType =
    dragOrigin && dragOrigin.nodeId !== id ? draggedPortType(inference, dragOrigin) : undefined

  return (
    <>
      {/*
       * Sibling of the card, not a child: the run outline is drawn *outside* the node, and
       * `.coda-node` clips with `overflow: hidden`. React Flow's wrapper is the positioned
       * ancestor, so an outset absolute box resolves against the node's own bounds.
       */}
      {info.state === 'running' && <NodeRunRing progress={info.progress} />}
      {/*
       * A sibling for the same reason the ring is: `.coda-node` clips with
       * `overflow: hidden`, and the resize handles straddle the card's edge. Inside, they
       * would render as grabbable-looking corners with half of each one cut off.
       */}
      {resizable && (
        <NodeResizer
          minWidth={MIN_NODE_WIDTH}
          minHeight={MIN_NODE_HEIGHT}
          isVisible={selected === true}
          lineClassName="coda-node__resize-line"
          handleClassName="coda-node__resize-handle"
        />
      )}
      <div
        className={`coda-node${showPreview ? ' coda-node--wide' : ''}${selected ? ' selected' : ''}`}
        data-state={info.state}
        data-disabled={node.disabled || undefined}
        data-sized={sized || undefined}
        /*
         * `--node-width` rather than `width`: the card's rule reads that custom property, so
         * overriding it here keeps one place deciding how a node is sized. The run ring is
         * percentage-sized against React Flow's wrapper, so it follows without being told.
         */
        style={
          body?.width
            ? ({ '--node-width': `${body.width}px` } as React.CSSProperties)
            : undefined
        }
      >
        <div className="coda-node__header" data-category={def.category} title={def.description}>
          <span
            className="state-badge"
            data-state={info.state}
            title={`${STATE_TEXT[info.state]}${info.error ? `: ${info.error}` : ''}`}
            aria-label={STATE_TEXT[info.state]}
          >
            {STATE_GLYPH[info.state]}
          </span>
          {renaming ? (
            <input
              className="coda-node__title-input nodrag"
              autoFocus
              defaultValue={node.title ?? def.label}
              onBlur={(e) => {
                const value = e.target.value.trim()
                renameNode(id, value === def.label ? '' : value)
                setRenaming(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <span
              className="coda-node__title"
              onDoubleClick={(e) => {
                e.stopPropagation()
                setRenaming(true)
              }}
              title={`${node.title ?? def.label} — ${def.type}`}
            >
              {node.title ?? def.label}
            </span>
          )}
          {info.state === 'running' ? (
            <button
              type="button"
              className="coda-node__run coda-node__run--stop nodrag"
              title="Cancel this run"
              aria-label="Cancel run"
              onClick={(e) => {
                e.stopPropagation()
                cancelRun()
              }}
            >
              ■
            </button>
          ) : (
            <button
              type="button"
              className="coda-node__run nodrag"
              disabled={!needsRun || busy || node.disabled === true}
              title={
                node.disabled
                  ? 'Node is muted'
                  : needsRun
                    ? 'Run this node and everything it needs'
                    : 'Already up to date'
              }
              aria-label="Run this node"
              onClick={(e) => {
                e.stopPropagation()
                void runNode(id)
              }}
            >
              ▶
            </button>
          )}
          {/* An expandable body offers this before the node has ever run — that is most of the
            point of Explore, whose list is populated whether or not the ports carry anything. */}
          {(outputValue !== undefined || body?.expandable) && (
            <button
              type="button"
              className="coda-node__run nodrag"
              title="Open this result full size"
              aria-label="Expand output"
              onClick={(e) => {
                e.stopPropagation()
                expandNode(id)
              }}
            >
              ⤢
            </button>
          )}
          {/* Stays in the header rather than on the band it controls: folded, the band is not
            rendered at all, so a toggle living inside it would have nothing left to press —
            the same rule the minimap's corner button and the overlay's Style button follow. */}
          {foldableParams && (
            <button
              type="button"
              className="coda-node__fold nodrag"
              aria-pressed={node.paramsCollapsed === true}
              title={
                node.paramsCollapsed
                  ? 'Show the parameter rows'
                  : 'Hide the parameter rows and give the space to the display'
              }
              aria-label={node.paramsCollapsed ? 'Show parameters' : 'Hide parameters'}
              onClick={(e) => {
                e.stopPropagation()
                toggleParamRows([id])
              }}
            >
              ☰
            </button>
          )}
          <button
            type="button"
            className="coda-node__collapse nodrag"
            title={node.collapsed ? 'Expand' : 'Collapse'}
            onClick={(e) => {
              e.stopPropagation()
              toggleCollapsed([id])
            }}
          >
            {node.collapsed ? '▸' : '▾'}
          </button>
        </div>

        <div className="coda-node__ports">
          {Array.from({ length: rowCount }, (_, row) => {
            const input = inputs[row]
            const output = outputs[row]
            const inputType = input ? types?.inputs[input.id] : undefined
            const outputType = output ? (types?.outputs[output.id] ?? output.type) : undefined
            const inputPortError = issues.some(
              (i) => i.severity === 'error' && input && i.portId === input.id,
            )

            // Dragging from an output only concerns inputs, and vice versa.
            const dimInput =
              draggedType !== undefined &&
              dragOrigin?.handleType === 'source' &&
              input !== undefined &&
              !isAssignable(draggedType, input.type)
            const dimOutput =
              draggedType !== undefined &&
              dragOrigin?.handleType === 'target' &&
              outputType !== undefined &&
              !isAssignable(outputType, draggedType)

            return (
              <div className="port-row" key={row}>
                <div
                  className="port-row__side port-row__side--in"
                  data-unconnected={input && !inputType ? 'true' : undefined}
                  data-error={inputPortError ? 'true' : undefined}
                >
                  {input && (
                    <>
                      <Handle
                        type="target"
                        position={Position.Left}
                        id={input.id}
                        className="socket"
                        data-family={socketStyle(input.type).family}
                        data-shape={socketStyle(input.type).shape}
                        data-compatible={dimInput ? 'false' : undefined}
                        title={`${input.label ?? input.id}: ${typeLabel(inputType ?? input.type)}`}
                      />
                      <span className="port-label">{input.label ?? input.id}</span>
                    </>
                  )}
                </div>
                <div className="port-row__side port-row__side--out">
                  {output && (
                    <>
                      <span className="port-label">{output.label ?? output.id}</span>
                      <Handle
                        type="source"
                        position={Position.Right}
                        id={output.id}
                        className="socket"
                        data-family={socketStyle(outputType).family}
                        data-shape={socketStyle(outputType).shape}
                        data-compatible={dimOutput ? 'false' : undefined}
                        title={`${output.label ?? output.id}: ${typeLabel(outputType)}`}
                      />
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {showParams && (
          <div className="coda-node__params">
            {visibleParams.map((param) => (
              <div
                key={param.id}
                className={`param${param.kind === 'boolean' || param.kind === 'columns' ? ' param--wide' : ''}`}
              >
                <span className="param__label" title={param.help ?? param.label}>
                  {param.label}
                </span>
                <ParamField
                  param={param}
                  value={node.params[param.id]}
                  ctx={ctx}
                  onChange={(value) => setParam(id, param.id, value)}
                />
              </div>
            ))}
          </div>
        )}

        {body && !node.collapsed && (
          <div className="coda-node__body">
            <body.Component
              node={node}
              ctx={ctx}
              compact
              setParam={(paramId, value) => setParam(id, paramId, value)}
              onError={setNotice}
            />
          </div>
        )}

        {showPreview && (
          <div
            className="coda-node__preview nodrag"
            onDoubleClick={(e) => {
              e.stopPropagation()
              expandNode(id)
            }}
            title="Double-click to open full size"
          >
            <ValuePreview
              node={node}
              value={outputValue}
              ctx={ctx}
              compact
              baseName={exportBaseName(graphName, node.title ?? def.label)}
              onExpand={() => expandNode(id)}
              onError={setNotice}
              onSelectionChange={(ids) => setParam(id, 'selection', ids)}
              onParamChange={(paramId, next) => setParam(id, paramId, next)}
              inputValues={nodeInputs(id)}
            />
          </div>
        )}

        {shownIssue && (
          <div className="coda-node__issue" data-severity={shownIssue.severity}>
            {shownIssue.message}
          </div>
        )}

        {!node.collapsed && (
          <div className="coda-node__footer">
            <span className="coda-node__summary">
              {outputValue ? describeValue(outputValue) : STATE_TEXT[info.state]}
            </span>
            {info.state === 'running' && info.note && <span>{info.note}</span>}
            {info.durationMs !== undefined && info.state === 'ok' && (
              <span className="coda-node__timing">{formatDuration(info.durationMs)}</span>
            )}
          </div>
        )}
      </div>
    </>
  )
}

/** Resolve the type sitting at the far end of an in-flight connection drag. */
function draggedPortType(
  inference: InferenceResult,
  origin: { nodeId: string; portId: string | null; handleType: 'source' | 'target' },
): CodaType | undefined {
  if (!origin.portId) return undefined
  if (origin.handleType === 'source') {
    return inference.nodes[origin.nodeId]?.outputs[origin.portId]
  }
  const graph = useGraphStore.getState().graph
  const node = graph.nodes.find((n) => n.id === origin.nodeId)
  const def = node ? getNodeDef(node.type) : undefined
  return (def?.inputs ?? []).find((p) => p.id === origin.portId)?.type
}

export const CodaNodeView = memo(CodaNodeViewImpl)
