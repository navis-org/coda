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
 * Card to frame: set these layers' segments and colours, and local annotation layers' annotations,
 * in place (`FrameSegmentsMessage`). The alternative is restoring `layers` through the fragment,
 * which tears every layer down and rebuilds it — the reason an update has to wait for the pointer
 * to leave, and meshes reload.
 *
 * Frame to card, as it changes: the segment under the pointer and where the pointer is
 * (`FrameHoverMessage`), which the review card lights its rows by and takes a hand pick from.
 *
 * And keys, both ways: a key pressed in the frame goes to the frame's document and never reaches
 * Coda's, so the card says which chords are Coda's (`FrameKeysMessage`) and the frame hands those
 * back (`FrameKeyMessage`) instead of letting neuroglancer have them.
 */

import { isSegmentId } from '../../core/ids'
import type { LayerAnnotations, LayerSelection, NgScene } from './scene'

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

/** Named for its first use; it carries both kinds of in-place change (`inPlaceChanges`). */
export interface FrameSegmentsMessage {
  type: typeof FRAME_SEGMENTS_MESSAGE
  layers: LayerSelection[]
  /** Local annotation layers' contents, replaced whole. Left out where none changed. */
  annotations?: LayerAnnotations[]
  update: number
}

export function isFrameSegmentsMessage(data: unknown): data is FrameSegmentsMessage {
  const message = messageOf(data, FRAME_SEGMENTS_MESSAGE)
  return (
    Array.isArray(message?.['layers']) &&
    (message['annotations'] === undefined || Array.isArray(message['annotations'])) &&
    typeof message['update'] === 'number'
  )
}

/** `data` as a message of this type, or undefined. */
function messageOf(data: unknown, type: string): Record<string, unknown> | undefined {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === type
    ? (data as Record<string, unknown>)
    : undefined
}

/**
 * Card to frame: point the camera here, in the scene's own coordinate space.
 *
 * The counterpart of `FrameSegmentsMessage` for the other thing a card changes between items.
 * It exists for the same reason: restoring a scene with a different `position` through the
 * fragment tears every layer down and reloads the meshes, which is unusable when the camera
 * moves once per click — a review queue, a list of sites, anything paged through.
 *
 * **No update number.** The echo on `FrameSegmentsMessage` exists so the frame's *reports* can
 * be attributed to the scene the card is holding, and a camera move changes nothing a report
 * carries. Sending one here would mean two numbers racing for the same slot.
 *
 * **`width` frames as well as points**, and without it the message is half useless. A scene that
 * publishes no `projectionScale` — the Aedes datastack publishes `dimensions` and `layers` and
 * nothing else — opens at neuroglancer's default zoom, which for a whole brain is hundreds of
 * micrometres across. The camera then goes exactly where it is told and a half-micrometre piece
 * sits in the middle of it, invisible. Pointing without framing is not showing somebody a site.
 *
 * Both are in the global coordinate space's units, not nanometres: whoever sends this has the
 * scene's `dimensions` and does the conversion once, where the scale is known.
 */
export const FRAME_SET_VIEW_MESSAGE = 'coda:ng-set-view'

export interface FrameSetViewMessage {
  type: typeof FRAME_SET_VIEW_MESSAGE
  position: readonly number[]
  /** How much to frame, across. Omitted leaves the zoom exactly as the reader left it. */
  width?: number
}

export function isFrameSetViewMessage(data: unknown): data is FrameSetViewMessage {
  if (!data || typeof data !== 'object') return false
  const message = data as Partial<FrameSetViewMessage>
  return (
    message.type === FRAME_SET_VIEW_MESSAGE &&
    Array.isArray(message.position) &&
    message.position.length > 0 &&
    message.position.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    (message.width === undefined ||
      (typeof message.width === 'number' &&
        Number.isFinite(message.width) &&
        message.width > 0))
  )
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
 * (`toggle-pick-layer-N`). `F` only where Coda's find path is on for the card — the SEAM pack
 * offered, a CAVE dataset (`isFindPathKey`); elsewhere it is neuroglancer's own find-path tool, its
 * Graph-tab button shown (user, 2026-11-24). Absent, as from a card built before it was sent: off.
 */
export interface FrameKeysMessage {
  type: typeof FRAME_KEYS_MESSAGE
  altDigits: boolean
  findPath?: boolean
  /**
   * The review keys (`REVIEW_KEY_CODES`) only while a Proofread Merges card is open: `G` is also
   * neuroglancer's multicut swap-group (`shift?+keyg`), which a frame claiming it always took from
   * every CAVE card. Absent: off.
   */
  review?: boolean
}

const optionalFlag = (value: unknown) => value === undefined || typeof value === 'boolean'

export function isFrameKeysMessage(data: unknown): data is FrameKeysMessage {
  const message = messageOf(data, FRAME_KEYS_MESSAGE)
  return (
    typeof message?.['altDigits'] === 'boolean' &&
    optionalFlag(message['findPath']) &&
    optionalFlag(message['review'])
  )
}

export const FRAME_PRESS_MESSAGE = 'coda:ng-press'

/**
 * Card to frame: press this key in neuroglancer, as if pressed in the frame — for a key pressed in
 * Coda's document over the card that is neuroglancer's there: `F` where Coda's find path is off
 * (`splitKey.ts`), so the reader gets neuroglancer's find-path tool, not Coda's fullscreen.
 */
export interface FramePressMessage {
  type: typeof FRAME_PRESS_MESSAGE
  code: string
  key: string
}

export function isFramePressMessage(data: unknown): data is FramePressMessage {
  const message = messageOf(data, FRAME_PRESS_MESSAGE)
  return typeof message?.['code'] === 'string' && typeof message['key'] === 'string'
}

export const FRAME_HOVER_MESSAGE = 'coda:ng-hover'

/**
 * Frame to card: the segment under the pointer, as text (invariant 8), or `null` where there is
 * none — the pointer on empty space, or out of the frame. Posted when it changes, and not stamped
 * with an update: it says where the pointer is, not what the scene holds.
 *
 * **And where the pointer is, in absolute nanometres** (`positionNm`), posted as it moves over
 * one segment too: a hand pick (`J`, `handPicks.ts`) is a segment *and* a place on it. On a 3D
 * panel neuroglancer puts the pointer on the surface it picked, so the place is on the segment.
 * Absent where the frame cannot say — no `x`/`y`/`z` in metres among its dimensions.
 */
export interface FrameHoverMessage {
  type: typeof FRAME_HOVER_MESSAGE
  segment: string | null
  positionNm?: readonly [number, number, number]
  /**
   * The name of the layer the segment is from — the first visible segmentation layer with one under
   * the pointer, which in a scene with extra layers need not be the dataset's. A key acting on the
   * card's own dataset (the split key) asks it. Absent with no segment.
   */
  layer?: string
}

export function isFrameHoverMessage(data: unknown): data is FrameHoverMessage {
  const message = messageOf(data, FRAME_HOVER_MESSAGE)
  const segment = message?.['segment']
  const at = message?.['positionNm']
  const placed =
    at === undefined ||
    (Array.isArray(at) && at.length === 3 && at.every((v) => Number.isFinite(v)))
  const layer = message?.['layer']
  return (
    placed &&
    (layer === undefined || typeof layer === 'string') &&
    (segment === null || (typeof segment === 'string' && isSegmentId(segment)))
  )
}

export const FRAME_KEY_MESSAGE = 'coda:ng-key'

/** Frame to card: a chord Coda claimed, pressed with focus in the frame. */
export interface FrameKeyMessage {
  type: typeof FRAME_KEY_MESSAGE
  code: string
  /**
   * The key as typed, for Coda's shortcuts that read `key` rather than `code`: bare `F` is
   * fullscreen (`appShortcuts.ts`), which the frame claims for find path and hands back when the
   * SEAM pack is off. Absent from a frame built before it was sent.
   */
  key?: string
  altKey: boolean
}

export function isFrameKeyMessage(data: unknown): data is FrameKeyMessage {
  const message = messageOf(data, FRAME_KEY_MESSAGE)
  const key = message?.['key']
  return (
    typeof message?.['code'] === 'string' &&
    typeof message['altKey'] === 'boolean' &&
    (key === undefined || typeof key === 'string')
  )
}

/**
 * The key event a card dispatches for a key its frame handed back, as if pressed in Coda's own
 * document: `key` too, and cancellable, so a card key that takes it (`splitKey.ts`) can keep it from
 * Coda's own shortcut on the same letter (`defaultPrevented`).
 */
export function frameKeyInit(message: FrameKeyMessage): KeyboardEventInit {
  return {
    code: message.code,
    key: message.key ?? '',
    altKey: message.altKey,
    bubbles: true,
    cancelable: true,
  }
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

/**
 * The hand-pick key (`J`, for join), bare: take the segment under the pointer into the review card
 * (`handPicks.ts`). Neither neuroglancer nor Spelunker binds `J`, so the frame claims it always and
 * hands it back (`FrameKeyMessage`) — with focus in the frame, Coda's document never hears it.
 * Matched by position (`code`), as a key handed back carries no `key`.
 */
export const PICK_KEY_CODE = 'KeyJ'

interface KeyChord {
  code: string
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

/** A key pressed with no modifier held. */
const bare = (event: KeyChord) =>
  !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey

export function isPickKey(event: KeyChord): boolean {
  return event.code === PICK_KEY_CODE && bare(event)
}

/**
 * The split key (`K`, beside `J`: join and split): the split gallery for the point under the
 * pointer (`ui/seam/splitSession.ts`, `docs/split-gallery-plan.md`). Unbound in neuroglancer (which
 * takes A B E G H L N O R S V X Z bare), Spelunker (C F M) and Coda (whose bare letters are D F H I
 * J M P and the review keys) — `D` was the first choice and is Coda's Dashboard. So the frame
 * claims it always and hands it back, as it does the pick key. By position (`code`).
 */
export const SPLIT_KEY_CODE = 'KeyK'

export function isSplitKey(event: KeyChord): boolean {
  return event.code === SPLIT_KEY_CODE && bare(event)
}

/**
 * The find-path key (`F`): Coda's find path, the route between two points with how strongly each
 * step is joined (`ui/seam/splitKey.ts`, `docs/find-path-plan.md`), in place of Spelunker's, which
 * binds it to neuroglancer's own tool — **only where Coda's find path is on**: the card tells the
 * frame (`FrameKeysMessage.findPath`), which then claims the key and hands it back as it does the
 * split key. Where it is off (the SEAM pack switched off), `F` is neuroglancer's own tool, in the
 * frame or over the card (`FramePressMessage`). Bare `F` is also Coda's fullscreen, off every card.
 * By position (`code`).
 */
export const FIND_PATH_KEY_CODE = 'KeyF'

export function isFindPathKey(event: KeyChord): boolean {
  return event.code === FIND_PATH_KEY_CODE && bare(event)
}

export const FRAME_LAYER_MESSAGE = 'coda:ng-own-layer'

/**
 * Card to frame: a layer of the frame's own, beside the scene's — added, replaced in place, or taken
 * away (`layer: null`), by name. For a drawing the card puts over its scene for a while, such as
 * find path's route (`packs/seam/findPath.ts`' `pathLayer`). Not part of the card's scene, which
 * would make it a navigation that rebuilds every layer: the frame adds, replaces and removes the
 * layer itself, and the card's fold reads only the dataset's layer, so it is never saved. A
 * navigation clears it with the rest.
 */
export interface FrameLayerMessage {
  type: typeof FRAME_LAYER_MESSAGE
  name: string
  layer: Readonly<Record<string, unknown>> | null
}

export function isFrameLayerMessage(data: unknown): data is FrameLayerMessage {
  const message = messageOf(data, FRAME_LAYER_MESSAGE)
  const layer = message?.['layer']
  return typeof message?.['name'] === 'string' && (layer === null || typeof layer === 'object')
}

/**
 * The review card's verdict keys, and the one that skips to the next row to review (user,
 * 2026-11-22; `ui/seam/reviewKeys.ts`). Along the top row in the buttons' order, skipping `E` and
 * `R`, with which neuroglancer rotates. **Bare letters, because nothing else is free**: neuroglancer
 * binds Shift with every letter to a tool, and its own bare letters (`A`, `B`, `L`, `S`, `X`, …)
 * would stop working while a card is open. Q W T Y U are unbound in neuroglancer and Spelunker;
 * `G` is neuroglancer's multicut swap-group (`shift?+keyg`, Shift+G still does it). So the frame
 * claims them only while a review card is open (`FrameKeysMessage.review`) and hands them back, as
 * it does the pick key. By position (`code`), as a key handed back carries no `key`.
 */
export const REVIEW_KEY_CODES = {
  accept: 'KeyQ',
  reject: 'KeyW',
  ends: 'KeyT',
  unsure: 'KeyY',
  ignore: 'KeyU',
  skip: 'KeyG',
} as const

export type ReviewKey = keyof typeof REVIEW_KEY_CODES

const REVIEW_KEY_OF = new Map<string, ReviewKey>(
  Object.entries(REVIEW_KEY_CODES).map(([key, code]) => [code, key as ReviewKey]),
)

/** Which review key this is, where it is one, pressed bare. */
export function reviewKeyOf(event: KeyChord): ReviewKey | undefined {
  return bare(event) ? REVIEW_KEY_OF.get(event.code) : undefined
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
