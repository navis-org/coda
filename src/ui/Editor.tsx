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
import type { NodeSize } from '../layout/elkGraph'
import { getNodeDef } from '../core/registry'
import type { CodaType } from '../core/types'
import { nodePorts, referenceEdgeIds } from '../core/graph'
import { groupsTouching } from '../core/groups'
import type { CollapsedEdge } from '../layout/collapse'
import { COLLAPSED_TYPE, collapsedView, isFolded } from '../layout/collapse'
import { spliceCandidate } from '../core/splice'
import { useGraphStore } from '../store/graphStore'
import { edgeUnderRect } from './spliceHit'
import type { CodaNodeData } from './nodes/CodaNodeView'
import { CARD_POINTERS } from './nodes/cardPointers'
import { CARD_TYPES, cardShape } from './nodes/cardNode'
import type { GroupCollapsedNode } from './nodes/GroupCollapsedCard'
import { GroupCollapsedCard } from './nodes/GroupCollapsedCard'
import { EDGE_TYPES } from './CodaEdge'
import { GroupLayer } from './GroupLayer'
import { LoopLayer } from './LoopLayer'
import { CommandPalette } from './panels/CommandPalette'
import { LayoutControls } from './panels/LayoutControls'
import { LockControl } from './panels/LockControl'
import { MinimapControl } from './panels/MinimapControl'
import { ViewControls } from './panels/ViewControls'
import { WorkflowTabs } from './panels/WorkflowTabs'
import { EdgeContextMenu } from './panels/EdgeContextMenu'
import { AddMenu } from './panels/AddMenu'
import { NodeBrowser } from './panels/NodeBrowser'
import { GroupContextMenu } from './panels/GroupContextMenu'
import { NodeContextMenu } from './panels/NodeContextMenu'
import type { PaletteItem } from './panels/paletteItems'
import { buildCommandItems, buildNodeItems } from './panels/paletteItems'
import { requestExportWarnings, useExportWarnings } from './exportWarnings'
import { FIT_VIEW_OPTIONS, useFitAll, useFitSelected, useFitSelectedRequests } from './fitView'
import { isTourActive, refreshTour } from './tour/tourState'
// `f`, `i`, `/` and `d` are bound in `useAppShortcuts`, not here: they are about the window, a
// panel and which view is up, and none of them needs the canvas. This handler keeps the keys that
// do. Both listeners share the two guards below.
import { TOUR_DECLINES, isTypingTarget } from './appShortcuts'
import { useClipboardShortcuts } from './clipboard'
import { LOCKED_NOTICE } from './lockCopy'
import { wireStyle } from './socketStyle'
import { useArrange } from './useArrange'
import { useDownloads } from './useDownloads'
import { useRunNotify } from './notify'
import { useForEach } from './useForEach'

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

// The two document renderers plus the pseudo card only this surface draws.
const NODE_TYPES = { ...CARD_TYPES, [COLLAPSED_TYPE]: GroupCollapsedCard }

/**
 * What the canvas draws: the document's cards, plus one pseudo card per collapsed group.
 *
 * A union rather than one data type, because the second kind is not a `GraphNode` and must not
 * be able to pass for one — every handler that maps a change back to the store asks
 * `collapsedGroupId` first, and a shared data shape is exactly what would make forgetting that
 * compile.
 */
type CanvasNode = Node<CodaNodeData> | GroupCollapsedNode



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
  // A primitive, not the panels object: snapshots are compared by identity and `togglePanel`
  // returns a fresh one each call. The button that flips it is `MinimapControl`, in the rail.
  const minimapOpen = useGraphStore((s) => s.panels.minimap)

  const { screenToFlowPosition, setViewport } = useReactFlow()
  /*
   * The canvas transform, saved into the active document and put back when it comes round again.
   *
   * Capture is React Flow's `onMove` and restore is a request counter, rather than one gesture
   * doing both, because the two ends are raised from different places: a pan is React Flow's own
   * event, and a switch can come from the switcher, the toolbar, a share link or the palette —
   * none of which is inside this provider. `recordViewport` writes no store state, so a frame of
   * a pan costs a property assignment. See the handler for why it is not `onMoveEnd`.
   */
  const recordViewport = useGraphStore((s) => s.recordViewport)
  const viewportRequest = useGraphStore((s) => s.viewportRequest)
  const handledViewport = useRef(viewportRequest.seq)
  useEffect(() => {
    if (viewportRequest.seq === handledViewport.current) return
    handledViewport.current = viewportRequest.seq
    /*
     * Undefined for a document being seen for the first time, which `loadGraph`'s `fitRequest`
     * frames instead. Answering it here as well would fight that fit.
     */
    if (viewportRequest.viewport) setViewport(viewportRequest.viewport)
  }, [viewportRequest, setViewport])
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
  useForEach()
  // Same reasoning: a run finishing is a whole-app event, and the tab it lands on may have no
  // card expanded at all.
  useRunNotify()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const pointerRef = useRef({ x: 0, y: 0 })
  const draggingRef = useRef(false)
  // The wire a drop would insert the dragged card into; drawn highlighted while it is set.
  const [spliceEdgeId, setSpliceEdgeId] = useState<string | undefined>(undefined)
  const resizingRef = useRef(false)
  const menuSeq = useRef(0)

  /**
   * The size React Flow last measured for each card, in flow units — held here and handed back
   * to it on every rebuild.
   *
   * **The minimap is why.** It draws from `nodeLookup` and skips any node `nodeHasDimensions`
   * says nothing about — which reads the *user* node, not the measurement. `rfNodes` mints fresh
   * objects on every store change and `onNodesChange` deliberately never writes a measured size
   * into the document (see the `dimensions` branch), so the only cards carrying a size there were
   * the ones with a `node.size` or a `defaultSize`. Everything else — every node that cannot be
   * resized, and every *collapsed* card, whose height is deliberately left to its content — was
   * simply absent from the map. Four of the eleven cards in `partners` drew.
   *
   * Component state rather than the store: this is a measurement, not a decision, so it must
   * stay out of the document, out of undo and out of the saved file. Feeding it back also stops
   * `adoptUserNodes` from wiping `measured` on every graph edit — it carries the field forward
   * from `userNode.measured` — so the cards are no longer re-measured once per edit.
   */
  const [measuredSizes, setMeasuredSizes] = useState<ReadonlyMap<string, NodeSize>>(
    () => new Map(),
  )

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
    /** The same click in flow units, converted here rather than in render — as `MenuState` does. */
    flowPosition: { x: number; y: number }
    nodeId: string
  } | null>(null)
  const [edgeMenu, setEdgeMenu] = useState<{
    screenPosition: { x: number; y: number }
    edgeId: string
  } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{
    screenPosition: { x: number; y: number }
    groupId: string
  } | null>(null)

  // --- derive React Flow's arrays -----------------------------------------

  const selectedSet = useMemo(() => new Set(selection), [selection])

  /**
   * The collapsed groups, as boxes and merged wires — see `layout/collapse.ts`.
   *
   * Handed the arrange animation's positions as well as the document's, so a box glides with its
   * members rather than sitting still and jumping at the end of the pass. `NO_COLLAPSE` is
   * identity-stable, so a graph with nothing folded costs one comparison and no allocation.
   */
  const collapse = useMemo(
    () => collapsedView(graph, measuredSizes, arrangeOverrides ?? undefined),
    [graph, measuredSizes, arrangeOverrides],
  )
  /** Which ids on the canvas are boxes rather than cards — see `onNodesChange`. */
  const boxIds = useMemo(() => new Set(collapse.boxes.map((b) => b.id)), [collapse])



  /** The handler the boxes carry in their data, kept stable so they re-render on their own terms. */
  const onGroupContextMenu = useCallback(
    (groupId: string, screenPosition: { x: number; y: number }) => {
      setMenu(null)
      setContextMenu(null)
      setEdgeMenu(null)
      setGroupMenu({ groupId, screenPosition })
    },
    [],
  )

  /**
   * The pseudo cards, memoised apart from the real ones.
   *
   * A box's `data` is a fresh object on every `rfNodes` pass, and that array recomputes on things
   * a box does not care about — a rubber-band selection (per pointer move), an arrange animation
   * (per frame), a measurement batch. Each of those changed the box's data identity, so React
   * Flow re-rendered `GroupCollapsedCard`: the mini-map's `union`, a `getNodeDef` and a `<rect>`
   * per member, and every promoted row, on every frame. A folded group is supposed to be the
   * *cheap* drawing of N cards.
   */
  const boxNodes = useMemo<CanvasNode[]>(
    () =>
      collapse.boxes.map((box) => ({
        id: box.id,
        type: COLLAPSED_TYPE,
        position: box.position,
        width: box.size.width,
        height: box.size.height,
        data: { box, onContextMenu: onGroupContextMenu },
        /*
         * Three refusals, each closing a path that would otherwise reach the store with an id
         * naming nothing in the document: the drag writes the *members*' positions and is ours,
         * the selection is the members' too, and ⌫ over a box would ask `deleteNodes` about a
         * pseudo id. See `GroupCollapsedCard`.
         */
        draggable: false,
        selectable: false,
        deletable: false,
        // And the price of those three, which is silent — see `CARD_POINTERS`. The gestures stay
        // ours; what this restores is the pointer reaching them at all.
        style: CARD_POINTERS,
      })),
    [collapse.boxes, onGroupContextMenu],
  )

  const rfNodes = useMemo<CanvasNode[]>(
    () => {
      const cards: CanvasNode[] = graph.nodes.map((node) => {
        return {
          id: node.id,
          // Which renderer and what size — `cardShape`, shared with the group peek.
          ...cardShape(node),
          // While an arrange is gliding, the card is drawn from the animation rather than from
          // the document — the store gets one commit at the end, not one per frame.
          position: arrangeOverrides?.get(node.id) ?? node.position,
          data: dataFor(node),
          selected: selectedSet.has(node.id),
          // What React Flow itself last measured, handed straight back — see `measuredSizes`.
          // Without it the minimap cannot see a card that carries no explicit size.
          ...(measuredSizes.has(node.id) ? { measured: measuredSizes.get(node.id) } : {}),
          /*
           * A card inside a folded group is hidden rather than dropped from the list. React Flow
           * keeps a hidden node's entry — so its measurement, its selection and its handles
           * survive the fold and come back with it — where an absent one is a node that was
           * deleted and re-added, and comes back unmeasured.
           */
          ...(collapse.hidden.has(node.id) ? { hidden: true } : {}),
        }
      })
      return [...cards, ...boxNodes]
    },
    [
      graph.nodes,
      selectedSet,
      arrangeOverrides,
      measuredSizes,
      collapse.hidden,
      boxNodes,
    ],
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

  /**
   * Whether anything selected is inside a folded group.
   *
   * React Flow draws a **multi-selection rectangle** around every node it thinks is selected and
   * does not skip the hidden ones, so a folded group whose members are still selected left a
   * 850×240 box across the canvas where its cards used to be — draggable, and moving cards
   * nobody could see. Seen in Chrome; jsdom draws no such overlay, so nothing in the suite could
   * have caught it.
   *
   * The fix is to stand that overlay down rather than to lie about the selection. A hidden card
   * that React Flow does not know is selected is one a click on the pane cannot *de*select — its
   * select changes never arrive — so the store's selection would silently accumulate cards
   * nobody can see, and the next ⌫ would take them with it. Keeping the flags honest and
   * dropping the drag handle costs only that handle, and only while a folded group is in the
   * selection: the box is how you drag those cards now.
   */
  const foldedSelection = selection.some((id) => collapse.hidden.has(id))

  const rfEdges = useMemo<Edge[]>(
    () => {
      const wires: Edge[] = graph.edges.map((edge) => {
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
          style: wireStyle(sourceType, muted),
          /*
           * A wire with an end inside a folded group is withheld, and `collapse.edges` draws the
           * merged stand-in instead. Hidden rather than dropped, for the reason a hidden card is:
           * React Flow keeps what it knows about it.
           */
          ...(isFolded(collapse, edge) ? { hidden: true } : {}),
        }
      })
      for (const edge of collapse.edges) {
        wires.push(collapsedWire(edge, inference, edgeRouting === 'orthogonal'))
      }
      return wires
    },
    [
      graph.edges,
      disabledIds,
      inference,
      edgeRouting,
      arrangeRoutes,
      spliceEdgeId,
      referenceIds,
      collapse,
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
   * The card's size comes from `offsetWidth`, the rule `useArrange` records at length: a bounding
   * rect is in screen pixels and would shrink with the camera, where a hit test against flow-space
   * path coordinates needs flow units. `measured` would do at rest — `measuredSizes` keeps it
   * alive now — but it lands a frame after the card does, and this runs mid-drag.
   */
  const spliceOn = useCallback((nodeId: string): string | undefined => {
    const store = useGraphStore.getState()
    const node = store.graph.nodes.find((n) => n.id === nodeId)
    if (!node) return undefined
    // Scoped to the canvas: the group peek draws the same cards, with the same ids, in a modal.
    const el = document.querySelector<HTMLElement>(
      `.canvas-area .react-flow__node[data-id="${nodeId}"]`,
    )
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
    (changes: NodeChange<CanvasNode>[]) => {
      const moves: Array<{ id: string; position: { x: number; y: number } }> = []
      const sizes: Array<{ id: string; size: { width: number; height: number } }> = []
      /** Measurements seen in this batch, folded into `measuredSizes` below if any changed. */
      const measured = new Map<string, NodeSize>()
      let selectionChanged = false
      const nextSelection = new Set(selection)

      for (const change of changes) {
        /*
         * A pseudo card is not in the document, so nothing it reports may reach the store or the
         * measurement bookkeeping: its id names no node, and `measuredSizes` prunes anything it
         * cannot find in `graph.nodes` — which would evict this entry on every batch and rebuild
         * every card with it. The box has no stored size to keep anyway; `COLLAPSED_SIZE` is
         * what it draws at and what the layout is told.
         *
         * Asked of the set of boxes rather than of the id's shape: a `startsWith` here is the
         * string-prefix test over ids this codebase has retired once already, and a second place
         * that would have to agree with the prefix `collapsedNodeId` mints.
         */
        if ('id' in change && boxIds.has(change.id)) continue
        if (change.type === 'position' && change.position) {
          moves.push({ id: change.id, position: change.position })
          draggingRef.current = change.dragging === true
        } else if (change.type === 'dimensions') {
          /*
           * Every measurement is kept — the minimap needs a size for cards that have no
           * declared one, and `measuredSizes` is where they live.
           *
           * Only a *deliberate* resize reaches the document, though. React Flow emits
           * `dimensions` for its own measurements too — every mount, every content change —
           * and those carry no `setAttributes`. Persisting them would write a measured pixel
           * size into the document on load and fill the undo stack with things nobody did.
           */
          if (change.dimensions) measured.set(change.id, change.dimensions)
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

      /*
       * One new map per batch that actually measured something differently, and none at all
       * otherwise: this handler runs on every drag frame, and a fresh map per frame would
       * rebuild `rfNodes` — and with it every card — for a measurement nobody took.
       *
       * Deleted cards are dropped here rather than on a `remove` change, because only the
       * keyboard deletes through React Flow — the context menu and the palette go straight to
       * the store, and an entry that outlived its node would be a leak per deletion.
       */
      if (measured.size > 0) {
        // Outside the updater, which React may run more than once and which has no business
        // reading a store.
        const live = new Set(useGraphStore.getState().graph.nodes.map((n) => n.id))
        setMeasuredSizes((current) => {
          const stale = [...current.keys()].some((id) => !live.has(id))
          const changed = [...measured].some(([id, size]) => {
            const previous = current.get(id)
            return previous?.width !== size.width || previous?.height !== size.height
          })
          if (!changed && !stale) return current
          const next = new Map(current)
          for (const id of next.keys()) if (!live.has(id)) next.delete(id)
          for (const [id, size] of measured) next.set(id, size)
          return next
        })
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
    [graph.nodes, selection, spliceOn, boxIds],
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
      setGroupMenu(null)
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
      setGroupMenu(null)
      setBrowserAt(screenToFlowPosition(screenPosition))
    },
    [screenToFlowPosition, refuseIfLocked],
  )

  /**
   * Insert a node at a flow point — the one place a node is added from a menu.
   *
   * All four routes in land here: the palette, `NodeBrowser`, the **+** menu's band, and the
   * button's own "browse everything". So the drop offset and the lock backstop are written once;
   * they were three copies of both, and the add menu's promise to put a card where the browser
   * would have was a comment rather than a shared line. Returns the new id, empty while locked,
   * because the palette wires the node it just made to the link that was dragged out.
   */
  const insertNodeAt = useCallback(
    (nodeType: string, flow: { x: number; y: number }): string => {
      // The one that matters: `addNode` answers a locked canvas with an empty id, and the
      // palette's auto-wire would then blame the *link* for a node that was never added.
      if (refuseIfLocked()) return ''
      // Drop the node so its top-left lands near the point rather than under it.
      return useGraphStore.getState().addNode(nodeType, { x: flow.x - 12, y: flow.y - 18 })
    },
    [refuseIfLocked],
  )

  /**
   * Where the **+** menu's own insertions land: the canvas's upper-middle, never the pointer.
   *
   * Stable, so `AddMenu` — which is rendered by a canvas that re-renders on every graph mutation
   * and on every pointer move of a drag — can be `memo`ised past all of it.
   */
  const addAtCanvasAnchor = useCallback(
    (nodeType: string) => {
      insertNodeAt(nodeType, screenToFlowPosition(canvasAnchor(wrapperRef.current)))
    },
    [screenToFlowPosition, insertNodeAt],
  )

  /** The rail's bottom button, for the same reason. */
  const browseAtCanvasAnchor = useCallback(() => {
    openBrowser(canvasAnchor(wrapperRef.current))
  }, [openBrowser])

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

  /**
   * Where a paste lands, in flow coordinates.
   *
   * `anchorPoint` is the same question the toolbar's insertions already ask — the pointer when it
   * is over the canvas, a point in the middle of it when the pointer is on a toolbar or a panel —
   * so this converts its answer rather than re-deriving the geometry. What it must never be is
   * "wherever the cards were when they were copied": a fragment carries absolute positions, and
   * pasting into a *different* graph is the case this exists for, so that answer can be a screen
   * away from anything on view — a paste that worked, selected the new cards, and looks exactly
   * like a paste that did nothing.
   *
   * Declared above the palette's memo because that memo reads it while it renders.
   */
  const pastePoint = useCallback(
    () => screenToFlowPosition(anchorPoint(wrapperRef.current, pointerRef.current)),
    [screenToFlowPosition],
  )

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
        pastePoint,
      }),
      ...buildNodeItems(undefined, locked),
    ]
    // `liveStore` is the whole state object while the palette is open, so this recomputes
    // whenever anything changes — which is what keeps `disabled` flags honest. The revision is
    // in the list for the same reason: an export warning that lands after the palette opened
    // has to reach the row it is about.
  }, [menu, liveStore, locked, fitAll, fitSelected, pastePoint, exportWarningsRevision])

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

      // The palette's node rows are disabled while locked; `insertNodeAt` carries the backstop
      // and answers with an empty id, which the auto-wire below must not be handed.
      const newId = insertNodeAt(item.nodeType, menu.flowPosition)
      if (!newId) {
        setMenu(null)
        return
      }

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
    [menu, insertNodeAt, setNotice],
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
   * reading that flag, and the flag was false here forever. `adoptUserNodes` computes it from
   * `userNode.measured`, and `rfNodes` used to mint fresh objects with that field empty on every
   * store change — so it latched false at the first edit, and `updateNodeInternals`, the path the
   * ResizeObserver takes, never recomputes it. `measuredSizes` now feeds those measurements back
   * and the flag would come good; the gate stays gone regardless, because the consumer already
   * waits and a gate here only ever added a way to be wrong.
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
  // The Guided Tour's half of the same job, from outside the provider — see `fitView.ts` for
  // why one of these is a store field and the other a channel.
  useFitSelectedRequests()

  const fitRequest = useGraphStore((s) => s.fitRequest)
  const handledFit = useRef(fitRequest)
  useEffect(() => {
    if (fitRequest === handledFit.current) return
    handledFit.current = fitRequest
    fitAll()
  }, [fitRequest, fitAll])

  // --- clipboard ----------------------------------------------------------

  useClipboardShortcuts({ pastePoint, refuseIfLocked })

  // --- keyboard -----------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Never steal keys from a field the user is typing in. Shared with `useAppShortcuts`, the
      // other listener that has to make the same exemption — see `isTypingTarget`.
      if (isTypingTarget(event.target)) return

      const mod = event.metaKey || event.ctrlKey
      /*
       * The keys a tour cannot follow, declined while one is on screen.
       *
       * driver's popover controls are ordinary `<button>`s, so the field guard above does not
       * cover them and every bare letter here is live under a reader's hands. But declining the
       * *whole* handler — which this did first — takes `Tab`, `Space`, `⇧R` and `⌘Z` with it,
       * and those are exactly the keys the tours tell people to press: "Press `+ Add` — or hit
       * `Tab`", "⌘Z brings it back". It also contradicts the reason `advanceWhen` is a predicate
       * rather than a hook on one button — a step waits for *a node to exist*, precisely so the
       * browser, the palette and a double-click all count, and a keyboard veto quietly ruled out
       * two of the three.
       *
       * So the list is only what the spotlight cannot survive: the four that re-lay-out the
       * shell or the spotlit card underneath a stage driver measured a moment ago, and has no
       * event to learn about. `§` is absent deliberately — it moves the camera, and the camera
       * is the one thing `onMove` already reports.
       */
      if (!mod && isTourActive() && TOUR_DECLINES.has(event.key.toLowerCase())) return
      const { selection: selected } = useGraphStore.getState()

      if (event.key === 'Escape') {
        setMenu(null)
        setContextMenu(null)
        setEdgeMenu(null)
        setGroupMenu(null)
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
      /*
       * ⌘G frames the selection, ⇧⌘G takes the frames it touches apart.
       *
       * `preventDefault` first, unconditionally: ⌘G is the browser's find-again, and a canvas
       * that grouped *and* jumped the page to the last search hit would be two things happening
       * at once with only one of them asked for.
       */
      if (mod && event.key.toLowerCase() === 'g') {
        event.preventDefault()
        if (refuseIfLocked()) return
        const store = useGraphStore.getState()
        if (event.shiftKey) {
          store.ungroup(groupsTouching(store.graph, selected).map((group) => group.id))
        } else {
          store.groupSelection()
        }
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
      /*
       * Pin, and it toggles against *this* node rather than against "is anything pinned": with a
       * second viewer selected the key should move the dock onto it, not close it. Unpinning is
       * then pressing it again on the node that is showing — the same key, the same node.
       *
       * Requires a single selection, like `m` and `h` require any: the dock draws one node, and
       * a key that quietly picked the first of four would be a coin toss.
       */
      const onlySelected = selected.length === 1 ? selected[0] : undefined
      if (!mod && event.key.toLowerCase() === 'p' && onlySelected) {
        event.preventDefault()
        const store = useGraphStore.getState()
        store.pinNode(store.pinnedNodeId === onlySelected ? undefined : onlySelected)
        return
      }
      /*
       * The key at the top left of the keyboard — `§` on this machine's layout, `` ` `` on a US
       * one, `^` on a German one — so it is matched by **position** (`code`) as well as by what
       * it prints. Nothing else in the app wants it, and every bare letter near the canvas is
       * either taken or one shift away from something else. Unqualified, like `f` and `i`: it is
       * about the view, and framing the selection is the thing you want right after selecting.
       *
       * **One key, two fits, chosen by the selection.** With nothing selected it frames the whole
       * graph rather than doing nothing — "show me what I mean" is the same intent at both
       * scales, and a key that is inert exactly when you have not selected anything is a key you
       * stop reaching for. The rail keeps the two as separate buttons, where each can say which
       * it is; a shortcut has no such room. The palette moves the `§` badge between its two rows
       * to match, so what it advertises is what the key would do right now.
       */
      if (!mod && (event.key === '§' || event.code === 'Backquote')) {
        event.preventDefault()
        if (refuseIfLocked()) return
        if (selected.length) fitSelected()
        else fitAll()
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fitAll, fitSelected, openBrowser, openPalette, refuseIfLocked, setNotice])

  // --- render -------------------------------------------------------------

  return (
    <div
      className="canvas-area"
      ref={wrapperRef}
      // The Guided Tour's anchor for "the canvas is the document" — see `tour/steps.ts` for why
      // the tour addresses elements by `data-tour` rather than by class or by accessible name.
      data-tour="canvas"
      onPointerMove={(e) => {
        pointerRef.current = { x: e.clientX, y: e.clientY }
      }}
    >
      <ReactFlow
        className={foldedSelection ? 'has-folded-selection' : undefined}
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
          setGroupMenu(null)
          setEdgeMenu({
            screenPosition: { x: event.clientX, y: event.clientY },
            edgeId: edge.id,
          })
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault()
          setMenu(null)
          setEdgeMenu(null)
          setGroupMenu(null)
          setContextMenu({
            screenPosition: { x: event.clientX, y: event.clientY },
            flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
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
          setGroupMenu(null)
        }}
        /*
         * The tour's spotlight is placed in viewport pixels, and this canvas moves by CSS
         * transform — which fires neither `resize` nor `scroll`, the only two things driver.js
         * watches. Without this a pan leaves the cut-out over empty canvas, rendering perfectly
         * and pointing at nothing. It fires for programmatic viewport animations too, so a step
         * that frames its own card is tracked through the whole transition. A no-op when no
         * tour is running.
         */
        /*
         * The tour's spotlight and this document's viewport, from the one event.
         *
         * `onMove` rather than `onMoveEnd` for the second of those, and the difference is the
         * case that reads as a bug: `onMoveEnd` ends a *gesture*, so a document that was only
         * ever framed by `fitView` — which is every document nobody has panned — records
         * nothing, and switching to it leaves the canvas on the outgoing document's transform.
         * `onMove` fires for programmatic animations too, which is the same property the tour
         * needs it for. `recordViewport` writes no store state, so a frame of a drag costs a
         * property assignment.
         */
        onMove={(_event, viewport) => {
          refreshTour()
          recordViewport(viewport)
        }}
        defaultViewport={graph.viewport ?? { x: 0, y: 0, zoom: 0.85 }}
        minZoom={0.15}
        maxZoom={2.5}
        /*
         * Where an in-flight link snaps to. It is only half of "easy to hit": starting a
         * drag needs a pointerdown on the handle element, which is why `.socket::before` in
         * editor.css widens that to a 20px circle.
         */
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
        {/*
         * Inside `<ReactFlow>` because `ViewportPortal` finds its container through the flow's
         * store, and *before* the background only for reading order — the layer places itself by
         * portal, so its position in this list decides nothing. See `GroupLayer` for the three
         * viewport properties that do.
         */}
        <GroupLayer measured={measuredSizes} onContextMenu={onGroupContextMenu} />
        {/*
         * After `GroupLayer` for reading order only, as above. It takes no pointer at all, so
         * none of the three viewport hazards that layer documents apply to it beyond the depth.
         */}
        <LoopLayer measured={measuredSizes} collapse={collapse} />
        {/*
         * The open workflows. Top-left is the one corner of the pane nothing else claims — see
         * `WorkflowTabs` for why it is a canvas panel rather than a strip in the shell.
         */}
        <WorkflowTabs />
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.4}
          color="var(--canvas-dot)"
        />
        {/*
         * Every button in the rail is ours — see `ViewControls` for why React Flow's own zoom
         * and fit are switched off rather than left to sit above them. Reading order is view,
         * then layout, then the lock that governs both. The minimap toggle counts as view: it
         * governs what you can see rather than where anything is, and it is the one button here
         * that stays live under the lock — see `MinimapControl`.
         */}
        <Controls
          showZoom={false}
          showFitView={false}
          showInteractive={false}
          position="bottom-left"
        >
          <ViewControls />
          <MinimapControl />
          <LayoutControls onArrange={arrange} />
          <LockControl />
        </Controls>
        {minimapOpen && (
          <MiniMap
            // The minimap moves the viewport too, which is the whole of what it is for.
            pannable={!locked}
            zoomable={!locked}
            position="bottom-left"
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
       * Add a node.
       *
       * A circle in the corner rather than a word in the toolbar, and outside `<ReactFlow>` for
       * the reason the minimap's toggle used to be: a control that has to keep its corner
       * whatever the pane is doing. It opens onto the six categories and then onto their nodes;
       * `AddMenu` holds the design record for why that beat opening the browser outright.
       *
       * **Both routes ask for `canvasAnchor`, not the pointer.** Every other route in — Tab,
       * ⇧A, a drag into space — is a gesture *at* a point, and the node lands there. This one is
       * a button, and the pointer is on the button: `anchorPoint` would find it inside the
       * canvas bounds and drop the card in the bottom-right corner, under the thing that made
       * it — or, now, under the band of buttons it was picked from.
       *
       * Gone with the canvas while the dashboard is up, which the toolbar version was not — and
       * there it was a dead control, since `NodeBrowser` and the Tab binding both live here.
       */}
      <AddMenu locked={locked} onBrowse={browseAtCanvasAnchor} onAdd={addAtCanvasAnchor} />

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
            // on with the browser already up. `insertNodeAt` is the backstop.
            insertNodeAt(nodeType, browserAt)
            setBrowserAt(null)
          }}
          onClose={() => setBrowserAt(null)}
        />
      )}

      {contextMenu && (
        <NodeContextMenu
          screenPosition={contextMenu.screenPosition}
          flowPosition={contextMenu.flowPosition}
          nodeId={contextMenu.nodeId}
          onClose={() => setContextMenu(null)}
        />
      )}

      {groupMenu && (
        <GroupContextMenu
          screenPosition={groupMenu.screenPosition}
          groupId={groupMenu.groupId}
          onClose={() => setGroupMenu(null)}
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
 * Where an insertion lands when the pointer is not a place: the upper-middle of the canvas.
 *
 * Split out of `anchorPoint` for the Add button, which is *on* the canvas and so would pass the
 * inside-the-bounds test with the pointer sitting on the button itself — dropping the new card
 * in the bottom-right corner, half under the button that made it. The toolbar version of that
 * bug is the one `anchorPoint` was written for; a control inside the pane is the same bug with
 * the test passing. So a surface where the pointer means "the button" asks for this directly.
 */
function canvasAnchor(wrapper: HTMLElement | null): { x: number; y: number } {
  const bounds = wrapper?.getBoundingClientRect()
  if (!bounds) return { x: 0, y: 0 }
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 3 }
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
  return inside ? pointer : canvasAnchor(wrapper)
}

/**
 * One merged wire crossing a collapsed group's boundary.
 *
 * **Un-interactive on purpose**, all four ways: it cannot be selected, focused, deleted or
 * reconnected. It is not an edge in the document — it stands for one or more that are — so every
 * one of those gestures would have to pick which real wire it meant, and the reader cannot see
 * the card at the other end to make that choice.
 *
 * Its colour is the type flowing through it *when they all agree*, which is the common case (one
 * card inside a group, wired to several outside it) and the honest one. Where several sockets of
 * different types merge into one line, the line takes no type colour at all rather than the first
 * one's: a wire drawn Neurons-green that is also carrying a table is a claim, where an achromatic
 * one is a line whose contents you have to unfold to see.
 */
function collapsedWire(
  edge: CollapsedEdge,
  inference: ReturnType<typeof useGraphStore.getState>['inference'],
  step: boolean,
): Edge {
  const types = new Set(
    edge.origins.map((from) => inference.nodes[from.nodeId]?.outputs[from.portId]),
  )
  const only = types.size === 1 ? [...types][0] : undefined
  return {
    id: edge.id,
    type: 'coda',
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
    data: { step },
    selectable: false,
    focusable: false,
    deletable: false,
    reconnectable: false,
    className: 'coda-edge--collapsed',
    style: wireStyle(only),
  }
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
  if (!node) return undefined
  return nodePorts(node, side).find((p) => p.id === portId)?.type
}

export function Editor() {
  return (
    <ReactFlowProvider>
      <EditorCanvas />
    </ReactFlowProvider>
  )
}
