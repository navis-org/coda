/**
 * The NeuronBridge pins: the `Pinned` port's schema half and value half agree (invariant 3), and a
 * stored entry survives the round trip or is dropped, never half-read.
 */

import { describe, expect, it } from 'vitest'

import { getColumn } from '../../core/values'
import type { NbPin } from './neuronbridgePins'
import {
  decodePin,
  encodePin,
  pinKey,
  PINNED_SCHEMA,
  pinnedTable,
  readPins,
} from './neuronbridgePins'

const PIN: NbPin = {
  neuronId: '720575940625431866',
  line: 'SS02800',
  collection: 'FlyLight Split-GAL4 Omnibus Broad',
  method: 'cds',
  score: 50000,
  pppmRank: null,
  matchingPixels: 424,
  mirrored: true,
  area: 'Brain',
  slideCode: '20150415_32_J1',
  objective: '63x',
  lmImageId: '2711777482658283531',
  emLibrary: 'FlyWire_FAFB_v783_realign',
  nbVersion: 'v3_10_0',
}

describe('neuronbridge pins', () => {
  it('builds a table whose schema is the declared one, for no pins and for some', () => {
    expect(pinnedTable([]).schema).toEqual(PINNED_SCHEMA)
    const table = pinnedTable([PIN])
    expect(table.schema).toEqual(PINNED_SCHEMA)
    expect(table.length).toBe(1)
    for (const column of PINNED_SCHEMA.columns) {
      expect(getColumn(table, column.name)).toHaveLength(1)
    }
  })

  it('keeps an 18-digit id as the text it was (invariant 8)', () => {
    const table = pinnedTable(readPins([encodePin(PIN)]))
    expect(getColumn(table, 'neuronId')[0]).toBe('720575940625431866')
    expect(getColumn(table, 'lmImageId')[0]).toBe('2711777482658283531')
  })

  it('round-trips every field', () => {
    expect(decodePin(encodePin(PIN))).toEqual(PIN)
    const pppm: NbPin = {
      ...PIN,
      method: 'pppm',
      score: 128,
      pppmRank: 0,
      matchingPixels: null,
    }
    expect(decodePin(encodePin(pppm))).toEqual(pppm)
  })

  it('drops what is not a pin, and keeps one pin once', () => {
    const other = { ...PIN, lmImageId: '1' }
    const pins = readPins([
      encodePin(PIN),
      'not json',
      JSON.stringify({ ...PIN, neuronId: 'LC4' }),
      JSON.stringify({ ...PIN, method: 'nblast' }),
      encodePin(PIN),
      encodePin(other),
      42,
    ])
    expect(pins.map(pinKey)).toEqual([pinKey(PIN), pinKey(other)])
    expect(readPins(undefined)).toEqual([])
  })

  it('tells two images of one line apart, and one image under two methods', () => {
    expect(pinKey(PIN)).not.toBe(pinKey({ ...PIN, lmImageId: '2' }))
    expect(pinKey(PIN)).not.toBe(pinKey({ ...PIN, method: 'pppm' }))
  })
})
