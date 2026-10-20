// @vitest-environment jsdom
/**
 * Simulate's partner list, rendered: the count, a tick per partner writing the silenced list, the
 * filter narrowing what the bulk buttons act on, and the full-size surface offered before a run.
 * The rules themselves are `partnerRows.test.ts`'.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { installJsdomStubs } from '../../test/jsdomStubs'
import { opensWithoutValue } from '../viewers/ValuePreview'
import { SimulatePartners } from './SimulatePartners'

beforeAll(() => installJsdomStubs())
afterEach(cleanup)

const PARTNERS = {
  id: ['101', '202', '303'],
  type: ['LC4', 'LPLC1', null],
  synapses: Int32Array.of(12, 3, 7),
  inhibitory: Int32Array.of(0, 0, 0),
}

function draw(silenced: string[] = []) {
  const onParamChange = vi.fn()
  render(
    <SimulatePartners
      nodeId="sim"
      partners={PARTNERS}
      silenced={silenced}
      onParamChange={onParamChange}
    />,
  )
  return onParamChange
}

describe('SimulatePartners', () => {
  it('says how many fire, and a tick silences or restores one partner', () => {
    const change = draw(['303'])
    expect(screen.getByText(/2 of 3 partners fire · 22 synapses/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('101 fires'))
    expect(change).toHaveBeenLastCalledWith('silenced', ['303', '101'])
    fireEvent.click(screen.getByLabelText('303 fires'))
    expect(change).toHaveBeenLastCalledWith('silenced', [])
  })

  it('acts on the shown rows only once a filter narrows them', () => {
    const change = draw()
    fireEvent.change(screen.getByLabelText('Filter partners'), { target: { value: 'LC' } })
    expect(screen.queryByLabelText('303 fires')).toBeNull()
    fireEvent.click(screen.getByText('Untick 2 shown'))
    expect(change).toHaveBeenLastCalledWith('silenced', ['101', '202'])
  })

  it('says why there is nothing to tick', () => {
    render(<SimulatePartners nodeId="sim" partners={undefined} silenced={[]} />)
    expect(screen.getByText(/Wire a Compartment Model/)).toBeTruthy()
  })

  it('opens full size before the node has run', () => {
    expect(opensWithoutValue('biophys:simulate')).toBe(true)
    expect(opensWithoutValue('core.filter')).toBe(false)
    // Drawing without a value is not opening before a run: the 3D View's card waits for one.
    expect(opensWithoutValue('out.viewer3d')).toBe(false)
  })
})
