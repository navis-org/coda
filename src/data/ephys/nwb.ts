/**
 * NWB 2 intracellular recordings (Neurodata Without Borders): what DANDI and the Allen Cell Types
 * database publish, read through h5wasm — HDF5 compiled to WebAssembly, imported only when an NWB
 * file is opened, so neither the main chunk nor the MCP bundle carries it.
 *
 * ## The file
 *
 * Every sweep is a pair of series: a response under `/acquisition` (`CurrentClampSeries`,
 * `IZeroClampSeries`, `VoltageClampSeries`) and the stimulus that drove it under
 * `/stimulus/presentation` (`CurrentClampStimulusSeries`, `VoltageClampStimulusSeries`), each with
 * its samples (`data`, times `conversion` plus `offset` into volts or amperes), its rate
 * (`starting_time`'s `rate`) and a link to its electrode. Read here in mV and pA, an ABF file's
 * units, so a recording's table reads the same whichever format it came from.
 *
 * ## Which sweeps belong together
 *
 * **A file holds many protocols** — an Allen file thirteen, from 7,650 to 980,000 samples a sweep at
 * 50 and 200 kHz, current and voltage clamp mixed — and a `Recording` is sweeps of one length at
 * one rate. So the file is read as **groups**: the sweeps sharing a clamp mode, a rate and a length,
 * each named by the protocol its sweeps share (`stimulus_description`), or by its shape where they
 * share none. Not by the description alone: a writer may give every sweep a description of its own,
 * fourteen one-sweep protocols of what is one. Load Recording picks a group (`protocol`).
 *
 * **A response and its stimulus are paired by sweep number and electrode**, the series' own
 * `sweep_number`. A file numbering no sweeps — allowed since NWB 2.4, whose tables say the
 * pairing instead — is paired in the order the file lists its series, and that is said. A start
 * time cannot pair them: writers leave every series at 0.
 *
 * Not read: NWB 1 (the Allen Cell Types database's older files), the 2.4 icephys tables'
 * repetitions and conditions, and extracellular data.
 */

import { h5wasm } from '../libraries'
import type { Recording, RecordingReader, RecordingSummary, Signal } from './recording'

/** HDF5's signature, at the start of a file with no user block. */
const HDF5 = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]

const RESPONSES = new Set(['CurrentClampSeries', 'IZeroClampSeries', 'VoltageClampSeries'])
const STIMULI = new Set(['CurrentClampStimulusSeries', 'VoltageClampStimulusSeries'])

/** SI into the table's units: volts into mV, amperes into pA. */
const INTO = {
  volts: { unit: 'mV', scale: 1e3 },
  amperes: { unit: 'pA', scale: 1e12 },
} as const satisfies Record<string, { unit: string; scale: number }>

/**
 * The largest value a trace can plausibly reach, per unit: past either end no cell has it, and the
 * file's conversion factor is suspect. A trace of zeros is no claim and passes.
 */
const PLAUSIBLE: Record<string, readonly [number, number]> = {
  mV: [1e-3, 1e4],
  pA: [1e-4, 1e6],
}

/** What a converter writes where the file has no description: no protocol named at all. */
const PLACEHOLDER = /^(n\/?a|none|no description|unknown)?$/i

/** How each response type is clamped, in the words a group with no protocol name is called by. */
const CLAMP: Record<string, string> = {
  CurrentClampSeries: 'current clamp',
  IZeroClampSeries: 'I = 0',
  VoltageClampSeries: 'voltage clamp',
}

export const NWB_READER: RecordingReader = {
  label: 'NWB',
  extensions: ['.nwb'],
  sniff: (bytes) => HDF5.every((b, i) => bytes[i] === b),
  read: readNwb,
}

/** One series as the file lists it: what it is, and where its samples are. */
interface Series {
  readonly path: string
  readonly role: 'response' | 'stimulus'
  readonly type: string
  readonly description: string
  readonly sweep: number | undefined
  readonly electrode: string
  /** `volts`, `amperes`, or what else the file says. */
  readonly unit: string
  readonly conversion: number
  readonly offset: number
  readonly rate: number
  readonly length: number
}

/** A group's identity: the sweeps that can be one `Recording`, one electrode's. */
function shapeKey(s: Series): string {
  return `${s.electrode}\u0000${s.type}\u0000${s.unit}\u0000${s.rate}\u0000${s.length}`
}

/** A response and the stimulus that drove it: the same sweep on the same electrode. */
function pairKey(s: Pick<Series, 'electrode'> & { sweep: number }): string {
  return `${s.sweep}\u0000${s.electrode}`
}

/** One sweep of a group: its number, its response and, where the file has it, its stimulus. */
interface Entry {
  readonly sweep: number
  readonly response: Series
  readonly stimulus: Series | undefined
}

async function readNwb(buffer: ArrayBuffer, protocol?: string): Promise<Recording> {
  const { library: h5, fs: FS } = await h5wasm()
  // A file of its own on the in-memory file system, kept open while the recording read from it
  // lives (`OPEN`). h5wasm's file system copies the buffer in (its build offers no way to adopt it),
  // so a file is held twice for the length of a read and once after.
  const path = `/nwb-${Math.random().toString(36).slice(2)}.nwb`
  FS.writeFile(path, new Uint8Array(buffer))
  let file: H5File | undefined
  // Whether the file outlives the read, a recording reading from it.
  let kept = false
  try {
    file = new h5.File(path, 'r')
    const f = file
    const attr = (at: string, name: string): unknown =>
      (f.get(at) as { attrs?: Record<string, { value: unknown }> } | null)?.attrs?.[name]?.value
    const text = (v: unknown) => (typeof v === 'string' ? v : '')
    const num = (v: unknown, otherwise: number) => {
      const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number.NaN
      return Number.isFinite(n) ? n : otherwise
    }
    const listed = (role: Series['role'], at: string): Series[] => {
      const group = f.get(at)
      if (!group || !('keys' in group)) return []
      return (group as { keys(): string[] }).keys().flatMap((name): Series[] => {
        const p = `${at}/${name}`
        const type = text(attr(p, 'neurodata_type'))
        if (!(role === 'response' ? RESPONSES : STIMULI).has(type)) return []
        const data = f.get(`${p}/data`) as { shape: number[] } | null
        if (!data) return []
        const sweep = attr(p, 'sweep_number')
        const description = text(attr(p, 'stimulus_description')).trim()
        return [
          {
            path: p,
            role,
            type,
            description: PLACEHOLDER.test(description) ? '' : description,
            sweep: sweep === undefined ? undefined : num(sweep, Number.NaN),
            electrode: (f.get_link(`${p}/electrode`) ?? '').split('/').at(-1) ?? '',
            unit: text(attr(`${p}/data`, 'unit')),
            conversion: num(attr(`${p}/data`, 'conversion'), 1),
            offset: num(attr(`${p}/data`, 'offset'), 0),
            rate: num(attr(`${p}/starting_time`, 'rate'), Number.NaN),
            length: data.shape[0] ?? 0,
          },
        ]
      })
    }
    const all = listed('response', 'acquisition')
    let stimuli = listed('stimulus', 'stimulus/presentation')
    if (all.length === 0) {
      throw new Error(
        'This NWB file holds no intracellular recordings: no current- or voltage-clamp series under /acquisition.',
      )
    }
    // The file's notes, every group's.
    const notes: string[] = []
    // A series timed by `timestamps` has no rate: set aside and counted, never a table of NaN times.
    const timed = (s: Series) => s.rate > 0
    let responses = all.filter(timed)
    if (responses.length < all.length) {
      const n = all.length - responses.length
      if (responses.length === 0) {
        throw new Error(
          'This NWB file times its recordings by timestamps rather than a sample rate, which is not read.',
        )
      }
      notes.push(
        `${n} recording${n === 1 ? ' is' : 's are'} timed by timestamps rather than a sample rate, which is not read, and ${n === 1 ? 'is' : 'are'} left out.`,
      )
    }
    stimuli = stimuli.filter(timed)
    // Sweep numbers where every series has a readable one. Otherwise responses pair with stimuli in
    // the order the file lists them — only where the two lists are as long, one missing stimulus
    // shifting every pairing after it — and a group's sweeps are counted from 1.
    const numbered = [...responses, ...stimuli].every((s) => Number.isFinite(s.sweep))
    if (!numbered) {
      const paired = responses.length === stimuli.length
      notes.push(
        paired
          ? 'This file numbers no sweeps, so each response is paired with a stimulus in the order the file lists them.'
          : `This file numbers no sweeps and lists ${responses.length} responses against ${stimuli.length} stimuli, so no stimulus can be paired with its response and there is no command.`,
      )
      responses = responses.map((s, i) => ({ ...s, sweep: i }))
      stimuli = paired ? stimuli.map((s, i) => ({ ...s, sweep: i })) : []
    }
    const stimulusFor = new Map(stimuli.map((s) => [pairKey({ ...s, sweep: s.sweep! }), s]))

    // Groups in the order their first sweep appears, sweeps in number order within each. A
    // stimulus is a sweep's only where it is sampled as its response is: indexed by the response's
    // samples, another rate or length would draw the command shifted against the voltage.
    const byShape = new Map<string, Entry[]>()
    let mismatched = 0
    for (const response of responses) {
      const sweep = response.sweep!
      const found = stimulusFor.get(pairKey({ ...response, sweep }))
      const fits = found && found.rate === response.rate && found.length === response.length
      if (found && !fits) mismatched++
      const entry = { sweep, response, stimulus: fits ? found : undefined }
      const list = byShape.get(shapeKey(response))
      if (list) list.push(entry)
      else byShape.set(shapeKey(response), [entry])
    }
    if (mismatched > 0) {
      notes.push(
        `${mismatched} stimul${mismatched === 1 ? 'us is' : 'i are'} sampled at another rate or length than ${mismatched === 1 ? 'its response' : 'their responses'}, so ${mismatched === 1 ? 'that sweep has' : 'those sweeps have'} no command.`,
      )
    }
    const groups = [...byShape.values()].map((entries) =>
      entries.sort((a, b) => a.sweep - b.sweep),
    )
    const shared = {
      format: `NWB ${text(attr('/', 'nwb_version'))}`.trim(),
      startedAt: text((f.get('session_start_time') as { value?: unknown } | null)?.value),
      notes,
    }
    const electrodes = new Set(responses.map((s) => s.electrode)).size > 1
    const protocols = named(
      groups.map((entries) => groupSummary(entries, shared, numbered)),
      electrodes,
    )
    const chosen = protocol ? protocols.findIndex((s) => s.protocol === protocol) : 0
    if (chosen < 0) {
      throw new Error(
        `This file has no protocol called "${protocol}". Pick one again on the card.`,
      )
    }
    const recording = sweepsOf(f, groups[chosen]!, protocols[chosen]!, protocols)
    // The file stays open for the recording's reads, each a window; closed when it is collected.
    OPEN.register(recording, { file: f, path, unlink: (at: string) => FS.unlink(at) })
    kept = true
    return { ...recording, heldBytes: buffer.byteLength }
  } finally {
    if (!kept) {
      file?.close()
      FS.unlink(path)
    }
  }
}

type H5File = InstanceType<Awaited<ReturnType<typeof h5wasm>>['library']['File']>

/** An open file a recording reads from, closed and removed once the recording is collected. */
const OPEN = new FinalizationRegistry<{
  file: H5File
  path: string
  unlink: (path: string) => void
}>(({ file, path, unlink }) => {
  file.close()
  unlink(path)
})

/**
 * The chosen group as a recording that reads each window from the open file when asked — a sweep
 * is decoded only as far as Sweeps and Crop reach, after Load Recording has checked the size — and
 * its summary, with what the first sweep says about the file's conversion. Built here so its
 * closures keep the file and this group's series, nothing else of the read.
 */
function sweepsOf(
  f: H5File,
  entries: readonly Entry[],
  group: RecordingSummary,
  protocols: readonly RecordingSummary[],
): Recording {
  const length = group.sweepSamples
  const read = (s: Series | undefined, from = 0, to = length) => {
    const begin = Math.max(0, from)
    const end = Math.min(length, to)
    if (!s) return new Float32Array(Math.max(0, end - begin)).fill(Number.NaN)
    return end > begin ? scaled(f, s, begin, end) : new Float32Array(0)
  }
  const first = entries[0]!
  return {
    summary: {
      ...group,
      notes: [
        ...group.notes,
        ...plausibility(group.channels[0], read(first.response)),
        ...plausibility(group.commands[0], read(first.stimulus)),
      ],
      protocols: protocols.length > 1 ? protocols : undefined,
    },
    channel: (_channel, sweep, from, to) => read(entries[sweep]!.response, from, to),
    command: (_command, sweep, from, to) => read(entries[sweep]!.stimulus, from, to),
  }
}

/**
 * A group's summary, unnamed but for the protocol its sweeps share: its shape, its one channel and
 * command, its sweep numbers, and the file's own format, start and notes.
 */
function groupSummary(
  entries: readonly Entry[],
  shared: Pick<RecordingSummary, 'format' | 'startedAt' | 'notes'>,
  /** Whether the file numbers its sweeps: if not, a group's are counted from 1. */
  numbered: boolean,
): RecordingSummary & { readonly shape: string; readonly electrode: string } {
  const first = entries[0]!.response
  const descriptions = new Set(entries.map((e) => e.response.description).filter(Boolean))
  const stimulus = entries.find((e) => e.stimulus)?.stimulus
  const into = (s: Series) => INTO[s.unit as keyof typeof INTO]?.unit ?? s.unit
  const notes = INTO[first.unit as keyof typeof INTO]
    ? shared.notes
    : [...shared.notes, `A series is in ${first.unit || 'no unit'}, which is read as stored.`]
  return {
    ...shared,
    notes,
    protocol: descriptions.size === 1 ? [...descriptions][0]! : '',
    rate: first.rate,
    sweeps: entries.length,
    sweepSamples: first.length,
    mode: 'episodic',
    channels: [{ name: first.unit === 'amperes' ? 'Im' : 'Vm', unit: into(first) }],
    commands: stimulus
      ? [
          {
            name: stimulus.unit === 'volts' ? 'Vcmd' : 'Icmd',
            unit: into(stimulus),
            origin: 'stored',
          },
        ]
      : [],
    sweepNumbers: numbered ? entries.map((e) => e.sweep) : undefined,
    shape: shapeWords(CLAMP[first.type] ?? first.type, first),
    electrode: first.electrode,
  }
}

/**
 * Every group named, in one pass: by the protocol its sweeps share or else by its shape, the
 * electrode's name in front where the file has several, and two groups of one name told apart by
 * their shape.
 */
function named(
  groups: readonly (RecordingSummary & { shape: string; electrode: string })[],
  electrodes: boolean,
): RecordingSummary[] {
  const base = groups.map((g) => {
    const name = g.protocol || g.shape
    return electrodes ? `${g.electrode}: ${name}` : name
  })
  const count = new Map<string, number>()
  for (const name of base) count.set(name, (count.get(name) ?? 0) + 1)
  const described = groups.map(({ shape }, i) =>
    count.get(base[i]!)! > 1 && groups[i]!.protocol ? `${base[i]} (${shape})` : base[i]!,
  )
  // Whatever still repeats — shapes rounding to one wording — is numbered: a name picks one group.
  const taken = new Set<string>()
  return groups.map(({ shape: _shape, electrode: _electrode, ...g }, i) => {
    let name = described[i]!
    for (let n = 2; taken.has(name); n++) name = `${described[i]} (${n})`
    taken.add(name)
    return { ...g, protocol: name }
  })
}

/** "current clamp, 1.3 s at 25 kHz": a group by its shape; how many sweeps is the picker's to say. */
function shapeWords(clamp: string, s: Pick<Series, 'length' | 'rate'>): string {
  const seconds = s.length / s.rate
  const rate = s.rate >= 1000 ? `${s.rate / 1000} kHz` : `${s.rate} Hz`
  return `${clamp}, ${Number(seconds.toPrecision(3))} s at ${rate}`
}

/**
 * Samples `from` up to `to` of a series in the table's unit: stored × conversion + offset, then into
 * mV or pA. Read as a slice, so only the window is decoded.
 */
function scaled(f: H5File, s: Series, from: number, to: number): Float32Array {
  const data = f.get(`${s.path}/data`) as {
    slice(ranges: [number, number][]): ArrayLike<number | bigint>
  }
  const raw = data.slice([[from, to]])
  const factor = s.conversion * (INTO[s.unit as keyof typeof INTO]?.scale ?? 1)
  const shift = s.offset * (INTO[s.unit as keyof typeof INTO]?.scale ?? 1)
  const out = new Float32Array(raw.length)
  // A 64-bit integer dataset arrives as BigInt; everything else indexes as plain numbers.
  if (raw instanceof BigInt64Array || raw instanceof BigUint64Array) {
    for (let i = 0; i < raw.length; i++) out[i] = Number(raw[i]) * factor + shift
  } else {
    const values = raw as ArrayLike<number>
    for (let i = 0; i < values.length; i++) out[i] = values[i]! * factor + shift
  }
  return out
}

/**
 * A trace whose values no cell has, said: a converter that wrote a recording's mV under a conversion
 * meant for pA leaves every value a billion times too small, and one that wrote pA as amperes a
 * trillion times too large — each reads as a flat or absurd trace rather than as the file's mistake.
 */
function plausibility(signal: Signal | undefined, trace: Float32Array): string[] {
  const bounds = signal && PLAUSIBLE[signal.unit]
  if (!bounds) return []
  let largest = 0
  // One sweep, at a stride: enough to tell a factor of a thousand from none.
  for (let i = 0; i < trace.length; i += 97) {
    if (Number.isFinite(trace[i]!)) largest = Math.max(largest, Math.abs(trace[i]!))
  }
  if (largest === 0 || (largest >= bounds[0] && largest <= bounds[1])) return []
  return [
    `${signal.name} reads ${largest.toPrecision(2)} ${signal.unit} at most, which no cell gives: the file's conversion factor is likely wrong, so every value of it is off by that factor. Whoever converted the file can correct it.`,
  ]
}
