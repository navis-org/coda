/**
 * The NWB reader against files built here with h5wasm's own writer — no recording is committed —
 * each a shape a real writer produces (`pnpm probe:nwb` holds the reader to pynwb on real ones):
 * protocols at different rates and lengths, voltage and current clamp, sweep numbers or none, a
 * stimulus missing, a conversion factor that is wrong.
 */

import { describe, expect, it } from 'vitest'

import { h5wasm } from '../libraries'
import { protocolSummary, readRecording } from './recording'

/** One series to write: where, what, and its samples as stored. */
interface SeriesSpec {
  readonly name: string
  readonly role: 'acquisition' | 'stimulus'
  readonly type: string
  readonly description: string
  /** A sweep number; an array is a writer storing it as a one-element array. */
  readonly sweep?: number | number[]
  readonly unit: 'volts' | 'amperes'
  readonly conversion: number
  /** Samples a second; none is a series timed by timestamps instead. */
  readonly rate: number | undefined
  readonly data: number[]
}

/** An NWB 2 file holding `series`, every one on electrode `elec0`, as bytes. */
async function nwb(series: readonly SeriesSpec[]): Promise<ArrayBuffer> {
  const { library: h5, fs } = await h5wasm()
  const path = `/test-${Math.random().toString(36).slice(2)}.nwb`
  const f = new h5.File(path, 'w')
  f.create_attribute('nwb_version', '2.5.0')
  f.create_dataset({ name: 'session_start_time', data: '2024-05-01T10:00:00' })
  f.create_group('acquisition')
  f.create_group('stimulus')
  f.create_group('stimulus/presentation')
  f.create_group('general')
  f.create_group('general/intracellular_ephys')
  f.create_group('general/intracellular_ephys/elec0')
  for (const s of series) {
    const at = `${s.role === 'acquisition' ? 'acquisition' : 'stimulus/presentation'}/${s.name}`
    const g = f.create_group(at)
    g.create_attribute('neurodata_type', s.type)
    g.create_attribute('stimulus_description', s.description)
    if (Array.isArray(s.sweep)) g.create_attribute('sweep_number', s.sweep, [s.sweep.length])
    else if (s.sweep !== undefined) g.create_attribute('sweep_number', s.sweep)
    const data = g.create_dataset({ name: 'data', data: new Float32Array(s.data) })
    data.create_attribute('unit', s.unit)
    data.create_attribute('conversion', s.conversion)
    if (s.rate === undefined) {
      g.create_dataset({ name: 'timestamps', data: new Float64Array(s.data.length) })
    } else {
      const start = g.create_dataset({ name: 'starting_time', data: 0 })
      start.create_attribute('rate', s.rate)
    }
    g.create_soft_link('/general/intracellular_ephys/elec0', 'electrode')
  }
  f.close()
  const bytes = fs.readFile(path) as Uint8Array
  fs.unlink(path)
  return bytes.slice().buffer
}

/** A current-clamp sweep: Vm stored in mV under a conversion to volts, the command in pA. */
function ccSweep(sweep: number | undefined, description: string, mV: number[], pA: number[]) {
  const shared = { description, rate: 10_000, ...(sweep === undefined ? {} : { sweep }) }
  return [
    {
      ...shared,
      name: `cc_response_${sweep ?? description}`,
      role: 'acquisition' as const,
      type: 'CurrentClampSeries',
      unit: 'volts' as const,
      conversion: 1e-3,
      data: mV,
    },
    {
      ...shared,
      name: `cc_stimulus_${sweep ?? description}`,
      role: 'stimulus' as const,
      type: 'CurrentClampStimulusSeries',
      unit: 'amperes' as const,
      conversion: 1e-12,
      data: pA,
    },
  ]
}

describe('the NWB reader', () => {
  it('reads each protocol as a recording of its own, in mV and pA, by its own sweep numbers', async () => {
    const vc = [7, 8].flatMap((sweep) => [
      {
        name: `vc_response_${sweep}`,
        role: 'acquisition' as const,
        type: 'VoltageClampSeries',
        description: 'Seal',
        sweep,
        unit: 'amperes' as const,
        conversion: 1e-12,
        rate: 20_000,
        data: [sweep, sweep, sweep],
      },
      {
        name: `vc_stimulus_${sweep}`,
        role: 'stimulus' as const,
        type: 'VoltageClampStimulusSeries',
        description: 'Seal',
        sweep,
        unit: 'volts' as const,
        conversion: 1,
        rate: 20_000,
        data: [-0.07, -0.06, -0.07],
      },
    ])
    const steps = [3, 1, 2].flatMap((n) =>
      ccSweep(n, 'Steps', [-70, -70 + n, -70], [0, 10 * n, 0]),
    )
    const bytes = await nwb([...steps, ...vc])
    const rec = await readRecording(bytes, 'cell.nwb')
    const { summary } = rec
    expect(summary.format).toBe('NWB 2.5.0')
    expect(summary.protocols?.map((s) => s.protocol)).toEqual(['Steps', 'Seal'])
    // The first protocol, its sweeps in number order.
    expect(summary.protocol).toBe('Steps')
    expect(summary.sweepNumbers).toEqual([1, 2, 3])
    expect([summary.rate, summary.sweepSamples]).toEqual([10_000, 3])
    expect(summary.channels).toEqual([{ name: 'Vm', unit: 'mV' }])
    expect(summary.commands).toEqual([{ name: 'Icmd', unit: 'pA', origin: 'stored' }])
    expect(Array.from(rec.channel(0, 1))).toEqual([-70, -68, -70])
    expect(Array.from(rec.command(0, 2))).toEqual([0, 30, 0])
    // The other protocol, by name: voltage clamp, so Im in pA against a command in mV.
    const seal = await readRecording(bytes, 'cell.nwb', 'Seal')
    expect(seal.summary.channels).toEqual([{ name: 'Im', unit: 'pA' }])
    expect(seal.summary.commands).toEqual([{ name: 'Vcmd', unit: 'mV', origin: 'stored' }])
    expect(seal.summary.sweepNumbers).toEqual([7, 8])
    expect(Array.from(seal.command(0, 0), (v) => Math.round(v))).toEqual([-70, -60, -70])
    expect(protocolSummary(summary, 'Seal')?.rate).toBe(20_000)
    await expect(readRecording(bytes, 'cell.nwb', 'Ramp')).rejects.toThrow(
      /no protocol called "Ramp"/,
    )
  })

  it('names a group by its shape where its sweeps share no description, and pairs unnumbered series in order', async () => {
    // A writer giving every sweep its own description, and numbering none.
    const series = [1, 2].flatMap((n) =>
      ccSweep(undefined, `injection_00${n}`, [-60, -60], [n, n]),
    )
    const rec = await readRecording(await nwb(series), 'cell.nwb')
    expect(rec.summary.protocols).toBeUndefined()
    expect(rec.summary.protocol).toBe('current clamp, 0.0002 s at 10 kHz')
    expect(rec.summary.notes.join(' ')).toMatch(/numbers no sweeps, so each response is paired/)
    expect(Array.from(rec.command(0, 1))).toEqual([2, 2])
  })

  it('leaves a sweep with no stimulus without a command, and says a conversion no cell fits', async () => {
    const [response, stimulus] = ccSweep(1, 'Steps', [-70, -71], [5, 5])
    const lone = { ...ccSweep(2, 'Steps', [-70, -70], [0, 0])[0]!, conversion: 1e-12 }
    // Stored mV under a conversion meant for pA, every sweep: a billion times too small.
    const wrong = { ...response!, conversion: 1e-12 }
    const rec = await readRecording(await nwb([wrong, stimulus!, lone]), 'cell.nwb')
    expect(Array.from(rec.command(0, 1)).every(Number.isNaN)).toBe(true)
    expect(rec.summary.notes.join(' ')).toMatch(
      /Vm reads 7\.0e-8 mV at most, which no cell gives/,
    )
  })

  it('reads only the window it is asked for, the file kept open between reads', async () => {
    const rec = await readRecording(
      await nwb(ccSweep(1, 'Steps', [-70, -65, -60, -55], [0, 5, 10, 0])),
      'cell.nwb',
    )
    expect(Array.from(rec.channel(0, 0, 1, 3))).toEqual([-65, -60])
    expect(Array.from(rec.command(0, 0, 2))).toEqual([10, 0])
    // And again, later: nothing closed it.
    expect(Array.from(rec.channel(0, 0, 3))).toEqual([-55])
  })

  it('pairs nothing where unnumbered lists differ in length, and counts each group from 1', async () => {
    const responses = [1, 2].map((n) => ccSweep(undefined, `r${n}`, [-60, -60], [n, n])[0]!)
    const lone = ccSweep(undefined, 's1', [-60, -60], [1, 1])[1]!
    const rec = await readRecording(await nwb([...responses, lone]), 'cell.nwb')
    expect(rec.summary.notes.join(' ')).toMatch(
      /lists 2 responses against 1 stimuli, so no stimulus/,
    )
    expect(rec.summary.commands).toEqual([])
    expect(rec.summary.sweepNumbers).toBeUndefined()
  })

  it('takes a sweep number it cannot read as no number, and refuses a stimulus of another length', async () => {
    // Stored as one-element arrays: not numbers, so the file pairs by order (equal lists here).
    const arrays = [1, 2].flatMap((n) =>
      ccSweep(undefined, 'Steps', [-60, -60], [n, n]).map((s) => ({ ...s, sweep: [n] })),
    )
    const rec = await readRecording(await nwb(arrays), 'cell.nwb')
    expect(rec.summary.notes.join(' ')).toMatch(/numbers no sweeps, so each response is paired/)
    const [response, stimulus] = ccSweep(1, 'Steps', [-60, -60, -60], [1, 1])
    const short = await readRecording(await nwb([response!, stimulus!]), 'cell.nwb')
    expect(short.summary.notes.join(' ')).toMatch(
      /1 stimulus is sampled at another rate or length/,
    )
    expect(Array.from(short.command(0, 0)).every(Number.isNaN)).toBe(true)
  })

  it('sets aside a series timed by timestamps, and refuses a file of nothing else', async () => {
    const [response, stimulus] = ccSweep(1, 'Steps', [-60, -60], [1, 1])
    const stamped = { ...ccSweep(2, 'Steps', [-60], [1])[0]!, rate: undefined }
    const rec = await readRecording(await nwb([response!, stimulus!, stamped]), 'cell.nwb')
    expect(rec.summary.notes.join(' ')).toMatch(/1 recording is timed by timestamps/)
    expect(rec.summary.sweeps).toBe(1)
    await expect(readRecording(await nwb([stamped]), 'cell.nwb')).rejects.toThrow(
      /times its recordings by timestamps/,
    )
  })

  it('gives every group a name of its own, even where two shapes round to one wording', async () => {
    // 7,650 and 7,651 samples at 50 kHz: both 0.153 s, no description to tell them apart.
    const sweep = (n: number, length: number) => ({
      ...ccSweep(n, '', Array(length).fill(-60), [])[0]!,
      rate: 50_000,
    })
    const rec = await readRecording(await nwb([sweep(1, 7650), sweep(2, 7651)]), 'cell.nwb')
    const names = rec.summary.protocols!.map((s) => s.protocol)
    expect(names).toEqual([
      'current clamp, 0.153 s at 50 kHz',
      'current clamp, 0.153 s at 50 kHz (2)',
    ])
  })
})
