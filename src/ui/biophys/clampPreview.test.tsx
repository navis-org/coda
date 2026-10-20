// @vitest-environment jsdom
/**
 * The Clamp tab's preview: drawn from the card's params before any run, saying so when injection
 * is off. The envelope itself is `simulate.test.ts`' (`clampEnvelope`).
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import '../../nodes'
import { defaultParams } from '../../core/node'
import { getNodeDef } from '../../core/registry'
import { simulateNode } from '../../packs/biophys/simulate'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { tabFigureKeys } from '../viewers/ValuePreview'
import { ClampPreview } from './ClampPreview'

beforeAll(() => installJsdomStubs())
afterEach(cleanup)

describe('ClampPreview', () => {
  const params = defaultParams(simulateNode)

  it('says how to see a waveform while injection is off', () => {
    render(<ClampPreview params={params} />)
    expect(screen.getByText(/Tick Inject current/)).toBeTruthy()
  })

  it('draws the waveform over the whole run, its extremes labelled', () => {
    render(
      <ClampPreview params={{ ...params, clamp: true, clampShape: 'ramp', rampFrom: -0.1 }} />,
    )
    expect(
      screen.getByRole('img', { name: 'Injected current over the 100 ms run' }),
    ).toBeTruthy()
    expect(screen.getByText('-0.1 nA')).toBeTruthy()
    expect(screen.getByText('100 ms')).toBeTruthy()
  })
})

describe('tab figures', () => {
  // A renamed tab would stop drawing its figure with nothing said; so every key is a real tab.
  it('names a tab its node has, for every one', () => {
    const keys = tabFigureKeys()
    expect(keys).toContainEqual(['biophys:simulate', 'clamp'])
    for (const [type, tab] of keys) {
      expect(getNodeDef(type)?.paramGroups?.map((g) => g.id)).toContain(tab)
    }
  })
})
