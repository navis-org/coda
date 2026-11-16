/**
 * Draws Submit's overlay (`MergeConfirm`) for the session in `mergeSession.ts`, mounted once in the
 * app shell — so the overlay, and the progress of merges being sent, survive the card that opened
 * it being unmounted (the dashboard, a closed expanded view). Draws nothing without a session.
 */

import { useMemo } from 'react'

import { getSource } from '../../data/source'
import { tipsOf } from '../../packs/seam/reviewQueue'
import { usePublishedScene } from '../viewers/NeuroglancerProfileFrame'
import { MergeConfirm } from './MergeConfirm'
import {
  closeSubmit,
  confirmSubmit,
  recheckSubmit,
  stopSubmit,
  useSubmitSession,
} from './mergeSession'

export function MergeSubmitHost() {
  const session = useSubmitSession()
  const request = session?.request
  const published = usePublishedScene(request?.sourceId, request?.datasetId)
  // The neuron's tips: where it reaches, so the overlay opens on all of it.
  const extentNm = useMemo(
    () => (request ? tipsOf(request.queue, request.reviewedRoot).map((tip) => tip.tipNm) : []),
    [request],
  )
  if (session?.phase !== 'ready' || !request) return null
  return (
    <MergeConfirm
      plan={session.plan}
      plannedAt={session.plannedAt}
      published={published.status === 'ready' ? published.scene : undefined}
      datasetId={request.datasetId}
      viewerSite={getSource(request.sourceId)?.peekDataset(request.datasetId)?.viewerSite}
      extentNm={extentNm}
      progress={session.progress}
      running={session.running}
      neuronRoot={session.neuronRoot}
      onConfirm={confirmSubmit}
      onStop={stopSubmit}
      onRecheck={recheckSubmit}
      onClose={closeSubmit}
    />
  )
}
