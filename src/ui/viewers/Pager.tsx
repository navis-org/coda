/**
 * ‹ › and "3 / 27": the pager Neuron Profile, the NeuronBridge card and its line stepper share.
 *
 * One component because three copies had begun, and what differed between them was never the
 * picture: it was the parts a fix has to reach everywhere — the accessible names, which end is
 * disabled, and how the position reads when nothing is selected (`–`, for a line the ticked
 * collections have filtered out). A fragment, so it sits in whichever row holds it.
 */

import { formatNumber } from '../format'

export interface PagerProps {
  /** The current position, 0-based; -1 for none. */
  index: number
  total: number
  /** Called with -1 or 1. */
  onStep: (delta: -1 | 1) => void
  /** What is being paged, for the buttons' names: "Previous neuron". */
  unit: string
}

export function Pager({ index, total, onStep, unit }: PagerProps) {
  return (
    <>
      <button
        type="button"
        className="profile__page-btn"
        aria-label={`Previous ${unit}`}
        title={`Previous ${unit}`}
        disabled={index <= 0}
        onClick={() => onStep(-1)}
      >
        ‹
      </button>
      <button
        type="button"
        className="profile__page-btn"
        aria-label={`Next ${unit}`}
        title={`Next ${unit}`}
        disabled={index >= total - 1}
        onClick={() => onStep(1)}
      >
        ›
      </button>
      <span className="profile__position">
        {index < 0 ? '–' : formatNumber(index + 1)} / {formatNumber(total)}
      </span>
    </>
  )
}
