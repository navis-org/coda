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

/** A recorded channel or a command output: what it is called and the unit it is in. */
export interface Signal {
  readonly name: string
  readonly unit: string
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
}

/** One file format. */
export interface RecordingReader {
  /** What the format is called in a sentence: "ABF". */
  readonly label: string
  /** Extensions it is usually saved under, lower case with the dot. */
  readonly extensions: readonly string[]
  /** Whether these bytes are this format: a signature, never the extension. */
  sniff(bytes: Uint8Array): boolean
  /** Read the file; throws a sentence naming what it cannot read. */
  read(buffer: ArrayBuffer): Recording
}

/**
 * Every format this build reads. A new one is an entry here.
 *
 * Two limits a later reader may hit, recorded rather than built for: `read` is synchronous over a
 * file held whole in memory (an NWB reader, HDF5 through a WebAssembly library, is likely to want
 * an asynchronous and ranged read, and files of gigabytes); and `sniff` sees the first 64 bytes,
 * where an HDF5 file with a user block keeps its signature at 512 or later.
 */
const READERS: readonly RecordingReader[] = [ABF_READER]

/** The file picker's `accept`: every reader's extensions. */
export const RECORDING_EXTENSIONS: string = READERS.flatMap((r) => r.extensions).join(',')

/** "ABF", or "ABF or NWB": what this build reads, for a refusal. */
function formatsRead(): string {
  const labels = READERS.map((r) => r.label)
  return labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)!}`
    : labels[0]!
}

/** Read a recording of any format this build knows, chosen by its bytes. */
export function readRecording(buffer: ArrayBuffer, fileName: string): Recording {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 64))
  const reader = READERS.find((r) => r.sniff(head))
  if (reader) return reader.read(buffer)
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
  stored.delete(id)
  stored.set(id, Promise.resolve(recording))
  keep(id, bytes)
}

export function storedRecording(id: string, fileName: string): Promise<Recording> {
  promote(id)
  return memoPromise(
    stored,
    id,
    async () => {
      const bytes = await getRecordingUpload(id)
      if (!bytes) throw new Error(uploadMissingReason(fileName, 'recording', 'node'))
      const recording = readRecording(bytes, fileName)
      keep(id, bytes.byteLength)
      return recording
    },
    { keep: 'resolved' },
  )
}
