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
 * **A remount is the other way that state dies, and `sceneMemo` is what carries it across.**
 * None of the above helps when the component itself goes away: expanding the card hands the node
 * to the overlay, which is a second instance, so the card stands down and the overlay opens a
 * frame of its own — and closing it does the same in reverse. Given a `viewerId`, the live state
 * is read on the way out and the next mount navigates to *that*, with the current selection
 * spliced in, instead of to the published scene. Same-origin only, like the splice it reuses.
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
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { TableValue } from '../../core/values'
import type { NgScene, ViewerKind } from '../../data/neuroglancer/scene'
import {
  parseSceneUrl,
  proxiedViewer,
  sceneIdentity,
  scenePatchUrl,
  viewerKind,
  sceneUrl,
  ownedLayerNames,
  spliceSegments,
  splitSceneUrl,
} from '../../data/neuroglancer/scene'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { errorMessage } from '../../core/errors'
import { describeLegend, resolveColor } from '../encoding'
import { copyText } from '../export'
import { forgetScene, recallScene, rememberScene } from './sceneMemo'
import { ViewerActions } from './ViewerActions'
import { plural } from '../format'

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
   * A key this embed's live state is remembered under, so a remount resumes rather than resets.
   *
   * The graph node id, exactly as `Viewer3D` and `NetworkViewer` take one: the card and the
   * overlay are two instances of one node and only the id says so. Undefined means remember
   * nothing, which is what a frame with no identity of its own should do.
   */
  viewerId?: string | undefined
  compact?: boolean
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
 * Readable only when the frame is same-origin, i.e. when the viewer is being served through the
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
  compact = false,
  baseName,
  onExpand,
  onError,
}: NeuroglancerViewerProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  /** What the live frame was last pointed at, so the next change knows how to apply itself. */
  const appliedRef = useRef<
    | { url: string; base: string; identity: string; viewerType?: ViewerKind | undefined }
    | undefined
  >(undefined)
  /** Whether a document has finished loading in the frame, i.e. whether there is state to merge into. */
  const loadedRef = useRef(false)
  /**
   * Bumped to throw the current document away and fetch a fresh one.
   *
   * There is no other way to reload a foreign-origin frame: `contentWindow.location.reload()`
   * is blocked, and re-assigning `src` with the same URL is a same-document fragment
   * navigation — the very property the merge depends on, working against us here. Remounting
   * the element is what forces a real load.
   */
  const [reloadCount, setReloadCount] = useState(0)
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
  }, [])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !url) return
    // Re-running for a URL already applied would renavigate for nothing — and under
    // StrictMode's double-invoked effects it would send a patch as the frame's *first*
    // navigation, merging onto neuroglancer's defaults instead of the published scene.
    // The chosen flavour as well as the URL: it is not *in* the URL — `sceneForViewer`
    // normalises — so flipping the control alone leaves this guard true and the frame showing
    // the scene built for the other one. The prop rather than the resolved kind, since
    // `viewerKind` is a pure function of the URL that is already being compared.
    if (appliedRef.current?.url === url && appliedRef.current.viewerType === viewerType) return

    /*
     * Nothing is written into a document somebody has the pointer in — see `pointerInside`.
     *
     * Only into a *loaded* one: an empty frame has no layers to tear down and no mouse state to
     * ask, so the opening navigation is never held and a card under the cursor still fills in.
     * The effect re-runs when the pointer leaves and picks this up from the top.
     */
    if (loadedRef.current && pointerInside) {
      heldRef.current = true
      return
    }
    const held = heldRef.current
    heldRef.current = false

    const split = splitSceneUrl(url)
    if (!split) {
      // Not a shape this understands — a hand-edited viewer URL. Navigate and stop guessing.
      frame.src = url
      appliedRef.current = undefined
      return
    }

    const identity = sceneIdentity(split.scene)
    // The frame goes to the proxied path where one exists; the *link* stays the absolute
    // public URL, so copying it still gives something that opens anywhere.
    const frameBase = sameOriginViewer(split.base) ?? split.base
    /*
     * Read off the *deployment*, not off `frameBase`: a proxy prefix is a path on this origin
     * and names no viewer, so asking about it would answer for the wrong one. Which flavour
     * decides whether a CAVE segmentation carries `middleauth+`, and both are wrong the other
     * way round — see `viewerKind`.
     */
    const kind = viewerType ?? viewerKind(split.base)
    const applied = appliedRef.current
    const canMerge =
      // Nothing to merge *into* until the first document has loaded. Without this, changing a
      // selection during the second or two neuroglancer takes to boot would land a patch as
      // the opening navigation, merging onto its defaults instead of the published scene.
      loadedRef.current &&
      applied !== undefined &&
      applied.base === split.base &&
      applied.identity === identity

    /*
     * What a *previous* instance of this viewer was showing, when there was one and it was
     * looking at the same place through the same deployment.
     *
     * Only consulted when there is no live frame to read — that is the whole case it exists for:
     * the card and the overlay are never up at once, so the hand-off between them arrives here
     * as a fresh mount with an empty frame. The gate is the one `canMerge` uses, asked of the
     * scene that *was* applied rather than of the state read back: see `sceneMemo`.
     */
    const remembered = viewerId ? recallScene(viewerId) : undefined
    const resumable =
      remembered && remembered.base === split.base && remembered.identity === identity
        ? remembered.scene
        : undefined

    // Recorded when the navigation happens, not when it is scheduled, so a burst that is
    // cancelled and superseded does not leave the frame's state misremembered.
    const navigate = () => {
      /*
       * Two questions, and they are independent: *what* state to write, and *how* to write it.
       *
       * What. Best first:
       * 1. Splice: take the state the viewer is showing — or, on a fresh mount, the one the last
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
      const live = canMerge ? readLiveScene(frame) : resumable
      const spliced =
        live && datasetId
          ? spliceSegments(
              live,
              split.scene,
              ownedLayerNames(split.scene, datasetId, extraLayers),
            )
          : undefined
      const scene = spliced ?? split.scene
      frame.src = canMerge
        ? scenePatchUrl(frameBase, scene, kind)
        : sceneUrl(frameBase, scene, kind)
      appliedRef.current = { url, base: split.base, identity, viewerType }
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
    // `reloadCount` belongs here rather than only on the element: the effect's own guard
    // returns early for a URL already applied, so a remount with no reason to renavigate would
    // leave a blank frame.
  }, [url, reloadCount, viewerType, datasetId, extraLayers, viewerId, pointerInside])

  /*
   * Read the live state on the way out, so the next instance can resume it.
   *
   * `useLayoutEffect`, and that is the load-bearing part: React runs a layout cleanup while the
   * subtree is still in the document, and a passive one after the host node has been removed. A
   * detached iframe has no `contentWindow`, so the passive version reads `undefined` every time
   * and remembers nothing — a null result that looks exactly like the cross-origin degrade.
   *
   * `viewerId` is the only dependency, so in practice this runs once and its cleanup fires on
   * unmount; everything else it reads is a ref, deliberately, so a re-render cannot make it
   * fire early. Nothing is stored before the first `load` or for a hand-edited URL
   * (`appliedRef` undefined), because in neither case is there a state belonging to a scene
   * this component can name.
   */
  useLayoutEffect(() => {
    if (!viewerId) return
    return () => {
      /*
       * The ref read *in* the cleanup, which is what the exhaustive-deps warning objects to and
       * is deliberate: Reload remounts the iframe element (`key={reloadCount}`), so an element
       * captured when the effect ran would be the discarded one by the time this fires. React
       * detaches a host ref after running the layout destroys above it, so the current one is
       * still there — the same ordering the read itself depends on.
       */
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const frame = frameRef.current
      const applied = appliedRef.current
      if (!frame || !applied || !loadedRef.current) return
      const live = readLiveScene(frame)
      if (live) {
        rememberScene(viewerId, {
          base: applied.base,
          identity: applied.identity,
          scene: live,
        })
      }
    }
  }, [viewerId])

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
    return (
      <div className="viewer">
        <div className="viewer__empty">Run the node to build a neuroglancer scene.</div>
      </div>
    )
  }

  const count = neurons?.length ?? 0
  /*
   * Three different states, and telling them apart is the whole job of this line: nothing
   * wired to the Neurons port, a port wired to something that is currently empty (an
   * untouched Explore selection), and neurons on screen. "0 neurons" for the first would read
   * as a failed fetch rather than as a scene nobody has asked anything of yet.
   */
  const summary = !neurons ? 'dataset scene · no neurons connected' : plural(count, 'neuron')

  const copyLink = () => {
    void copyText(url).catch((err: unknown) => onError?.(errorMessage(err)))
  }

  /*
   * Both refs are cleared first, and both matter. `appliedRef` is what the effect checks before
   * doing anything, so leaving it set means the remount produces an empty frame; `loadedRef`
   * decides merge-versus-replace, and merging into a document that no longer exists lands the
   * patch on neuroglancer's defaults rather than on the published scene.
   */
  const reload = () => {
    appliedRef.current = undefined
    loadedRef.current = false
    // And any hold, which is bookkeeping about a navigation that is now moot: left set, it
    // would put the fresh document's opening navigation behind the merge timer.
    heldRef.current = false
    // And the remembered state, which is the third thing a reload has to throw away: this is the
    // button somebody presses when the frame has gone wrong, so resuming into it is the one
    // outcome it must not have. Reload means the published scene.
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
      >
        <iframe
          // Remounting is the reload: see `reloadCount`.
          key={reloadCount}
          ref={frameRef}
          className="ng-frame__doc nodrag nowheel"
          title="Neuroglancer"
          referrerPolicy="no-referrer"
          allow="fullscreen"
          // Fires for fragment navigations as well as real loads, which is harmless here:
          // this only ever latches, and both mean a document is present to merge into.
          onLoad={() => {
            loadedRef.current = true
          }}
        />
      </div>

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
