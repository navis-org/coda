/**
 * Simulate's full-size view: three tabs, Partners (who fires, chosen before a run), Playback (the
 * last run over the neuron) and Sites (where current is injected). Playback opens first once the
 * card has a result to play, Partners before that, when choosing who fires is the only thing there
 * is to do.
 */

import { useState } from 'react'

import type { ParamValue } from '../../core/node'
import { SILENCED_PARAM, firingTop } from '../../packs/biophys/simulateOps'
import { useGraphStore } from '../../store/graphStore'
import { RailTabs } from '../viewers/topoChrome'
import type { SimulatePlaybackProps } from './SimulatePlayback'
import { SimulatePlayback } from './SimulatePlayback'
import { SimulatePartners } from './SimulatePartners'
import { SimulateSites } from './SimulateSites'

type Tab = 'partners' | 'playback' | 'sites'

const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: 'partners', label: 'Partners' },
  { id: 'playback', label: 'Playback' },
  { id: 'sites', label: 'Sites' },
]

/**
 * Playback's props, which already carry the param writer the other tabs use too, and the
 * several-at-once writer the Sites tab turns injection on with.
 */
export type SimulateViewProps = SimulatePlaybackProps & {
  onParamsChange?: ((values: Readonly<Record<string, ParamValue>>) => void) | undefined
}

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
        ) : shown === 'sites' ? (
          <SimulateSites
            model={props.model}
            params={props.params}
            record={props.record}
            column={props.column}
            onParamsChange={props.onParamsChange}
          />
        ) : (
          <SimulatePlayback {...props} />
        )}
      </div>
    </div>
  )
}
