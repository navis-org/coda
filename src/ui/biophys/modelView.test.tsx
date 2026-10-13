// @vitest-environment jsdom
/**
 * The Compartment Model's full-size view: the Regions tab lists this neuron's strokes, removes one
 * and renames a region — carrying the channel rows placed on it — and the Channels tab offers a
 * painted region before any run. The painting itself is `regions.test.ts`'; the click that makes a
 * stroke needs a laid-out dendrogram, which jsdom has not.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  newChannelRow,
  readChannelRows,
  writeChannelRow,
} from '../../packs/biophys/channelRows'
import type { RegionStroke } from '../../packs/biophys/regions'
import { readRegionStrokes, writeRegionStroke } from '../../packs/biophys/regions'
import { neuron } from '../../packs/biophys/testFixtures'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { ModelView } from './ModelView'

beforeAll(() => installJsdomStubs())
afterEach(cleanup)

const stroke: RegionStroke = {
  neuron: '7',
  at: [30_000, 10_000, 0],
  scope: 'distal',
  region: 'branch',
  root: [0, 0, 0],
}

function view(change = vi.fn()) {
  const params = {
    paintedRegions: [writeRegionStroke(stroke), writeRegionStroke({ ...stroke, neuron: '8' })],
    channels: [writeChannelRow({ ...newChannelRow('pospischil.na'), regions: ['branch'] })],
  }
  render(
    <ModelView skeletons={neuron()} model={undefined} params={params} onParamChange={change} />,
  )
  return change
}

describe('ModelView', () => {
  it('offers a painted region in the channel list before any run', () => {
    view()
    expect(screen.getByRole('tab', { name: 'Channels' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByRole('button', { name: 'branch' })).toBeTruthy()
    expect(screen.queryByText(/Run the model to see/)).toBeNull()
  })

  it('lists this neuron’s strokes, and removes one leaving the other neuron’s', () => {
    const change = view()
    fireEvent.click(screen.getByRole('tab', { name: 'Regions' }))
    expect(screen.getByText('Away from the root → branch')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Remove stroke 1'))
    expect(change.mock.lastCall?.[0]).toBe('paintedRegions')
    expect(readRegionStrokes(change.mock.lastCall?.[1]).map((s) => s.neuron)).toEqual(['8'])
  })

  // Every neuron's, as the channel rows naming it are every neuron's.
  it('renames a region in all its strokes and in the channel rows placed on it', () => {
    const change = view()
    fireEvent.click(screen.getByRole('tab', { name: 'Regions' }))
    const field = screen.getByLabelText('Rename branch')
    fireEvent.change(field, { target: { value: 'SIZ' } })
    fireEvent.blur(field, { target: { value: 'SIZ' } })
    const calls = Object.fromEntries(change.mock.calls)
    expect(readRegionStrokes(calls.paintedRegions).map((s) => [s.neuron, s.region])).toEqual([
      ['7', 'SIZ'],
      ['8', 'SIZ'],
    ])
    expect(readChannelRows(calls.channels)[0]!.regions).toEqual(['SIZ'])
  })
})

describe('ModelView with a one-commit setter', () => {
  it('renames a region in one call, strokes and channel rows together', () => {
    const many = vi.fn()
    const one = vi.fn()
    const params = {
      paintedRegions: [writeRegionStroke(stroke)],
      channels: [writeChannelRow({ ...newChannelRow('pospischil.na'), regions: ['branch'] })],
    }
    render(
      <ModelView
        skeletons={neuron()}
        model={undefined}
        params={params}
        onParamChange={one}
        onParamsChange={many}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Regions' }))
    const field = screen.getByLabelText('Rename branch')
    fireEvent.change(field, { target: { value: 'SIZ' } })
    fireEvent.blur(field, { target: { value: 'SIZ' } })
    expect(one).not.toHaveBeenCalled()
    expect(many).toHaveBeenCalledTimes(1)
    const values = many.mock.lastCall?.[0]
    expect(readRegionStrokes(values.paintedRegions)[0]!.region).toBe('SIZ')
    expect(readChannelRows(values.channels)[0]!.regions).toEqual(['SIZ'])
  })
})
