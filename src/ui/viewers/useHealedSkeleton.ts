/**
 * The first neuron of a skeletons value, joined into one tree where it arrived in pieces — the
 * Neuron Dendrogram card's half of `nodes/lib/arborHeal.ts`, which the node's Run shares.
 *
 * A whole skeleton, or one healed before, is answered during render, so a neuron with nothing to
 * heal goes straight to `ready` — an effect flipping it there a commit later would hand the card a
 * new object for the same skeleton and rebuild the whole arbour twice. Only a forest waits on
 * Python. The state remembers which skeleton it answers, so a neuron paged to is never drawn from
 * the last one's heal, and paging away aborts a heal nobody is waiting for.
 */

import { useEffect, useMemo, useState } from 'react'

import { errorMessage } from '../../core/errors'
import type { SkeletonGeometry, SkeletonsValue } from '../../core/values'
import type { Healed } from '../../nodes/lib/arborHeal'
import { healSkeleton, healedNow } from '../../nodes/lib/arborHeal'

export type HealState =
  | { status: 'idle' }
  | { status: 'healing'; pieces: number }
  | { status: 'ready'; data: Healed }
  | { status: 'error'; message: string; pieces: number }

type Settled = { for: SkeletonGeometry } & (
  { status: 'ready'; data: Healed } | { status: 'error'; message: string }
)

/** The first neuron of `value`, joined into one tree where it arrived in pieces. */
export function useHealedSkeleton(value: SkeletonsValue | undefined): HealState {
  const skeleton = value?.items[0]
  const now = useMemo(() => (skeleton ? healedNow(skeleton) : undefined), [skeleton])
  const [settled, setSettled] = useState<Settled | undefined>()

  useEffect(() => {
    if (!skeleton || !now || 'skeleton' in now) return
    const controller = new AbortController()
    healSkeleton(skeleton, controller.signal).then(
      (data) => setSettled({ for: skeleton, status: 'ready', data }),
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setSettled({ for: skeleton, status: 'error', message: errorMessage(error) })
        }
      },
    )
    return () => controller.abort()
  }, [skeleton, now])

  if (!now) return { status: 'idle' }
  if ('skeleton' in now) return { status: 'ready', data: now }
  if (!settled || settled.for !== skeleton) return { status: 'healing', pieces: now.pieces }
  return settled.status === 'ready'
    ? { status: 'ready', data: settled.data }
    : { status: 'error', message: settled.message, pieces: now.pieces }
}
