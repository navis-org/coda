/**
 * Simulate's full-size view: two tabs, Partners (who fires, chosen before a run) and Playback (the
 * last run over the neuron). Playback opens first once the card has a result to play, Partners
 * before that, when choosing who fires is the only thing there is to do.
 */

import { useState } from 'react'

import { SILENCED_PARAM, firingTop } from '../../packs/biophys/simulateOps'
import { useGraphStore } from '../../store/graphStore'
import { RailTabs } from '../viewers/topoChrome'
import type { SimulatePlaybackProps } from './SimulatePlayback'
import { SimulatePlayback } from './SimulatePlayback'
import { SimulatePartners } from './SimulatePartners'

type Tab = 'partners' | 'playback'

const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: 'partners', label: 'Partners' },
  { id: 'playback', label: 'Playback' },
]

/** Playback's props, which already carry the param writer the Partners tab uses too. */
export type SimulateViewProps = SimulatePlaybackProps

export function SimulateView(props: SimulateViewProps) {
  const ran = useGraphStore((s) => s.nodeOutput(props.nodeId, 'traces') !== undefined)
  const [tab, setTab] = useState<Tab | undefined>(undefined)
  const shown = tab ?? (ran ? 'playback' : 'partners')
  return (
    <div className="simulate-view">
      <RailTabs tabs={TABS} tab={shown} onTab={setTab} />
      <div className="simulate-view__panel" role="tabpanel">
        {shown === 'partners' ? (
          <SimulatePartners
            nodeId={props.nodeId}
            partners={props.model?.partners}
            silenced={props.params[SILENCED_PARAM] as string[]}
            top={firingTop(props.params)}
            onParamChange={props.onParamChange}
          />
        ) : (
          <SimulatePlayback {...props} />
        )}
      </div>
    </div>
  )
}
