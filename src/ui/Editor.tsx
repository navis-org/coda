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
  useNodesInitialized,
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
import { EdgeContextMenu } from './panels/EdgeContextMenu'
import { NodeBrowser } from './panels/NodeBrowser'
import { NodeContextMenu } from './panels/NodeContextMenu'
import type { PaletteItem } from './panels/paletteItems'
import { buildCommandItems, buildNodeItems } from './panels/paletteItems'
import { requestExportWarnings, useExportWarnings } from './exportWarnings'
import { appElement, toggleFullscreen } from './fullscreen'
import { typeColorVar } from './socketStyle'
import { useArrange } from './useArrange'
import { useDownloads } from './useDownloads'

/**
 * Framing for both fits: React Flow's own initial one and the one a load asks for. Shared so a
 * freshly opened graph is framed exactly as the first one was, and `maxZoom: 1` so a two-node
 * graph is not blown up to fill a monitor.
 */
const FIT_VIEW_OPTIONS = { padding: 0.22, maxZoom: 1 }

/**
 * Minimap size.
 *
 * Passed to the component as a `style` prop rather than set in the stylesheet: React Flow reads
 * `style.width`/`style.height` to compute the map's viewBox, so sizing it in CSS alone leaves it
 * drawing a 200x150 projection into whatever box CSS produced.
 */
const MINIMAP_SIZE = { width: 180, height: 120 }

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

  const { screenToFlowPosition, fitView } = useReactFlow()
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
    [graph.edges, disabledIds, inference, edgeRouting, arrangeRoutes, spliceEdgeId, referenceIds],
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
  const spliceOn = useCallback(
    (nodeId: string): string | undefined => {
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
    },
    [],
  )

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
      setMenu(null)
      setContextMenu(null)
      setEdgeMenu(null)
      setBrowserAt(screenToFlowPosition(screenPosition))
    },
    [screenToFlowPosition],
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
    if (menu.filter) return buildNodeItems(menu.filter)
    return [
      ...buildCommandItems({
        store: liveStore ?? useGraphStore.getState(),
        fitView: () => void fitView({ duration: 200 }),
      }),
      ...buildNodeItems(),
    ]
    // `liveStore` is the whole state object while the palette is open, so this recomputes
    // whenever anything changes — which is what keeps `disabled` flags honest. The revision is
    // in the list for the same reason: an export warning that lands after the palette opened
    // has to reach the row it is about.
  }, [menu, liveStore, fitView, exportWarningsRevision])

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
    [menu, setNotice],
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
   * Gated on `nodesInitialized`, and that is the whole difficulty: `fitView` reads each node's
   * *measured* size, and a node committed this render has none yet — fitting straight away
   * frames a set of zero-sized boxes and lands at some arbitrary zoom. The hook goes false while
   * the new cards are unmeasured and true once React Flow's ResizeObserver has them, so leaving
   * the request unhandled until then is what makes the fit correct rather than merely late.
   *
   * The request is only ever raised for a graph with nodes, so it cannot sit pending and then
   * fire on whatever the user adds next.
   */
  const fitRequest = useGraphStore((s) => s.fitRequest)
  const handledFit = useRef(fitRequest)
  const nodesInitialized = useNodesInitialized()
  useEffect(() => {
    if (fitRequest === handledFit.current || !nodesInitialized) return
    handledFit.current = fitRequest
    void fitView({ ...FIT_VIEW_OPTIONS, duration: 240 })
  }, [fitRequest, nodesInitialized, fitView])

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
        if (event.shiftKey) useGraphStore.getState().redo()
        else useGraphStore.getState().undo()
        return
      }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        useGraphStore.getState().duplicateSelection()
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
  }, [openBrowser, openPalette, setNotice])

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
          if ((event.target as HTMLElement).classList.contains('react-flow__pane')) {
            openPalette({ x: event.clientX, y: event.clientY }, ADD_PREFIX)
          }
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
        panOnDrag={[0, 1, 2]}
        selectionOnDrag={false}
        selectionKeyCode="Shift"
        // Shift is taken by box-select, so additive click-selection uses the modifiers.
        multiSelectionKeyCode={['Meta', 'Control']}
        // Frees Space for the command palette (React Flow binds it to pan by default).
        panActivationKeyCode={null}
        panOnScroll={false}
        zoomOnDoubleClick={false}
        deleteKeyCode={['Delete', 'Backspace']}
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
        <Controls showInteractive={false} position="bottom-left">
          <LayoutControls onArrange={arrange} />
        </Controls>
        {minimapOpen && (
          <MiniMap
            pannable
            zoomable
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
            useGraphStore
              .getState()
              .addNode(nodeType, { x: browserAt.x - 12, y: browserAt.y - 18 })
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
