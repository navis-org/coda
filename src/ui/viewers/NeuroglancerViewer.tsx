/**
 * Neuroglancer, embedded.
 *
 * The node has already built the URL — scene, segments and colours all live in its fragment
 * — so this component is an iframe plus a caption. That is the entire integration: no SDK,
 * no bundled copy of neuroglancer, and nothing crosses back, because a foreign-origin frame
 * cannot be read.
 *
 * It renders in the node body too, not only in the expanded overlay, because a viewer you
 * have to open before you can look at anything is not the exploration surface this is meant
 * to be. That is a real cost — each instance is a full WebGL application that starts fetching
 * EM on mount — so the card carries resize handles and the usual collapse toggle, which is
 * how you make one bigger or shut one up.
 *
 * **Navigation is driven by hand, not by a `src` prop.** React would re-point the frame at the
 * full scene on every change, and the full form makes neuroglancer `reset()` first — which
 * threw away the framing someone had just set up every time a selection changed upstream.
 * Instead: the first navigation carries the whole scene, and every later one carries only
 * what this app owns, in the `#!+` merge form. The camera, the panel layout and anything else
 * the viewer holds then survive an edit.
 *
 * **Where the viewer is proxied same-origin, updates are spliced rather than merged**: the
 * frame's live state is read, this app's selection is put into it, and that is written back. A
 * merge can only send *our* layer list, so it discards layers the user hid or added — the
 * finest granularity a merge has is a top-level key, and `layers` is one key. Reading their
 * state first is the only way round that, and reading needs same-origin. Cross-origin it falls
 * back to the merge, so the embed still works with no proxy at all.
 *
 * A full navigation returns whenever the scene's *identity* changes — a different dataset or
 * a different viewer instance — because keeping the old camera there would leave you looking
 * at empty space beside the volume you asked for.
 *
 * **Assigning `src` a URL that differs only in its fragment does not reload the document.** It
 * is a same-document fragment navigation, so neuroglancer keeps its meshes and simply handles
 * `hashchange`. Verified against the deployed viewer: the camera readout is identical either
 * side of a patch. Beware the obvious way to check this — **the iframe element's `load` event
 * fires on fragment navigations too**, so a load counter in the parent reports a reload that
 * did not happen. Only a signal from inside the frame can tell the two apart.
 *
 * What a merge still cannot preserve is per-layer state the viewer owns — a visibility toggle,
 * a randomised colour seed — because the merge is per top-level key and `layers` is replaced
 * whole. Sending a shorter layer list to dodge that deletes the EM volume instead.
 *
 * **A remount is the other way that state dies, and two things carry it across.** Expanding the
 * card hands the node to the overlay, which is a second instance, so the card stands down and the
 * overlay mounts — and closing it does the same in reverse. Where the browser can move an element
 * without reloading it (`moveBefore`), the frame itself is kept and handed over (`frames`, below),
 * so the application never stops and there is nothing to resume. Where it cannot, or once a kept
 * frame has been released, `sceneMemo` resumes instead: given a `viewerId`, the live state is read
 * on the way out and the next mount navigates to *that*, with the current selection spliced in.
 * Same-origin only, like the splice it reuses.
 *
 * Merges are debounced. Auto-run turns one upstream edit into a stream of scenes, and applying
 * each would have neuroglancer rebuilding its layers several times a second underneath whatever
 * the user is doing with the mouse.
 *
 * **And nothing is written while the pointer is inside the frame.** "Underneath whatever the
 * user is doing with the mouse" turned out to be literal: restoring `layers` rebuilds every
 * layer in two steps, and a layer that has been constructed but not yet initialised throws when
 * the hover machinery asks it anything — which it does exactly while `mouseState.active`, i.e.
 * while the pointer is over a render panel. So the update waits for `mouseleave`. See
 * `pointerInside`.
 *
 * **Except where nothing is restored.** Coda's own frame takes a change that is only a selection —
 * which neurons show, and their colours — as a message and edits the live layer in place
 * (`FrameSegmentsMessage`), so that, the commonest update by far, applies under the cursor with
 * the camera, the layout and the loaded meshes left alone. Only a structural change still navigates.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import type { TableValue } from '../../core/values'
import type { NgScene, ViewerKind } from '../../data/neuroglancer/scene'
import {
  parseSceneUrl,
  proxiedViewer,
  sceneIdentity,
  patchUrl,
  scenePatchUrl,
  viewerKind,
  sceneUrl,
  ownedLayerNames,
  spliceSegments,
  splitSceneUrl,
  layerPanelPatch,
  withLayerPanel,
  selectionLayerName,
  selectionChanges,
  layerListing,
  sceneUrlBase,
} from '../../data/neuroglancer/scene'
import type { FrameSegmentsMessage } from '../../data/neuroglancer/frameMessage'
import type { FrameKeysMessage } from '../../data/neuroglancer/frameMessage'
import {
  FRAME_KEYS_MESSAGE,
  FRAME_SEGMENTS_MESSAGE,
  isFrameKeyMessage,
  isFrameUnappliedMessage,
  decodeSavedView,
  encodeSavedView,
  isFrameStateMessage,
  isFrameViewMessage,
  withUpdate,
} from '../../data/neuroglancer/frameMessage'
import {
  decodeSelectionEdits,
  encodeSelectionEdits,
  mergeShownSegments,
} from '../../data/neuroglancer/selectionEdits'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { errorMessage } from '../../core/errors'
import { describeLegend, resolveColor } from '../../style/encoding'
import { copyText } from '../export'
import { useLatest } from '../useLatest'
import { useGraphStore } from '../../store/graphStore'
import { RootRegistry } from './persistentRoots'
import type { RootLease } from './persistentRoots'
import { forgetScene, recallScene, rememberScene } from './sceneMemo'
import { ViewerActions } from './ViewerActions'
import { plural } from '../../style/format'
import { ViewerEmpty } from './ViewerEmpty'

export interface NeuroglancerViewerProps {
  /** Built by the node; empty until it has run. */
  url: string
  /** The table the colours were resolved from. Only the legend needs it. */
  neurons?: TableValue | undefined
  color: ColorSpec
  /**
   * Frame scale. Below 1 the document is laid out larger and drawn smaller, which shrinks
   * neuroglancer's own toolbar and panels relative to the card. Nothing to do with its camera.
   */
  scale?: number
  /**
   * Which neuroglancer flavour the scene was built for, when somebody said so explicitly.
   *
   * Undefined means read it off the deployment. It has to arrive as a prop because the URL
   * cannot carry it: `sceneForViewer` normalises, so re-deriving here would undo an override on
   * exactly the host the table gets wrong — and this card is where that is seen.
   */
  viewerType?: ViewerKind | undefined
  /**
   * Which dataset the scene was built for, and how many layers came off the Extra layers socket.
   *
   * The pair `ownedLayerNames` needs, and props for `viewerType`'s reason stated one field up: the
   * URL cannot carry them. A published state ships preset `segments` on layers that are not ours —
   * male-CNS on sixteen of them — so "the layers with a selection" is not the question, and only
   * the node that built the scene knows these two facts.
   *
   * `datasetId` absent means updates fall to the merge tier rather than guessing. That is the
   * honest degrade: splicing writes into somebody's live state, and doing it to the wrong layer is
   * worse than sending our own list.
   *
   * Two primitives rather than one object because they belong in the effect's dependency list, and
   * an object rebuilt each render would re-navigate the frame on every parent render.
   */
  datasetId?: string | undefined
  extraLayers?: number | undefined
  /**
   * The key this embed's frame is kept under between surfaces, and its live state remembered under
   * once the frame is gone — the node's key within its workflow (`scopedKey`), exactly as `Viewer3D`
   * takes one: the card and the overlay are two instances of one node and only the key says so.
   * Undefined keeps and remembers nothing, which is what a frame with no identity of its own — the
   * profile tile — should do.
   */
  viewerId?: string | undefined
  /**
   * What the caption says, for a caller that hands its segments over inside the scene rather than
   * as a `neurons` table. Counting `neurons` there answers "no neurons connected" underneath a
   * neuron that is plainly drawn — which the profile's 3D tile did until this existed.
   */
  summary?: string | undefined
  /**
   * A small surface: button labels and the legend go.
   */
  compact?: boolean
  /**
   * Whether neuroglancer's layer bar shows — in the frame only, never in the link ↗ and ⧉ hand
   * out. Off unless asked for, on every surface. See `withLayerPanel`.
   */
  layerBar?: boolean
  /**
   * The node's `selectionEdits` as stored, and the way to write it — what somebody double-clicked
   * into or out of the scene. Both absent on a surface that has no node to write to (the profile
   * tile), which then never reads the frame back.
   */
  selectionEdits?: unknown
  onSelectionEdits?: (next: string[]) => void
  /**
   * The deployment to open the frame at, where it is not the link's — Coda's own copy, which can be
   * read back, while the link opens the dataset's viewer (`frameTarget`). Undefined frames `url`.
   */
  frameViewer?: string | undefined
  /** Whether a neuron hidden in the viewer stays selected — `Hidden neurons` on the node. */
  keepHidden?: boolean
  /**
   * The node's saved view (`encodeSavedView`), and the way to write it: the camera and layout the
   * frame reopens at. Absent where nothing can be written, and the frame then opens as published.
   */
  savedView?: unknown
  onSavedView?: (text: string) => void
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/**
 * How long a burst of updates is allowed to collapse for before one is sent.
 *
 * Auto-run re-evaluates on every upstream edit, so dragging a threshold or typing in a filter
 * produces a stream of scenes. Each one applied would have neuroglancer tearing its layers
 * down and rebuilding them several times a second, on top of whatever the user is doing with
 * the mouse — which is the shape of the errors this was reported with. Only the last of a
 * burst is worth anything, so only the last is sent.
 *
 * Trailing-edge only, and only for merges: the *first* navigation shows the scene immediately,
 * because a viewer that waits before showing anything reads as broken.
 */
const MERGE_DEBOUNCE_MS = 300

/**
 * The scene the embed is currently showing, or undefined when it cannot be read.
 *
 * Readable only when the frame is same-origin — Coda's own copy, or the public demo through the dev
 * proxy. Cross-origin this throws, and that is the whole difference between editing the user's
 * state and overwriting it.
 */
function readLiveScene(frame: HTMLIFrameElement): NgScene | undefined {
  try {
    const hash = frame.contentWindow?.location.hash
    return hash ? parseSceneUrl(hash) : undefined
  } catch {
    return undefined
  }
}

/**
 * A frame, and what has been done to it — the part that has to outlive any one component.
 *
 * Kept with the frame rather than in the component's refs because a surface that adopts a live
 * frame has to know what it is already showing. Adopted without it, the next instance would take
 * the frame for an empty one and send it the full scene, resetting exactly the camera and layers
 * that keeping the frame exists to carry.
 */
interface HeldFrame {
  frame: HTMLIFrameElement
  /** What the frame was last pointed at, so the next change knows how to apply itself. */
  applied:
    | {
        url: string
        base: string
        /** `url`'s scene, parsed once — every later update and every frame report compares to it. */
        scene: NgScene
        identity: string
        viewerType?: ViewerKind | undefined
        /** Whether the layer bar was last sent shown — see `withLayerPanel`. */
        layerPanel: boolean
      }
    | undefined
  /** Whether a document has finished loading in the frame, i.e. whether there is state to merge into. */
  loaded: boolean
  /** Where its live state is remembered once the frame is gone — the leasing surface's `viewerId`. */
  memoKey: string | undefined
  /**
   * The deployment the frame was showing when it last reported its state — i.e. that it is Coda's
   * own neuroglancer, which can take a selection in place. Keyed by the deployment, since a frame
   * re-pointed at a typed `Viewer` is a different document that reports nothing and takes nothing.
   */
  speaksFor: string | undefined
  /**
   * How many updates the frame has been sent — stamped on every navigation and in-place message, so
   * a report can say which one it describes (`FRAME_UPDATE_KEY`).
   */
  sent: number
  /** Whether this document was last told ⌥1–9 are Coda's (`FrameKeysMessage`). */
  claimsAltDigits?: boolean
}

/**
 * Everything known about the document in a frame, dropped when the frame navigates to another
 * deployment — which loads a new document that has not loaded, not reported, and not been told
 * which keys are Coda's.
 */
function forgetDocument(held: HeldFrame): void {
  held.loaded = false
  held.speaksFor = undefined
  held.claimsAltDigits = undefined
}

function createFrame(): { host: HTMLElement; root: HeldFrame } {
  const frame = document.createElement('iframe')
  frame.className = 'ng-frame__doc nodrag nowheel'
  frame.title = 'Neuroglancer'
  frame.referrerPolicy = 'no-referrer'
  frame.allow = 'fullscreen'
  const held: HeldFrame = {
    frame,
    applied: undefined,
    loaded: false,
    memoKey: undefined,
    speaksFor: undefined,
    sent: 0,
  }
  // Every load, not the first: a navigation to another deployment loads a new document, and
  // `forgetDocument` unlatched this for it. (A fragment navigation fires `load` too, harmlessly.)
  frame.addEventListener('load', () => {
    held.loaded = true
  })
  return { host: frame, root: held }
}

/**
 * Read a frame's live state into `sceneMemo` as it is destroyed, so the next instance can resume it.
 *
 * Only when a frame is *gone* — released after nothing adopted it, built privately where it could not
 * be kept, or discarded — since a frame handed to the next surface is still showing that state and a
 * read would be parsed for nothing. The registry calls this while the frame is still in the document:
 * a detached iframe has no `contentWindow`, and a null read looks exactly like the cross-origin degrade.
 * Nothing is stored before the first `load` or for a hand-edited URL (`applied` undefined), because in
 * neither case is there a state belonging to a scene this component can name.
 */
function rememberFrame(held: HeldFrame): void {
  if (!held.memoKey || !held.applied || !held.loaded) return
  const live = readLiveScene(held.frame)
  if (live) {
    rememberScene(held.memoKey, {
      base: held.applied.base,
      identity: held.applied.identity,
      scene: live,
    })
  }
}

/**
 * Frames kept between surfaces — only where `moveBefore` keeps one alive through a move, and pinned
 * at their size while parked, since neuroglancer watches its own. See `docs/viewers.md`.
 */
const frames = new RootRegistry<HeldFrame>({
  create: createFrame,
  destroy: rememberFrame,
  keepOnlyIfMovable: true,
  pinWhenParked: true,
})

/**
 * The same-origin path serving this deployment, **where this build is behind one**.
 *
 * `proxiedViewer` answers a question about the *configuration* — which origins have a prefix
 * declared — and that is deliberately not the question asked here, which is whether anything
 * is serving it. The `/ng` rule lives in `vite.config.ts`, so it exists under `pnpm dev` and
 * nowhere else. Getting the two confused does not degrade to the cross-origin embed, which is
 * what makes it worth a function: `/ng` is an *absolute path*, so the frame is pointed at this
 * origin and 404s. Measured against the published site — `navis-org.github.io/ng/` and
 * `/coda/ng/` both answer 404, and the first is where the deployed card sent its frame — so
 * every dataset that does not name a viewer of its own showed a blank panel.
 *
 * `import.meta.env.DEV` rather than a flag of our own, and it costs the splice under
 * `pnpm preview` even though that server does mount the rule. That is the right way round:
 * preview serves the deploy artefact, and a preview that behaves better than the thing it
 * previews is not one.
 */
function sameOriginViewer(viewerBase: string): string | undefined {
  return import.meta.env.DEV ? proxiedViewer(viewerBase) : undefined
}

function safeScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

/** Matches the node: neuroglancer renders on black whatever Coda's theme is. */
const VIEWER_MODE = 'dark' as const

export function NeuroglancerViewer({
  url,
  neurons,
  color,
  scale = 1,
  viewerType,
  datasetId,
  extraLayers = 0,
  viewerId,
  summary: givenSummary,
  compact = false,
  layerBar = false,
  selectionEdits,
  onSelectionEdits,
  frameViewer,
  keepHidden = false,
  savedView,
  onSavedView,
  baseName,
  onExpand,
  onError,
}: NeuroglancerViewerProps) {
  /** The frame this surface shows, kept or private — see `frames`. */
  const leaseRef = useRef<RootLease<HeldFrame> | null>(null)
  /**
   * Bumped to throw the frame away and build a fresh one.
   *
   * There is no other way to reload a foreign-origin frame: `contentWindow.location.reload()`
   * is blocked, and re-assigning `src` with the same URL is a same-document fragment
   * navigation — the very property the merge depends on, working against us here. A new element
   * is what forces a real load.
   */
  const [reloadCount, setReloadCount] = useState(0)
  /** Bumped to re-run the navigation when the frame could not apply an update in place. */
  const [resync, setResync] = useState(0)
  /** The element the pointer enters, which is the frame plus its own padding. */
  const boxRef = useRef<HTMLDivElement>(null)
  /**
   * Whether the pointer is inside the embed, and the reason a navigation waits for it to leave.
   *
   * Restoring `layers` makes neuroglancer tear down and rebuild *every* layer, and it does that
   * in two steps: a layer is constructed — at which point it has already subscribed to the
   * hover machinery — and only then initialised, which is where `selectionState` is assigned.
   * Anything that asks a layer about the mouse in between reads `generation` off `undefined`.
   *
   * `LayerSelectedValues.handleLayerChange` asks exactly when `mouseState.active` is true, and
   * that is true when the pointer is over a render panel with a resolved pick. So the crash
   * reported against this card — `can't access property "generation" of undefined` — is what a
   * patch landing under the cursor does, and holding the patch until the pointer leaves is what
   * removes the precondition. It cannot be fixed from here: neuroglancer never disposes the
   * subscription, so one such failure poisons hover for the life of the document.
   * See [docs/viewers.md](../../../docs/viewers.md).
   *
   * State rather than a ref, because the navigation effect has to *re-run* when it clears.
   */
  const [pointerInside, setPointerInside] = useState(false)
  /** Whether a navigation is waiting on that, so the resume knows it is not a fresh one. */
  const heldRef = useRef(false)
  /** Whether there is a frame box to put a frame in — none before the node has run. */
  const hasUrl = url !== ''

  /*
   * Native listeners rather than React's `onMouseEnter`/`onMouseLeave`, and the reason is the
   * iframe. React synthesises enter/leave from delegated `mouseover`/`mouseout` at the root, and
   * a pointer that has crossed into a foreign document produces neither — the events happen in
   * the frame's own tree. The element's own `mouseenter`/`mouseleave` are dispatched by the
   * browser against the *iframe box*, so they fire either way.
   */
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const enter = () => setPointerInside(true)
    const leave = () => setPointerInside(false)
    box.addEventListener('mouseenter', enter)
    box.addEventListener('mouseleave', leave)
    return () => {
      box.removeEventListener('mouseenter', enter)
      box.removeEventListener('mouseleave', leave)
    }
  }, [hasUrl])

  /*
   * Take a frame — the one this node already has, where it can be kept — into the box, and give it
   * back on the way out. A layout effect, so it runs before the navigation effect reads the lease.
   */
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const lease = frames.lease(viewerId, box)
    lease.root.memoKey = viewerId
    leaseRef.current = lease
    return () => {
      leaseRef.current = null
      lease.release()
    }
  }, [viewerId, reloadCount, hasUrl])

  /*
   * The deployment the frame opens, which is not always the link's: Coda's own copy where the node
   * says so (`frameTarget`). Everything below navigates, merges and reads the frame against this;
   * Copy link and New tab hand out `url` as it is. The scene is rebuilt for this deployment's
   * flavour by the same `sceneUrl`/`scenePatchUrl` that build every navigation, so a link built
   * for the Seung-lab fork still loads here.
   */
  const target = frameViewer ?? sceneUrlBase(url)

  /**
   * Whether the frame reports back by itself, which only Coda's own copy does — on this origin.
   * Not the public demo through the dev proxy: same-origin, but it posts nothing. Elsewhere (the
   * dataset's viewer, a custom one) the selection comes back as a pasted link instead.
   */
  const readable = useMemo(() => {
    if (target === undefined) return false
    try {
      return new URL(target, window.location.href).origin === window.location.origin
    } catch {
      return false
    }
  }, [target])

  /** Read by the opening navigation, which must not re-run every time the camera is saved. */
  const savedViewRef = useLatest(savedView)
  const onSavedViewRef = useLatest(onSavedView)

  /*
   * A saved view taken in another dataset is cleared rather than kept: it is a position in that
   * volume's coordinates, and nothing here could ever reopen at it.
   */
  useEffect(() => {
    const saved = decodeSavedView(savedView)
    if (saved && datasetId && saved.dataset !== datasetId) onSavedViewRef.current?.('')
  }, [savedView, datasetId, onSavedViewRef])

  useEffect(() => {
    const kept = leaseRef.current?.root
    if (!kept || !url) return
    /** The next update's number — every write to the frame takes one (`FRAME_UPDATE_KEY`). */
    const nextUpdate = () => ++kept.sent
    // Re-running for a URL already applied would renavigate for nothing — and under
    // StrictMode's double-invoked effects it would send a patch as the frame's *first*
    // navigation, merging onto neuroglancer's defaults instead of the published scene. It is also
    // what makes adopting a kept frame free: it is already showing this URL.
    // The chosen flavour as well as the URL: it is not *in* the URL — `sceneForViewer`
    // normalises — so flipping the control alone leaves this guard true and the frame showing
    // the scene built for the other one. The prop rather than the resolved kind, since
    // `viewerKind` is a pure function of the URL that is already being compared.
    const was = kept.applied
    const sameScene = was?.url === url && was.base === target && was.viewerType === viewerType
    if (sameScene && was.layerPanel === layerBar) return

    /*
     * Only `layerBar` changed. The bar goes on its own, so no layer is rebuilt and no pointer
     * hold applies. Only into a *loaded* document: a patch as the opening navigation would leave
     * a scene of nothing but the bar.
     */
    if (sameScene && kept.loaded) {
      kept.frame.src = patchUrl(
        sameOriginViewer(was.base) ?? was.base,
        withUpdate(layerPanelPatch(layerBar), nextUpdate()),
      )
      kept.applied = { ...was, layerPanel: layerBar }
      return
    }

    const split = splitSceneUrl(url)

    /*
     * Only a selection changed, and the frame is Coda's own (it has reported): set it in place, no
     * pointer hold, no navigation — see the file header. Anything else navigates, below.
     */
    if (
      was &&
      split &&
      kept.loaded &&
      kept.speaksFor === was.base &&
      target === was.base &&
      was.viewerType === viewerType &&
      was.layerPanel === layerBar
    ) {
      const changes = selectionChanges(was.scene, split.scene)
      if (changes) {
        if (changes.length > 0) {
          const message: FrameSegmentsMessage = {
            type: FRAME_SEGMENTS_MESSAGE,
            layers: changes,
            update: nextUpdate(),
          }
          kept.frame.contentWindow?.postMessage(message, window.location.origin)
        }
        kept.applied = { ...was, url, scene: split.scene }
        // A navigation held for the pointer is superseded: this is the scene to show now.
        heldRef.current = false
        return
      }
    }

    /*
     * Nothing is written into a document somebody has the pointer in — see `pointerInside`.
     *
     * Only into a *loaded* one: an empty frame has no layers to tear down and no mouse state to
     * ask, so the opening navigation is never held and a card under the cursor still fills in.
     * The effect re-runs when the pointer leaves and picks this up from the top.
     */
    if (kept.loaded && pointerInside) {
      heldRef.current = true
      return
    }
    const held = heldRef.current
    heldRef.current = false

    if (!split || target === undefined) {
      // Not a shape this understands — a hand-edited viewer URL. Navigate and stop guessing, and
      // unnumbered: with nothing applied there is nothing a report from it could be folded into.
      kept.frame.src = url
      kept.applied = undefined
      return
    }

    const identity = sceneIdentity(split.scene)
    // The frame's deployment, through the dev proxy where one is served. The link is not touched
    // here: it is the datastack's own viewer, as the node built it.
    const frameBase = sameOriginViewer(target) ?? target
    /*
     * Read off the *deployment*, not off `frameBase`: a proxy prefix is a path on this origin
     * and names no viewer, so asking about it would answer for the wrong one. Which flavour
     * decides whether a CAVE segmentation carries `middleauth+`, and both are wrong the other
     * way round — see `viewerKind`.
     */
    const kind = viewerType ?? viewerKind(target)
    const applied = kept.applied
    const canMerge =
      // Nothing to merge *into* until the first document has loaded. Without this, changing a
      // selection during the second or two neuroglancer takes to boot would land a patch as
      // the opening navigation, merging onto its defaults instead of the published scene.
      kept.loaded &&
      applied !== undefined &&
      applied.base === target &&
      applied.identity === identity

    /*
     * What a *previous* instance of this viewer was showing, when there was one and it was
     * looking at the same place through the same deployment.
     *
     * Only consulted when there is no live frame to read — that is the whole case it exists for:
     * a frame that could not be kept arrives here as a fresh mount with an empty frame. The gate
     * is the one `canMerge` uses, asked of the scene that *was* applied rather than of the state
     * read back: see `sceneMemo`.
     */
    const remembered = viewerId ? recallScene(viewerId) : undefined
    const resumable =
      remembered && remembered.base === target && remembered.identity === identity
        ? remembered.scene
        : undefined

    // Recorded when the navigation happens, not when it is scheduled, so a burst that is
    // cancelled and superseded does not leave the frame's state misremembered.
    const navigate = () => {
      /*
       * Two questions, and they are independent: *what* state to write, and *how* to write it.
       *
       * What. Best first:
       * 1. Splice: take the state the viewer is showing — or, on a fresh frame, the one the last
       *    instance was showing — and put our selection into it. Everything the user has done,
       *    hidden layers, layers of their own, ordering, camera, is in the state we started
       *    from, so none of it is lost. Needs a same-origin frame to have been read.
       * 2. The scene the node built. Correct, but it is *ours*, so their layer edits go.
       *
       * How. A patch (`#!+`) merges onto what the document already holds, so it is the only
       * form worth sending to a frame that has one — and the only form that is *safe* to send,
       * since the full form resets first. A fresh frame has nothing to merge into and takes the
       * full form, which is exactly why resuming has to happen through the state rather than
       * through the URL form: the whole scene, restored in one navigation.
       */
      const live = canMerge ? readLiveScene(kept.frame) : resumable
      const spliced =
        live && datasetId
          ? spliceSegments(
              live,
              split.scene,
              ownedLayerNames(split.scene, datasetId, extraLayers),
            )
          : undefined
      /*
       * A frame opening from nothing — not a merge, not a resume — opens where the workflow was
       * saved looking (`view`), if that view was taken in this dataset. Only then: a later full
       * navigation is somebody changing `Layout` or the dataset, and means the published framing.
       */
      const saved = decodeSavedView(savedViewRef.current)
      const reopened =
        !live && applied === undefined && saved && saved.dataset === datasetId ? saved.view : {}
      const scene = { ...(spliced ?? split.scene), ...reopened }
      // A merge carries the bar only when it changed, so one toggled inside the viewer survives a
      // selection; a full navigation always takes the setting, whatever a resumed state said.
      const barChange = applied?.layerPanel === layerBar ? {} : layerPanelPatch(layerBar)
      if (applied && applied.base !== target) forgetDocument(kept)
      kept.frame.src = canMerge
        ? scenePatchUrl(frameBase, scene, kind, withUpdate(barChange, nextUpdate()))
        : sceneUrl(frameBase, withUpdate(withLayerPanel(scene, layerBar), nextUpdate()), kind)
      kept.applied = {
        url,
        base: target,
        scene: split.scene,
        identity,
        viewerType,
        layerPanel: layerBar,
      }
    }

    /*
     * A replacement is immediate — there is no live framing to protect and waiting would leave
     * the card showing the wrong volume — *unless* it is resuming from a hold, where the delay
     * is the point. The pointer has just crossed out of the frame and the frame's own
     * `mouseleave` is what clears `mouseState.active`; going through the timer keeps our write
     * behind it rather than racing it across two documents.
     */
    if (!canMerge && !held) {
      navigate()
      return
    }
    const timer = setTimeout(navigate, MERGE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `reloadCount` belongs here: the lease it swaps holds a frame that has applied nothing, and
    // this effect is what points it somewhere.
  }, [
    url,
    target,
    reloadCount,
    viewerType,
    datasetId,
    extraLayers,
    viewerId,
    pointerInside,
    layerBar,
    savedViewRef,
    resync,
  ])

  /**
   * Fold a scene the viewer reports — or one pasted as a link — into the node's edits, measured
   * against the scene the frame was last sent (`mergeShownSegments` says why not the input).
   * Writes only when something changed, so the frame's report of a scene the node just built is
   * not an edit.
   */
  const foldScene = (reported: NgScene): boolean => {
    const applied = leaseRef.current?.root.applied
    if (!onSelectionEdits || !datasetId || !applied) return false
    const layer = selectionLayerName(applied.scene, datasetId)
    const sent = layer ? layerListing(applied.scene, layer) : undefined
    const got = layer ? layerListing(reported, layer) : undefined
    // No such layer in what came back: somebody deleted it, which is not a statement about neurons.
    if (!sent || !got) return false
    // Where hidden neurons stay selected, the list is the selection and the hidden ones are noted;
    // otherwise only what is drawn counts, and hiding a neuron removes it.
    const current = decodeSelectionEdits(selectionEdits)
    const was = encodeSelectionEdits(current)
    const next = encodeSelectionEdits(
      keepHidden
        ? mergeShownSegments(current, sent.listed, got.listed, got.hidden)
        : mergeShownSegments(current, sent.shown, got.shown),
    )
    if (next.join('\n') !== was.join('\n')) onSelectionEdits(next)
    return true
  }
  /** Save where the frame is looking, with the dataset it is looking at (`encodeSavedView`). */
  const saveView = (view: NgScene) => {
    if (!onSavedView || !datasetId) return
    const text = encodeSavedView(datasetId, view)
    if (text !== savedView) onSavedView(text)
  }
  /** This render's handlers, for a listener bound once. */
  const handlers = useLatest({ foldScene, saveView })

  /*
   * ⌥1–9 switch dashboard tabs, and with focus in the frame Coda never hears them: the key goes to
   * the frame's document. So a frame that reports back (Coda's own) is told to hand them over while
   * the dashboard is open, and leaves them to neuroglancer elsewhere, as Coda does. Told again on
   * its first report, since a message sent before its script has loaded is lost.
   */
  const claimAltDigits = useGraphStore((s) => s.dashboardOpen)
  const claimRef = useLatest(claimAltDigits)
  const tellKeys = (kept: HeldFrame) => {
    if (kept.speaksFor === undefined || kept.claimsAltDigits === claimRef.current) return
    kept.claimsAltDigits = claimRef.current
    const message: FrameKeysMessage = { type: FRAME_KEYS_MESSAGE, altDigits: claimRef.current }
    kept.frame.contentWindow?.postMessage(message, window.location.origin)
  }
  const tellKeysRef = useLatest(tellKeys)
  useEffect(() => {
    const kept = leaseRef.current?.root
    if (kept) tellKeysRef.current(kept)
  }, [claimAltDigits, claimRef, tellKeysRef])

  /*
   * Bound whether or not this surface can write: a report is also how the frame says it is Coda's
   * own and can take a selection in place (`speaksFor`). Either report is used only if it is of
   * the latest update — an older one describes a scene, or a framing, the card no longer holds
   * (`FRAME_UPDATE_KEY`).
   */
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const kept = leaseRef.current?.root
      if (!kept || event.source !== kept.frame.contentWindow) return
      if (event.origin !== window.location.origin) return
      if (isFrameKeyMessage(event.data)) {
        // As if pressed here: Coda's own shortcut listener decides, tour and all.
        const { code, altKey } = event.data
        window.dispatchEvent(new KeyboardEvent('keydown', { code, altKey, bubbles: true }))
        return
      }
      const latest = (event.data as { update?: unknown }).update === kept.sent
      if (!latest) return
      if (isFrameViewMessage(event.data)) {
        // Never the opening view: the frame keeps that to itself (`reportChanges`).
        handlers.current.saveView(event.data.view)
      } else if (isFrameStateMessage(event.data)) {
        // Only from a report of the latest update: a late one from the document before a
        // navigation would vouch for a document that has not reported.
        kept.speaksFor = kept.applied?.base
        tellKeysRef.current(kept)
        handlers.current.foldScene(event.data.state)
      } else if (isFrameUnappliedMessage(event.data) && kept.applied) {
        // The frame could not set the selection in place: stop trying, and navigate instead.
        kept.speaksFor = undefined
        kept.applied = { ...kept.applied, url: '' }
        setResync((n) => n + 1)
      }
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [handlers, tellKeysRef])

  const [pasting, setPasting] = useState(false)
  const readLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = String(new FormData(event.currentTarget).get('link') ?? '')
    const scene = parseSceneUrl(text.trim())
    if (!scene || !foldScene(scene)) {
      // Only a link carrying its state inline (`#!{…}`). A FlyWire or CAVE share link points at a
      // stored state, which would need fetching — often with a sign-in.
      onError?.(
        'Could not read neurons from that link. Paste a link that carries its state (#!{…}) and ' +
          'shows this dataset; a share link pointing at a saved state is not supported yet.',
      )
      return
    }
    setPasting(false)
  }

  /*
   * Recomputed rather than carried on the value: same table, same spec, same palette, so it
   * cannot disagree with the colours already baked into the URL.
   *
   * Memoised, and above the early return because a hook cannot be conditional. `pointerInside`
   * renders this component twice per pointer crossing, and the table it reads is the *whole*
   * input — measured at 17 ms per call over 50,000 rows under `hash` colouring, which is 34 ms
   * of nothing on the way in and out of a card somebody is trying to look at. Free under the
   * node's own default (`resolveColor` early-returns for `default`), which is why it went
   * unnoticed. The deps are exactly what it reads, and neither changes on a hover.
   */
  const legend = useMemo(
    () => resolveColor(neurons, color, VIEWER_MODE).legend,
    [neurons, color],
  )

  if (!url) {
    return <ViewerEmpty>Run the node to build a neuroglancer scene.</ViewerEmpty>
  }

  const count = neurons?.length ?? 0
  /*
   * Three different states, and telling them apart is the whole job of this line: nothing
   * wired to the Neurons port, a port wired to something that is currently empty (an
   * untouched Explore selection), and neurons on screen. "0 neurons" for the first would read
   * as a failed fetch rather than as a scene nobody has asked anything of yet.
   */
  const summary =
    givenSummary ??
    (!neurons ? 'dataset scene · no neurons connected' : plural(count, 'neuron'))

  const copyLink = () => {
    void copyText(url).catch((err: unknown) => onError?.(errorMessage(err)))
  }

  const reload = () => {
    // Bookkeeping about a navigation that is now moot: left set, it would put the fresh document's
    // opening navigation behind the merge timer.
    heldRef.current = false
    // Thrown away rather than parked: this is the button somebody presses when the frame has gone
    // wrong, and the next lease builds one from nothing, with no `applied` and no `loaded`.
    leaseRef.current?.discard()
    // And forgotten *after* the discard, which remembers the frame as it goes: resuming into the
    // state that went wrong is the one outcome Reload must not have. It means the published scene.
    if (viewerId) forgetScene(viewerId)
    setReloadCount((n) => n + 1)
  }

  return (
    <div className="viewer">
      <div
        ref={boxRef}
        className="ng-frame"
        // A stored file could carry anything; a zero or negative scale divides the frame's
        // size by it and produces an element with no size, or an infinite one.
        style={{ '--ng-scale': safeScale(scale) } as React.CSSProperties}
      />

      {legend?.kind === 'categorical' && !compact && (
        <div className="legend">
          {legend.entries.map((entry) => (
            <span key={entry.label} className="legend__item">
              <span className="legend__swatch" style={{ background: entry.color }} />
              {entry.label}
            </span>
          ))}
        </div>
      )}

      {pasting && (
        <form className="ng-paste nodrag" onSubmit={readLink}>
          <input
            name="link"
            className="ng-paste__input"
            placeholder="Paste a neuroglancer link"
            aria-label="Neuroglancer link"
            autoFocus
            onKeyDown={(event) => {
              // A bare key must not reach the canvas's shortcuts while typing here.
              event.stopPropagation()
              if (event.key === 'Escape') setPasting(false)
            }}
          />
          <button type="submit" className="viewer-actions__btn">
            Read
          </button>
        </form>
      )}

      <div className="viewer__caption">
        <span>
          {summary}
          {count > 0 && legend && ` · ${describeLegend(legend)}`}
        </span>
        <div className="viewer-actions">
          <button
            type="button"
            className="viewer-actions__btn nodrag"
            title="Copy the scene link"
            aria-label="Copy link"
            onClick={copyLink}
          >
            ⧉{!compact && <span>Copy link</span>}
          </button>
          {onSelectionEdits && datasetId && !readable && (
            <button
              type="button"
              className="viewer-actions__btn nodrag"
              title="Read the neurons from a neuroglancer link — this viewer cannot be read directly"
              aria-label="Read neurons from a link"
              aria-pressed={pasting}
              onClick={() => setPasting((open) => !open)}
            >
              ⇣{!compact && <span>From link</span>}
            </button>
          )}
          <button
            type="button"
            className="viewer-actions__btn nodrag"
            title="Reload the viewer"
            aria-label="Reload the viewer"
            onClick={reload}
          >
            ↻{!compact && <span>Reload</span>}
          </button>
          <a
            className="viewer-actions__btn nodrag"
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            title="Open in a new tab"
            aria-label="Open in a new tab"
          >
            ↗{!compact && <span>New tab</span>}
          </a>
          <ViewerActions
            baseName={baseName ?? 'neuroglancer'}
            source={{}}
            compact={compact}
            onExpand={onExpand}
            onError={onError}
          />
        </div>
      </div>
    </div>
  )
}
