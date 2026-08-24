/**
 * The canvas.
 *
 * React Flow owns pan/zoom/hit-testing; the store owns the document. Node positions round
 * trip through the store (so undo and autosave cover them) but never trigger evaluation.
 *
 * Interaction model, borrowed where the references got it right:
 *   Tab / ⇧A                 open the node browser (previews, category filters)
 *   Space                    open the command palette
 *   double-click / right-click  compact palette, prefilled to node insertions
 *   drag a link into space   palette filtered to nodes that accept the dragged type
 *   drag a link's end off     re-route it, or drop on empty canvas to unplug
 *   right-click a link       its own menu, naming both ends
 *   M / H / ⌘D               mute / collapse / duplicate the selection
 *   ⇧R                       run everything stale
 *   F                        real fullscreen, i.e. the browser's chrome gone
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import type {
  Edge,
  FinalConnectionState,
  HandleType,
  IsValidConnection,
  Node,
  NodeChange,
  OnConnectEnd,
  OnReconnect,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CodaGraph, GraphNode } from '../core/graph'
import { getNodeDef, isAnnotation } from '../core/registry'
import type { CodaType } from '../core/types'
import { referenceEdgeIds } from '../core/graph'
import { spliceCandidate } from '../core/splice'
import { useGraphStore } from '../store/graphStore'
import { edgeUnderRect } from './spliceHit'
import type { CodaNodeData } from './nodes/CodaNodeView'
import { CodaNodeView } from './nodes/CodaNodeView'
import { NoteCard } from './nodes/NoteCard'
import { CodaEdge } from './CodaEdge'
import { CommandPalette } from './panels/CommandPalette'
import { LayoutControls } from './panels/LayoutControls'
import { LockControl } from './panels/LockControl'
import { ViewControls } from './panels/ViewControls'
import { EdgeContextMenu } from './panels/EdgeContextMenu'
import { NodeBrowser } from './panels/NodeBrowser'
import { NodeContextMenu } from './panels/NodeContextMenu'
import type { PaletteItem } from './panels/paletteItems'
import { buildCommandItems, buildNodeItems } from './panels/paletteItems'
import { requestExportWarnings, useExportWarnings } from './exportWarnings'
import { FIT_VIEW_OPTIONS, useFitAll, useFitSelected } from './fitView'
import { LOCKED_NOTICE } from './lockCopy'
import { appElement, toggleFullscreen } from './fullscreen'
import { typeColorVar } from './socketStyle'
import { useArrange } from './useArrange'
import { useDownloads } from './useDownloads'

/**
 * Minimap size.
 *
 * Passed to the component as a `style` prop rather than set in the stylesheet: React Flow reads
 * `style.width`/`style.height` to compute the map's viewBox, so sizing it in CSS alone leaves it
 * drawing a 200x150 projection into whatever box CSS produced.
 */
const MINIMAP_SIZE = { width: 180, height: 120 }

/*
 * Module constants rather than array literals in the JSX, because React Flow diffs these three by
 * *identity*: a fresh array per render re-runs `panZoom.update` (rebuilding d3-zoom's filters) and
 * tears down and re-adds `useKeyPress`'s four window listeners. This canvas re-renders on every
 * graph, selection, run-status and notice change, so that was happening constantly.
 */
const PAN_BUTTONS = [0, 1, 2]
const MULTI_SELECT_KEYS = ['Meta', 'Control']
const DELETE_KEYS = ['Delete', 'Backspace']

/*
 * Two card renderers, chosen per node by `isAnnotation`. A text note has no header, no sockets
 * and no run state, so it is a different component rather than a branch inside `CodaNodeView` —
 * that component's hooks all subscribe to run state, and a card with none would be paying for
 * every one of them on every scheduler tick.
 */
/** Shared, so the hit test's `exclude` argument is not a fresh Set on every pointer move. */
const EMPTY_IDS: ReadonlySet<string> = new Set()

const NODE_TYPES = { coda: CodaNodeView, note: NoteCard }

/**
 * One edge type for all three routings. Registered rather than left to React Flow's default
 * bezier, which is what every wire was before routing existed — `CodaEdge` still draws exactly
 * that whenever it has no route to follow, so `curved` is not a reimplementation of the old
 * behaviour, it is the old behaviour reached through one more component.
 */
const EDGE_TYPES = { coda: CodaEdge }

/** Keeps `data` object identity stable per GraphNode so memoised nodes don't re-render. */
const dataCache = new WeakMap<GraphNode, CodaNodeData>()

function dataFor(node: GraphNode): CodaNodeData {
  const cached = dataCache.get(node)
  if (cached) return cached
  const data: CodaNodeData = { node }
  dataCache.set(node, data)
  return data
}

/** Prefix that restricts the palette to node insertions. */
const ADD_PREFIX = 'Add:'

interface MenuState {
  /** Bumped per open, and used as the palette's React key so its state resets. */
  seq: number
  screenPosition: { x: number; y: number }
  flowPosition: { x: number; y: number }
  /** Prefilled search text. `Add:` narrows the list to node insertions. */
  initialQuery: string
  /** Present when the palette was opened by dragging a link into empty canvas. */
  filter?: { type: CodaType; from: 'source' | 'target' }
  /** Set alongside `filter`, so the inserted node can be wired up immediately. */
  connectFrom?: { nodeId: string; portId: string; handleType: 'source' | 'target' }
}

function EditorCanvas() {
  const graph = useGraphStore((s) => s.graph)
  const selection = useGraphStore((s) => s.selection)
  const inference = useGraphStore((s) => s.inference)
  const notice = useGraphStore((s) => s.notice)
  const setNotice = useGraphStore((s) => s.setNotice)
  // Primitives, not the panels object: snapshots are compared by identity and `togglePanel`
  // returns a fresh one each call.
  const minimapOpen = useGraphStore((s) => s.panels.minimap)
  const togglePanel = useGraphStore((s) => s.togglePanel)

  const { screenToFlowPosition } = useReactFlow()
  const fitAll = useFitAll()
  const fitSelected = useFitSelected()
  // A primitive — invariant 7. What the lock covers is written up on `GraphState.locked`.
  const locked = useGraphStore((s) => s.locked)
  /**
   * Refuse a gesture the lock covers, and say so. `true` means "handled — stop here".
   *
   * Five call sites reach this: the node browser, the palette's pick, both pane gestures and the
   * keyboard. Reads through `getState()` rather than the subscribed flag so the callbacks that
   * hold it keep their identity — `openBrowser` is a dependency of the keyboard effect.
   */
  const refuseIfLocked = useCallback((): boolean => {
    if (!useGraphStore.getState().locked) return false
    setNotice(LOCKED_NOTICE)
    return true
  }, [setNotice])
  const { arrange, overrides: arrangeOverrides, routes: arrangeRoutes } = useArrange()
  // A primitive, so the snapshot identity check is satisfied — invariant 7.
  const edgeRouting = useGraphStore((s) => s.edgeRouting)
  // Mounted here rather than from the Download node's own card: a collapsed card unmounts its
  // body, and a Download node that stopped writing when somebody tidied it away would be a bug
  // nobody could reproduce on purpose.
  useDownloads()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const pointerRef = useRef({ x: 0, y: 0 })
  const draggingRef = useRef(false)
  // The wire a drop would insert the dragged card into; drawn highlighted while it is set.
  const [spliceEdgeId, setSpliceEdgeId] = useState<string | undefined>(undefined)
  const resizingRef = useRef(false)
  const menuSeq = useRef(0)

  const [menu, setMenu] = useState<MenuState | null>(null)

  /**
   * Live state, but only while the palette is open.
   *
   * `buildCommandItems` reads stale counts and undo depth, so its input has to be the whole
   * state object — and subscribing to that unconditionally re-rendered the entire canvas on
   * every `runVersion` bump, i.e. once per manifest and once per fragment of a mesh fetch.
   * Closed, the selector returns a stable `null` and nothing here re-renders; open, the
   * `disabled` flags stay as honest as they ever were.
   *
   * Everything else on the store is an action, and actions never change identity — those go
   * through `getState()` at call time instead, which is always current and never subscribes.
   */
  const liveStore = useGraphStore((s) => (menu ? s : null))
  /** Flow position an inserted node should land at, set when the browser opens. */
  const [browserAt, setBrowserAt] = useState<{ x: number; y: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    screenPosition: { x: number; y: number }
    nodeId: string
  } | null>(null)
  const [edgeMenu, setEdgeMenu] = useState<{
    screenPosition: { x: number; y: number }
    edgeId: string
  } | null>(null)

  // --- derive React Flow's arrays -----------------------------------------

  const selectedSet = useMemo(() => new Set(selection), [selection])

  const rfNodes = useMemo<Node<CodaNodeData>[]>(
    () =>
      graph.nodes.map((node) => {
        // `node.size` is a decision someone made; `defaultSize` is the definition's ask. Read
        // as a fallback rather than stamped at creation, so every path that makes a node gets
        // it and only a real resize lands in the file.
        const size = node.size ?? getNodeDef(node.type)?.defaultSize
        return {
          id: node.id,
          type: isAnnotation(node.type) ? 'note' : 'coda',
          // While an arrange is gliding, the card is drawn from the animation rather than from
          // the document — the store gets one commit at the end, not one per frame.
          position: arrangeOverrides?.get(node.id) ?? node.position,
          data: dataFor(node),
          selected: selectedSet.has(node.id),
          /*
           * Width always, height only while the card is showing something. A collapsed card is
           * a header, and pinning the wrapper to a 620px Profile box leaves it floating in the
           * top-left of an empty rectangle — with `.coda-node::before` inset against the
           * *wrapper*, so the state bar hangs 570px below it as a coloured line with nothing
           * beside it. Letting the height go auto also makes the wrapper actually shrink, which
           * is what re-measures the handles now that collapsing moves them.
           */
          ...(size
            ? { width: size.width, ...(node.collapsed ? {} : { height: size.height }) }
            : {}),
        }
      }),
    [graph.nodes, selectedSet, arrangeOverrides],
  )

  /** Only the `disabled` flag is read per edge, so a set beats a node lookup per edge. */
  const disabledIds = useMemo(
    () => new Set(graph.nodes.filter((n) => n.disabled).map((n) => n.id)),
    [graph.nodes],
  )

  /*
   * Which wires name a node rather than carrying its output, so the edge memo below can mark
   * them without a registry lookup per edge.
   *
   * Keyed on `graph`, like `disabledIds` two lines up is on `graph.nodes` — and with the same
   * honest caveat: `moveNodes` mints a fresh `nodes` array per drag frame, so both recompute on
   * every frame of a drag. That costs nothing measurable, and it is already true of `rfEdges`
   * either way; the earlier comment here claimed the opposite, which was simply wrong.
   */
  const referenceIds = useMemo(() => referenceEdgeIds(graph), [graph])

  const rfEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const sourceType = inference.nodes[edge.source]?.outputs[edge.sourceHandle]
        const muted = disabledIds.has(edge.source)
        /*
         * A route reaches the wire only under `orthogonal`. `curved` withholds it rather than
         * having the component check the mode: the mode is a fact about the canvas and the route
         * a fact about one wire, and letting the edge read both is how a wire ends up bent in a
         * mode that says it should not be.
         */
        const orthogonal = edgeRouting === 'orthogonal'
        const route = orthogonal ? arrangeRoutes?.get(edge.id) : undefined
        return {
          id: edge.id,
          type: 'coda',
          source: edge.source,
          sourceHandle: edge.sourceHandle,
          target: edge.target,
          targetHandle: edge.targetHandle,
          data: { route, step: orthogonal },
          /*
           * Two independent marks, **joined** rather than spread as two `className` keys — the
           * later spread silently won, so a reference wire that was also the splice candidate
           * lost its splice highlight with nothing failing. The cost of the shape is not that
           * one missing mark: it is that the third thing wanting a class would have clobbered
           * the second the same way.
           *
           * `--splice`: the wire a dropped card would be inserted into, marked *during* the drag,
           * because a drop that rewires the graph with no warning is a surprise whatever it does
           * afterwards. `--reference`: a wire that names a node rather than carrying its output,
           * drawn dotted because a wire carrying no data should not look like one that does.
           */
          className:
            [
              edge.id === spliceEdgeId && 'coda-edge--splice',
              referenceIds.has(edge.id) && 'coda-edge--reference',
            ]
              .filter(Boolean)
              .join(' ') || undefined,
          // Links wear the colour of the data flowing through them, as in Blender.
          style: {
            stroke: typeColorVar(sourceType),
            strokeWidth: 1.8,
            ...(muted ? { strokeDasharray: '4 3', opacity: 0.5 } : {}),
          },
        }
      }),
    [
      graph.edges,
      disabledIds,
      inference,
      edgeRouting,
      arrangeRoutes,
      spliceEdgeId,
      referenceIds,
    ],
  )

  // --- change handlers ----------------------------------------------------

  /**
   * The edge a card at this position would be inserted into, or undefined.
   *
   * Two halves, and both have to say yes: the wire has to run under the card (`edgeUnderRect`,
   * which walks the *drawn* path so a route or an orthogonal step is judged where it is shown),
   * and the node has to have a pair of ports that fit (`spliceCandidate`, which is where every
   * decision lives).
   *
   * The card's size comes from `offsetWidth`, the rule `useArrange` records at length: React
   * Flow's `measured` is wiped on every graph edit here, and a bounding rect is in screen pixels
   * and would shrink with the camera — where a hit test against flow-space path coordinates needs
   * flow units.
   */
  const spliceOn = useCallback((nodeId: string): string | undefined => {
    const store = useGraphStore.getState()
    const node = store.graph.nodes.find((n) => n.id === nodeId)
    if (!node) return undefined
    const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`)
    if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return undefined

    const edgeId = edgeUnderRect(
      {
        x: node.position.x,
        y: node.position.y,
        width: el.offsetWidth,
        height: el.offsetHeight,
      },
      // Nothing to exclude: an isolated node touches no wire, and `spliceCandidate` refuses a
      // node that is not isolated — so a wire of the dragged node's own can never be a target.
      EMPTY_IDS,
    )
    if (!edgeId) return undefined

    const edge = store.graph.edges.find((e) => e.id === edgeId)
    if (!edge) return undefined
    return spliceCandidate(store.graph, store.inference, nodeId, edge) ? edgeId : undefined
  }, [])

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CodaNodeData>>[]) => {
      const moves: Array<{ id: string; position: { x: number; y: number } }> = []
      const sizes: Array<{ id: string; size: { width: number; height: number } }> = []
      let selectionChanged = false
      const nextSelection = new Set(selection)

      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          moves.push({ id: change.id, position: change.position })
          draggingRef.current = change.dragging === true
        } else if (change.type === 'dimensions') {
          /*
           * Only a *deliberate* resize. React Flow emits `dimensions` for its own
           * measurements too — every mount, every content change — and those carry no
           * `setAttributes`. Persisting them would write a measured pixel size into the
           * document on load and fill the undo stack with things nobody did.
           */
          if (!change.setAttributes || !change.dimensions) continue
          sizes.push({ id: change.id, size: change.dimensions })
          resizingRef.current = change.resizing === true
        } else if (change.type === 'select') {
          selectionChanged = true
          if (change.selected) nextSelection.add(change.id)
          else nextSelection.delete(change.id)
        } else if (change.type === 'remove') {
          useGraphStore.getState().deleteNodes([change.id])
        }
      }

      if (moves.length > 0) {
        /*
         * Dropping an isolated card on a wire inserts it there. Only ever one card — splicing a
         * whole selection into one link means nothing — and only where `spliceCandidate` found a
         * pair of ports, so an incompatible node dropped on a wire is an ordinary move.
         */
        const candidate = moves.length === 1 ? spliceOn(moves[0]!.id) : undefined
        if (!draggingRef.current) {
          setSpliceEdgeId(undefined)
          if (candidate && moves.length === 1) {
            useGraphStore.getState().spliceNode(moves[0]!.id, candidate, moves)
            return
          }
        } else {
          setSpliceEdgeId(candidate)
        }
        // History gets one entry per drag, recorded when the drag ends.
        useGraphStore.getState().moveNodes(moves, !draggingRef.current)
      }
      if (sizes.length > 0) {
        useGraphStore.getState().resizeNodes(sizes, !resizingRef.current)
      }
      if (selectionChanged) {
        useGraphStore
          .getState()
          .setSelection(graph.nodes.filter((n) => nextSelection.has(n.id)).map((n) => n.id))
      }
    },
    [graph.nodes, selection, spliceOn],
  )

  const isValidConnection = useCallback<IsValidConnection>((candidate) => {
    if (!candidate.source || !candidate.target) return false
    return useGraphStore
      .getState()
      .canConnect(
        { nodeId: candidate.source, portId: candidate.sourceHandle ?? '' },
        { nodeId: candidate.target, portId: candidate.targetHandle ?? '' },
      ).ok
  }, [])

  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, connectionState) => {
      // Landed on a node: React Flow already fired onConnect (or rejected it).
      if (connectionState.toNode || !connectionState.fromHandle || !connectionState.fromNode) {
        return
      }
      const point =
        'clientX' in event
          ? { x: event.clientX, y: event.clientY }
          : { x: event.touches[0]?.clientX ?? 0, y: event.touches[0]?.clientY ?? 0 }

      const handle = connectionState.fromHandle
      const type = portTypeOf(
        graph,
        inference,
        handle.nodeId,
        handle.id ?? '',
        handle.type === 'source' ? 'output' : 'input',
      )
      if (!type) return

      setMenu({
        seq: ++menuSeq.current,
        screenPosition: point,
        flowPosition: screenToFlowPosition(point),
        // The item list is already nodes-only here, so no prefix is needed — the type hint
        // above the list explains the narrowing.
        initialQuery: '',
        filter: { type, from: handle.type === 'source' ? 'source' : 'target' },
        connectFrom: {
          nodeId: handle.nodeId,
          portId: handle.id ?? '',
          handleType: handle.type === 'source' ? 'source' : 'target',
        },
      })
    },
    [graph, inference, screenToFlowPosition],
  )

  /**
   * Re-routing a link: drag either end off its socket and drop it on another.
   *
   * Both ends are grabbable. The input end answers "where should this go?", the output end
   * "what should feed this?" — and both anchors sit just *outside* the card, offset along the
   * wire, so neither competes with the socket's own "drag a new link out" gesture.
   *
   * The store validates it as it would a fresh connection and keeps the edge's id, so the whole
   * gesture is one undo step rather than a delete and an add.
   */
  const onReconnect = useCallback<OnReconnect>((oldEdge, connection) => {
    useGraphStore.getState().reconnect(oldEdge.id, {
      source: connection.source,
      sourceHandle: connection.sourceHandle ?? '',
      target: connection.target,
      targetHandle: connection.targetHandle ?? '',
    })
  }, [])

  /**
   * The other half of the gesture: dropped on nothing means unplug.
   *
   * `toHandle` is the discriminator, and it is the *only* honest one — React Flow sets it
   * whenever the drop landed on a socket, valid or not. So a drop that a port refused (wrong
   * type, would cycle) leaves the link alone and the wire snaps back, while a drop into empty
   * canvas breaks it. Answering a mis-aimed drop by deleting the link would make every failed
   * re-route cost the connection as well.
   *
   * Note this runs *after* `onReconnect` on a successful drop, which is why it cannot simply
   * delete on "no reconnect happened".
   */
  const onReconnectEnd = useCallback(
    (
      _event: MouseEvent | TouchEvent,
      edge: Edge,
      _handleType: HandleType,
      connectionState: FinalConnectionState,
    ) => {
      if (!connectionState.toHandle) useGraphStore.getState().deleteEdges([edge.id])
    },
    [],
  )

  const openPalette = useCallback(
    (screenPosition: { x: number; y: number }, initialQuery = '') => {
      setContextMenu(null)
      setEdgeMenu(null)
      setMenu({
        seq: ++menuSeq.current,
        screenPosition,
        flowPosition: screenToFlowPosition(screenPosition),
        initialQuery,
      })
    },
    [screenToFlowPosition],
  )

  const openBrowser = useCallback(
    (screenPosition: { x: number; y: number }) => {
      // The single gate for adding a node: Tab, ⇧A, the toolbar's + Add and the palette's
      // `Browse All Nodes…` all arrive here, so one check covers the lot.
      if (refuseIfLocked()) return
      setMenu(null)
      setContextMenu(null)
      setEdgeMenu(null)
      setBrowserAt(screenToFlowPosition(screenPosition))
    },
    [screenToFlowPosition, refuseIfLocked],
  )

  /**
   * Items for the open palette. Commands are only offered for a bare Space — a
   * drag-into-space is unambiguously "insert a node here", and mixing "Undo" into that
   * list would be noise.
   */
  /*
   * The palette's export rows can say how much of the graph will come out as a TODO, and the
   * only honest way to know is to run the exporter — so it is started here, when the palette
   * opens, rather than from `buildCommandItems`, which runs on every store change while it is
   * open. `useExportWarnings` is the cursor that re-renders when an answer lands.
   */
  const exportWarningsRevision = useExportWarnings()
  useEffect(() => {
    if (menu) requestExportWarnings(useGraphStore.getState().graph)
  }, [menu])

  const paletteItems = useMemo<PaletteItem[]>(() => {
    // Read so the dependency is a real one: `buildCommandItems` calls `peekExportWarnings`,
    // which answers differently once a walk has landed and is invisible to the lint rule.
    // `Inspector`'s `void s.runVersion` is the same idiom in a selector.
    void exportWarningsRevision
    if (!menu) return []
    if (menu.filter) return buildNodeItems(menu.filter, locked)
    return [
      ...buildCommandItems({
        store: liveStore ?? useGraphStore.getState(),
        fitView: fitAll,
        fitSelected,
      }),
      ...buildNodeItems(undefined, locked),
    ]
    // `liveStore` is the whole state object while the palette is open, so this recomputes
    // whenever anything changes — which is what keeps `disabled` flags honest. The revision is
    // in the list for the same reason: an export warning that lands after the palette opened
    // has to reach the row it is about.
  }, [menu, liveStore, locked, fitAll, fitSelected, exportWarningsRevision])

  /** Run a command, or insert a node and wire it to the drag origin. */
  const handlePick = useCallback(
    (item: PaletteItem) => {
      if (!menu) return

      if (item.perform) {
        setMenu(null)
        item.perform()
        return
      }
      if (!item.nodeType) {
        setMenu(null)
        return
      }

      // The palette's node rows are disabled while locked, so this is the backstop — and the
      // one that matters, because `addNode` answers a locked canvas with an empty id and the
      // auto-wire below would then blame the *link* for a node that was never added.
      if (refuseIfLocked()) {
        setMenu(null)
        return
      }

      // Drop the node so its top-left lands near the pointer rather than under it.
      const position = { x: menu.flowPosition.x - 12, y: menu.flowPosition.y - 18 }
      const newId = useGraphStore.getState().addNode(item.nodeType, position)

      const origin = menu.connectFrom
      if (origin && item.portId) {
        const ok =
          origin.handleType === 'source'
            ? useGraphStore.getState().connect({
                source: origin.nodeId,
                sourceHandle: origin.portId,
                target: newId,
                targetHandle: item.portId,
              })
            : useGraphStore.getState().connect({
                source: newId,
                sourceHandle: item.portId,
                target: origin.nodeId,
                targetHandle: origin.portId,
              })
        if (!ok) setNotice('Node added, but the link was rejected')
      }
      setMenu(null)
    },
    [menu, refuseIfLocked, setNotice],
  )

  /*
   * The toolbar sits outside the React Flow provider and cannot convert screen coordinates,
   * so both of its buttons ask through the store and land here.
   *
   * The refs record which request was last acted on, seeded with whatever the counter is at
   * mount. Without that, a remount after any earlier request would re-fire it and pop the
   * widget open unprompted — the store outlives this component.
   */
  const paletteRequest = useGraphStore((s) => s.paletteRequest)
  const handledPalette = useRef(paletteRequest.seq)
  useEffect(() => {
    if (paletteRequest.seq === handledPalette.current) return
    handledPalette.current = paletteRequest.seq
    openPalette(
      anchorPoint(wrapperRef.current, pointerRef.current),
      paletteRequest.initialQuery,
    )
  }, [paletteRequest, openPalette])

  const browserRequest = useGraphStore((s) => s.browserRequest)
  const handledBrowser = useRef(browserRequest)
  useEffect(() => {
    if (browserRequest === handledBrowser.current) return
    handledBrowser.current = browserRequest
    openBrowser(anchorPoint(wrapperRef.current, pointerRef.current))
  }, [browserRequest, openBrowser])

  /*
   * Frame a graph that has just been opened.
   *
   * **Asked for unconditionally, and waiting for the cards to be measured is React Flow's job
   * rather than ours.** `fitView()` does not fit: it sets `fitViewQueued` and pushes a no-op onto
   * the node queue, and the fit resolves either at the next `setNodes` where every node has a
   * measurement or, failing that, inside `updateNodeInternals` when the ResizeObserver delivers
   * one. So a graph committed this render — whose cards have no size yet — is framed a beat later
   * against real measurements, which is exactly what a gate here was trying to arrange.
   *
   * This *was* gated on `useNodesInitialized`, which made it the only surface in the app still
   * reading that flag, and the flag is false here forever. `adoptUserNodes` carries a
   * measurement forward only while the **user** node object behind it is identity-equal and
   * otherwise re-seeds `measured` from `userNode.measured`; `rfNodes` mints fresh objects on
   * every store change and `onNodesChange` deliberately never writes a measured size back into
   * the document, so that field is permanently undefined. `updateNodeInternals` — the path the
   * ResizeObserver takes — never recomputes the flag, so nothing brings it back.
   *
   * What that cost is worth recording, because it looked like an intermittent bug rather than a
   * dead control: the **first** open of a session framed correctly and every one after it did
   * not. That first fit is React Flow's own `fitView` prop, queued at mount and resolved when the
   * opened graph's cards were measured — nothing to do with this effect. Measured in a browser:
   * opening a second graph left the viewport transform byte-identical, with the new graph's top
   * row at y = −109 against a pane starting at y = 42.
   *
   * `useArrange` reached the same conclusion about the same flag from the other side and asks its
   * readiness question of the sizes it is about to use. Here there is no question to ask, because
   * the consumer already waits.
   *
   * The request is only ever raised for a graph with nodes, so it cannot sit pending and then
   * fire on whatever the user adds next.
   */
  const fitRequest = useGraphStore((s) => s.fitRequest)
  const handledFit = useRef(fitRequest)
  useEffect(() => {
    if (fitRequest === handledFit.current) return
    handledFit.current = fitRequest
    fitAll()
  }, [fitRequest, fitAll])

  // --- keyboard -----------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // Never steal keys from a field the user is typing in.
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }

      const mod = event.metaKey || event.ctrlKey
      const { selection: selected } = useGraphStore.getState()

      if (event.key === 'Escape') {
        setMenu(null)
        setContextMenu(null)
        setEdgeMenu(null)
        return
      }
      // Space opens the full palette. React Flow's default binds it to pan-activation,
      // which is disabled below via panActivationKeyCode so this can own the key.
      if (event.key === ' ') {
        event.preventDefault()
        openPalette(pointerRef.current)
        return
      }
      // Tab and ⇧A are the "put a node here" gestures (⇧A is Blender's add menu), so they
      // open the browser — the deliberate "what can I add?" surface.
      if (event.key === 'Tab' || (event.shiftKey && event.key.toLowerCase() === 'a' && !mod)) {
        event.preventDefault()
        openBrowser(pointerRef.current)
        return
      }
      if (!mod && event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault()
        void useGraphStore.getState().runAll()
        return
      }
      if (mod && event.key === 'Enter') {
        event.preventDefault()
        void useGraphStore.getState().runAll()
        return
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (refuseIfLocked()) return
        if (event.shiftKey) useGraphStore.getState().redo()
        else useGraphStore.getState().undo()
        return
      }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        if (refuseIfLocked()) return
        useGraphStore.getState().duplicateSelection()
        return
      }
      /*
       * React Flow's own delete is switched off at the prop while locked, so nothing would
       * happen and nothing would say why. This is the half that speaks — and it is inert unless
       * the lock is on, because unlocked this key is React Flow's to handle.
       */
      if (!mod && (event.key === 'Delete' || event.key === 'Backspace') && refuseIfLocked()) {
        event.preventDefault()
        return
      }
      if (mod && event.key.toLowerCase() === 's') {
        // Autosave already ran; swallow the browser's Save dialog and hint at Save.
        event.preventDefault()
        setNotice('Use the Save button to download this graph as .coda.json')
        return
      }
      if (!mod && event.key.toLowerCase() === 'm' && selected.length > 0) {
        event.preventDefault()
        useGraphStore.getState().toggleDisabled(selected)
        return
      }
      if (!mod && event.key.toLowerCase() === 'h' && selected.length > 0) {
        event.preventDefault()
        useGraphStore.getState().toggleCollapsed(selected)
        return
      }
      // Unqualified for the same reason as `i`, and more so: what fullscreen is about is the
      // window, which has nothing to do with what happens to be selected. The browser's own
      // F11 does the same thing — this is the half that is discoverable from inside the app,
      // and it pairs with the toolbar's ⛶.
      if (!mod && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        void toggleFullscreen(appElement())
        return
      }
      /*
       * The key at the top left of the keyboard — `§` on this machine's layout, `` ` `` on a US
       * one, `^` on a German one — so it is matched by **position** (`code`) as well as by what
       * it prints. Nothing else in the app wants it, and every bare letter near the canvas is
       * either taken or one shift away from something else. Unqualified, like `f` and `i`: it is
       * about the view, and framing the selection is the thing you want right after selecting.
       */
      if (!mod && (event.key === '§' || event.code === 'Backquote')) {
        event.preventDefault()
        if (refuseIfLocked()) return
        fitSelected()
        return
      }
      /*
       * `/` rather than a letter, and unqualified. Every bare letter near the canvas is either
       * taken (`f`, `i`, `m`, `h`) or one shift away from something else — `a` would sit beside
       * `⇧A` for the node browser and mean something entirely different. `/` is the universal
       * "start typing at something" and collides with nothing here.
       */
      if (!mod && event.key === '/') {
        event.preventDefault()
        useGraphStore.getState().togglePanel('assistant')
        return
      }
      // Unqualified, unlike `m` and `h`: showing the inspector is worth doing with nothing
      // selected, since that is exactly when you are about to select something.
      if (!mod && !event.shiftKey && event.key.toLowerCase() === 'i') {
        event.preventDefault()
        useGraphStore.getState().togglePanel('inspector')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fitSelected, openBrowser, openPalette, refuseIfLocked, setNotice])

  // --- render -------------------------------------------------------------

  return (
    <div
      className="canvas-area"
      ref={wrapperRef}
      /*
       * The minimap's height, published to CSS so the toggle button — which lives outside the
       * minimap's subtree and has to sit clear of it — reads the same number the component was
       * given. One constant, two consumers.
       */
      style={{ '--minimap-height': `${MINIMAP_SIZE.height}px` } as React.CSSProperties}
      onPointerMove={(e) => {
        pointerRef.current = { x: e.clientX, y: e.clientY }
      }}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={(changes) => {
          const removed = changes
            .filter((c): c is Extract<typeof c, { type: 'remove' }> => c.type === 'remove')
            .map((c) => c.id)
          if (removed.length) useGraphStore.getState().deleteEdges(removed)
        }}
        onConnect={(connection) => {
          useGraphStore.getState().connect({
            source: connection.source,
            sourceHandle: connection.sourceHandle ?? '',
            target: connection.target,
            targetHandle: connection.targetHandle ?? '',
          })
        }}
        isValidConnection={isValidConnection}
        onConnectEnd={onConnectEnd}
        onReconnect={onReconnect}
        onReconnectEnd={onReconnectEnd}
        /*
         * The grab zone at each end of a wire. React Flow's default is 10, which leaves a
         * ring barely wider than the 11px socket it sits beside; 14 is a comfortable target
         * without turning the canvas either side of every node into dead space — the anchors
         * swallow pointer events, so this number is a tax on panning near a socket.
         */
        reconnectRadius={14}
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault()
          setMenu(null)
          setContextMenu(null)
          setEdgeMenu({
            screenPosition: { x: event.clientX, y: event.clientY },
            edgeId: edge.id,
          })
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault()
          setMenu(null)
          setEdgeMenu(null)
          setContextMenu({
            screenPosition: { x: event.clientX, y: event.clientY },
            nodeId: node.id,
          })
        }}
        onPaneContextMenu={(event) => {
          // Right-click on empty canvas means "add a node here", so it gets the same
          // node-only palette as Tab. Right-clicking a *node* keeps its own context menu.
          event.preventDefault()
          setContextMenu(null)
          // A canvas gesture whose only purpose is adding a node, so the lock stops it outright
          // rather than opening a menu of rows that are all greyed out.
          if (refuseIfLocked()) return
          openPalette(
            {
              x: 'clientX' in event ? event.clientX : 0,
              y: 'clientY' in event ? event.clientY : 0,
            },
            ADD_PREFIX,
          )
        }}
        onDoubleClick={(event) => {
          // Only the empty pane opens the palette; nodes use double-click to rename.
          if (!(event.target as HTMLElement).classList.contains('react-flow__pane')) return
          if (refuseIfLocked()) return
          openPalette({ x: event.clientX, y: event.clientY }, ADD_PREFIX)
        }}
        onPaneClick={() => {
          setMenu(null)
          setContextMenu(null)
          setEdgeMenu(null)
        }}
        defaultViewport={graph.viewport ?? { x: 0, y: 0, zoom: 0.85 }}
        minZoom={0.15}
        maxZoom={2.5}
        // Generous snapping radius so 11px sockets are easy to hit.
        connectionRadius={26}
        /*
         * Navigation model: left-drag on empty canvas pans; Shift+left-drag draws a
         * selection box. Panning is the far more frequent action, so it gets the bare
         * gesture. Middle and right drag pan too, for trackpad-free mice.
         */
        panOnDrag={locked ? false : PAN_BUTTONS}
        selectionOnDrag={false}
        // Box-select survives the lock: selecting changes nothing, and the inspector, the help
        // overlay and every viewer are still worth reaching on a frozen canvas.
        selectionKeyCode="Shift"
        // Shift is taken by box-select, so additive click-selection uses the modifiers.
        multiSelectionKeyCode={MULTI_SELECT_KEYS}
        // Frees Space for the command palette (React Flow binds it to pan by default).
        panActivationKeyCode={null}
        panOnScroll={false}
        zoomOnDoubleClick={false}
        /*
         * The lock, at the props React Flow reads before any handler of ours runs — the drag,
         * the wheel, the pinch, the socket drag, the wire rewire and the Delete key. Everything
         * else it covers is a button or a store guard; these six are gestures the library owns
         * outright, and this is the only place they can be refused.
         */
        zoomOnScroll={!locked}
        zoomOnPinch={!locked}
        nodesDraggable={!locked}
        nodesConnectable={!locked}
        edgesReconnectable={!locked}
        deleteKeyCode={locked ? null : DELETE_KEYS}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.4}
          color="var(--canvas-dot)"
        />
        {/*
         * Every button in the rail is ours — see `ViewControls` for why React Flow's own zoom
         * and fit are switched off rather than left to sit above them. Reading order is view,
         * then layout, then the lock that governs both.
         */}
        <Controls
          showZoom={false}
          showFitView={false}
          showInteractive={false}
          position="bottom-left"
        >
          <ViewControls />
          <LayoutControls onArrange={arrange} />
          <LockControl />
        </Controls>
        {minimapOpen && (
          <MiniMap
            // The minimap moves the viewport too, which is the whole of what it is for.
            pannable={!locked}
            zoomable={!locked}
            position="bottom-right"
            nodeColor={(node) => {
              const graphNode = (node.data as CodaNodeData | undefined)?.node
              const def = graphNode ? getNodeDef(graphNode.type) : undefined
              return def ? `var(--cat-${def.category})` : 'var(--text-muted)'
            }}
            nodeStrokeWidth={0}
            maskColor="color-mix(in srgb, var(--canvas) 72%, transparent)"
            style={MINIMAP_SIZE}
          />
        )}
      </ReactFlow>

      {/*
       * Outside `<ReactFlow>`, so it keeps its corner whether or not the minimap is mounted —
       * a toggle that moved when you pressed it would be a target that runs away. `nodrag` and
       * the stopped pointer event keep the click off the pane behind it.
       */}
      <button
        type="button"
        className="minimap-toggle nodrag"
        data-open={minimapOpen || undefined}
        aria-pressed={minimapOpen}
        title={minimapOpen ? 'Hide the minimap' : 'Show the minimap'}
        aria-label={minimapOpen ? 'Hide minimap' : 'Show minimap'}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => togglePanel('minimap')}
      >
        <svg viewBox="0 0 16 12" width="15" height="11" aria-hidden="true" focusable="false">
          <rect
            x="0.75"
            y="0.75"
            width="14.5"
            height="10.5"
            rx="1.5"
            fill="none"
            stroke="currentColor"
          />
          <rect x="3" y="3" width="4" height="3" fill="currentColor" />
          <rect x="9" y="6" width="4" height="3" fill="currentColor" />
        </svg>
      </button>

      {menu && (
        <CommandPalette
          // Keyed per open so the search box resets to this request's prefill.
          key={menu.seq}
          items={paletteItems}
          screenPosition={menu.screenPosition}
          initialQuery={menu.initialQuery}
          {...(menu.filter ? { filterType: menu.filter.type } : {})}
          onPick={handlePick}
          onClose={() => setMenu(null)}
        />
      )}

      {browserAt && (
        <NodeBrowser
          onPick={(nodeType) => {
            // `openBrowser` refuses to open while locked, so reaching here means the lock came
            // on with the browser already up. Same backstop as `handlePick`.
            if (!refuseIfLocked()) {
              useGraphStore
                .getState()
                .addNode(nodeType, { x: browserAt.x - 12, y: browserAt.y - 18 })
            }
            setBrowserAt(null)
          }}
          onClose={() => setBrowserAt(null)}
        />
      )}

      {contextMenu && (
        <NodeContextMenu
          screenPosition={contextMenu.screenPosition}
          nodeId={contextMenu.nodeId}
          onClose={() => setContextMenu(null)}
        />
      )}

      {edgeMenu && (
        <EdgeContextMenu
          screenPosition={edgeMenu.screenPosition}
          edgeId={edgeMenu.edgeId}
          onClose={() => setEdgeMenu(null)}
        />
      )}

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(undefined)} title="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Where a toolbar-triggered insertion should land: the pointer when it is over the canvas,
 * otherwise the upper-middle of the canvas. Clicking a toolbar button leaves the pointer on
 * the toolbar, and dropping the node under the cursor there would put it off-screen.
 */
function anchorPoint(
  wrapper: HTMLElement | null,
  pointer: { x: number; y: number },
): { x: number; y: number } {
  const bounds = wrapper?.getBoundingClientRect()
  if (!bounds) return pointer
  const inside =
    pointer.x >= bounds.left &&
    pointer.x <= bounds.right &&
    pointer.y >= bounds.top &&
    pointer.y <= bounds.bottom
  return inside
    ? pointer
    : { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 3 }
}

/** Static type of a port, used when a drag starts so the palette can filter. */
function portTypeOf(
  graph: CodaGraph,
  inference: ReturnType<typeof useGraphStore.getState>['inference'],
  nodeId: string,
  portId: string,
  side: 'input' | 'output',
): CodaType | undefined {
  if (side === 'output') {
    const resolved = inference.nodes[nodeId]?.outputs[portId]
    if (resolved) return resolved
  }
  const node = graph.nodes.find((n) => n.id === nodeId)
  const def = node ? getNodeDef(node.type) : undefined
  const ports = side === 'output' ? def?.outputs : def?.inputs
  return (ports ?? []).find((p) => p.id === portId)?.type
}

export function Editor() {
  return (
    <ReactFlowProvider>
      <EditorCanvas />
    </ReactFlowProvider>
  )
}
