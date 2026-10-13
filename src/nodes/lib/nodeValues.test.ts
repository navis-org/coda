import { describe, expect, it } from 'vitest'
import { BUILT_IN_NODE_VALUES, NODE_VALUES } from './nodeValues'

describe('NODE_VALUES', () => {
  it('lists the built-in values first, then every pack’s', () => {
    expect(NODE_VALUES.slice(0, BUILT_IN_NODE_VALUES.length)).toEqual(BUILT_IN_NODE_VALUES)
    // The Biophysics pack declares its own, rather than core naming its node.
    expect(NODE_VALUES.find((v) => v.value === 'peakVoltage')?.label).toBe('peak voltage (mV)')
  })

  it('names the pack a pack’s value comes from, so a switched-off pack’s is not offered', () => {
    expect(NODE_VALUES.find((v) => v.value === 'peakVoltage')?.pack).toBe('biophys')
    expect(BUILT_IN_NODE_VALUES.every((v) => !('pack' in v))).toBe(true)
  })

  it('gives each value a label and a source', () => {
    // Each named once is the module's own refusal at load, so not asked here.
    for (const v of NODE_VALUES) {
      expect(v.label).toBeTruthy()
      expect(v.source).toBeTruthy()
    }
  })
})
