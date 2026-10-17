/**
 * The Compartment Model's full-size view: three tabs, Regions (painting named regions onto the
 * neuron, and what the soma replaces), Channels (placing channels on them) and Model (the built
 * compartments, and the numbers a broken model fails). Regions opens first, being what the other
 * two are made from.
 *
 * The regions both tabs read are `modelRegions` over the wired skeleton — what the build will
 * name them, which nodes the soma replaces and which are ignored — so a region painted a moment
 * ago is in the channel list before any run. Without a skeleton, the last built model's names
 * stand in.
 */

import { useMemo, useState } from 'react'

import type { ParamValue } from '../../core/node'
import type { CellModelValue, SkeletonsValue } from '../../core/values'
import { CHANNELS_PARAM } from '../../packs/biophys/channelRows'
import {
  REGIONS_PARAM,
  modelRegions,
  readRegionStrokes,
  regionOptions,
} from '../../packs/biophys/regions'
import { RailTabs } from '../viewers/topoChrome'
import { ChannelsEditor } from './ChannelsEditor'
import { CompartmentsView } from './CompartmentsView'
import { RegionsEditor } from './RegionsEditor'

type Tab = 'regions' | 'channels' | 'model'

const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: 'regions', label: 'Regions' },
  { id: 'channels', label: 'Channels' },
  { id: 'model', label: 'Model' },
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
  const [tab, setTab] = useState<Tab>('regions')
  // One neuron, as the build takes it; more is the build's refusal to make, not this view's.
  const skeleton = skeletons?.items.length === 1 ? skeletons.items[0] : undefined
  const strokes = params[REGIONS_PARAM]
  const stored = useMemo(() => readRegionStrokes(strokes), [strokes])
  // Once, here, for both tabs: the regions the build will make of this neuron.
  // The build's own options (`regionOptions`), so the picture is the model; `modelRegions` keeps its
  // last answer per skeleton, which is the build's when it has run.
  const painted = skeleton ? modelRegions(skeleton, regionOptions(params, stored)) : undefined
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
        ) : tab === 'model' ? (
          <CompartmentsView model={model} />
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
