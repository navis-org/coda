/**
 * Coda's own neuroglancer, served from this origin as `neuroglancer.html` so the Neuroglancer card
 * can read the selection back — a frame on neuroglancer's own origin cannot be read at all.
 *
 * The neuroglancer is Spelunker, CAVE's build (`vendor/`, `scripts/build-neuroglancer.mjs`). This is
 * its `main.bundle.js` and `main.js` minus `util/google_tag_manager.js` — this build ships no
 * third-party tag beyond the gated GoatCounter one — with the deployment's keybindings set first
 * (`keybinds.ts`).
 */

// First: neuroglancer reads its keybindings once, as its modules are evaluated.
import './keybinds'
import 'neuroglancer/unstable/util/polyfills.js'
import 'neuroglancer/unstable/layer/enabled_frontend_modules.js'
import 'neuroglancer/unstable/datasource/enabled_frontend_modules.js'
import 'neuroglancer/unstable/kvstore/enabled_frontend_modules.js'
import { setupDefaultViewer } from 'neuroglancer/unstable/ui/default_viewer_setup.js'
import { getCachedJson } from 'neuroglancer/unstable/util/trackable.js'

import { registerCaveCredentials } from './caveCredentials'
import { isSegmentId } from '../core/ids'
import { isTypingTarget } from '../core/keys'
import {
  FRAME_UNAPPLIED_MESSAGE,
  type FrameUnappliedMessage,
  FRAME_KEY_MESSAGE,
  type FrameKeyMessage,
  isAltDigit,
  isFrameKeysMessage,
  FRAME_STATE_MESSAGE,
  FRAME_VIEW_MESSAGE,
  type FrameStateMessage,
  type FrameViewMessage,
  pickView,
  isFrameSegmentsMessage,
  updateIn,
} from '../data/neuroglancer/frameMessage'
import type { LayerSelection } from '../data/neuroglancer/scene'
import { parseSceneUrl, segmentEntry } from '../data/neuroglancer/scene'

/** Settled for this long before posting; neuroglancer's own hash binding waits 200 ms. */
const SETTLE_MS = 250

/** The update a navigation's fragment carries, if any. */
const hashUpdate = () => updateIn(parseSceneUrl(window.location.hash))

/** The last of the card's updates applied here, echoed on every report (`FRAME_UPDATE_KEY`). */
let applied = hashUpdate() ?? 0

// Coda's CAVE tokens first in line for every protected data server (`caveCredentials.ts`).
registerCaveCredentials()
const viewer = setupDefaultViewer()
window.addEventListener('hashchange', () => {
  // Neuroglancer restores the state on this same event, so a report after it describes this update.
  applied = hashUpdate() ?? applied
})
if (window.parent !== window) reportChanges(viewer)

/** Post the layers and the view to the card whenever they settle after a change. */
function reportChanges(ng: typeof viewer): void {
  const layers = ng.state.children.get('layers')
  if (!layers) return
  let timer: ReturnType<typeof setTimeout> | undefined
  let posted = -1
  let postedView = ''
  // This origin only: a state can name private sources.
  const post = (message: FrameStateMessage | FrameViewMessage) =>
    window.parent.postMessage(message, window.location.origin)
  ng.state.changed.add(() => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      // The layers only when they moved, from the JSON the hash binding has already built.
      const { generation, value } = getCachedJson(layers)
      if (generation !== posted) {
        posted = generation
        post({ type: FRAME_STATE_MESSAGE, state: { layers: value }, update: applied })
      }
      // The view only when it moved — a camera drag posts once it settles, not per frame.
      const view = pickView((key) => {
        const child = ng.state.children.get(key)
        return child ? getCachedJson(child).value : undefined
      })
      const text = JSON.stringify(view)
      if (text !== postedView) {
        postedView = text
        post({ type: FRAME_VIEW_MESSAGE, view, update: applied })
      }
    }, SETTLE_MS)
  })
}

/*
 * Segments and colours set in place, from the card (`FrameSegmentsMessage`): no layer is restored,
 * so this applies under the cursor and keeps the camera, the layout and loaded meshes. Only ids
 * that changed are touched. Adding to `visibleSegments` selects too, and deleting from
 * `selectedSegments` hides too — the pair neuroglancer's own restore relies on.
 */
/** Whether ⌥1–9 are Coda's right now (`FrameKeysMessage`) — the dashboard's tab keys. */
let claimAltDigits = false

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return
  if (isFrameKeysMessage(event.data)) {
    claimAltDigits = event.data.altDigits
    return
  }
  if (!isFrameSegmentsMessage(event.data)) return
  // Every layer, then the number: one that could not be set leaves the frame on the last update it
  // fully applied, so its reports are dropped rather than read against a scene it is not showing.
  let all = true
  for (const selection of event.data.layers) all = setSelection(selection) && all
  if (all) applied = event.data.update
  else {
    window.parent.postMessage(
      {
        type: FRAME_UNAPPLIED_MESSAGE,
        update: event.data.update,
      } satisfies FrameUnappliedMessage,
      window.location.origin,
    )
  }
})

/**
 * The part of a segmentation layer this touches. Read by shape because the package ships no
 * declarations for `layer/segmentation`; anything without it — an image layer under that name —
 * is left alone.
 */
interface SegmentationDisplay {
  segmentationGroupState: {
    value: { selectedSegments: Set<bigint>; visibleSegments: Set<bigint> }
  }
  segmentationColorGroupState: {
    value: {
      toJSON(): unknown
      restoreState(json: unknown): void
      segmentStatedColors: { clear(): void }
      segmentDefaultColor: { restoreState(json: unknown): void }
    }
  }
}

function segmentationDisplay(name: string): SegmentationDisplay | undefined {
  const layer = viewer.layerManager.getLayerByName(name)?.layer as
    { displayState?: Partial<SegmentationDisplay> } | null | undefined
  const display = layer?.displayState
  return display?.segmentationGroupState && display.segmentationColorGroupState
    ? (display as SegmentationDisplay)
    : undefined
}

function setSelection(selection: LayerSelection): boolean {
  const display = segmentationDisplay(selection.name)
  if (!display) return false
  const group = display.segmentationGroupState.value
  // `!id` is listed but hidden, as neuroglancer writes it: selected, not visible.
  const wanted = new Map<bigint, boolean>()
  for (const raw of selection.segments) {
    const entry = segmentEntry(raw)
    if (entry) wanted.set(BigInt(entry.id), entry.visible)
  }
  for (const id of [...group.selectedSegments]) {
    if (!wanted.has(id)) group.selectedSegments.delete(id)
  }
  for (const [id, visible] of wanted) {
    if (visible) {
      if (!group.visibleSegments.has(id)) group.visibleSegments.add(id)
    } else {
      if (!group.selectedSegments.has(id)) group.selectedSegments.add(id)
      if (group.visibleSegments.has(id)) group.visibleSegments.delete(id)
    }
  }

  // Colours only where they differ: setting them fires a state change, which the frame reports.
  const colors = display.segmentationColorGroupState.value
  const stated = Object.fromEntries(
    Object.entries(selection.segmentColors).filter(([id]) => isSegmentId(id)),
  )
  const held = colors.toJSON() as {
    segmentColors?: Record<string, string>
    segmentDefaultColor?: string
  }
  if (!sameColors(held.segmentColors ?? {}, stated)) {
    colors.segmentStatedColors.clear()
    colors.restoreState({ segmentColors: stated })
  }
  if (held.segmentDefaultColor !== selection.segmentDefaultColor) {
    colors.segmentDefaultColor.restoreState(selection.segmentDefaultColor)
  }
  return true
}

/** Two colour maps naming the same colour for the same ids, whatever the case of the hex. */
function sameColors(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(b)
  return (
    Object.keys(a).length === keys.length &&
    keys.every((id) => a[id]?.toLowerCase() === b[id]!.toLowerCase())
  )
}

/*
 * A chord Coda claimed goes back to Coda. Focus in the frame means the key reaches this document
 * and never Coda's, so without this the dashboard's ⌥1–9 did nothing once somebody had clicked into
 * the scene — and neuroglancer toggled a layer's picking instead. Capture phase, so it is taken
 * before neuroglancer's own bindings see it; a field in the frame keeps it, for the same reason
 * Coda's own fields do (⌥digit is how a Mac types `¡` and `™`).
 */
window.addEventListener(
  'keydown',
  (event) => {
    if (!claimAltDigits || window.parent === window || isTypingTarget(event.target)) return
    if (!isAltDigit(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    window.parent.postMessage(
      { type: FRAME_KEY_MESSAGE, code: event.code, altKey: true } satisfies FrameKeyMessage,
      window.location.origin,
    )
  },
  { capture: true },
)
