/**
 * Simulate: run a Compartment Model — its partners firing, current injected at its record sites —
 * and read the voltage at the soma and wherever else is recorded.
 *
 * **`expensive`**: a run is tens of milliseconds to minutes, so it waits for Run, and it runs in a
 * worker (`simulateJob.ts`), one job doing the settle, the main run and every per-partner run.
 *
 * **A ticked partner fires**: every partner of the model fires on its train unless silenced — the
 * `silenced` list, which the expanded view's partner table edits (Phase 2b). Each partner's train
 * is its own seeded stream (`stimulus.ts`). The per-partner summary is a separate switch that runs
 * every firing partner alone.
 */

import type { InferContext, ParamValues } from '../../core/node'
import { packNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isCellModelValue } from '../../core/values'
import { runWorkerJob } from '../../data/workerJob'
import { formatNumber } from '../../style/format'
import type { SimulateResult } from './simulateJob'
import { runSimulateJob, sweepClamps } from './simulateJob'
import { columnsInUnit, unitParam } from './unitColumns'
import {
  ARBOUR_SCHEMA,
  CLAMP_SITES_PARAM,
  INPUT_SPIKES_SCHEMA,
  NO_SPIKE_TABLE,
  arbourValue,
  SILENCED_PARAM,
  SHOW_TRACES_PARAM,
  TRACES_PARAM,
  SOMA_COLUMN,
  keepRest,
  CURRENT_TAKEN,
  injects,
  TIME_COLUMN,
  outputSpikesSchema,
  resolveCurrent,
  partnersSchema,
  inputSpikesTable,
  partnersTable,
  planRun,
  runInputs,
  outputSpikesTable,
  inferredTracesSchema,
  tracesTable,
  summaryLeftOut,
  unrestedNote,
} from './simulateOps'

const byTrains = (p: ParamValues) => p.drive === 'trains'
const byTable = (p: ParamValues) => p.drive === 'table'
const clamped = (p: ParamValues) => p.clamp === true
const summarised = (p: ParamValues) => p.perPartner === true

/** The Current socket's table as its pickers read it, or undefined with nothing wired. */
function currentRead(ctx: Pick<InferContext, 'schema' | 'column' | 'params'>) {
  const schema = ctx.schema('current')
  return schema ? resolveCurrent(schema, (id) => ctx.column(id), ctx.params) : undefined
}

export const simulateNode = packNode({
  type: 'biophys:simulate',
  label: 'Simulate Model',
  category: 'analysis',
  description:
    'Runs a Compartment Model with its partners firing and records the voltage at the soma and at ' +
    'wired points; tables of traces, input and output spikes and each partner’s effect, and the arbour coloured by ' +
    'peak voltage.',
  guide:
    'Runs a compartment model: partners fire on seeded spike trains or on times from a spike ' +
    'table, with optional current injection — a step, ramp, sine or pulse train — at any record ' +
    'site. Records the soma, any wired points and the traces added in Playback, ' +
    'and can run each partner alone to say how much it moves the soma. Plot Traces in a Line ' +
    'Chart; colour Arbour by node value in a 3D View.',
  cost: 'expensive',
  inputs: [
    { id: 'model', label: 'Model', type: T.cellModel() },
    { id: 'record', label: 'Record at', type: T.points(), required: false },
    { id: 'spikes', label: 'Input spikes', type: T.table(), required: false },
    { id: 'current', label: 'Current', type: T.table(), required: false },
  ],
  // Traces first: its schema is the one `observesOutputSchema` reads back after a run.
  outputs: [
    { id: 'traces', label: 'Traces', type: T.table() },
    /*
     * The drive as it was fired — seeded trains included — in the columns the Input spikes port
     * reads, so one run's drive can be wired into another.
     */
    { id: 'inputSpikes', label: 'Input spikes', type: T.table() },
    { id: 'outputSpikes', label: 'Output spikes', type: T.table() },
    { id: 'partners', label: 'Partners', type: T.table() },
    /*
     * The neuron with each node's peak voltage on it, for a 3D View set to "by node value". A port
     * of its own rather than values written onto the model's skeleton: the model is the input to
     * every run, and a run must not change it.
     */
    { id: 'arbour', label: 'Arbour', type: T.skeletons() },
  ],
  observesOutputSchema: true,
  paramGroups: [
    { id: 'run', label: 'Run', affectsData: true },
    { id: 'drive', label: 'Drive', affectsData: true },
    { id: 'clamp', label: 'Clamp', affectsData: true },
  ],
  params: [
    {
      id: 'duration',
      kind: 'number',
      label: 'Duration (ms)',
      group: 'run',
      default: 100,
      min: 0.1,
    },
    {
      id: 'dt',
      kind: 'number',
      label: 'dt (ms)',
      group: 'run',
      default: 0.025,
      min: 0.001,
      step: 0.005,
      advanced: true,
    },
    {
      id: 'sampleEvery',
      kind: 'number',
      label: 'Sample every (ms)',
      group: 'run',
      default: 0.1,
      min: 0.001,
      advanced: true,
      help: 'How often the traces are written. Spikes and peaks are read every step whatever this is.',
    },
    {
      id: 'threshold',
      kind: 'number',
      label: 'Spike threshold (mV)',
      group: 'run',
      default: 0,
      advanced: true,
      help: 'An upward crossing of this voltage at a record site counts as a spike. A fly’s somatic spikes are small, attenuated on their way from the axon, so a low threshold.',
    },
    {
      id: 'perPartner',
      kind: 'boolean',
      label: 'Per-partner summary',
      group: 'run',
      default: false,
      help: 'Also run every firing partner alone, one spike each, and say in the Partners table how much it moves the soma and its own synapses. One extra simulation per partner.',
    },
    {
      id: 'window',
      kind: 'number',
      label: 'Summary window (ms)',
      group: 'run',
      default: 50,
      min: 1,
      visibleIf: summarised,
      help: 'How long each partner’s solo run lasts.',
    },
    {
      id: 'summaryOnset',
      kind: 'number',
      label: 'Summary onset (ms)',
      group: 'run',
      default: 5,
      min: 0,
      visibleIf: summarised,
      advanced: true,
      help: 'When each partner’s one spike arrives in its solo run.',
    },
    {
      id: 'drive',
      kind: 'enum',
      label: 'Drive',
      group: 'drive',
      default: 'trains',
      options: [
        { value: 'trains', label: 'Spike trains' },
        { value: 'table', label: 'Input spikes' },
        { value: 'none', label: 'None' },
      ],
      help: 'Spike trains: every firing partner on its own seeded train. Input spikes: times from a table wired into Input spikes, with a partner and a time column — another Simulate Model’s Input spikes output replays its drive. None: only the clamp drives the cell.',
    },
    {
      id: SILENCED_PARAM,
      kind: 'ids',
      label: 'Silenced partners',
      noun: 'partners',
      group: 'drive',
      default: [],
      help: 'Partners that do not fire, whatever Fire says.',
    },
    {
      id: TRACES_PARAM,
      kind: 'ids',
      label: 'Playback traces',
      noun: 'traces',
      group: 'run',
      default: [],
      // Written by clicking Playback's dendrogram and by nothing else (`ParamBase.internal`). In
      // the key: each is a record site, a column of the Traces output, so a click makes the card
      // stale. Playback keeps playing its movie meanwhile, a record site changing nothing a movie
      // shows (`movieBasis`, `simulateJob.ts`).
      advanced: true,
      internal: true,
      help: 'Points on the neuron, clicked on Playback’s dendrogram, whose voltage is recorded beside the soma: each is a column of the Traces output after the next run.',
    },
    {
      id: SHOW_TRACES_PARAM,
      kind: 'boolean',
      label: 'Traces in Playback',
      group: 'run',
      default: true,
      // Playback's own checkbox writes it; how the view is laid out, never what a run returns.
      presentational: true,
      advanced: true,
      help: 'Whether Playback draws the traces under its scrubber. Off, the neuron takes the whole view, and the traces are for a Line Chart wired to the Traces output.',
    },
    {
      id: 'fire',
      kind: 'enum',
      label: 'Fire',
      group: 'drive',
      default: 'all',
      options: [
        { value: 'all', label: 'every partner' },
        { value: 'top', label: 'the top N by synapses' },
      ],
      visibleIf: (p) => p.drive !== 'none',
      help: 'Which partners fire, of those not silenced. All of them at once usually drives a cell to the synapses’ reversal; the top N by synapses fires only the N with most synapses on this neuron.',
    },
    {
      id: 'top',
      kind: 'int',
      label: 'N',
      group: 'drive',
      default: 1,
      min: 1,
      visibleIf: (p) => p.drive !== 'none' && p.fire === 'top',
    },
    { id: 'start', kind: 'number', label: 'Start (ms)', group: 'drive', default: 10, min: 0 },
    {
      id: 'number',
      kind: 'int',
      label: 'Spikes',
      group: 'drive',
      default: 1,
      min: 0,
      visibleIf: byTrains,
    },
    {
      id: 'interval',
      kind: 'number',
      label: 'Interval (ms)',
      group: 'drive',
      default: 10,
      min: 0.1,
      visibleIf: byTrains,
    },
    {
      id: 'noise',
      kind: 'number',
      label: 'Noise',
      group: 'drive',
      default: 0,
      min: 0,
      max: 1,
      step: 0.1,
      slider: true,
      visibleIf: byTrains,
      help: '0 fires at exactly Start, Start + Interval, …; 1 makes every interval exponential with that mean (Poisson). NEURON’s NetStim.',
    },
    { id: 'seed', kind: 'int', label: 'Seed', group: 'drive', default: 1, visibleIf: byTrains },
    {
      id: 'spikePartner',
      kind: 'column',
      label: 'Partner',
      group: 'drive',
      from: 'spikes',
      default: 'partnerId',
      visibleIf: byTable,
    },
    {
      id: 'spikeTime',
      kind: 'column',
      label: 'Time (ms)',
      group: 'drive',
      from: 'spikes',
      default: 'time',
      dtypes: ['f64', 'i64'],
      visibleIf: byTable,
    },
    {
      id: 'clamp',
      kind: 'boolean',
      label: 'Inject current',
      group: 'clamp',
      default: false,
      help: 'A current clamp at the record sites ticked in the Sites tab of the expanded card: the soma unless others are ticked. Combines with Drive, which still fires the partners.',
    },
    {
      id: CLAMP_SITES_PARAM,
      kind: 'ids',
      label: 'Inject at',
      noun: 'sites',
      group: 'clamp',
      // The soma, so a graph from before sites were picked injects where it always did.
      default: [SOMA_COLUMN],
      visibleIf: clamped,
      help: 'The record sites the current is injected at, by name: the soma, `Record at`’s points and Playback’s traces. Picked in the Sites tab of the expanded card; every one gets the same current.',
    },
    {
      id: 'clampShape',
      kind: 'enum',
      label: 'Shape',
      group: 'clamp',
      default: 'step',
      options: [
        { value: 'step', label: 'Step' },
        { value: 'ramp', label: 'Ramp' },
        { value: 'sine', label: 'Sine' },
        { value: 'pulses', label: 'Pulse train' },
      ],
      visibleIf: clamped,
      help: 'Step: Amplitude throughout. Ramp: from From to Amplitude, linearly. Sine: Offset plus Amplitude times a sine of Frequency, rising from Start. Pulse train: Amplitude for Width every Interval. Zero before Start and after Start plus Duration, whatever the shape.',
    },
    {
      id: 'amplitude',
      kind: 'number',
      label: 'Amplitude (nA)',
      group: 'clamp',
      default: 0.05,
      step: 0.01,
      visibleIf: clamped,
      help: 'The current, or a ramp’s end, a sine’s swing either side of Offset, a pulse’s height. Positive depolarises.',
    },
    {
      id: 'rampFrom',
      kind: 'number',
      label: 'From (nA)',
      group: 'clamp',
      default: 0,
      step: 0.01,
      visibleIf: (p) => clamped(p) && p.clampShape === 'ramp',
      help: 'The current at Start, which the ramp runs from to Amplitude at its end.',
    },
    {
      id: 'sineFrequency',
      kind: 'number',
      label: 'Frequency (Hz)',
      group: 'clamp',
      default: 10,
      min: 0,
      visibleIf: (p) => clamped(p) && p.clampShape === 'sine',
    },
    {
      id: 'sineOffset',
      kind: 'number',
      label: 'Offset (nA)',
      group: 'clamp',
      default: 0,
      step: 0.01,
      visibleIf: (p) => clamped(p) && p.clampShape === 'sine',
      help: 'A constant current the sine rides on.',
    },
    {
      id: 'pulseWidth',
      kind: 'number',
      label: 'Width (ms)',
      group: 'clamp',
      default: 2,
      min: 0.001,
      visibleIf: (p) => clamped(p) && p.clampShape === 'pulses',
    },
    {
      id: 'pulseInterval',
      kind: 'number',
      label: 'Interval (ms)',
      group: 'clamp',
      default: 10,
      min: 0.001,
      visibleIf: (p) => clamped(p) && p.clampShape === 'pulses',
      help: 'From the start of one pulse to the start of the next.',
    },
    {
      id: 'clampDelay',
      kind: 'number',
      label: 'Start (ms)',
      group: 'clamp',
      default: 10,
      min: 0,
      visibleIf: clamped,
    },
    {
      id: 'clampDuration',
      kind: 'number',
      label: 'Duration (ms)',
      group: 'clamp',
      default: 50,
      min: 0,
      visibleIf: clamped,
    },
    {
      id: 'currentTime',
      kind: 'column',
      label: 'Current time',
      group: 'clamp',
      from: 'current',
      default: TIME_COLUMN,
      dtypes: NUMERIC_DTYPES,
      whenWired: true,
      advanced: true,
      help: 'The current table’s times, from the start of the run; in ms unless the column says otherwise.',
    },
    {
      id: 'currentValue',
      kind: 'column',
      label: 'Current',
      group: 'clamp',
      from: 'current',
      schemaFrom: columnsInUnit('current', 'current', 'currentUnit', CURRENT_TAKEN),
      default: '',
      dtypes: NUMERIC_DTYPES,
      whenWired: true,
      help: 'The current to inject, held from each row’s time to the next, and added to the Clamp tab’s. Lists the columns in pA or nA; set Current unit to choose any column.',
    },
    {
      id: 'currentSite',
      kind: 'column',
      label: 'Current site',
      group: 'clamp',
      from: 'current',
      default: '',
      optional: true,
      whenWired: true,
      help: 'A column naming the record site each row goes into: soma, a Record at point or a Playback trace. None, or an empty cell, is the soma.',
    },
    {
      id: 'currentSweep',
      kind: 'column',
      label: 'Current sweep',
      group: 'clamp',
      from: 'current',
      default: 'sweep',
      optional: true,
      whenWired: true,
      help: 'A column naming each row’s sweep: every sweep its own run from rest, the outputs gaining a sweep column. None is one run.',
    },
    unitParam('currentUnit', 'Current unit', 'current', ['pA', 'nA'], {
      group: 'clamp',
      whenWired: 'current',
    }),
    {
      id: 'recordLabel',
      kind: 'column',
      label: 'Record label',
      from: 'record',
      default: '',
      optional: true,
      help: 'A column naming each record point; its trace column takes the name. Otherwise sites are numbered.',
    },
    {
      id: 'recordSnap',
      kind: 'number',
      label: 'Record distance (µm)',
      default: 2,
      min: 0,
      advanced: true,
      help: 'A record point further than this from the arbour is not recorded, and is counted.',
    },
  ],

  inferOutputs: (ctx) => {
    const current = currentRead(ctx)
    const sweep = current && 'sweep' in current ? current.sweep?.dtype : undefined
    return {
      // Record sites are named by the data, so after a run the observed schema; before, the two
      // columns every run has. A current table injects, and names the sweeps.
      traces: T.table(
        inferredTracesSchema(ctx.observed, injects(ctx.params, current !== undefined), sweep),
      ),
      inputSpikes: T.table(INPUT_SPIKES_SCHEMA),
      outputSpikes: T.table(outputSpikesSchema(sweep)),
      partners: T.table(partnersSchema(summarised(ctx.params))),
      arbour: T.skeletons(ARBOUR_SCHEMA),
    }
  },

  validate: (ctx) => {
    const current = currentRead(ctx)
    return [
      ...(byTable(ctx.params) && !ctx.inputs.spikes ? [NO_SPIKE_TABLE] : []),
      ...(current && 'issues' in current ? current.issues : []),
    ]
  },

  evaluate: async (ctx) => {
    const value = ctx.input('model')
    if (!isCellModelValue(value)) throw new Error('Wire a Compartment Model into Model.')
    const { job, labels, notes, sweeps, injecting } = planRun(
      value,
      ctx.params,
      runInputs(
        {
          record: ctx.input('record'),
          spikes: ctx.input('spikes'),
          current: ctx.input('current'),
        },
        (id) => ctx.column(id),
        ctx.params,
      ),
    )
    for (const note of notes) ctx.warn(note)

    const result: SimulateResult = await runWorkerJob(
      // Written out here, where vite can see it — see `workerJob.ts`.
      () => new Worker(new URL('./simulate.worker.ts', import.meta.url), { type: 'module' }),
      job,
      {
        label: 'simulation',
        here: runSimulateJob,
        onProgress: (fraction, note) => ctx.progress(fraction, note),
        signal: ctx.signal,
      },
    )
    keepRest(value, job.dt, result.settle)
    if (result.summary && result.summary.cut > 0) {
      const { cut } = result.summary
      ctx.warn(
        summaryLeftOut(
          cut,
          `the soma was still rising when the ${formatNumber(job.summary!.window)} ms window ` +
            'closed, so the peak and the attenuation would be cut short. Lengthen Summary window.',
        ),
      )
    }
    // Each sweep's own ending; the first that stayed away from rest is the one said.
    for (const [s, run] of result.runs.entries()) {
      const unrested = unrestedNote(value, job, sweepClamps(job, s), run.final, result.settle)
      if (!unrested) continue
      ctx.warn(sweeps ? `Sweep ${String(sweeps.cells[s])}: ${unrested}` : unrested)
      break
    }
    if (result.settle && !result.settle.converged) {
      ctx.warn(
        `The model had not come to rest after ${formatNumber(result.settle.time)} ms of settling: ` +
          'it is still drifting, or fires on its own with no input. The run starts from where it was.',
      )
    }

    return {
      traces: tracesTable(labels, result, job, sweeps, injecting),
      inputSpikes: inputSpikesTable(value, job.firing),
      outputSpikes: outputSpikesTable(labels, result, sweeps),
      partners: partnersTable(
        value,
        job.firing.map(([p]) => p),
        result.summary,
      ),
      arbour: arbourValue(value, result.peak),
    }
  },
})
