/**
 * Load Recording: an electrophysiology recording of your own, as a long table of its sweeps.
 *
 * **One node for every format.** The reader is chosen by the file (`data/ephys/recording.ts`);
 * ABF is the first, and a later format is a reader there, not a node here — so a workflow built on
 * this node reads an NWB file the day there is a reader for one, with nothing migrated.
 *
 * **The file, not a table, is stored** (`putRecordingUpload`), and read on every run: what comes
 * out depends on the channel, sweep and window controls, and keeping the file means changing them
 * re-runs this node rather than asking for the file again. The summary beside it is what inference
 * and the controls read, synchronously (`peekRecordingUpload`) — Upload Table's peek, for the same
 * reason. And Upload Table's cost, too: **a workflow sent to somebody arrives without the file**.
 *
 * `cheap`: no network, and a few megabytes of samples is milliseconds; a recording big enough to
 * matter is refused at the crash floor with the controls that shrink it named.
 */

import type { InferContext, ParamValues } from '../../core/node'
import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import { storedRecording } from '../../data/ephys/recording'
import { peekRecordingUpload, uploadMissingBadge, uploadPeekSettled } from '../../data/uploads'
import {
  cropped,
  readRecordingPick,
  recordingColumns,
  recordingPickIssues,
  recordingSchema,
  recordingTable,
} from './recordingOps'

const NO_FILE = 'No file chosen. Use the button on the node to pick a recording.'

/** The summary of the recording the node names, if this session knows it yet. */
const summaryOf = (p: ParamValues) => peekRecordingUpload(String(p.dataId))?.summary

export const loadRecordingNode = packNode({
  type: 'biophys:loadRecording',
  label: 'Load Recording',
  category: 'utility',
  cardWidth: 300,
  description:
    'Load an electrophysiology recording (ABF) as a table of its sweeps: time, sweep, a column per channel and the stimulus.',
  guide:
    'Brings in a patch-clamp recording of your own, such as an ABF file from Clampex, as one long ' +
    'table: time in ms, the sweep, a column per channel, and the command rebuilt from the ' +
    'protocol. Pick channels and sweeps, crop and downsample here; Combine Traces lines it up ' +
    'with a simulation. The file stays in this browser, so a colleague has to pick it again.',
  cost: 'cheap',
  inputs: [],
  outputs: [{ id: 'out', label: 'Traces', type: T.table() }],
  params: [
    // Written by the card, never typed: Upload Table's pair, for its reasons.
    { id: 'dataId', kind: 'string', label: 'Data', default: '', advanced: true },
    {
      id: 'fileName',
      kind: 'string',
      label: 'File',
      default: '',
      advanced: true,
      presentational: true,
      browserStored: 'an uploaded recording',
    },
    {
      id: 'channels',
      kind: 'multiEnum',
      label: 'Channels',
      default: [],
      noun: 'channel',
      emptyLabel: 'every channel',
      // The recording's own columns, read from the stored summary: an IndexedDB peek, no fetch.
      options: (ctx: InferContext) => {
        const summary = summaryOf(ctx.params)
        return summary
          ? recordingColumns(summary).map((c) => ({
              value: c.name,
              label: c.unit ? `${c.name} (${c.unit})` : c.name,
            }))
          : []
      },
      // The browser's own upload shelf, as Upload Table's pickers read it: no source listing.
      optionsWithoutPeek: true,
      help: 'Which recorded channels and rebuilt commands become columns. None picked is every one.',
    },
    {
      id: 'sweeps',
      kind: 'string',
      label: 'Sweeps',
      default: '',
      placeholder: 'all, or e.g. 1-3, 7',
      help: 'Which sweeps, counted from 1 as Clampex counts them: single sweeps and ranges, such as `1-3, 7`. Empty is every sweep.',
    },
    {
      id: 'crop',
      kind: 'boolean',
      label: 'Crop',
      default: false,
      help: 'Keep only a window of each sweep.',
    },
    {
      id: 'windowStart',
      kind: 'number',
      label: 'From (ms)',
      default: 0,
      min: 0,
      visibleIf: cropped,
    },
    {
      id: 'windowEnd',
      kind: 'number',
      label: 'To (ms)',
      default: 1000,
      min: 0,
      visibleIf: cropped,
      help: 'The window keeps samples from From up to, not including, To.',
    },
    {
      id: 'rezero',
      kind: 'boolean',
      label: 'Start at 0',
      default: false,
      visibleIf: cropped,
      help: 'Count time from the window’s start rather than the sweep’s.',
    },
    {
      id: 'downsample',
      kind: 'int',
      label: 'Downsample',
      default: 1,
      min: 1,
      help: 'Average each this many samples into one: 10 turns 10 kHz into 1 kHz. Averaging rather than skipping keeps noise from folding into the trace, at the cost of blunting a spike narrower than the block a little.',
    },
  ],

  // Pure and synchronous against whatever the peek can answer; a bare table until it lands.
  inferOutputs: (ctx) => {
    const summary = summaryOf(ctx.params)
    return {
      out: summary
        ? T.table(recordingSchema(summary, readRecordingPick(ctx.params)))
        : T.table(),
    }
  },

  validate: (ctx) => {
    const dataId = String(ctx.params.dataId)
    if (!dataId) return [NO_FILE]
    if (!uploadPeekSettled(dataId)) return []
    const summary = summaryOf(ctx.params)
    if (!summary) return [uploadMissingBadge(String(ctx.params.fileName), 'recording')]
    return recordingPickIssues(summary, readRecordingPick(ctx.params))
  },

  evaluate: async (ctx) => {
    const dataId = String(ctx.params.dataId)
    if (!dataId) throw new Error(NO_FILE)
    const recording = await storedRecording(dataId, String(ctx.params.fileName))
    const pick = readRecordingPick(ctx.params)
    // Refuses no sweeps and a table past the crash floor. A pick's other issues are `validate`'s,
    // already on the card; only what the file itself says is new here.
    const out = recordingTable(recording, pick)
    for (const note of recording.summary.notes) ctx.warn(note)
    return { out }
  },
})
