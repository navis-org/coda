/**
 * The split key (`K`, `isSplitKey`) and the find-path key (`F`, `isFindPathKey`,
 * `findPathSession.ts`) in the Neuroglancer cards that can split: each card says which
 * frame is its and where its neurons live (`useSplitKey`); a press goes to the card whose frame
 * the pointer is in, with the segment and the point under it (`segmentHover.ts`). The pointer's
 * moves over those cards go to the session too, for reading ahead (`splitPointer`) — so the
 * viewer itself knows nothing of splitting but which frame is its. The key reaches
 * the window by both roads the pick key does — pressed in Coda's document, or in the frame and
 * handed back — and is bound here, while a card that can split is mounted, as the pick key is
 * bound by the review card. `shortcuts.ts` lists it.
 */

import { useEffect } from 'react'
import type { RefObject } from 'react'

import { isTypingTarget } from '../../core/keys'
import type { FramePressMessage } from '../../data/neuroglancer/frameMessage'
import {
  FRAME_PRESS_MESSAGE,
  isFindPathKey,
  isSplitKey,
} from '../../data/neuroglancer/frameMessage'
import { useGraphStore } from '../../store/graphStore'
import { useOfferedPack } from '../packSwitches'
import { useLatest } from '../useLatest'
import { onPointerMove, pointerStay } from '../viewers/segmentHover'
import { pressFindPath } from './findPathSession'
import type { SplitCard, SplitRequest, SplitTarget } from './splitSession'
import { splitPointer, startSplit } from './splitSession'

/** Each mounted card's frame, target and dataset layer, as its hook last saw them. */
const cards = new Set<
  RefObject<{
    frame: () => object | undefined
    target: SplitTarget | undefined
    layer: () => string | undefined
    /** Whether the SEAM pack is offered: off, a press says so and nothing reads ahead. */
    offered: boolean
    /** The card itself, where it can write its neurons (`SplitRequest.card`). */
    card: SplitCard | undefined
  }>
>()

/** A card key: which presses it is, what it is for (in the sentences that refuse), what it does. */
interface CardKey {
  readonly letter: string
  readonly matches: (event: KeyboardEvent) => boolean
  /** What it does, after its letter: "K splits neurons". */
  readonly does: string
  /** What the point under the pointer would be for: "no point to split at". */
  readonly on: string
  readonly press: (asked: Pointed) => void
  /**
   * Neuroglancer's own key where Coda's is off (`F`: Spelunker's find-path tool): while the SEAM
   * pack is off a press over the card is pressed into its frame (`FramePressMessage`), unsaid — a
   * pack switched off hides its feature, and the card's own tool is what the reader gets (user,
   * 2026-11-24). Never Coda's fullscreen over the card.
   */
  readonly neuroglancerKey?: true
}

/** The segment and point under the pointer, on a card that can split, and that card's frame. */
interface Pointed {
  readonly request: SplitRequest
  readonly frame: object
}

/** Why a press over a card that can split asks for nothing — worded by the key pressed. */
type Refusal =
  | { readonly refused: 'packOff'; readonly frame: object }
  | { readonly refused: 'otherLayer'; readonly layer: string | undefined }
  | { readonly refused: 'noPoint' }

const CARD_KEYS: readonly CardKey[] = [
  {
    letter: 'K',
    matches: isSplitKey,
    does: 'splits neurons',
    on: 'to split at',
    press: ({ request }) => startSplit(request),
  },
  {
    letter: 'F',
    matches: isFindPathKey,
    does: 'finds paths',
    on: 'to find a path from',
    press: ({ request, frame }) => pressFindPath(request, frame),
    neuroglancerKey: true,
  },
]

/** A refusal as the status bar says it, for `key`. */
function sentenceOf(key: CardKey, refusal: Refusal): string {
  switch (refusal.refused) {
    case 'packOff':
      return (
        `${key.letter} ${key.does} with the SEAM plugin, which is switched off. Switch it on in ` +
        'Plugins to use it here.'
      )
    case 'otherLayer':
      return (
        `${key.letter} works on the card's own neurons, and the segment under the pointer is ` +
        `from ${refusal.layer ? `the layer "${refusal.layer}"` : 'another layer'}. Point at one ` +
        "of the dataset's neurons."
      )
    case 'noPoint':
      return `Neuroglancer cannot say where the pointer is in this scene, so there is no point ${key.on}.`
  }
}

/**
 * What the pointer asks for: the segment under it and the point on it, in the datastack of the
 * card whose frame it is in, with that frame — or, over such a card, why not. Undefined off every
 * card that can split.
 */
function underPointer(): Pointed | Refusal | undefined {
  const stay = pointerStay()
  const card = stay && [...cards].find((one) => one.current.frame() === stay.from)?.current
  const target = card?.target
  if (!stay || !target) return undefined
  if (!card.offered) return { refused: 'packOff', frame: stay.from }
  // Only a segment of the dataset's own layer: an extra segmentation layer's ids are not its.
  const own = card.layer()
  if (own === undefined || stay.point.layer !== own) {
    return { refused: 'otherLayer', layer: stay.point.layer }
  }
  const pointNm = stay.point.positionNm
  return pointNm
    ? {
        request: { ...target, root: stay.point.segment, pointNm, card: card.card },
        frame: stay.from,
      }
    : { refused: 'noPoint' }
}

/**
 * Taken on the capture phase: bare `F` is also Coda's fullscreen (`appShortcuts.ts`), which stands
 * down for a press this has taken (`defaultPrevented`).
 */
function onKey(event: KeyboardEvent): void {
  if (event.repeat || isTypingTarget(event.target)) return
  const key = CARD_KEYS.find((one) => one.matches(event))
  const asked = key && underPointer()
  if (!key || !asked) return
  event.preventDefault()
  if ('refused' in asked && asked.refused === 'packOff' && key.neuroglancerKey) {
    const message: FramePressMessage = {
      type: FRAME_PRESS_MESSAGE,
      code: event.code,
      key: event.key,
    }
    const into = (asked.frame as { contentWindow?: Window | null }).contentWindow
    into?.postMessage(message, window.location.origin)
    return
  }
  if ('refused' in asked) useGraphStore.getState().setNotice(sentenceOf(key, asked))
  else key.press(asked)
}

/** Every pointer report: where it rests over a card that can split, the session reads ahead. */
function onMove(): void {
  const asked = underPointer()
  splitPointer(asked && !('refused' in asked) ? asked.request : undefined)
}

let unsubscribe: (() => void) | undefined

/**
 * While mounted, the split key over `frame()` asks for splits of the segment under the pointer in
 * `target`'s datastack — a segment of `layer()`, the dataset's own layer, only. A card whose
 * target is undefined (not a CAVE dataset) takes no press. `card` names the card, so a split's new
 * roots can be put in its neurons.
 */
export function useSplitKey(
  frame: () => object | undefined,
  target: SplitTarget | undefined,
  layer: () => string | undefined,
  card?: SplitCard,
): void {
  /*
   * The SEAM pack's feature, so its switch decides, as it does for the pack's nodes ("a pack
   * switched off hides"): off, K reads nothing — not even ahead — and writes nothing; it says on
   * the status bar what to switch on, since a key that silently does nothing reads as broken.
   */
  const offered = useOfferedPack()('seam')
  const latest = useLatest({ frame, target, layer, offered, card })
  useEffect(() => {
    const card = latest
    if (cards.size === 0) {
      window.addEventListener('keydown', onKey, true)
      unsubscribe = onPointerMove(onMove)
    }
    cards.add(card)
    return () => {
      cards.delete(card)
      if (cards.size === 0) {
        window.removeEventListener('keydown', onKey, true)
        unsubscribe?.()
      }
    }
  }, [latest])
}
