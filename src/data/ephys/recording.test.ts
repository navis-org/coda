/**
 * The stored-recording cache: a parse the card hands over serves the node's first run, and a few
 * files are kept within a byte budget, a read counting as a use, so a recording and its control do
 * not evict each other. The readers are their own
 * tests' (`abf.test.ts`); the store is `data/uploads.test.ts`'.
 */

import { describe, expect, it } from 'vitest'

import type { Recording } from './recording'
import { rememberRecording, storedRecording } from './recording'

const fake = (format: string): Recording => ({
  summary: {
    format,
    protocol: '',
    rate: 1000,
    sweeps: 1,
    sweepSamples: 1,
    mode: 'episodic',
    channels: [],
    commands: [],
    notes: [],
  },
  channel: () => new Float32Array(1),
  command: () => new Float32Array(1),
})

describe('storedRecording', () => {
  it('answers from what the card parsed, and keeps a recording and its control both', async () => {
    const cell = fake('cell')
    const control = fake('control')
    rememberRecording('r_cell', cell, 1000)
    rememberRecording('r_control', control, 1000)
    // Asked for in turn, as two cheap cards re-running are: neither evicts the other.
    for (let pass = 0; pass < 3; pass++) {
      expect(await storedRecording('r_cell', 'cell.abf')).toBe(cell)
      expect(await storedRecording('r_control', 'control.abf')).toBe(control)
    }
  })

  it('lets the least recently asked for go once the kept files outgrow their budget', async () => {
    const first = fake('first')
    rememberRecording('r_first', first, 60e6)
    // Asked for again: a read counts, so this outlives a file read after it.
    expect(await storedRecording('r_first', 'first.abf')).toBe(first)
    rememberRecording('r_2', fake('r_2'), 60e6)
    expect(await storedRecording('r_first', 'first.abf')).toBe(first)
    // A third 60 MB file puts the three past 128 MB: the least recently asked for, r_2, goes.
    rememberRecording('r_3', fake('r_3'), 60e6)
    expect(await storedRecording('r_first', 'first.abf')).toBe(first)
    await expect(storedRecording('r_2', 'two.abf')).rejects.toThrow(/“two\.abf” is not stored/)
    // A file larger than the whole budget is still kept while it is the newest.
    const huge = fake('huge')
    rememberRecording('r_huge', huge, 1e9)
    expect(await storedRecording('r_huge', 'huge.abf')).toBe(huge)
  })
})
