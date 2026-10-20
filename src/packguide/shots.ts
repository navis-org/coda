/**
 * How each pack guide's figures are made: `pnpm guide:shots` opens the named example in headless
 * Chrome, runs it, does what the shot says and writes a WebP into `public/guides/<folder>/`. One
 * table, read by the script and by `render.test.ts`, which holds it to the figures each guide
 * actually shows — a second list in the script would be the copy that drifts.
 *
 * Data only: the script imports this through `vite-node`, and so does the test.
 */

export interface GuideShot {
  /**
   * The `demo://` node type whose example the shot is taken in — the guide's own Open link. None is
   * the app on a first visit, for a picture of the app itself (a dialog `open` opens).
   */
  readonly demo?: string
  /** The credential the example needs: read from this machine, never printed, the shot skipped without it. */
  readonly signIn?: 'neuprint'
  /** Plugins switched on first, by pack id. */
  readonly switchOn?: readonly string[]
  /**
   * The example's cards to keep, by id, every other taken off before the run: the workflow as a
   * step of the guide has built it so far.
   */
  readonly keep?: readonly string[]
  /**
   * A new, empty workflow holding these node types in a row, unwired — a pack's nodes side by side.
   * Taken on the canvas.
   */
  readonly cards?: readonly string[]
  /** The canvas itself, fitted to the workflow, rather than an expanded node. */
  readonly canvas?: true
  /** A store action opening a dialog, which is then the picture: `openPlugins`, say. */
  readonly open?: string
  /** Expand the first node of this type. */
  readonly expand?: string
  /** Then open these tabs of its expanded view, by label, in order — beside the drawing and among the settings. */
  readonly tab?: string | readonly string[]
  /**
   * Then move the slider of this accessible name this far along, 0 to 1 — Playback's `Time`, say,
   * so the picture is mid-run.
   */
  readonly range?: { readonly label: string; readonly at: number }
  /** Crop to these elements of the expanded view or dialog, together, rather than taking all of it. */
  readonly crop?: readonly string[]
  /** Params set before the run, on the first node of each type named. */
  readonly params?: readonly { type: string; param: string; value: string | number | boolean }[]
}

const SIMULATE = { demo: 'biophys:simulate', signIn: 'neuprint' } as const
const FIT = { demo: 'biophys:fit' } as const

/** Every guide's figures, by pack id and then file name: written to `public/guides/<pack>/`. */
/** The guide's workflow, card by card as its steps add them (`wizard/curated.ts`' example). */
const NEURON = ['ds', 'find', 'pick', 'skel']
const MODEL = [...NEURON, 'model']
const INPUT = [...MODEL, 'orns', 'syn']
const SIMULATED = [...INPUT, 'sim']

/** Every guide's figures, by pack id and then file name: written to `public/guides/<pack>/`. */
export const GUIDE_SHOTS: Readonly<Record<string, Readonly<Record<string, GuideShot>>>> = {
  biophys: {
    // Section 2: the five nodes, side by side.
    'nodes.webp': {
      switchOn: ['biophys'],
      cards: [
        'biophys:model',
        'biophys:simulate',
        'biophys:loadRecording',
        'biophys:fit',
        'biophys:combineTraces',
      ],
      canvas: true,
    },
    // 1. The plugin, switched on.
    'plugins.webp': {
      switchOn: ['biophys'],
      open: 'openPlugins',
      crop: ['[data-pack="biophys"]'],
    },
    // 2. A neuron and its skeleton.
    'step-neuron.webp': { ...SIMULATE, keep: NEURON, canvas: true },
    // 3. The model: on the canvas, its membrane, regions and channels.
    'step-model.webp': { ...SIMULATE, keep: MODEL, canvas: true },
    'model-membrane.webp': { ...SIMULATE, keep: MODEL, expand: 'biophys:model', tab: 'Model' },
    'regions-tab.webp': { ...SIMULATE, keep: MODEL, expand: 'biophys:model', tab: 'Regions' },
    'channels-tab.webp': { ...SIMULATE, keep: MODEL, expand: 'biophys:model', tab: 'Channels' },
    // 4. Its input: the ORNs' synapses, and their preset.
    'step-synapses.webp': { ...SIMULATE, keep: INPUT, canvas: true },
    'synapse-preset.webp': {
      ...SIMULATE,
      keep: INPUT,
      expand: 'biophys:model',
      tab: ['Model', 'Synapses (exc.)'],
    },
    // 5. Simulate Model: who fires and how, and where it records.
    'step-simulate.webp': { ...SIMULATE, keep: SIMULATED, canvas: true },
    'simulate-drive.webp': {
      ...SIMULATE,
      keep: SIMULATED,
      expand: 'biophys:simulate',
      tab: ['Partners', 'Drive'],
    },
    // At the start of the run, the neuron at rest, so the trace marks are what stands out.
    'record-sites.webp': {
      ...SIMULATE,
      keep: SIMULATED,
      expand: 'biophys:simulate',
      tab: 'Playback',
      range: { label: 'Time', at: 0 },
      crop: ['.playback__controls', '.playback__dendrogram'],
    },
    // 6. The run: played back, and what comes out.
    'playback.webp': {
      ...SIMULATE,
      keep: SIMULATED,
      expand: 'biophys:simulate',
      tab: 'Playback',
      range: { label: 'Time', at: 0.245 },
    },
    'step-outputs.webp': { ...SIMULATE, canvas: true },
    'simulate-traces.webp': { ...SIMULATE, expand: 'out.lineChart' },
    'fit-workflow.webp': { ...FIT, canvas: true },
    // A step a few mV deep: the example's own drives its miniature cell a volt and more.
    'fit-view.webp': {
      ...FIT,
      expand: 'biophys:fit',
      params: [{ type: 'biophys:simulate', param: 'amplitude', value: -0.0001 }],
    },
  },
}
