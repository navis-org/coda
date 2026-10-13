// @vitest-environment jsdom
/**
 * The Compartment Model's channel editor, rendered: a passive cell said, the squid soma preset and
 * a new row written as channel rows, a region toggled, a row removed. What a row means is
 * `build.test.ts`' (`the channel list`).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  newChannelRow,
  readChannelRows,
  writeChannelRow,
} from '../../packs/biophys/channelRows'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { opensWithoutValue } from '../viewers/ValuePreview'
import { ChannelsEditor } from './ChannelsEditor'

beforeAll(() => installJsdomStubs())
afterEach(cleanup)

const written = (change: ReturnType<typeof vi.fn>) => readChannelRows(change.mock.lastCall?.[1])

describe('ChannelsEditor', () => {
  it('says a cell with no channels is passive, and adds the squid soma as two rows', () => {
    const change = vi.fn()
    render(<ChannelsEditor channels={[]} regionNames={undefined} onParamChange={change} />)
    expect(screen.getByText('A passive cell: no channels.')).toBeTruthy()
    fireEvent.click(screen.getByText('+ Squid HH soma'))
    expect(change.mock.lastCall?.[0]).toBe('channels')
    expect(written(change).map((r) => [r.channel, r.regions])).toEqual([
      ['hh.na', ['soma']],
      ['hh.k', ['soma']],
    ])
  })

  it('adds a channel everywhere, toggles a region onto it and removes it', () => {
    const change = vi.fn()
    const row = writeChannelRow({ ...newChannelRow('pospischil.na'), value: 30 })
    render(<ChannelsEditor channels={[row]} regionNames={undefined} onParamChange={change} />)
    expect(screen.getByText('everywhere')).toBeTruthy()
    fireEvent.click(screen.getByText('axon'))
    expect(written(change)[0]!.regions).toEqual(['axon'])
    fireEvent.click(screen.getByLabelText('Remove channel 1'))
    expect(written(change)).toEqual([])
    fireEvent.click(screen.getByText('+ Add channel'))
    expect(written(change)).toHaveLength(2)
  })

  it('resets a density to the new channel’s own when the channel changes, and keeps a total', () => {
    const change = vi.fn()
    const rows = [
      writeChannelRow({ ...newChannelRow('pospischil.na'), value: 30 }),
      writeChannelRow({ ...newChannelRow('pospischil.na'), mode: 'total', value: 4 }),
    ]
    render(<ChannelsEditor channels={rows} regionNames={undefined} onParamChange={change} />)
    fireEvent.change(screen.getByLabelText('Channel 1'), { target: { value: 'pospischil.k' } })
    expect(written(change)[0]).toMatchObject({ channel: 'pospischil.k', value: 5 })
    fireEvent.change(screen.getByLabelText('Channel 2'), { target: { value: 'hh.na' } })
    expect(written(change)[1]).toMatchObject({ channel: 'hh.na', mode: 'total', value: 4 })
  })

  it('explains a row’s channel on its “?”, with the density it starts at', () => {
    const row = writeChannelRow({ ...newChannelRow('pospischil.k'), value: 5 })
    render(<ChannelsEditor channels={[row]} regionNames={undefined} onParamChange={vi.fn()} />)
    expect(screen.queryByText(/Starts at 5 mS\/cm²/)).toBeNull()
    fireEvent.click(screen.getByLabelText('About K (Pospischil)'))
    expect(screen.getByText(/Starts at 5 mS\/cm²/)).toBeTruthy()
    expect(screen.getByText(/Gating n⁴, reversal −90 mV/)).toBeTruthy()
  })

  it('keeps a “?” open on its channel when a row above it is removed', () => {
    const rows = [
      writeChannelRow({ ...newChannelRow('pospischil.na'), value: 30 }),
      writeChannelRow({ ...newChannelRow('pospischil.k'), value: 5 }),
    ]
    const { rerender } = render(
      <ChannelsEditor channels={rows} regionNames={undefined} onParamChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByLabelText('About K (Pospischil)'))
    fireEvent.click(screen.getByLabelText('Remove channel 1'))
    // The node writes the list back without row 1; K is now row 1, and its text still open.
    rerender(
      <ChannelsEditor channels={[rows[1]]} regionNames={undefined} onParamChange={vi.fn()} />,
    )
    expect(screen.getByText(/Starts at 5 mS\/cm²/)).toBeTruthy()
  })

  it('opens full size before the model has run', () => {
    expect(opensWithoutValue('biophys:model')).toBe(true)
  })

  it('shows a region the model no longer has, so it can be unticked', () => {
    const change = vi.fn()
    const row = writeChannelRow({ ...newChannelRow('pospischil.na'), regions: ['region 1'] })
    render(
      <ChannelsEditor
        channels={[row]}
        regionNames={['unlabelled', 'soma', 'dendrite']}
        onParamChange={change}
      />,
    )
    const stale = screen.getByRole('button', { name: 'region 1' })
    expect(stale.getAttribute('aria-pressed')).toBe('true')
    expect(stale.hasAttribute('data-missing')).toBe(true)
    fireEvent.click(stale)
    expect(written(change)[0]!.regions).toEqual([])
  })
})
