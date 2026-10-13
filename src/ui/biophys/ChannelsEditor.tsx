/**
 * The Compartment Model's channel list, edited: a row per channel — which one, where, how much, and
 * its ΔV50 shifts — and the squid HH soma as a one-click preset. The card shows the list as a count
 * (`Channels`); this is the expanded view's Channels tab (`ModelView`), beside Regions.
 *
 * What a row means is `channelRows.ts`': regions by the model's own names, none for everywhere;
 * a density in mS/cm² or a total per cell in nS. Regions offered are the wired skeleton's, painted
 * ones included, else the last built model's, else the four the split and SWC labels give.
 */

import { Fragment, useState } from 'react'

import type { ParamValue } from '../../core/node'
import type { ChannelRow } from '../../packs/biophys/channelRows'
import {
  CHANNELS_PARAM,
  CHANNEL_OPTIONS,
  DEFAULT_REGIONS,
  SQUID_SOMA,
  changeChannel,
  channelOption,
  nameableRegions,
  describeChannel,
  newChannelRow,
  readChannelRows,
  writeChannelRow,
} from '../../packs/biophys/channelRows'
import { plural } from '../../style/format'
import { NumberField, SelectField } from '../params/ParamField'

export interface ChannelsEditorProps {
  /** The stored `channels` param, as it is. */
  channels: unknown
  /** The regions the node's last built model has; absent before a run. */
  regionNames: readonly string[] | undefined
  onParamChange?: ((paramId: string, value: ParamValue) => void) | undefined
}

const CHANNEL_CHOICES = CHANNEL_OPTIONS.map((o) => ({ value: o.id, label: o.label }))

const MODES = [
  { value: 'density', label: 'mS/cm²' },
  { value: 'total', label: 'nS per cell' },
]

export function ChannelsEditor({ channels, regionNames, onParamChange }: ChannelsEditorProps) {
  const rows = readChannelRows(channels)
  // The model's own regions once built, less unlabelled cable, which no row can name.
  const regions = regionNames ? nameableRegions(regionNames) : DEFAULT_REGIONS
  const write = (next: readonly ChannelRow[]) =>
    onParamChange?.(CHANNELS_PARAM, next.map(writeChannelRow))
  const replace = (i: number, next: ChannelRow) =>
    write(rows.map((row, k) => (k === i ? next : row)))
  const update = (i: number, patch: Partial<ChannelRow>) =>
    replace(i, { ...rows[i]!, ...patch })
  const editable = !!onParamChange
  // Which rows show their "?" text, by position: a removal shifts the ones after it (`remove`).
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set())
  const toggle = (i: number) =>
    setOpen((was) => {
      const next = new Set(was)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  const remove = (i: number) => {
    write(rows.filter((_, k) => k !== i))
    setOpen((was) => new Set([...was].flatMap((k) => (k < i ? [k] : k > i ? [k - 1] : []))))
  }

  return (
    <div className="channels-editor">
      <div className="channels-editor__bar">
        <span className="channels-editor__count">
          {rows.length === 0 ? 'A passive cell: no channels.' : plural(rows.length, 'channel')}
        </span>
        {editable && (
          <>
            <button
              type="button"
              className="btn btn--ghost nodrag"
              onClick={() => {
                write([...rows, newChannelRow(CHANNEL_OPTIONS[0]!.id)])
              }}
            >
              + Add channel
            </button>
            <button
              type="button"
              className="btn btn--ghost nodrag"
              title="Squid Hodgkin–Huxley sodium and potassium on the soma"
              onClick={() => write([...rows, ...SQUID_SOMA])}
            >
              + Squid HH soma
            </button>
          </>
        )}
      </div>

      {rows.length > 0 && (
        <table className="channels-editor__table">
          <thead>
            <tr>
              <th>Channel</th>
              <th title="Where the channel sits. None ticked is everywhere, unlabelled cable included.">
                Regions
              </th>
              <th>Amount</th>
              <th title="mV the activation gates are moved by; negative is towards hyperpolarisation">
                ΔV50 act.
              </th>
              <th title="mV the inactivation gates are moved by">ΔV50 inact.</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const option = channelOption(row.channel)
              return (
                <Fragment key={i}>
                  <tr>
                    <td>
                      <div className="channels-editor__channel">
                        <SelectField
                          label={`Channel ${i + 1}`}
                          value={row.channel}
                          options={CHANNEL_CHOICES}
                          onChange={(channel) => replace(i, changeChannel(row, channel))}
                        />
                        {option && (
                          <button
                            type="button"
                            className="btn btn--ghost channels-editor__help nodrag"
                            aria-label={`About ${option.label}`}
                            aria-expanded={open.has(i)}
                            title={`About ${option.label}`}
                            onClick={() => toggle(i)}
                          >
                            ?
                          </button>
                        )}
                      </div>
                    </td>
                    <td>
                      <div
                        className="channels-editor__regions"
                        role="group"
                        aria-label={`Regions of channel ${i + 1}`}
                      >
                        {/* The model's regions, then any this row names that it no longer has —
                            shown, so the stale name can be unticked rather than stuck. */}
                        {[...regions, ...row.regions.filter((r) => !regions.includes(r))].map(
                          (name) => {
                            const on = row.regions.includes(name)
                            const gone = !regions.includes(name)
                            return (
                              <button
                                key={name}
                                type="button"
                                className="chip-filter nodrag"
                                aria-pressed={on}
                                data-missing={gone || undefined}
                                title={gone ? `This model has no ${name} cable` : undefined}
                                disabled={!editable}
                                onClick={() =>
                                  update(i, {
                                    regions: on
                                      ? row.regions.filter((r) => r !== name)
                                      : [...row.regions, name],
                                  })
                                }
                              >
                                {name}
                              </button>
                            )
                          },
                        )}
                        {row.regions.length === 0 && (
                          <span className="channels-editor__everywhere">everywhere</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="channels-editor__amount">
                        <NumberField
                          label={`Amount of channel ${i + 1}`}
                          value={row.value}
                          integer={false}
                          min={0}
                          step={row.mode === 'total' ? 0.1 : 1}
                          onChange={(value) => update(i, { value })}
                        />
                        <SelectField
                          label={`Unit of channel ${i + 1}`}
                          value={row.mode}
                          options={MODES}
                          onChange={(mode) => update(i, { mode: mode as ChannelRow['mode'] })}
                        />
                      </div>
                    </td>
                    <td>
                      <NumberField
                        label={`Activation shift of channel ${i + 1}`}
                        value={row.activation}
                        integer={false}
                        step={1}
                        onChange={(activation) => update(i, { activation })}
                      />
                    </td>
                    <td>
                      <NumberField
                        label={`Inactivation shift of channel ${i + 1}`}
                        value={row.inactivation}
                        integer={false}
                        step={1}
                        onChange={(inactivation) => update(i, { inactivation })}
                      />
                    </td>
                    <td>
                      {editable && (
                        <button
                          type="button"
                          className="btn btn--ghost nodrag"
                          aria-label={`Remove channel ${i + 1}`}
                          title="Remove this channel"
                          onClick={() => remove(i)}
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                  {option && open.has(i) && (
                    <tr className="channels-editor__about">
                      <td colSpan={6}>
                        {describeChannel(option).map((line, k) => (
                          <p key={k}>{line}</p>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="channels-editor__note">
        There is no axon-terminal region: a channel on the axon covers its terminals too, unless
        they are painted as a region of their own in the Regions tab.
        {!regionNames && ' Run the model to see which regions this neuron has.'}
        {regionNames &&
          !regions.some((name) => name !== 'soma') &&
          ' Only the soma is labelled on this neuron: paint regions in the Regions tab, or run its skeleton through Split Axon/Dendrite.'}
      </p>
    </div>
  )
}
