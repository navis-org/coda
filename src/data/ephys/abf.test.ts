/**
 * The ABF2 reader against files built here, byte by byte, to the layouts `abf.ts` reads. What a
 * real Clampex file holds is `pnpm probe:abf`'s, which holds this reader to pyABF on one; these pin
 * the rules a probe on one file cannot reach — scaling, interleaving, gap-free, every epoch type
 * the reader rebuilds, the opening level, and the refusals.
 */

import { describe, expect, it } from 'vitest'

import { commandWaveform } from './abf'
import { readRecording } from './recording'

interface ChannelSpec {
  name: string
  unit: string
  /** `fInstrumentScaleFactor`: raw × (range / resolution) / this. */
  scale: number
  offset?: number
}

interface EpochSpec {
  type: number
  level: number
  levelInc?: number
  duration: number
  durationInc?: number
  period?: number
  width?: number
}

interface DacSpec {
  name: string
  unit: string
  enabled: boolean
  source: number
  holding?: number
  keepLast?: boolean
  epochs?: EpochSpec[]
}

/** An ABF2 file: `raw[sweep][channel][sample]`, int16 unless `float`. */
function abf2(o: {
  channels: ChannelSpec[]
  raw: number[][][]
  rate?: number
  mode?: number
  float?: boolean
  dacs?: DacSpec[]
  truncate?: number
}): ArrayBuffer {
  const sweeps = o.raw.length
  const samples = o.raw[0]![0]!.length
  const strings = ['Clampex', 'C:\\pCLAMP\\Params\\IV_step.pro']
  const index = (s: string) => {
    strings.push(s)
    return strings.length // index 0 is the empty string before the first
  }
  const adc = o.channels.map((c) => ({ ...c, nameAt: index(c.name), unitAt: index(c.unit) }))
  const dacs = (o.dacs ?? []).map((d) => ({
    ...d,
    nameAt: index(d.name),
    unitAt: index(d.unit),
  }))
  const epochs = dacs.flatMap((d, dacNum) =>
    (d.epochs ?? []).map((e, n) => ({ ...e, dacNum, n })),
  )
  // One byte a character, as Clampex writes them: `µ` is 0xB5, never UTF-8's two bytes.
  const text = Uint8Array.from(`xx\0\0${strings.join('\0')}`, (ch) => ch.charCodeAt(0))
  const bytesPer = o.float ? 4 : 2
  const points = sweeps * samples * o.channels.length
  // Blocks: 0 header, 1 protocol, 2 ADC, 3 DAC, 4 epochs, 5 strings, 6… data.
  const size = 6 * 512 + points * bytesPer
  const buffer = new ArrayBuffer(size)
  const v = new DataView(buffer)
  'ABF2'.split('').forEach((ch, i) => v.setUint8(i, ch.charCodeAt(0)))
  v.setUint8(6, 6)
  v.setUint8(7, 2)
  v.setUint32(12, sweeps, true)
  v.setUint32(16, 20260211, true)
  v.setUint32(20, (18 * 3600 + 54 * 60 + 15) * 1000, true)
  v.setUint16(30, o.float ? 1 : 0, true)
  v.setUint32(72, 2, true)
  const section = (at: number, block: number, entry: number, count: number) => {
    v.setUint32(at, block, true)
    v.setUint32(at + 4, entry, true)
    v.setInt32(at + 8, count, true)
  }
  section(76, 1, 512, 1)
  section(92, 2, 128, adc.length)
  section(108, 3, 128, dacs.length)
  section(156, 4, 32, epochs.length)
  section(220, 5, text.length, 1)
  section(236, 6, bytesPer, points)

  const p = 512
  v.setInt16(p, o.mode ?? 5, true)
  v.setFloat32(p + 2, 1e6 / (o.rate ?? 10_000), true)
  v.setFloat32(p + 110, 10, true)
  v.setInt32(p + 118, 32768, true)
  adc.forEach((c, i) => {
    const at = 2 * 512 + i * 128
    v.setInt16(at, i, true)
    v.setFloat32(at + 28, 1, true)
    v.setFloat32(at + 40, c.scale, true)
    v.setFloat32(at + 44, c.offset ?? 0, true)
    v.setFloat32(at + 48, 1, true)
    v.setInt32(at + 74, c.nameAt, true)
    v.setInt32(at + 78, c.unitAt, true)
  })
  dacs.forEach((d, i) => {
    const at = 3 * 512 + i * 128
    v.setInt16(at, i, true)
    v.setFloat32(at + 12, d.holding ?? 0, true)
    v.setInt32(at + 24, d.nameAt, true)
    v.setInt32(at + 28, d.unitAt, true)
    v.setInt16(at + 40, d.enabled ? 1 : 0, true)
    v.setInt16(at + 42, d.source, true)
    v.setInt16(at + 44, d.keepLast ? 1 : 0, true)
  })
  epochs.forEach((e, i) => {
    const at = 4 * 512 + i * 32
    v.setInt16(at, e.n, true)
    v.setInt16(at + 2, e.dacNum, true)
    v.setInt16(at + 4, e.type, true)
    v.setFloat32(at + 6, e.level, true)
    v.setFloat32(at + 10, e.levelInc ?? 0, true)
    v.setInt32(at + 14, e.duration, true)
    v.setInt32(at + 18, e.durationInc ?? 0, true)
    v.setInt32(at + 22, e.period ?? 0, true)
    v.setInt32(at + 26, e.width ?? 0, true)
  })
  new Uint8Array(buffer, 5 * 512, text.length).set(text)
  let k = 0
  for (const sweep of o.raw) {
    for (let i = 0; i < samples; i++) {
      for (const channel of sweep) {
        const at = 6 * 512 + k++ * bytesPer
        if (o.float) v.setFloat32(at, channel[i]!, true)
        else v.setInt16(at, channel[i]!, true)
      }
    }
  }
  return o.truncate ? buffer.slice(0, size - o.truncate) : buffer
}

const VM: ChannelSpec = { name: 'Vm', unit: 'mV', scale: 0.01 }
const IM: ChannelSpec = { name: 'Im', unit: 'µA', scale: 0.0005 }

describe('reading an ABF2 file', () => {
  it('names, scales and de-interleaves each channel, sweep by sweep', () => {
    const raw = [
      [
        [100, -200, 300],
        [10, 20, 30],
      ],
      [
        [-100, 0, 100],
        [40, 50, 60],
      ],
    ]
    const rec = readRecording(abf2({ channels: [VM, IM], raw }), 'cell.abf')
    expect(rec.summary).toMatchObject({
      format: 'ABF 2.6',
      protocol: 'IV_step',
      startedAt: '2026-02-11T18:54:15.000',
      rate: 10_000,
      sweeps: 2,
      sweepSamples: 3,
      mode: 'episodic',
      // pyABF reads µ as u, so a unit compares equal to its.
      channels: [
        { name: 'Vm', unit: 'mV' },
        { name: 'Im', unit: 'uA' },
      ],
      commands: [],
    })
    // raw × (10 V / 32768) / scale, the scale as the file stores it (a float32): 100 counts at
    // 0.01 V/mV is 3.0518 mV.
    const lsb = 10 / 32768
    expect(Array.from(rec.channel(0, 0))).toEqual(
      [100, -200, 300].map((x) => Math.fround((x * lsb) / Math.fround(0.01))),
    )
    expect(Array.from(rec.channel(1, 1))).toEqual(
      [40, 50, 60].map((x) => Math.fround((x * lsb) / Math.fround(0.0005))),
    )
  })

  it('reads floats as they are, and a gap-free file as one sweep', () => {
    const rec = readRecording(
      abf2({ channels: [VM], raw: [[[1.5, -2.25, 3]]], float: true, mode: 3 }),
      'free.abf',
    )
    expect(rec.summary.mode).toBe('gap-free')
    expect(rec.summary.sweeps).toBe(1)
    expect(Array.from(rec.channel(0, 0))).toEqual([1.5, -2.25, 3])
  })

  it('refuses an ABF1 file, a short file and a file no reader knows, each in its own words', () => {
    const abf1 = new Uint8Array(64)
    'ABF '.split('').forEach((ch, i) => (abf1[i] = ch.charCodeAt(0)))
    expect(() => readRecording(abf1.buffer, 'old.abf')).toThrow(
      /ABF1 file \(pCLAMP 9 or earlier\)/,
    )
    expect(() =>
      readRecording(abf2({ channels: [VM], raw: [[[1, 2, 3, 4]]], truncate: 4 }), 'cut.abf'),
    ).toThrow(/shorter than its header says/)
    expect(() => readRecording(new ArrayBuffer(64), 'trace.abf')).toThrow(
      /named like ABF but is not one/,
    )
    expect(() => readRecording(new ArrayBuffer(64), 'trace.dat')).toThrow(
      /not a recording format this build reads\. It reads ABF \(\.abf\)/,
    )
  })
})

describe('rebuilding the command', () => {
  const samples = 128 // the pre-epoch is the first 128 / 64 = 2 samples
  const zeros = () => [Array.from({ length: samples }, () => 0)]

  it('offers only outputs a waveform drives, and says which come from a stimulus file', () => {
    const rec = readRecording(
      abf2({
        channels: [VM],
        raw: [zeros()],
        dacs: [
          { name: 'I_clamp', unit: 'pA', enabled: true, source: 1, epochs: [] },
          { name: 'Cmd 1', unit: 'pA', enabled: false, source: 1 },
          { name: 'Cmd 2', unit: 'mV', enabled: true, source: 2 },
        ],
      }),
      'cell.abf',
    )
    expect(rec.summary.commands).toEqual([{ name: 'I_clamp', unit: 'pA' }])
    expect(rec.summary.notes).toEqual([
      'The command on Cmd 2 comes from a stimulus file, which is not in the recording, so it is not rebuilt.',
    ])
  })

  it('steps each sweep by its increments after a sixty-fourth at the holding level', () => {
    const rec = readRecording(
      abf2({
        channels: [VM],
        raw: [zeros(), zeros(), zeros()],
        dacs: [
          {
            name: 'I_clamp',
            unit: 'pA',
            enabled: true,
            source: 1,
            holding: -5,
            epochs: [
              { type: 1, level: 0, duration: 10 },
              { type: 1, level: -30, levelInc: 5, duration: 20, durationInc: 2 },
            ],
          },
        ],
      }),
      'iv.abf',
    )
    const sweep2 = rec.command(0, 2)
    expect(sweep2[0]).toBe(-5)
    expect(sweep2[1]).toBe(-5)
    expect(sweep2[2]).toBe(0)
    // Sweep 3 of the step: −30 + 2 × 5 for 20 + 2 × 2 samples, from sample 2 + 10.
    expect(Array.from(sweep2.slice(12, 36))).toEqual(Array(24).fill(-20))
    expect(sweep2[36]).toBe(-5)
    expect(sweep2[samples - 1]).toBe(-5)
  })

  it('draws a ramp from the level before it, both ends included, and a pulse train', () => {
    const ramp = commandWaveform(
      { holding: 0, keepsLastLevel: false, epochs: [epoch(2, 10, 5)] },
      0,
      64,
    )
    // One pre-epoch sample, then 0 → 10 over five samples.
    expect(Array.from(ramp.slice(1, 6))).toEqual([0, 2.5, 5, 7.5, 10])
    const train = commandWaveform(
      {
        holding: 0,
        keepsLastLevel: false,
        epochs: [{ ...epoch(3, 1, 10), pulsePeriod: 4, pulseWidth: 2 }],
      },
      0,
      64,
    )
    // Two whole pulses fit ten samples (the partial third is not drawn).
    expect(Array.from(train.slice(1, 11))).toEqual([1, 1, 0, 0, 1, 1, 0, 0, 0, 0])
  })

  it('opens the next sweep at the last level when the output keeps it', () => {
    const waves = [0, 1].map((sweep) =>
      commandWaveform(
        { holding: 0, keepsLastLevel: true, epochs: [{ ...epoch(1, 3, 4), levelInc: 1 }] },
        sweep,
        64,
      ),
    )
    expect(waves[0]![0]).toBe(0)
    expect(waves[0]![63]).toBe(3)
    expect(waves[1]![0]).toBe(3)
    expect(waves[1]![63]).toBe(4)
  })
})

function epoch(type: number, level: number, duration: number) {
  return { type, level, levelInc: 0, duration, durationInc: 0, pulsePeriod: 0, pulseWidth: 0 }
}
