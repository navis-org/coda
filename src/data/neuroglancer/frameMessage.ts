/**
 * The messages between Coda and its own neuroglancer frame (`neuroglancer.html`). Shared by both
 * ends; only ever posted to and accepted from this origin.
 *
 * Frame to card, each once it settles after a change and stamped with the update it describes:
 *  - the layers (`FrameStateMessage`), which is where the selection is read from;
 *  - the view (`FrameViewMessage`) — camera and layout — which the card saves with the workflow.
 * Messages rather than reads of `location.hash`, which neuroglancer writes with
 * `history.replaceState`, firing no event.
 *
 * Card to frame: set these layers' segments and colours in place (`FrameSegmentsMessage`). The
 * alternative is restoring `layers` through the fragment, which tears every layer down and
 * rebuilds it — the reason an update has to wait for the pointer to leave, and meshes reload.
 *
 * And keys, both ways: a key pressed in the frame goes to the frame's document and never reaches
 * Coda's, so the card says which chords are Coda's (`FrameKeysMessage`) and the frame hands those
 * back (`FrameKeyMessage`) instead of letting neuroglancer have them.
 */

import type { LayerSelection, NgScene } from './scene'

/**
 * Which of the card's updates a report describes — the number every navigation and every in-place
 * message carries, echoed back on each report as the last one the frame actually applied.
 *
 * Without it a report is folded into the edits against whatever the card sent *last*, and a report
 * taken just before the frame handled that (its settle timer already running) reads every neuron
 * the update added as one the user removed — saved into the document as an edit. A report whose
 * number is not the card's latest is not about the scene the card is holding, so it is dropped. An
 * update the frame could not apply leaves its number where it was, so the frame's reports stay
 * dropped until the next one rather than misread.
 *
 * In a navigation it rides in the fragment, frame-only like the layer bar, under this key, which
 * neuroglancer ignores and drops from the hash it writes back.
 */
export const FRAME_UPDATE_KEY = 'codaUpdate'

export function withUpdate(scene: NgScene, update: number): NgScene {
  return { ...scene, [FRAME_UPDATE_KEY]: update }
}

/** The update a navigation's scene carries, if any. */
export function updateIn(scene: NgScene | undefined): number | undefined {
  const update = scene?.[FRAME_UPDATE_KEY]
  return typeof update === 'number' ? update : undefined
}

export const FRAME_STATE_MESSAGE = 'coda:ng-state'

export interface FrameStateMessage {
  type: typeof FRAME_STATE_MESSAGE
  state: NgScene
  /** The last update the frame applied — see `FRAME_UPDATE_KEY`. */
  update: number
}

export function isFrameStateMessage(data: unknown): data is FrameStateMessage {
  return reportOf(data, FRAME_STATE_MESSAGE, 'state')
}

export const FRAME_SEGMENTS_MESSAGE = 'coda:ng-set-segments'

export interface FrameSegmentsMessage {
  type: typeof FRAME_SEGMENTS_MESSAGE
  layers: LayerSelection[]
  update: number
}

export function isFrameSegmentsMessage(data: unknown): data is FrameSegmentsMessage {
  const message = messageOf(data, FRAME_SEGMENTS_MESSAGE)
  return Array.isArray(message?.['layers']) && typeof message['update'] === 'number'
}

/** `data` as a message of this type, or undefined. */
function messageOf(data: unknown, type: string): Record<string, unknown> | undefined {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === type
    ? (data as Record<string, unknown>)
    : undefined
}

export const FRAME_VIEW_MESSAGE = 'coda:ng-view'

/**
 * Where somebody is looking and how the panels are laid out — the part of a viewer state a saved
 * workflow, or a share link, should reopen at. Everything else in a state is the scene, which the
 * node builds.
 */
const VIEW_KEYS = [
  'layout',
  'position',
  'crossSectionOrientation',
  'crossSectionScale',
  'crossSectionDepth',
  'projectionOrientation',
  'projectionScale',
  'projectionDepth',
] as const

/** Frame to card: the view, whenever it settles after a change. */
export interface FrameViewMessage {
  type: typeof FRAME_VIEW_MESSAGE
  view: NgScene
  update: number
}

export function isFrameViewMessage(data: unknown): data is FrameViewMessage {
  return reportOf(data, FRAME_VIEW_MESSAGE, 'view')
}

/** A report from the frame: an object under `field`, and the update it describes. */
function reportOf(data: unknown, type: string, field: string): boolean {
  const message = messageOf(data, type)
  const value = message?.[field]
  return typeof value === 'object' && value !== null && typeof message?.['update'] === 'number'
}

/** The view part of a state, read key by key — from a parsed state, or a live viewer's. */
export function pickView(read: (key: (typeof VIEW_KEYS)[number]) => unknown): NgScene {
  const view: Record<string, unknown> = {}
  for (const key of VIEW_KEYS) {
    const value = read(key)
    if (value !== undefined) view[key] = value
  }
  return view
}

/**
 * A saved view as the node stores it: the view, and the dataset it was taken in. A camera is a
 * position in one dataset's coordinates, and applied to another volume it opens on empty space —
 * so a view whose dataset is not the one now wired is not a view of anything here.
 */
export function encodeSavedView(datasetId: string, view: NgScene): string {
  return JSON.stringify({ dataset: datasetId, view })
}

export function decodeSavedView(raw: unknown): { dataset: string; view: NgScene } | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    const parsed = JSON.parse(raw) as { dataset?: unknown; view?: unknown }
    const view = parsed.view
    if (typeof parsed.dataset !== 'string' || typeof view !== 'object' || view === null) {
      return undefined
    }
    // Only the view's own keys: a hand-edited file must not smuggle layers into the scene.
    return {
      dataset: parsed.dataset,
      view: pickView((key) => (view as Record<string, unknown>)[key]),
    }
  } catch {
    return undefined
  }
}

export const FRAME_KEYS_MESSAGE = 'coda:ng-keys'

/**
 * Card to frame: which chords are Coda's while focus is in the frame. ⌥1–9 only while the dashboard
 * is open, where they switch tabs; elsewhere Coda leaves them free and neuroglancer keeps its own
 * (`toggle-pick-layer-N`).
 */
export interface FrameKeysMessage {
  type: typeof FRAME_KEYS_MESSAGE
  altDigits: boolean
}

export function isFrameKeysMessage(data: unknown): data is FrameKeysMessage {
  return typeof messageOf(data, FRAME_KEYS_MESSAGE)?.['altDigits'] === 'boolean'
}

export const FRAME_KEY_MESSAGE = 'coda:ng-key'

/** Frame to card: a chord Coda claimed, pressed with focus in the frame. */
export interface FrameKeyMessage {
  type: typeof FRAME_KEY_MESSAGE
  code: string
  altKey: boolean
}

export function isFrameKeyMessage(data: unknown): data is FrameKeyMessage {
  const message = messageOf(data, FRAME_KEY_MESSAGE)
  return typeof message?.['code'] === 'string' && typeof message['altKey'] === 'boolean'
}

/** The chord `FrameKeysMessage.altDigits` claims: ⌥ and a digit key 1–9, no other modifier. */
export function isAltDigit(event: {
  code: string
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}): boolean {
  return (
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    /^Digit[1-9]$/.test(event.code)
  )
}

export const FRAME_UNAPPLIED_MESSAGE = 'coda:ng-unapplied'

/**
 * Frame to card: an in-place update it could not apply — no such layer, somebody renamed or deleted
 * it. The card stops updating in place and navigates instead, which restores what the scene needs.
 */
export interface FrameUnappliedMessage {
  type: typeof FRAME_UNAPPLIED_MESSAGE
  update: number
}

export function isFrameUnappliedMessage(data: unknown): data is FrameUnappliedMessage {
  return typeof messageOf(data, FRAME_UNAPPLIED_MESSAGE)?.['update'] === 'number'
}
