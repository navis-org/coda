/**
 * The split key (`K`, `isSplitKey`) in the Neuroglancer cards that can split: each card says which
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
import { isSplitKey } from '../../data/neuroglancer/frameMessage'
import { useGraphStore } from '../../store/graphStore'
import { useOfferedPack } from '../packSwitches'
import { useLatest } from '../useLatest'
import { onPointerMove, pointerStay } from '../viewers/segmentHover'
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

/** Why a press over a card that can split asks for nothing, as the status bar says it. */
const NO_POINT =
  'Neuroglancer cannot say where the pointer is in this scene, so there is no point to split at.'
const PACK_OFF =
  'K splits neurons with the SEAM plugin, which is switched off. Switch it on in Plugins to split here.'
const otherLayer = (layer: string | undefined) =>
  `K splits the card's own neurons, and the segment under the pointer is from ` +
  `${layer ? `the layer "${layer}"` : 'another layer'}. Point at one of the dataset's neurons.`

/**
 * The split the pointer asks for: the segment under it and the point on it, in the datastack of
 * the card whose frame it is in — or, over such a card, why not (a sentence for the status bar).
 * Undefined off every card that can split.
 */
function underPointer(): SplitRequest | { readonly refused: string } | undefined {
  const stay = pointerStay()
  const card = stay && [...cards].find((one) => one.current.frame() === stay.from)?.current
  const target = card?.target
  if (!stay || !target) return undefined
  if (!card.offered) return { refused: PACK_OFF }
  // Only a segment of the dataset's own layer: an extra segmentation layer's ids are not its.
  const own = card.layer()
  if (own === undefined || stay.point.layer !== own)
    return { refused: otherLayer(stay.point.layer) }
  const pointNm = stay.point.positionNm
  return pointNm
    ? { ...target, root: stay.point.segment, pointNm, card: card.card }
    : { refused: NO_POINT }
}

function onKey(event: KeyboardEvent): void {
  if (event.repeat || !isSplitKey(event) || isTypingTarget(event.target)) return
  const request = underPointer()
  if (!request) return
  event.preventDefault()
  if ('refused' in request) useGraphStore.getState().setNotice(request.refused)
  else startSplit(request)
}

/** Every pointer report: where it rests over a card that can split, the session reads ahead. */
function onMove(): void {
  const request = underPointer()
  splitPointer(request && !('refused' in request) ? request : undefined)
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
      window.addEventListener('keydown', onKey)
      unsubscribe = onPointerMove(onMove)
    }
    cards.add(card)
    return () => {
      cards.delete(card)
      if (cards.size === 0) {
        window.removeEventListener('keydown', onKey)
        unsubscribe?.()
      }
    }
  }, [latest])
}
