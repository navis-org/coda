/**
 * The Compartment Model's full-size view: two tabs, Regions (painting named regions onto the
 * neuron) and Channels (placing channels on them). Channels opens first, the list being what most
 * visits are for; Regions is where a name the list does not yet offer comes from.
 *
 * The regions both tabs read are `paintedRegions` over the wired skeleton — what the build will
 * name them — so a region painted a moment ago is in the channel list before any run. Without a
 * skeleton, the last built model's names stand in.
 */

import { useMemo, useState } from 'react'

import type { ParamValue } from '../../core/node'
import type { CellModelValue, SkeletonsValue } from '../../core/values'
import { CHANNELS_PARAM } from '../../packs/biophys/channelRows'
import { REGIONS_PARAM, paintedRegions, readRegionStrokes } from '../../packs/biophys/regions'
import { RailTabs } from '../viewers/topoChrome'
import { ChannelsEditor } from './ChannelsEditor'
import { RegionsEditor } from './RegionsEditor'

type Tab = 'regions' | 'channels'

const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: 'regions', label: 'Regions' },
  { id: 'channels', label: 'Channels' },
]

export interface ModelViewProps {
  /** The wired `neuron` input; one neuron, or the build refuses it. */
  skeletons: SkeletonsValue | undefined
  /** The node's last built model, if any. */
  model: CellModelValue | undefined
  params: Readonly<Record<string, ParamValue>>
  onParamChange?: ((paramId: string, value: ParamValue) => void) | undefined
  /** Several params in one commit: a region rename moves strokes and channel rows together. */
  onParamsChange?: ((values: Readonly<Record<string, ParamValue>>) => void) | undefined
}

export function ModelView({
  skeletons,
  model,
  params,
  onParamChange,
  onParamsChange,
}: ModelViewProps) {
  const [tab, setTab] = useState<Tab>('channels')
  // One neuron, as the build takes it; more is the build's refusal to make, not this view's.
  const skeleton = skeletons?.items.length === 1 ? skeletons.items[0] : undefined
  const strokes = params[REGIONS_PARAM]
  const stored = useMemo(() => readRegionStrokes(strokes), [strokes])
  // Painted once, here, for both tabs: what the build will name this neuron's regions.
  const painted = useMemo(
    () => (skeleton ? paintedRegions(skeleton, stored) : undefined),
    [skeleton, stored],
  )
  return (
    <div className="simulate-view">
      <RailTabs tabs={TABS} tab={tab} onTab={setTab} />
      <div className="simulate-view__panel" role="tabpanel">
        {tab === 'regions' ? (
          <RegionsEditor
            skeleton={skeleton}
            stored={stored}
            painted={painted}
            channels={params[CHANNELS_PARAM]}
            onParamChange={onParamChange}
            onParamsChange={onParamsChange}
          />
        ) : (
          <ChannelsEditor
            channels={params[CHANNELS_PARAM]}
            regionNames={painted?.names ?? model?.regionNames}
            onParamChange={onParamChange}
          />
        )}
      </div>
    </div>
  )
}
