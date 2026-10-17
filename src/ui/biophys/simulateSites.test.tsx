// @vitest-environment jsdom
/**
 * Simulate's Sites tab: the run's record sites, in its order and by its names, and what ticking one
 * writes. Where the clamps land is `simulate.test.ts`' (`planRun`); this is the list and the ticks.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { defaultParams } from '../../core/node'
import { writeManualPoint } from '../../nodes/lib/skeletonPoints'
import { simulateNode } from '../../packs/biophys/simulate'
import { build, exc, input } from '../../packs/biophys/testFixtures'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { SimulateSites, siteRows } from './SimulateSites'

beforeAll(() => installJsdomStubs())
afterEach(cleanup)

const model = () => build({}, exc(input([['A', '7', 'pre', 45_000, 0]])))
const traces = [writeManualPoint({ neuron: '7', at: [40_000, 0, 0], name: 'tip' })]

describe('siteRows', () => {
  it('lists the run’s sites by where they come from, then a ticked name no site has', () => {
    const rows = siteRows({ labels: ['soma', 'p1', 'tip'], recorded: 2 }, ['tip', 'gone'])
    expect(rows).toEqual([
      { label: 'soma', from: 'soma', ticked: false },
      { label: 'p1', from: 'Record at', ticked: false },
      { label: 'tip', from: 'Playback trace', ticked: true },
      { label: 'gone', from: undefined, ticked: true },
    ])
  })
})

describe('SimulateSites', () => {
  const renderSites = (over: Record<string, unknown>) => {
    const onParamsChange = vi.fn()
    render(
      <SimulateSites
        model={model()}
        params={{ ...defaultParams(simulateNode), traces, ...over }}
        record={undefined}
        column={() => undefined}
        onParamsChange={onParamsChange}
      />,
    )
    return onParamsChange
  }

  it('turns injection on at the site ticked while it is off, in one commit', () => {
    const write = renderSites({})
    expect(screen.getByText(/Current injection is off/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Inject at tip' }))
    expect(write).toHaveBeenCalledWith({ clamp: true, clampSites: ['tip'] })
  })

  it('adds and removes sites while on, and unticking the last turns it off', () => {
    const write = renderSites({ clamp: true })
    expect(
      screen.getByText(/^Injecting a 0.05 nA step from 10 ms for 50 ms at 1 site of 2/),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Inject at tip' }))
    expect(write).toHaveBeenLastCalledWith({ clampSites: ['soma', 'tip'] })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Inject at soma' }))
    expect(write).toHaveBeenLastCalledWith({ clamp: false })
  })
})
