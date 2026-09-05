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

import { Handle, NodeResizer, Position, useStore, useUpdateNodeInternals } from '@xyflow/react'

import { backendForNodeType } from '../../nodes/lib/datasetFamilies'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import type { GraphNode } from '../../core/graph'
import type { InferenceResult, NodeIssue } from '../../core/inference'
import type { NodeDefinition } from '../../core/node'
import type { ParamDef, ParamValues } from '../../core/node'
import {
  changedParams,
  configurableParams,
  hiddenParams,
  makeInferContext,
} from '../../core/node'
import { getNodeDef } from '../../core/registry'
import { hasHelp } from '../../help/registry'
import type { CodaType } from '../../core/types'
import { datasetRef, isAssignable, typeLabel } from '../../core/types'
import { describeValue, isDatasetValue } from '../../core/values'
import { useGraphStore } from '../../store/graphStore'
import { exportBaseName } from '../export'
import { formatDuration } from '../format'
import { ParamField } from '../params/ParamField'
import { bucketParams } from '../params/paramGroups'
import { socketStyle } from '../socketStyle'
import { ValuePreview } from '../viewers/ValuePreview'
import { CacheAge } from './CacheAge'
import { DatasetCacheAge } from './DatasetCacheAge'
import { nodeBody } from './nodeBodies'
import { nodeIssues } from './nodeIssues'
import { NodeHints } from './NodeHints'
import { NodeRunRing } from './NodeRunRing'
import { STATE_GLYPH, STATE_TEXT } from './runState'
import { ResultDownload } from './ResultDownload'
import { firstOutputPort, inputPorts, outputPorts } from '../../core/ports'
import { nodePorts } from '../../core/graph'

export interface CodaNodeData {
  [key: string]: unknown
  node: GraphNode
  /**
   * Whether a viewer card on this surface may draw its result. Absent means yes.
   *
   * Set false by the group peek, which mounts real cards inside a modal to show what a folded
   * frame contains — several live viewers is a heavy answer to a glance, and the panel is about
   * structure and settings. A flag on the *data* rather than a context because the data is
   * already per surface: the canvas's cache hands back `{ node }` and this one builds its own.
   */
  previews?: boolean
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
const SELF_DRAWING_NODE_TYPES = new Set([
  'out.viewer3d',
  'out.neuroglancer',
  'out.profile',
  // Draws its input's topology, so it has a card one scheduler step before its own value —
  // and reading the input rather than the output is also what makes the card share the run's
  // memoised metrics instead of computing a second set. See `ValuePreview`'s branch.
  'net.metrics',
  // The two with no outputs at all, so they could never draw from anything else.
  'out.datasetSummary',
  'out.rois',
])

/**
 * Output nodes render their result inline; everything else shows a one-line summary.
 *
 * Read off the definition rather than kept as a second list of the same seven type ids. The
 * hand-maintained one had nothing keeping it in step: a new viewer node would register, show
 * up in the palette and the browser, and then silently render with no inline preview and no
 * resize handles — no error, no failing typecheck, nothing to blame.
 */
export function isViewer(def: NodeDefinition): boolean {
  return def.category === 'visualisation'
}

function CodaNodeViewImpl({
  id,
  data,
  selected,
  draggable,
}: {
  id: string
  data: CodaNodeData
  selected?: boolean
  /**
   * React Flow's answer to "may this card be dragged?", which with no per-node `draggable` in
   * this app is exactly `!locked` — the canvas passes the lock in as `nodesDraggable`. Taken as
   * a prop rather than read from the store, because this component is mounted once per card and
   * a subscription here costs a selector call on every store write, per card, for a flag that
   * moves twice a session. See `resizable`.
   */
  draggable?: boolean
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
  const pinNode = useGraphStore((s) => s.pinNode)
  /*
   * Primitives, so the snapshots compare by identity — invariant 7. `isPinned` is selected as
   * the *comparison* rather than as the raw id, because that is all four readers want: every
   * card would otherwise re-render whenever the pin moved between two other nodes.
   */
  const expandedNodeId = useGraphStore((s) => s.expandedNodeId)
  const isPinned = useGraphStore((s) => s.pinnedNodeId === id)
  const openHelp = useGraphStore((s) => s.openHelp)
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
    const def = getNodeDef(node.type)
    const port = def ? firstOutputPort(def, node.params) : undefined
    return port ? s.nodeOutput(id, port.id) : undefined
  })
  /*
   * Subscribed to, not read — the tick that makes a streamed scene appear.
   *
   * `nodeInputs(id)` below is called during render rather than selected, so nothing about it can
   * schedule one. For a viewer drawing from its inputs that is the *only* thing on the card that
   * moves while an upstream fetch fills in: its own output and its own state are both unchanged,
   * so every selector above returns exactly what it returned before and zustand skips the render.
   *
   * **Constant for everything that is not a viewer**, which is what keeps the cost proportional
   * to the scene rather than to the graph. A publish is four times a second and re-rendering a
   * card also costs two `nodeInputs` walks (a `find` over the nodes plus an `edgeInto` scan per
   * port), so on a sixty-node graph the ungated version was tens of thousands of array scans a
   * second to repaint the two cards that could have changed. `def` is stable per node and the
   * selector still returns a primitive — invariant 7 holds either way.
   */
  const previewable = getNodeDef(node.type)
  const drawsPreviews = previewable !== undefined && isViewer(previewable)
  void useGraphStore((s) => (drawsPreviews ? s.previewVersion : 0))
  // A number or undefined, so the snapshot is a primitive — invariant 7.
  const fetchedAt = useGraphStore((s) => {
    void s.runVersion
    return s.nodeFetchedAt(id)
  })
  /*
   * What the last run said it was doing anyway — a set past a guard rail, a draw that was
   * sampled. A string or undefined, so this is a primitive too.
   *
   * It arrives *during* the run, which is the point: the warning names a wait before the wait,
   * with Cancel an inch away. See `EvalContext.warn`.
   */
  const runWarning = useGraphStore((s) => {
    void s.runVersion
    return s.nodeWarning(id)
  })
  const clearNodeCache = useGraphStore((s) => s.clearNodeCache)
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

  /*
   * Collapsing *or* folding moves the sockets onto the header, and React Flow caches each
   * handle's position
   * in the internal node. It re-measures when a card's measured size changes, which this does —
   * but that is the ResizeObserver's promise rather than ours, and a wire still anchored where
   * the port rows used to be is a confusing thing to debug. So the move is declared.
   *
   * Guarded by a mount-seeded ref rather than firing on every mount: `updateNodeInternals`
   * writes to React Flow's store, and thirty of those on load is thirty store updates for
   * measurements it is about to take anyway. Only an actual change needs declaring.
   */
  const updateNodeInternals = useUpdateNodeInternals()
  const portsOnHeader = node.collapsed === true || node.paramsCollapsed === true
  const wereOnHeader = useRef(portsOnHeader)
  useEffect(() => {
    if (wereOnHeader.current === portsOnHeader) return
    wereOnHeader.current = portsOnHeader
    updateNodeInternals(id)
  }, [id, portsOnHeader, updateNodeInternals])

  const def = getNodeDef(node.type)
  // Dataset cards are tinted by backend; every other category falls through to its own token.
  const backend = backendForNodeType(node.type)
  const types = inference.nodes[id]
  const ctx = useMemo(
    () => (def ? makeInferContext(def, node.params, types?.inputs ?? {}) : undefined),
    [def, node.params, types],
  )
  /*
   * The inspector-only params, and how many of them carry a value somebody chose. The card
   * cannot draw either and the inspector is closed by default, so without this a node fetching
   * five times what its neighbour does looks identical to it.
   */
  const hidden = useMemo(() => (def ? hiddenParams(def, node.params) : []), [def, node.params])
  /*
   * True when the inspector-only params are *all* this node has, which is what makes the hint
   * say "hidden" rather than "more" — Neuroglancer's nine, Skeletons' one. "More" is a claim
   * about something else being on the card, and on those cards there is nothing.
   *
   * Asked of the definition rather than of `visibleParams`, because a node with a body of its
   * own draws no generic rows while its body renders controls all the same: Explore's search
   * box is on the card, so its advanced params are "more". Both sides come from
   * `configurableParams`, or a node whose only other param is a nonce would say "more" while
   * drawing nothing.
   */
  const onlyHidden = useMemo(
    () => def !== undefined && hidden.length === configurableParams(def, node.params).length,
    [def, hidden, node.params],
  )
  const hiddenChanged = useMemo(
    () => changedParams(hidden, node.params).length,
    [hidden, node.params],
  )

  /*
   * The param band in tabs, for a card whose band would otherwise grow without limit.
   *
   * `compare.connectivity` is the case: four params per dataset behind an arity param, so four
   * datasets is sixteen rows and the card is taller than the graph around it. Tabs make the
   * height constant in the arity instead of linear in it.
   *
   * Up here with the other hooks rather than beside the band it feeds, because it is one — the
   * `!def` return below is an early return, and a hook after one is a hook that does not run on
   * every render. `def &&` stands in for the guard that would otherwise be structural.
   *
   * The bucketing is `bucketParams`, shared with the styling panel: the card takes the buckets
   * rather than the panel's rows because it has no composite row to draw and its own field
   * markup, but which tab a param is in is one answer in one place.
   */
  const buckets = useMemo(
    () => (def ? bucketParams(def, node.params, (p) => !p.advanced) : []),
    [def, node.params],
  )
  const [tabId, setTabId] = useState<string | undefined>(undefined)

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

  const inputs = inputPorts(def, node.params)
  const outputs = outputPorts(def, node.params)
  /*
   * The dataset this card *is*, if it is one — read off the inferred output type rather than off
   * the node's params, so a version dropdown and the cache line can never name different
   * releases. Undefined on every other node, which is what gates the cache clause below.
   */
  const datasetOut = datasetRef(types?.outputs?.['dataset'])
  const rowCount = Math.max(inputs.length, outputs.length)
  // Type errors carry a `portId`; the socket ring below reads them directly, since that is a
  // question about one port rather than about the node.
  const typeIssues = types?.issues ?? []
  // One line: the worst of what this node has to say. The inspector shows the same list whole,
  // and the ranking is `nodeIssues`' so the two cannot drift apart.
  const shownIssue: NodeIssue | undefined = nodeIssues(info, types?.issues, runWarning)[0]

  /*
   * A node with its own body owns the whole area below the sockets. Its params are still real
   * params — reachable in the inspector, saved, part of the provenance key — but rendering them
   * as fields *as well* would put a raw "Search" text box under the search bar that writes it.
   */
  const body = nodeBody(node.type)
  /*
   * Flattened out of the buckets rather than filtered a second time. `bucketParams` invents
   * nothing and drops nothing — a param the definition did not place lands in a trailing "Other"
   * — so the flattening is exactly the band a flat card draws, and a node with no declared
   * groups gets one bucket holding everything in declaration order. The alternative was this
   * predicate written twice in one file, once here and once inside the memo, with the file then
   * choosing between the two results.
   */
  const visibleParams = body ? [] : buckets.flatMap((bucket) => bucket.params)

  /*
   * Not while the overlay or the dock is showing this same node.
   *
   * A viewer is a *renderer*, not a picture: the network and 3D viewers each take a WebGL
   * context of their own and upload their own copy of the geometry to the GPU, so a node drawn
   * in two places at once is two contexts, two copies and two redraws on every invalidation —
   * measured at 3 contexts and 3 × 170 kB for a 21-neuron scene with the card, the inspector
   * and the overlay all up. The overlay is modal and larger, so while it owns a node there is
   * nothing behind it worth paying for.
   *
   * The **dock** is the same argument with the modality removed: it is a third mount site for
   * one node, drawn at half the window, and the card behind it is a thumbnail of the thing
   * already on screen. That the store refuses to hold one node in both the dock and the overlay
   * caps this at two possible surfaces rather than three; this caps the live ones at one.
   *
   * The cost of standing down is a remount when the surface closes, which re-frames the card's
   * camera. That is the right way round: somebody who has just been working full size is not
   * also curating the thumbnail behind it.
   */
  const showPreview =
    isViewer(def) &&
    data.previews !== false &&
    !node.collapsed &&
    expandedNodeId !== id &&
    !isPinned &&
    (outputValue !== undefined || SELF_DRAWING_NODE_TYPES.has(node.type))

  /*
   * Only viewers resize, and only while they are showing one. A transform node's height is
   * decided by its params, so a drag handle there would promise a control that does nothing,
   * and a collapsed node is a title bar — stretching that means nothing either.
   *
   * A locked canvas has no handles at all rather than handles that refuse: `NodeResizer` runs
   * its own pointer gesture and never consults `nodesDraggable`, so the prop that stops a drag
   * does nothing to a resize — this is where that has to be said again. `resizeNodes` refuses
   * the write as a backstop, which without this would draw a card being stretched and snap it
   * back on release.
   */
  const resizable = isViewer(def) && !node.collapsed && draggable !== false
  /*
   * Whether this card offers the two full-size routes at all. One name for one question, so the
   * expand and pin buttons cannot drift apart — a third surface would otherwise add a third copy
   * of the same condition to the same header.
   */
  const canOpenFullSize = outputValue !== undefined || body?.expandable
  /**
   * True when React Flow's wrapper carries an explicit width for this card, so the card fills it
   * rather than taking `--node-width`.
   *
   * Asked without reference to `collapsed`, unlike `resizable`, because the wrapper keeps its
   * width through a collapse — a card that jumped from 560 to 232 on its way to a title bar
   * would move every wire on it twice. Only the *height* half of filling the box is dropped,
   * which is what `[data-collapsed]` turns off in the stylesheet.
   */
  const sized = isViewer(def) && (node.size !== undefined || def.defaultSize !== undefined)

  /*
   * Whether there is a param band to fold, and whether it currently is folded.
   *
   * Every card that draws one, not only the viewers. On a viewer the freed height goes to the
   * drawing, which is the case this was built for; on a transform node the card simply gets
   * shorter, which is worth having on its own — a settled pipeline is a row of decisions
   * already made, and reading the graph then means reading the titles and the wires.
   *
   * That it is safe everywhere comes from where the button sits: it is in the *header*, so it
   * survives the band it hides and there is always something to press. Distinct from
   * `collapsed`, which also takes the ports' labels, the footer's summary and any preview —
   * folded, a node still says what it is holding.
   *
   * The `visibleParams.length` check is what keeps a card from growing a button for a band it
   * does not draw: a node whose params are all `advanced`, and every node with a body of its
   * own, which renders its own controls instead of the generic rows.
   */
  /*
   * The `☰` fold takes the param rows *and* the port rows, leaving the header, the body and the
   * footer — so on a viewer the drawing gets both bands back, which is the whole reason it
   * exists. Offered wherever there is either kind of row to fold, not only where there are
   * params: Neuroglancer's card is nine advanced params and two sockets, and the sockets are
   * the only thing on it a fold can reclaim.
   *
   * Safe on any card because the button is in the *header*, which survives everything it hides.
   */
  const foldable = !node.collapsed && (visibleParams.length > 0 || rowCount > 0)
  const folded = foldable && node.paramsCollapsed === true
  const showParams = !node.collapsed && !folded && visibleParams.length > 0

  /*
   * **Only past two tabs.** One tab is a strip that offers no choice, above rows it was already
   * showing — pure chrome. That single rule is also what keeps this from reaching cards nobody
   * asked it to: `out.viewer3d` draws no generic rows at all and `out.network` draws one, in one
   * group, so neither grows a strip. `out.scatter` does, and there the shorter band goes to the
   * plot, which is the same trade the fold above is for.
   */
  const tabbed = buckets.length > 1
  /*
   * Resolved against the live buckets rather than trusted, because a tab can *leave*: turning
   * `datasetCount` down from 4 to 2 takes `Dataset 3` and `Dataset 4` with it, and a card
   * holding a dead id would draw a strip with nothing selected and no rows under it.
   */
  const tab = buckets.find((b) => b.id === tabId) ?? buckets[0]
  const bandParams = tabbed && tab ? tab.params : visibleParams
  /*
   * The hint rides at the end of the band but is not gated on it: the cards that need it most
   * are the ones drawing *no* rows at all — Skeletons has a single param and it is advanced, so
   * an empty body is all there was to go on. It does go away with a fold, which is the one case
   * where something else on the card is already saying "there is more here".
   */
  const showHidden = !node.collapsed && !folded && hidden.length > 0

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
       * A sibling for the same reason, and the component says at length why hints are drawn
       * outside the card rather than in the issue band.
       *
       * **Guarded, and the guard is the point.** `NodeHints` subscribes to which hints this
       * reader has dismissed, and this component is mounted once per card — the note on
       * `draggable` above states the rule that follows: a subscription here costs a call on
       * every write, per card. Almost no node carries a hint (a wizard graph has three), so
       * mounting it everywhere would buy a live subscription per card to render nothing.
       */}
      {node.hints?.length ? <NodeHints node={node} /> : null}
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
        data-collapsed={node.collapsed || undefined}
        /* Both states put the sockets on the header; the stylesheet needs one name for that. */
        data-ports-folded={node.collapsed || folded || undefined}
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
        <div
          className="coda-node__header"
          data-category={def.category}
          {...(backend ? { 'data-backend': backend.id } : {})}
          title={def.description}
        >
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
          {/*
           * The two ways to open this result full size. One condition, because they are the same
           * question — an expandable body offers both before the node has ever run, which is most
           * of the point of Explore, whose list is populated whether or not the ports carry
           * anything.
           *
           * Two buttons rather than one, because they answer different moments: ⤢ is "let me look
           * at this", ⇥ is "keep this beside me while I work", and a single control that did both
           * would have to guess which. The pin's glyph is an arrow to a bar — the result, sent to
           * the edge of the screen.
           */}
          {canOpenFullSize && (
            <>
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
              <button
                type="button"
                className="coda-node__run nodrag"
                aria-pressed={isPinned}
                title={
                  isPinned
                    ? 'Unpin from the side of the canvas'
                    : 'Pin this result to the side of the canvas'
                }
                aria-label={isPinned ? 'Unpin output' : 'Pin output to the side'}
                onClick={(e) => {
                  e.stopPropagation()
                  pinNode(isPinned ? undefined : id)
                }}
              >
                ⇥
              </button>
            </>
          )}
          {/*
           * `?` appears because a document exists for this node type and for no other reason —
           * see `src/help/registry.ts`. So most cards never grow a sixth button, and the ones
           * that do are the ones where somebody was moved to write several pages.
           */}
          {hasHelp(node.type) && (
            <button
              type="button"
              className="coda-node__help nodrag"
              title={`What ${def.label} does, and what it assumes`}
              aria-label={`Help for ${def.label}`}
              onClick={(e) => {
                e.stopPropagation()
                openHelp(node.type)
              }}
            >
              ?
            </button>
          )}
          {/* Stays in the header rather than on the band it controls: folded, the band is not
            rendered at all, so a toggle living inside it would have nothing left to press —
            the same rule the minimap's rail button and the overlay's Style button follow. */}
          {foldable && (
            <button
              type="button"
              className="coda-node__fold nodrag"
              aria-pressed={folded}
              title={
                folded
                  ? 'Show the parameters and ports'
                  : 'Hide the parameters and ports, giving the space to what is below them'
              }
              aria-label={folded ? 'Show parameters and ports' : 'Hide parameters and ports'}
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
            const inputPortError = typeIssues.some(
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

        {(showParams || showHidden) && (
          <div className="coda-node__params">
            {showParams && tabbed && (
              /*
               * `nodrag` because a click on the canvas is a node drag by default, and `nowheel`
               * is deliberately absent: the strip does not scroll, so the canvas keeps the wheel.
               */
              <div className="coda-node__tabs nodrag" role="tablist">
                {buckets.map((bucket) => (
                  <button
                    type="button"
                    key={bucket.id}
                    role="tab"
                    className="coda-node__tab"
                    aria-selected={bucket.id === tab?.id}
                    title={`${bucket.label} — ${bucket.params.length} setting${bucket.params.length === 1 ? '' : 's'}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setTabId(bucket.id)
                    }}
                  >
                    {bucket.label}
                  </button>
                ))}
              </div>
            )}
            {showParams &&
              bandParams.map((param) => (
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
            {showHidden && (
              /*
               * Right-aligned and muted, in the register of a "…more" affordance rather than a
               * warning: on most nodes this is a fact about the node *type* and nothing anybody
               * did. The changed count is the half that is about this particular node, so it
               * takes a step up in ink and nothing else.
               */
              <button
                type="button"
                className="coda-node__more nodrag"
                title={`${hidden.length} ${onlyHidden ? 'hidden' : 'more'} in the inspector: ${hidden
                  .map((p) => (isChanged(p, node.params) ? `${p.label} (changed)` : p.label))
                  .join(', ')}. Click to open.`}
                aria-label={`${hidden.length} ${onlyHidden ? 'hidden' : 'more'} ${
                  hidden.length === 1 ? 'parameter' : 'parameters'
                } in the inspector${hiddenChanged > 0 ? `, ${hiddenChanged} changed` : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  /*
                   * Read at click time rather than subscribed to: every card would re-render on
                   * an unrelated inspector toggle, and `togglePanel` is the only setter there is
                   * — so an open inspector must not be closed by a button that means "show me".
                   */
                  const store = useGraphStore.getState()
                  store.setSelection([id])
                  if (!store.panels.inspector) store.togglePanel('inspector')
                }}
              >
                … {hidden.length} {onlyHidden ? 'hidden' : 'more'}
                {hiddenChanged > 0 && (
                  <span className="coda-node__more-set"> ({hiddenChanged} changed)</span>
                )}
              </button>
            )}
          </div>
        )}

        {body && !node.collapsed && (
          <div className="coda-node__body">
            <body.Component
              node={node}
              ctx={ctx}
              compact
              inputValues={nodeInputs(id)}
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
            {/*
             * How old the data behind this result is, and the control that replaces it. Absent
             * unless the node reported a fetch, so it never appears on a node with nothing to
             * re-read — and it says so even when the answer is `0s`, because a line that shows
             * up only when something is wrong is one nobody learns to look at.
             */}
            <CacheAge
              fetchedAt={fetchedAt}
              onRefresh={() => {
                clearNodeCache(id)
                void runNode(id)
              }}
            />
            {/*
             * The same clause for a dataset card, reading the cache rather than the run.
             *
             * A dataset node fetches none of what goes stale — its `evaluate` resolves metadata,
             * while the neuron index behind every Explore and Find Neurons is downloaded later
             * and kept for a month. So `fetchedAt` above is always undefined here and this looks
             * the age up instead. See `DatasetCacheAge`.
             */}
            {datasetOut && (
              <DatasetCacheAge
                sourceId={datasetOut.sourceId}
                datasetId={datasetOut.datasetId}
                annotations={isDatasetValue(outputValue) ? outputValue.annotations : undefined}
              />
            )}
            {/*
             * Write this node's result to a file, for the cards that have no viewer to ask.
             *
             * Withheld where the card is drawing one, because that card already carries a ⤓ an
             * inch above this — and it is the better of the two there, since a viewer can offer
             * its picture as SVG and PNG where a value cannot. Saying the same thing twice on
             * one card is the rule the `… N more` hint follows when it stands down on a fold.
             */}
            {!showPreview && (
              <ResultDownload
                value={outputValue}
                baseName={exportBaseName(graphName, node.title ?? def.label)}
                onError={setNotice}
              />
            )}
          </div>
        )}
      </div>
    </>
  )
}

/** Whether this param holds something other than what its definition declared. */
function isChanged(param: ParamDef, values: ParamValues): boolean {
  return changedParams([param], values).length > 0
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
  return node ? nodePorts(node, 'input').find((p) => p.id === origin.portId)?.type : undefined
}

export const CodaNodeView = memo(CodaNodeViewImpl)
