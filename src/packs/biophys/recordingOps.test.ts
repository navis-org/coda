/**
 * Load Recording's table from a recording built here (`Recording` is an interface, so no file is
 * needed): sweeps, the window, the averaging, the names, and the schema agreeing with the table.
 * The ABF reader is `data/ephys/abf.test.ts`'.
 */

import { describe, expect, it } from 'vitest'

import { getColumn } from '../../core/values'
import type { Recording, RecordingSummary } from '../../data/ephys/recording'
import type { RecordingPick } from './recordingOps'
import {
  parseSweeps,
  recordingColumns,
  recordingPickIssues,
  recordingSchema,
  recordingTable,
} from './recordingOps'

/** 1 kHz, `sweeps` sweeps of 10 samples: Vm is 100 × sweep + sample, the command a step at 5. */
function recording(sweeps = 3, over: Partial<RecordingSummary> = {}): Recording {
  const summary: RecordingSummary = {
    format: 'ABF 2.6',
    protocol: 'IV',
    rate: 1000,
    sweeps,
    sweepSamples: 10,
    mode: 'episodic',
    channels: [
      { name: 'Vm', unit: 'mV' },
      { name: 'Im', unit: 'pA' },
    ],
    commands: [{ name: 'I_clamp', unit: 'pA' }],
    notes: [],
    ...over,
  }
  return {
    summary,
    // Samples `from` up to `to`, as a reader hands a window.
    channel: (c, s, from = 0, to = 10) =>
      Float32Array.from({ length: to - from }, (_, k) =>
        c === 0 ? 100 * s + from + k : -(from + k),
      ),
    command: (_, s) => Float32Array.from({ length: 10 }, (_, i) => (i < 5 ? 0 : 10 * (s + 1))),
  }
}

const ALL: RecordingPick = {
  columns: [],
  sweeps: '',
  window: undefined,
  rezero: false,
  every: 1,
}

describe('parseSweeps', () => {
  it('reads single sweeps and ranges counted from 1, once each, and returns what names none', () => {
    expect(parseSweeps('', 3)).toEqual({ sweeps: [0, 1, 2], bad: [] })
    expect(parseSweeps('3, 1-2 2', 5)).toEqual({ sweeps: [0, 1, 2], bad: [] })
    expect(parseSweeps('2-1, 9, x, 0', 5)).toEqual({ sweeps: [], bad: ['2-1', '9', 'x', '0'] })
    // A range typed with spaces, or an en dash, is still one range: not 1, a dash and 3.
    expect(parseSweeps('1 - 3', 5)).toEqual({ sweeps: [0, 1, 2], bad: [] })
    expect(parseSweeps('[1 – 2, 5]', 5)).toEqual({ sweeps: [0, 1, 4], bad: [] })
  })
})

describe('recordingColumns', () => {
  it('keeps the file’s names, telling apart a clash with t, sweep or each other', () => {
    const rec = recording(1, {
      channels: [
        { name: 't', unit: 'mV' },
        { name: '', unit: 'pA' },
      ],
      commands: [{ name: 't', unit: 'pA' }],
    })
    expect(recordingColumns(rec.summary).map((c) => c.name)).toEqual([
      't (2)',
      'channel 2',
      't (3)',
    ])
  })
})

describe('recordingTable', () => {
  it('is long: a row per sample per sweep, time in ms, the sweep from 1, every column', () => {
    const table = recordingTable(recording(), ALL)
    expect(table.schema).toEqual(recordingSchema(recording().summary, ALL))
    expect(table.schema.columns.map((c) => [c.name, c.unit])).toEqual([
      ['t', 'ms'],
      ['sweep', undefined],
      ['Vm', 'mV'],
      ['Im', 'pA'],
      ['I_clamp', 'pA'],
    ])
    expect(table.length).toBe(30)
    expect(getColumn(table, 't').slice(0, 3)).toEqual([0, 1, 2])
    expect(getColumn(table, 'sweep')[10]).toBe(2)
    expect(getColumn(table, 'Vm')[12]).toBe(102)
    expect(getColumn(table, 'I_clamp').slice(4, 6)).toEqual([0, 10])
  })

  it('keeps the picked columns and sweeps, a window from up to not including to, re-zeroed', () => {
    const pick: RecordingPick = {
      columns: ['I_clamp', 'Vm'],
      sweeps: '3',
      window: { start: 2, end: 5 },
      rezero: true,
      every: 1,
    }
    const table = recordingTable(recording(), pick)
    expect(table.schema).toEqual(recordingSchema(recording().summary, pick))
    // The file's order, not the pick's.
    expect(table.schema.columns.map((c) => c.name)).toEqual(['t', 'sweep', 'Vm', 'I_clamp'])
    expect(getColumn(table, 't')).toEqual([0, 1, 2])
    expect(getColumn(table, 'Vm')).toEqual([202, 203, 204])
  })

  it('averages each block of samples into one, timed at its middle, a short last block too', () => {
    const table = recordingTable(recording(1), { ...ALL, every: 4 })
    expect(getColumn(table, 't')).toEqual([1.5, 5.5, 8.5])
    expect(getColumn(table, 'Vm')).toEqual([1.5, 5.5, 8.5])
    // The command's block straddling its step averages across it.
    expect(getColumn(table, 'I_clamp')).toEqual([0, 7.5, 10])
  })
})

describe('recordingPickIssues', () => {
  it('names a channel the file lacks, sweeps that name none, and a window outside the sweep', () => {
    const { summary } = recording()
    expect(recordingPickIssues(summary, ALL)).toEqual([])
    expect(
      recordingPickIssues(summary, { ...ALL, columns: ['Vm', 'Iout'], sweeps: '4' }),
    ).toEqual([
      '1 picked channel is not in this recording: Iout.',
      'Sweeps: 4 names no sweep of the 3 in this recording.',
    ])
    expect(recordingPickIssues(summary, { ...ALL, window: { start: 20, end: 30 } })).toEqual([
      'The window is outside the sweep, which is 10 ms long.',
    ])
    expect(recordingPickIssues(summary, { ...ALL, window: { start: 5, end: 2 } })).toEqual([
      'The window ends before it starts.',
    ])
    // Known from the summary alone, so said on the card before a run, in the run's own words.
    const huge = { ...summary, sweepSamples: 2e9 }
    const [size] = recordingPickIssues(huge, ALL)
    expect(size).toMatch(/^Refused: 6,000,000,000 rows × 5 columns/)
    expect(() => recordingTable(recording(3, { sweepSamples: 2e9 }), ALL)).toThrow(size)
  })
})
