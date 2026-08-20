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
 * Merges are debounced. Auto-run turns one upstream edit into a stream of scenes, and applying
 * each would have neuroglancer rebuilding its layers several times a second underneath whatever
 * the user is doing with the mouse.
 */

import { useEffect, useRef } from 'react'

import type { TableValue } from '../../core/values'
import type { NgScene } from '../../data/neuroglancer/scene'
import {
  parseSceneUrl,
  proxiedViewer,
  sceneIdentity,
  scenePatchUrl,
  sceneUrl,
  spliceSegments,
  splitSceneUrl,
} from '../../data/neuroglancer/scene'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { describeLegend, resolveColor } from '../encoding'
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
  compact = false,
  baseName,
  onExpand,
  onError,
}: NeuroglancerViewerProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  /** What the live frame was last pointed at, so the next change knows how to apply itself. */
  const appliedRef = useRef<{ url: string; base: string; identity: string } | undefined>(
    undefined,
  )
  /** Whether a document has finished loading in the frame, i.e. whether there is state to merge into. */
  const loadedRef = useRef(false)

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !url) return
    // Re-running for a URL already applied would renavigate for nothing — and under
    // StrictMode's double-invoked effects it would send a patch as the frame's *first*
    // navigation, merging onto neuroglancer's defaults instead of the published scene.
    if (appliedRef.current?.url === url) return

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
    const frameBase = proxiedViewer(split.base) ?? split.base
    const applied = appliedRef.current
    const canMerge =
      // Nothing to merge *into* until the first document has loaded. Without this, changing a
      // selection during the second or two neuroglancer takes to boot would land a patch as
      // the opening navigation, merging onto its defaults instead of the published scene.
      loadedRef.current &&
      applied !== undefined &&
      applied.base === split.base &&
      applied.identity === identity

    // Recorded when the navigation happens, not when it is scheduled, so a burst that is
    // cancelled and superseded does not leave the frame's state misremembered.
    const navigate = () => {
      /*
       * Three ways to apply an update, best first.
       *
       * 1. Splice: read what the viewer is showing, put our selection into that, write it back.
       *    Everything the user has done — hidden layers, layers of their own, ordering, camera
       *    — is in the state we started from, so none of it is lost. Needs a same-origin frame.
       * 2. Merge: send our own layer list. Correct, but it is *ours*, so their layer edits go.
       * 3. Replace: the whole scene, for a first load or a different dataset.
       */
      const live = canMerge ? readLiveScene(frame) : undefined
      const spliced = live ? spliceSegments(live, split.scene) : undefined
      frame.src = spliced
        ? scenePatchUrl(frameBase, spliced)
        : canMerge
          ? scenePatchUrl(frameBase, split.scene)
          : sceneUrl(frameBase, split.scene)
      appliedRef.current = { url, base: split.base, identity }
    }

    if (!canMerge) {
      navigate()
      return
    }
    const timer = setTimeout(navigate, MERGE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [url])

  if (!url) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Run the node to build a neuroglancer scene.</div>
      </div>
    )
  }

  // Recomputed rather than carried on the value: same table, same spec, same palette, so it
  // cannot disagree with the colours already baked into the URL.
  const legend = resolveColor(neurons, color, VIEWER_MODE).legend
  const count = neurons?.length ?? 0
  /*
   * Three different states, and telling them apart is the whole job of this line: nothing
   * wired to the Neurons port, a port wired to something that is currently empty (an
   * untouched Explore selection), and neurons on screen. "0 neurons" for the first would read
   * as a failed fetch rather than as a scene nobody has asked anything of yet.
   */
  const summary = !neurons ? 'dataset scene · no neurons connected' : plural(count, 'neuron')

  const copyLink = () => {
    // Absent in jsdom, and on any page not served over a secure origin.
    const clipboard = navigator.clipboard
    if (!clipboard) {
      onError?.('This browser has no clipboard access')
      return
    }
    void clipboard
      .writeText(url)
      .catch(() => onError?.('This browser refused clipboard access'))
  }

  return (
    <div className="viewer">
      <div
        className="ng-frame"
        // A stored file could carry anything; a zero or negative scale divides the frame's
        // size by it and produces an element with no size, or an infinite one.
        style={{ '--ng-scale': safeScale(scale) } as React.CSSProperties}
      >
        <iframe
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
