/**
 * NeuronBridge: the light-microscopy images that match each neuron, one neuron at a time.
 *
 * NeuronBridge (Janelia) has matched every neuron of hemibrain, male CNS, MANC, FlyWire and BANC
 * against FlyLight's split-GAL4 and MCFO image collections, and publishes the results as a public
 * bucket (`data/neuronbridge`). This card pages through a neuron table and shows, for the neuron on
 * screen, the lines whose images match it — which is how somebody finds a driver line for a cell
 * they have only ever seen in EM. It is the first light-microscopy data on the canvas.
 *
 * Three decisions, all Neuron Profile's:
 *
 * **`cheap`, and `evaluate` never fetches.** Every request belongs to the widget, per neuron
 * *viewed*, cached for the session: ~1 kB to find the neuron and ~3 MB for its match list. The
 * scheduler never sees them, so a Run costs nothing and nothing downstream waits on a bucket.
 *
 * **Browsing is presentational, pinning is not.** `page`, the collection chips, the method, the
 * comparison modes and the data version decide what the card *draws* and change no output, so none
 * of them marks anything stale. A ☆ writes the whole match into `pins` — not an id to fetch again —
 * so `Pinned` is built from params alone and `evaluate` stays network-free
 * (`nodes/lib/neuronbridgePins.ts`).
 *
 * **A dataset NeuronBridge does not cover is a warning, not a refusal.** The card still pages and
 * says why there is nothing to show; the table still passes through. The same goes for a version
 * mismatch — male CNS `v1.0` wired against NeuronBridge's `v0.9` — which the card states and then
 * looks up anyway, since an id present in both releases is the same body and one that is not simply
 * has no record.
 */

import type { InferContext } from '../../core/node'
import { registerNode } from '../../core/registry'
import { T, columnNames, isTabular, schemaOf } from '../../core/types'
import { isDatasetValue, isTableValue } from '../../core/values'
import { peekCurrentVersion, versionLabel } from '../../data/neuronbridge/client'
import { COVERED_DATASETS, isCoveredDataset } from '../../data/neuronbridge/libraries'
import { COLLECTIONS } from '../../data/neuronbridge/matches'
import { COMPARE_MODES, LM_VIEWS } from '../../data/neuronbridge/views'
import { datasetInfoFromType } from '../lib/datasetParam'
import { PINNED_SCHEMA, pinnedTable, readPins } from '../lib/neuronbridgePins'

/** The source and dataset ids a Dataset socket's type names, when it names them yet. */
function datasetIds(ctx: InferContext): { sourceId: string; datasetId: string } | undefined {
  const type = ctx.inputs.dataset
  if (type?.kind !== 'dataset' || !type.sourceId || !type.datasetId) return undefined
  return { sourceId: type.sourceId, datasetId: type.datasetId }
}

registerNode({
  type: 'out.neuronbridge',
  label: 'NeuronBridge',
  category: 'visualisation',
  description:
    'Page through neurons and see the light-microscopy images NeuronBridge matched to each — ' +
    'split-GAL4 and MCFO lines, best image per line. Pin matches to send them downstream.',
  guide:
    'Finds driver lines for EM neurons. For the neuron on screen, shows NeuronBridge’s ' +
    'precomputed colour-depth matches from FlyLight’s split-GAL4 and MCFO collections, one tile ' +
    'per line at its best image, with the rest one click away. Covers hemibrain, male CNS, MANC, ' +
    'FlyWire and BANC. Paging is free; ☆ pins a match to the Pinned port.',
  cost: 'cheap',
  defaultSize: { width: 620, height: 640 },
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'neurons', label: 'Neurons', type: T.table() },
  ],
  outputs: [
    { id: 'out', label: 'Neurons', type: T.table() },
    { id: 'pinned', label: 'Pinned', type: T.table(PINNED_SCHEMA) },
  ],
  params: [
    {
      id: 'page',
      kind: 'int',
      label: 'Neuron',
      help: 'Which neuron of the incoming table is shown. Browsing never invalidates anything.',
      default: 0,
      min: 0,
      presentational: true,
      advanced: true,
      internal: true,
    },
    {
      id: 'collections',
      kind: 'multiEnum',
      label: 'Collections',
      help: 'Which FlyLight image collections to show matches from. Split-GAL4 Drivers are published, stable lines; Omnibus Broad is a larger release of further split lines; the two MCFO sets are sparse single-cell images of Gen1 GAL4 lines.',
      default: COLLECTIONS.map((c) => c.id),
      options: COLLECTIONS.map((c) => ({ value: c.id, label: c.label })),
      optionsWithoutPeek: true,
      emptyLabel: 'None — nothing is shown',
      noun: 'collection',
      presentational: true,
      // The card draws these as chips above its tiles; a param row on the card as well would be
      // the same control twice. The inspector keeps it.
      advanced: true,
    },
    {
      id: 'method',
      kind: 'enum',
      label: 'Method',
      help: 'Which of NeuronBridge’s matching algorithms to show. Colour depth search (CDS) covers every dataset; PPPM is precomputed for hemibrain only and ranks MCFO images.',
      default: 'cds',
      options: [
        { value: 'cds', label: 'Colour depth search (CDS)' },
        { value: 'pppm', label: 'PPPM (hemibrain)' },
      ],
      optionsWithoutPeek: true,
      presentational: true,
      // A switch on the card where PPPM exists, for `collections`' reason.
      advanced: true,
    },
    {
      id: 'compare',
      kind: 'enum',
      label: 'Compare',
      help: 'How an opened match is drawn: the EM neuron beside the light-microscopy image, the LM image alone, or the EM neuron laid over it. A mirrored match flips the EM image, never the LM one.',
      default: 'side',
      options: COMPARE_MODES.map((m) => ({ value: m.id, label: m.label })),
      optionsWithoutPeek: true,
      presentational: true,
      advanced: true,
    },
    {
      id: 'lmView',
      kind: 'enum',
      label: 'LM image',
      help: 'Which light-microscopy image: the segmented hit NeuronBridge compared, the whole sample it was cut from, or the hit in colour over the whole sample in grey. PPPM has no hit that can be laid over the sample.',
      default: 'hit',
      options: LM_VIEWS.map((v) => ({ value: v.id, label: v.label })),
      optionsWithoutPeek: true,
      presentational: true,
      advanced: true,
    },
    {
      id: 'emOpacity',
      kind: 'number',
      label: 'EM opacity',
      help: 'How strongly the EM neuron is drawn over the LM image in the overlay.',
      default: 0.7,
      min: 0,
      max: 1,
      step: 0.05,
      slider: true,
      presentational: true,
      advanced: true,
    },
    {
      id: 'emTint',
      kind: 'enum',
      label: 'EM drawn in',
      help: 'The EM neuron in an overlay: in white, so it stands apart from the light-microscopy image, or in its own depth colours, where a good match coincides with the hit colour for colour.',
      default: 'white',
      options: [
        { value: 'white', label: 'White' },
        { value: 'colour', label: 'Depth colours' },
      ],
      optionsWithoutPeek: true,
      presentational: true,
      advanced: true,
    },
    {
      id: 'freeze',
      kind: 'boolean',
      label: 'Keep comparison in view',
      help: 'Hold an opened match above the tiles while they scroll, rather than scrolling it away with them.',
      default: true,
      presentational: true,
      advanced: true,
    },
    {
      id: 'tiles',
      kind: 'int',
      label: 'Lines per step',
      help: 'How many lines the card shows at first, and how many more each "Show more" adds.',
      default: 24,
      min: 6,
      max: 200,
      step: 6,
      presentational: true,
      advanced: true,
    },
    {
      id: 'version',
      kind: 'enum',
      label: 'Data version',
      help: 'Which NeuronBridge data release to read. Latest follows NeuronBridge; pin a version to keep a shared workflow showing what it showed you. A pinned match records the version it came from either way.',
      default: '',
      options: () => {
        const current = peekCurrentVersion()
        return current
          ? [
              { value: '', label: `Latest (${versionLabel(current)})` },
              { value: current, label: versionLabel(current) },
            ]
          : [{ value: '', label: 'Latest' }]
      },
      presentational: true,
      advanced: true,
    },
    {
      id: 'pins',
      kind: 'ids',
      label: 'Pinned',
      noun: 'matches',
      help: 'The matches the Pinned port emits. Written by the ☆ on each tile.',
      default: [],
    },
  ],

  inferOutputs: (ctx) => {
    const input = ctx.inputs.neurons
    return {
      // Passed through as whatever came in, so dropping this card between two nodes does not
      // downgrade a Neurons edge into a Table one.
      out: input?.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)),
      pinned: T.table(PINNED_SCHEMA),
    }
  },

  validate: (ctx) => {
    const issues: string[] = []
    const ids = datasetIds(ctx)
    if (ids && !isCoveredDataset(ids.sourceId, ids.datasetId)) {
      const label = datasetInfoFromType(ctx.inputs.dataset)?.label ?? ids.datasetId
      issues.push(`NeuronBridge has no matches for ${label}. It covers ${COVERED_DATASETS}.`)
    }
    const input = ctx.inputs.neurons
    // Only once the schema is known — an unknown one may well have a neuronId (Profile's rule).
    if (isTabular(input) && input.schema) {
      const names = columnNames(input.schema)
      if (!names.includes('neuronId')) {
        issues.push(
          `NeuronBridge needs a "neuronId" column. This table has: ` +
            `${names.length ? names.join(', ') : '(no columns)'}`,
        )
      }
    }
    return issues
  },

  evaluate: (ctx) => {
    const neurons = ctx.input('neurons')
    if (!isTableValue(neurons)) throw new Error('Neurons input is not a table')
    // The dataset is read by the widget alone; it is required so a card is never drawn against
    // ids whose library it cannot name.
    if (!isDatasetValue(ctx.input('dataset'))) throw new Error('Dataset input is not a dataset')
    return { out: neurons, pinned: pinnedTable(readPins(ctx.params.pins)) }
  },
})
