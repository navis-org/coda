/**
 * ABF, the Axon Binary Format of Molecular Devices' Clampex: ABF2 (pCLAMP 10 and later) and ABF1
 * (pCLAMP 9 and earlier, `readAbf1`).
 *
 * Molecular Devices publishes the header structures but no specification. The layouts, the
 * scaling and the stimulus rules here are a port of **pyABF** (Scott W. Harden, MIT licence,
 * https://github.com/swharden/pyABF) — `abf2/*Section.py`, `abf.py`'s `_readHeadersV2` and
 * `waveform.py` — so a value read here is the value pyABF reads, which is what most people check a
 * file against. `scripts/probe-abf.py` holds the two side by side on a real file.
 *
 * ## The file
 *
 * A 76-byte header, then a map of sections, each a block index (512-byte blocks), an entry size
 * and an entry count. The ones read: Protocol (rate, ADC range), ADC (one per recorded channel:
 * name, unit, gains), DAC (one per output: name, unit, holding level, whether a waveform drives
 * it), EpochPerDAC (the waveform as a table of epochs), Strings (every name, by index) and Data.
 *
 * ## The samples
 *
 * Interleaved across channels, sweep after sweep, usually 16-bit integers that a per-channel gain
 * and offset turn into the channel's unit; 32-bit floats need neither.
 *
 * ## The command
 *
 * **Not stored as samples**: each output's waveform is an epoch table — a level, a duration and a
 * type per epoch, with per-sweep increments — and is rebuilt here, sweep by sweep, the way pyABF
 * rebuilds `sweepC`: the first sixty-fourth of the sweep at the holding level (or the last sweep's
 * last level), then the epochs, then the holding level again. A waveform read from a separate
 * stimulus file is not rebuilt (the file is not in the recording), and said.
 *
 * Not read: variable-length event-driven files, ABF1 samples stored as floats (pyABF reads none),
 * digital outputs, tags and the user list.
 */

import type { Recording, RecordingReader, RecordingSummary, Signal } from './recording'

const BLOCK = 512

/** One entry of the section map: where a section starts, and how its entries are laid out. */
interface Section {
  readonly start: number
  readonly size: number
  readonly count: number
}

/** The section map's byte offsets in the header (pyABF's `Section(fb, position)`). */
const SECTION_AT = {
  protocol: 76,
  adc: 92,
  dac: 108,
  epochPerDac: 156,
  strings: 220,
  data: 236,
} as const

/** Epoch types, as Clampex numbers them; 6 is unused. */
const EPOCH = {
  off: 0,
  step: 1,
  ramp: 2,
  pulse: 3,
  triangle: 4,
  cosine: 5,
  biphasic: 7,
} as const

/** One epoch of an output's waveform, as the table stores it (durations in samples). */
interface Epoch {
  readonly type: number
  readonly level: number
  readonly levelInc: number
  readonly duration: number
  readonly durationInc: number
  readonly pulsePeriod: number
  readonly pulseWidth: number
}

interface DacWaveform {
  readonly holding: number
  /** Whether a sweep starts from the last sweep's final level rather than the holding level. */
  readonly keepsLastLevel: boolean
  readonly epochs: readonly Epoch[]
}

export const ABF_READER: RecordingReader = {
  label: 'ABF',
  extensions: ['.abf'],
  sniff: (bytes) => signature(bytes) === 'ABF2' || signature(bytes) === 'ABF ',
  read: readAbf,
}

function signature(bytes: Uint8Array): string {
  return bytes.length < 4 ? '' : String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
}

function readAbf(buffer: ArrayBuffer): Recording {
  const view = new DataView(buffer)
  const sig = signature(new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength)))
  if (sig === 'ABF ') return readAbf1(buffer)
  if (sig !== 'ABF2') throw new Error('This is not an ABF file.')

  const section = (at: number): Section => ({
    start: view.getUint32(at, true) * BLOCK,
    size: view.getUint32(at + 4, true),
    count: view.getInt32(at + 8, true),
  })
  const protocol = section(SECTION_AT.protocol)
  const adc = section(SECTION_AT.adc)
  const dac = section(SECTION_AT.dac)
  const epochPerDac = section(SECTION_AT.epochPerDac)
  const data = section(SECTION_AT.data)
  const strings = indexedStrings(buffer, section(SECTION_AT.strings))
  const text = (i: number) => strings[i] ?? ''

  // Four bytes, least significant first (`00 00 06 02` is 2.6.0.0); named as people name it, "2.6".
  const version = Array.from(new Uint8Array(buffer, 6, 2))
    .reverse()
    .join('.')
  const mode = view.getInt16(protocol.start, true)
  if (mode === 1) throw new Error(EVENT_DRIVEN)
  const interval = view.getFloat32(protocol.start + 2, true) // µs per sample, per channel
  const adcRange = view.getFloat32(protocol.start + 110, true)
  const adcResolution = view.getInt32(protocol.start + 118, true)
  if (!(interval > 0)) throw new Error('This ABF file does not say its sample rate.')

  const channelCount = adc.count
  if (channelCount < 1) throw new Error('This ABF file records no channels.')
  const channels: Signal[] = []
  const gain: number[] = []
  const offset: number[] = []
  for (let c = 0; c < channelCount; c++) {
    const at = adc.start + c * adc.size
    const f32 = (o: number) => view.getFloat32(at + o, true)
    const telegraph = view.getInt16(at + 2, true) === 1
    channels.push({
      name: text(view.getInt32(at + 74, true)),
      unit: text(view.getInt32(at + 78, true)),
    })
    const scale = channelScale({
      instrument: f32(40),
      signalGain: f32(48),
      programmable: f32(28),
      telegraph: telegraph ? f32(6) : undefined,
      range: adcRange,
      resolution: adcResolution,
      instrumentOffset: f32(44),
      signalOffset: f32(52),
    })
    gain.push(scale.gain)
    offset.push(scale.offset)
  }

  const float = view.getUint16(30, true) === 1
  const bytesPer = float ? 4 : 2
  const points = data.count
  let sweeps = view.getUint32(12, true)
  if (mode === 3 || sweeps === 0) sweeps = 1
  const sweepSamples = Math.floor(points / sweeps / channelCount)
  if (data.start + points * bytesPer > buffer.byteLength) {
    throw new Error(
      'This ABF file is shorter than its header says: it may have been cut off while copying.',
    )
  }

  // The outputs a waveform drives, and the ones whose waveform is in a file of its own.
  const commands: Signal[] = []
  const waveforms: DacWaveform[] = []
  const notes: string[] = []
  for (let d = 0; d < dac.count; d++) {
    const at = dac.start + d * dac.size
    const enabled = view.getInt16(at + 40, true) !== 0
    const source = view.getInt16(at + 42, true)
    if (!enabled || source === 0) continue
    const name = text(view.getInt32(at + 24, true))
    if (source !== 1) {
      notes.push(stimulusFileNote(name, d))
      continue
    }
    commands.push({ name, unit: text(view.getInt32(at + 28, true)), origin: 'rebuilt' })
    waveforms.push({
      holding: holdingLevel(view.getFloat32(at + 12, true)),
      keepsLastLevel: view.getInt16(at + 44, true) !== 0,
      epochs: epochsOf(view, epochPerDac, view.getInt16(at, true)),
    })
  }

  const summary: RecordingSummary = {
    format: `ABF ${version}`,
    protocol: protocolName(text(view.getUint32(72, true))),
    startedAt: startedAt(view.getUint32(16, true), view.getUint32(20, true)),
    rate: 1e6 / interval,
    sweeps,
    sweepSamples,
    mode: mode === 3 ? 'gap-free' : 'episodic',
    channels,
    commands,
    notes,
  }

  /*
   * A typed view rather than a `DataView` read per sample: the data section starts on a 512-byte
   * block, so it is aligned for either width, and the samples are little-endian, as every platform
   * a browser runs on is.
   */
  const samples = float
    ? new Float32Array(buffer, data.start, points)
    : new Int16Array(buffer, data.start, points)
  return abfRecording({
    summary,
    channelCount,
    // Floats need no scaling: a gain of 1 and no offset.
    gain: float ? gain.map(() => 1) : gain,
    offset: float ? offset.map(() => 0) : offset,
    sample: (i) => samples[i]!,
    waveforms,
  })
}

/**
 * ABF1, pCLAMP 9 and earlier: one fixed header of variables at set byte positions rather than
 * ABF2's map of sections, read as pyABF's `HeaderV1` and `_readHeadersV1` read it. The samples are
 * ABF2's — interleaved 16-bit integers under a per-channel gain and offset — and so is the command:
 * the same epoch table, ten epochs for each of two outputs, rebuilt by `commandWaveform`.
 *
 * Three of pyABF's readings are kept because they are what a value is checked against: the rate is
 * truncated to whole hertz (`int(1e6 / interval / channels)`), the data start adds the ignored
 * points as bytes, and a channel is named by its physical slot through the sampling sequence.
 */
function readAbf1(buffer: ArrayBuffer): Recording {
  const view = new DataView(buffer)
  const at = {
    i16: (o: number) => view.getInt16(o, true),
    i32: (o: number) => view.getInt32(o, true),
    f32: (o: number) => view.getFloat32(o, true),
    text: (o: number, n: number) => fixedText(buffer, o, n),
  }
  if (buffer.byteLength < 6000) {
    throw new Error(
      'This ABF file is shorter than its header: it may have been cut off while copying.',
    )
  }
  const version = at.f32(4)
  const mode = at.i16(8)
  if (mode === 1) throw new Error(EVENT_DRIVEN)
  if (at.i16(100) !== 0) {
    throw new Error(
      'This ABF1 file stores its samples as floats, which pyABF does not read either.',
    )
  }
  const channelCount = at.i16(120)
  const interval = at.f32(122) // µs per sample, across every channel
  if (channelCount < 1) throw new Error('This ABF file records no channels.')
  if (!(interval > 0)) throw new Error('This ABF file does not say its sample rate.')
  const adcRange = at.f32(244)
  const adcResolution = at.i32(252)

  const channels: Signal[] = []
  const gain: number[] = []
  const offset: number[] = []
  for (let c = 0; c < channelCount; c++) {
    // The physical slot the c-th sampled channel is: names, units and gains are by slot.
    const slot = at.i16(410 + 2 * c)
    channels.push({ name: at.text(442 + 10 * slot, 10), unit: at.text(602 + 8 * slot, 8) })
    const scale = channelScale({
      instrument: at.f32(922 + 4 * slot),
      signalGain: at.f32(1050 + 4 * slot),
      programmable: at.f32(730 + 4 * slot),
      telegraph: at.i16(4512 + 2 * slot) === 1 ? at.f32(4576 + 4 * slot) : undefined,
      range: adcRange,
      resolution: adcResolution,
      instrumentOffset: at.f32(986 + 4 * slot),
      signalOffset: at.f32(1114 + 4 * slot),
    })
    gain.push(scale.gain)
    offset.push(scale.offset)
  }

  const points = at.i32(10)
  const start = at.i32(40) * BLOCK + at.i16(14)
  let sweeps = at.i32(16)
  if (mode === 3 || sweeps === 0) sweeps = 1
  const sweepSamples = Math.floor(points / sweeps / channelCount)
  if (start + points * 2 > buffer.byteLength) {
    throw new Error(
      'This ABF file is shorter than its header says: it may have been cut off while copying.',
    )
  }

  // Two outputs, ten epochs each; pyABF takes an output's holding level from `fEpochInitLevel`.
  const commands: Signal[] = []
  const waveforms: DacWaveform[] = []
  const notes: string[] = []
  for (let d = 0; d < 2; d++) {
    const enabled = at.i16(2296 + 2 * d) !== 0
    const source = at.i16(2300 + 2 * d)
    if (!enabled || source === 0) continue
    const name = at.text(1306 + 10 * d, 10)
    if (source !== 1) {
      notes.push(stimulusFileNote(name, d))
      continue
    }
    const epochs: Epoch[] = []
    for (let e = 10 * d; e < 10 * d + 10; e++) {
      const type = at.i16(2308 + 2 * e)
      if (type === EPOCH.off) continue
      epochs.push({
        type,
        level: at.f32(2348 + 4 * e),
        levelInc: at.f32(2428 + 4 * e),
        duration: at.i32(2508 + 4 * e),
        durationInc: at.i32(2588 + 4 * e),
        pulsePeriod: 0,
        pulseWidth: 0,
      })
    }
    commands.push({ name, unit: at.text(1346 + 8 * d, 8), origin: 'rebuilt' })
    waveforms.push({
      holding: holdingLevel(at.f32(2348 + 4 * d)),
      keepsLastLevel: at.i16(2304 + 2 * d) !== 0,
      epochs,
    })
  }

  const summary: RecordingSummary = {
    format: `ABF ${Number(version.toFixed(2))}`,
    protocol: protocolName(at.text(4898, 256)),
    startedAt: startedAt(at.i32(20), at.i32(24) * 1000 + at.i16(366)),
    rate: Math.trunc(1e6 / interval / channelCount),
    sweeps,
    sweepSamples,
    mode: mode === 3 ? 'gap-free' : 'episodic',
    channels,
    commands,
    notes,
  }
  return abfRecording({
    summary,
    channelCount,
    gain,
    offset,
    // Not a typed view: the data section may start an odd number of bytes in (the ignored points).
    sample: (i) => view.getInt16(start + 2 * i, true),
    waveforms,
  })
}

const EVENT_DRIVEN =
  'This ABF file was recorded in variable-length event-driven mode, whose sweeps differ in length; it is not read yet.'

/** An output whose waveform is played from a file of its own, said: either ABF version. */
function stimulusFileNote(name: string, output: number): string {
  return `The command on ${name || `output ${output}`} comes from a stimulus file, which is not in the recording, so it is not rebuilt.`
}

/**
 * pyABF's `_dataGain` and `_dataOffset` for one channel, in its order: the instrument scale, the
 * signal gain and the programmable gain divided out (and the telegraphed gain, where one is), then
 * the ADC's volts per count; the offset the instrument's less the signal's. Both ABF versions.
 */
function channelScale(c: {
  instrument: number
  signalGain: number
  programmable: number
  telegraph: number | undefined
  range: number
  resolution: number
  instrumentOffset: number
  signalOffset: number
}): { gain: number; offset: number } {
  let g = 1 / c.instrument / c.signalGain / c.programmable
  if (c.telegraph !== undefined) g /= c.telegraph
  return { gain: (g * c.range) / c.resolution, offset: c.instrumentOffset - c.signalOffset }
}

/**
 * An ABF file's recording, either version: samples interleaved across channels sweep after sweep,
 * `sample(i)` the i-th raw value, each channel scaled by its gain and offset, and the command
 * rebuilt from its epochs. Built here so its closures keep what they read and not the header.
 */
function abfRecording(r: {
  summary: RecordingSummary
  channelCount: number
  gain: readonly number[]
  offset: readonly number[]
  sample: (i: number) => number
  waveforms: readonly DacWaveform[]
}): Recording {
  const { summary, channelCount, gain, offset, sample, waveforms } = r
  const { sweepSamples } = summary
  return {
    summary,
    channel(channel, sweep, from = 0, to = sweepSamples) {
      const begin = Math.max(0, from)
      const out = new Float32Array(Math.max(0, Math.min(to, sweepSamples) - begin))
      const first = (sweep * sweepSamples + begin) * channelCount + channel
      const g = gain[channel]!
      const o = offset[channel]!
      for (let i = 0; i < out.length; i++) out[i] = sample(first + i * channelCount) * g + o
      return out
    },
    command(command, sweep, from = 0, to = sweepSamples) {
      return commandWaveform(waveforms[command]!, sweep, sweepSamples).subarray(from, to)
    },
  }
}

/** Bytes as text, `µ` (0xB5) read as `u` as pyABF reads it in ABF2. */
function latin1(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => (b === 0xb5 ? 'u' : String.fromCharCode(b))).join('')
}

/** A fixed-width text field: up to its first NUL, trimmed. */
function fixedText(buffer: ArrayBuffer, offset: number, length: number): string {
  const bytes = new Uint8Array(buffer, offset, Math.min(length, buffer.byteLength - offset))
  const end = bytes.indexOf(0)
  return latin1(bytes.subarray(0, end < 0 ? bytes.length : end)).trim()
}

/** pyABF's clean-up of a holding level that is uninitialised memory read as a float. */
function holdingLevel(level: number): number {
  if (Math.abs(level) > 1e6) return Number.NaN
  if (Math.abs(level) > 0 && Math.abs(level) < 1e-6) return 0
  return level
}

/** An output's epochs, in table order, the ones switched off left out. */
function epochsOf(view: DataView, section: Section, dacNum: number): Epoch[] {
  const epochs: Epoch[] = []
  for (let i = 0; i < section.count; i++) {
    const at = section.start + i * section.size
    if (view.getInt16(at + 2, true) !== dacNum) continue
    const type = view.getInt16(at + 4, true)
    if (type === EPOCH.off) continue
    epochs.push({
      type,
      level: view.getFloat32(at + 6, true),
      levelInc: view.getFloat32(at + 10, true),
      duration: view.getInt32(at + 14, true),
      durationInc: view.getInt32(at + 18, true),
      pulsePeriod: view.getInt32(at + 22, true),
      pulseWidth: view.getInt32(at + 26, true),
    })
  }
  return epochs
}

/**
 * The level a sweep's waveform ends on, after its last epoch, and the next one starts from: the
 * last epoch's level that sweep where the output keeps it, the holding level otherwise. A scalar,
 * so one sweep is built without building those before it.
 */
function closingLevel(waveform: DacWaveform, sweep: number): number {
  const last = waveform.epochs.at(-1)
  return waveform.keepsLastLevel && last ? last.level + last.levelInc * sweep : waveform.holding
}

/**
 * One sweep's command waveform, by pyABF's `getEpochWaveformsBySweep` and `getWaveform`: the
 * pre-epoch sixty-fourth at the opening level, the epochs with this sweep's increments, then the
 * closing level to the sweep's end.
 */
export function commandWaveform(
  waveform: DacWaveform,
  sweep: number,
  sweepSamples: number,
): Float32Array {
  const wave = new Float32Array(sweepSamples).fill(Number.NaN)
  const fill = (from: number, to: number, value: (i: number) => number) => {
    for (let i = Math.max(0, from); i < Math.min(to, sweepSamples); i++)
      wave[i] = value(i - from)
  }
  const opening = sweep === 0 ? waveform.holding : closingLevel(waveform, sweep - 1)
  const pre = Math.floor(sweepSamples / 64)
  fill(0, pre, () => opening)
  let position = pre
  let before = opening
  for (const epoch of waveform.epochs) {
    const duration = epoch.duration + epoch.durationInc * sweep
    const level = epoch.level + epoch.levelInc * sweep
    const length = Math.max(0, duration)
    fill(position, position + length, epochShape(epoch, length, before, level))
    position += duration
    before = level
  }
  const closing = closingLevel(waveform, sweep)
  fill(position, sweepSamples, () => closing)
  return wave
}

/** One epoch's samples from its start, as `getWaveform` draws its type. */
function epochShape(
  epoch: Epoch,
  length: number,
  before: number,
  level: number,
): (i: number) => number {
  const { pulsePeriod: period, pulseWidth: width } = epoch
  const pulses = period > 0 ? Math.floor(length / period) : 0
  const delta = level - before
  // Whether sample `i` is inside one of the epoch's pulses, and where in it.
  const inPulse = (i: number) => {
    const k = period > 0 ? Math.floor(i / period) : -1
    return k >= 0 && k < pulses ? i - k * period : -1
  }
  switch (epoch.type) {
    case EPOCH.step:
      return () => level
    case EPOCH.ramp:
      // `np.linspace(before, level, length)`: both ends included.
      return (i) => (length > 1 ? before + (delta * i) / (length - 1) : before)
    case EPOCH.pulse:
      return (i) => {
        const at = inPulse(i)
        return at >= 0 && at < width ? level : before
      }
    case EPOCH.triangle:
      return (i) => {
        const at = inPulse(i)
        if (at < 0) return Number.NaN
        // Up over the width, back down over the rest of the period, each a `linspace`.
        if (at < width) return width > 1 ? before + (delta * at) / (width - 1) : before
        const down = period - width
        return down > 1 ? level - (delta * (at - width)) / (down - 1) : level
      }
    case EPOCH.cosine:
      return (i) => {
        const phase = (length > 1 ? (2 * pulses * Math.PI * i) / (length - 1) : 0) + Math.PI
        return before + (Math.cos(phase) * delta) / 2 + delta / 2
      }
    case EPOCH.biphasic:
      return (i) => {
        const at = inPulse(i)
        if (at < 0 || at >= width) return before
        return at < Math.floor(width / 2) ? before + delta : before - delta
      }
    default:
      return () => Number.NaN
  }
}

/**
 * The strings section's indexed strings: the first block, from its last double NUL, split on NUL,
 * the leading empty one dropped. `µ` (0xB5) is read as `u`, as pyABF does.
 */
function indexedStrings(buffer: ArrayBuffer, section: Section): string[] {
  if (section.count < 1 || section.size < 1) return []
  const raw = new Uint8Array(
    buffer,
    section.start,
    Math.min(section.size, buffer.byteLength - section.start),
  )
  let from = -1
  for (let i = raw.length - 2; i >= 0; i--) {
    if (raw[i] === 0 && raw[i + 1] === 0) {
      from = i
      break
    }
  }
  if (from < 0) return []
  return latin1(raw.subarray(from))
    .split('\u0000')
    .slice(1)
    .map((s) => s.trim())
}

/** `C:\…\Iclampstep_MBON.pro` → `Iclampstep_MBON`: the protocol's name, not the rig's paths. */
function protocolName(path: string): string {
  const base = path.split(/[\\/]/).at(-1) ?? ''
  return base.replace(/\.pro$/i, '')
}

/** The header's `yyyymmdd` date and milliseconds since midnight, as ISO 8601. */
function startedAt(date: number, ms: number): string | undefined {
  const y = Math.floor(date / 10000)
  const m = Math.floor(date / 100) % 100
  const d = date % 100
  if (y < 1980 || m < 1 || m > 12 || d < 1 || d > 31) return undefined
  const at = new Date(Date.UTC(y, m - 1, d) + ms)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString().replace('Z', '')
}
