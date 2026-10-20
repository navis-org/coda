/**
 * Electrophysiology recordings: one shape every file format is read into, and the readers.
 *
 * **A format is a reader, not a node.** `Load Recording` asks `readRecording` for whatever the file
 * is, and each reader fills the same `Recording`: sweeps of equal length, recorded channels and
 * command outputs each with a name and a unit, and a sample rate. ABF is the first; HEKA
 * PatchMaster and NWB would each be another entry in `READERS` and nothing else — no new node, no
 * graph migration, no second set of channel and window controls.
 *
 * **The file is sniffed, then named.** A reader answers for the bytes (`sniff`, a signature)
 * before the extension is consulted, because a renamed file is still the format it is; the
 * extension is only used to say what a file that no reader recognises was probably meant to be.
 *
 * Headless and synchronous: it reads an `ArrayBuffer` already in memory. The card reads the file
 * and the summary; the node reads the samples.
 */

import { getRecordingUpload, uploadMissingReason } from '../uploads'
import { CRASH_FLOOR_BYTES } from '../../core/limits'
import { memoPromise } from '../memoPromise'
import { ABF_READER } from './abf'
import { NWB_READER } from './nwb'

/** A recorded channel or a command output: what it is called and the unit it is in. */
export interface Signal {
  readonly name: string
  readonly unit: string
  /** A command's: rebuilt from the protocol (ABF's epoch table) or stored as samples (NWB). */
  readonly origin?: 'rebuilt' | 'stored'
}

/**
 * What a recording is, without its samples: everything the card shows and the node's controls
 * offer. Plain data, so it is stored beside the file and peeked synchronously.
 */
export interface RecordingSummary {
  /** The format and its version, as a reader names it: "ABF 2.6". */
  readonly format: string
  /** The acquisition protocol's name, if the file records one. */
  readonly protocol: string
  /** When the recording started, ISO 8601, if the file says. */
  readonly startedAt?: string | undefined
  /** Samples a second, per channel. */
  readonly rate: number
  readonly sweeps: number
  /** Samples in one sweep, per channel. */
  readonly sweepSamples: number
  /** Sweeps triggered by a protocol, or one continuous stretch. */
  readonly mode: 'episodic' | 'gap-free'
  readonly channels: readonly Signal[]
  /** Command outputs whose waveform the file describes, so it can be rebuilt. */
  readonly commands: readonly Signal[]
  /** What the reader could not do, said once: a command from a stimulus file, say. */
  readonly notes: readonly string[]
  /**
   * The file's own number for each sweep (NWB's `sweep_number`), the table's `sweep` column and
   * what Sweeps is read against; absent, sweeps are counted from 1.
   */
  readonly sweepNumbers?: readonly number[]
  /**
   * Every group of a file holding several — an NWB file's protocols, each a summary of its own,
   * named by `protocol` — the first of which this summary is. Load Recording reads one at a time.
   */
  readonly protocols?: readonly RecordingSummary[]
}

/** The summary of `protocol` in a file's summary: that group's, or the file's first where none is named. */
export function protocolSummary(
  summary: RecordingSummary,
  protocol: string | undefined,
): RecordingSummary | undefined {
  if (!protocol) return summary
  return summary.protocols?.find((s) => s.protocol === protocol)
}

export interface Recording {
  readonly summary: RecordingSummary
  /**
   * Channel `channel`'s samples in sweep `sweep` (both from 0), in the channel's unit: samples
   * `from` up to `to`, the whole sweep by default — so a short window of a long gap-free file
   * decodes only the window.
   */
  channel(channel: number, sweep: number, from?: number, to?: number): Float32Array
  /** Command `command`'s waveform in sweep `sweep`, in its unit, `from` up to `to` as `channel`'s; NaN where it is not defined. */
  command(command: number, sweep: number, from?: number, to?: number): Float32Array
  /**
   * Bytes it holds once read, where that is not its file's: an NWB group decodes its own sweeps
   * and keeps nothing else. What the stored-recording budget charges; the file's size otherwise.
   */
  readonly heldBytes?: number
}

/** One file format. */
export interface RecordingReader {
  /** What the format is called in a sentence: "ABF". */
  readonly label: string
  /** Extensions it is usually saved under, lower case with the dot. */
  readonly extensions: readonly string[]
  /** Whether these bytes are this format: a signature, never the extension. */
  sniff(bytes: Uint8Array): boolean
  /**
   * Read the file — group `protocol` of a file holding several, the first by default; throws a
   * sentence naming what it cannot read. Asynchronous, for a reader that loads a library to do it.
   */
  read(buffer: ArrayBuffer, protocol?: string): Recording | Promise<Recording>
}

/**
 * Every format this build reads. A new one is an entry here.
 *
 * A limit recorded rather than built for: `sniff` sees the first 64 bytes, where an HDF5 file with
 * a user block keeps its signature at 512 or later; no NWB writer measured here adds one.
 */
const READERS: readonly RecordingReader[] = [ABF_READER, NWB_READER]

/** The file picker's `accept`: every reader's extensions. */
export const RECORDING_EXTENSIONS: string = READERS.flatMap((r) => r.extensions).join(',')

/** "ABF", or "ABF or NWB": what this build reads, for a refusal. */
function formatsRead(): string {
  const labels = READERS.map((r) => r.label)
  return labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)!}`
    : labels[0]!
}

/** Read a recording of any format this build knows, chosen by its bytes; `protocol` as `RecordingReader.read`. */
export async function readRecording(
  buffer: ArrayBuffer,
  fileName: string,
  protocol?: string,
): Promise<Recording> {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 64))
  const reader = READERS.find((r) => r.sniff(head))
  if (reader) return reader.read(buffer, protocol)
  const ext = /\.[^.]+$/.exec(fileName.toLowerCase())?.[0]
  const claimed = READERS.find((r) => ext !== undefined && r.extensions.includes(ext))
  throw new Error(
    claimed
      ? `"${fileName}" is named like ${claimed.label} but is not one this reader recognises: it may be damaged, or another format renamed.`
      : `"${fileName}" is not a recording format this build reads. It reads ${formatsRead()} (${RECORDING_EXTENSIONS}).`,
  )
}

/**
 * Stored recordings, read and parsed once each: Load Recording is `cheap` and re-runs on every
 * edit of its controls, and without this each keystroke in Sweeps read the whole file back out of
 * IndexedDB and parsed it again. Overlapping runs share one read (`memoPromise`).
 *
 * **Bounded by bytes, a read counting as a use** — `lruMap.ts`' byte-budgeted, read-promoting
 * shape, the third such cache: a parsed recording holds its whole file (its samples are views on
 * it), so a count would let four gap-free files near the crash floor. Within `KEPT_BYTES` a
 * recording and its control on one canvas do not evict each other; past it the least recently
 * asked for go first, the newest always kept. Map order is the recency.
 */
const stored = new Map<string, Promise<Recording>>()
/** Each kept recording's file size, once read; what the budget is spent on. */
const sizes = new Map<string, number>()
const KEPT_BYTES = CRASH_FLOOR_BYTES / 4

/** Move `id` to the newest end: asked for now. */
function promote(id: string): void {
  const hit = stored.get(id)
  if (!hit) return
  stored.delete(id)
  stored.set(id, hit)
}

/** Record a recording's size and let the oldest go until the rest fit, keeping the newest. */
function keep(id: string, bytes: number): void {
  sizes.set(id, bytes)
  let total = 0
  for (const key of stored.keys()) total += sizes.get(key) ?? 0
  const newest = [...stored.keys()].at(-1)
  for (const key of [...stored.keys()]) {
    if (total <= KEPT_BYTES || key === newest) break
    total -= sizes.get(key) ?? 0
    stored.delete(key)
    sizes.delete(key)
  }
}

/**
 * A recording the card has just parsed, kept for the node's first run: the card reads the file to
 * check it before storing it, and handing over what it read saves the run reading it back.
 */
export function rememberRecording(id: string, recording: Recording, bytes: number): void {
  // Under the group it is, by name where the file has several: what the card then picks.
  const { summary } = recording
  const key = keyOf(id, summary.protocols ? summary.protocol : undefined)
  const promise = Promise.resolve(recording)
  stored.delete(key)
  stored.set(key, promise)
  keep(key, recording.heldBytes ?? bytes)
  // The file's first group is also what no protocol names (a node saved before the picker), so it
  // is found under that key too — charged once, under its name.
  const first = keyOf(id, undefined)
  if (first !== key) {
    stored.delete(first)
    stored.set(first, promise)
    keep(first, 0)
  }
}

/**
 * A stored recording read as one of its groups: each group is a recording of its own, kept apart.
 * No protocol, or `''`, is the file's first.
 */
function keyOf(id: string, protocol: string | undefined): string {
  return `${id}\u0000${protocol ?? ''}`
}

export function storedRecording(
  id: string,
  fileName: string,
  /** The group of a file holding several (`RecordingSummary.protocols`); its first by default. */
  protocol?: string,
): Promise<Recording> {
  const key = keyOf(id, protocol)
  promote(key)
  return memoPromise(
    stored,
    key,
    async () => {
      const bytes = await getRecordingUpload(id)
      if (!bytes) throw new Error(uploadMissingReason(fileName, 'recording', 'node'))
      const size = bytes.byteLength
      const recording = await readRecording(bytes, fileName, protocol || undefined)
      keep(key, recording.heldBytes ?? size)
      return recording
    },
    { keep: 'resolved' },
  )
}
