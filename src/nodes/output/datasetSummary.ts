import type { InferContext } from '../../core/node'
import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isDatasetValue } from '../../core/values'
import { ANY_OPTION, datasetInfoFromType, schemasFromType } from '../lib/datasetParam'

/**
 * What is in this dataset?
 *
 * The question Explore answers one neuron at a time and Profile answers one cell at a time,
 * asked of the whole volume: how many neurons, how they are classified, which transmitters,
 * which side, and — the part no other surface here can show — how completely each region has
 * been reconstructed. Modelled on Codex's Stats page, with ROI completeness added, because a
 * dataset that is 91% traced on presynaptic sites and 39% on postsynaptic ones is a fact worth
 * knowing before reading any number that came out of it.
 *
 * Three shape decisions, each with a precedent in this codebase.
 *
 * **A self-drawing viewer with no outputs.** `category: 'visualisation'` plus an entry in
 * `SELF_DRAWING_NODE_TYPES` is what earns it resize handles, a `defaultSize` and the full-size
 * overlay while having no output value of its own — the same standing `out.neuroglancer` and
 * `out.profile` have, minus their ports. No outputs at all is `dataset.description`'s call and
 * for the same reason: this is an annotation hanging off a dataset node, and a socket would
 * invite wiring a pipeline through the credits. Appending a `Selected` output later, when
 * clicking a bar lands, moves no existing socket.
 *
 * **`cheap`, despite the widget fetching a great deal.** `evaluate` touches no network — it
 * confirms the input is a dataset and returns nothing. The neuron index, the ROI completeness
 * and the region connectivity are all the *widget's* requests, issued and cached on its own
 * terms, exactly as Profile's three per-neuron fetches are. What a viewer fetches for itself is
 * not what the scheduler has to reason about.
 *
 * **Every param but `Status` is presentational**, which here is trivially true and still worth
 * stating: `evaluate` returns nothing, so nothing can change what it returns. `Status` is the
 * exception in *meaning* rather than in effect — it decides which neurons every count is over,
 * so it belongs in the provenance key on the same principle even though no downstream node can
 * observe it today. Marking it presentational would be right by the letter and wrong the moment
 * this node grows the `Selected` output.
 */

/**
 * The neuron index carries no status filter.
 *
 * `neuronIndex` calls `findNeurons` with none, so the cached table is every `:Neuron` in the
 * dataset rather than the Traced subset — deliberately, since it is what Explore searches. The
 * default here is therefore *everything*, unlike `Find Neurons` and `IDs from Label`, which both
 * default to `Traced`. That is not an inconsistency to tidy away: those two narrow a population
 * somebody is asking about, where this describes a dataset, and a summary that quietly omitted
 * 11,300 of male-CNS's 176,422 neurons would be answering a different question than its title.
 * The caption names the population every time.
 */
const STATUS_HELP =
  'Which neurons the counts are over. Empty means every neuron the dataset publishes, which is what the index carries — unlike Find Neurons, which defaults to Traced.'

export const datasetSummaryNode = registerNode({
  type: 'out.datasetSummary',
  label: 'Dataset Summary',
  category: 'visualisation',
  description:
    'What is in a dataset: neuron counts, how they are classified, and how completely each region is traced.',
  guide:
    'High-level summary of what`s in the dataset: neuron counts, annotations, reconstruction completeness and so on. What can be shown depends on the input dataset.',
  cost: 'cheap',
  // Profile's box. The two are the same kind of card — a grid of tiles read at a glance — and a
  // summary that opened narrower than the thing it is a sibling of would read as less important.
  defaultSize: { width: 560, height: 620 },
  inputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  outputs: [],
  params: [
    {
      id: 'status',
      kind: 'enum',
      label: 'Status',
      help: STATUS_HELP,
      default: '',
      options: (ctx: InferContext) => {
        const statuses = datasetInfoFromType(ctx.inputs.dataset)?.statuses ?? ['Traced']
        return [ANY_OPTION, ...statuses.map((s) => ({ value: s, label: s }))]
      },
      advanced: true,
    },
    {
      /*
       * Which attributes get a chart. Empty means "decide for me", which is what
       * `summaryAttributes` does from a priority list — the same idiom, and the same wording,
       * as Explore's `chips`. A list chosen here is taken literally and uncapped, because
       * trimming what somebody asked for by name is how a control stops being believed.
       */
      id: 'attributes',
      kind: 'columns',
      label: 'Charts',
      from: 'dataset',
      // A Dataset socket carries a source id, not a schema, so the picker is handed the lookup
      // — the same neuron schema the counts are taken over.
      schemaFrom: (inputs) => schemasFromType(inputs.dataset).neurons,
      help: 'Which fields get a chart. Leave empty to choose automatically.',
      default: [],
      presentational: true,
      advanced: true,
    },
    {
      /*
       * Ten, where Codex's page lists twenty-five.
       *
       * The number is set by the card rather than by the question: at twenty the list alone is
       * most of a 620px card and pushes the region tiles — the thing this widget has that no
       * other surface does — off the bottom. Capping it in `compact` and showing more in the
       * overlay was the other option and is the one Explore's chips already record as a
       * mistake: the card is where a list is actually read, and a card that disagrees with its
       * own overlay is worse than a shorter list. Raise it in the inspector; both follow.
       */
      id: 'topTypes',
      kind: 'int',
      label: 'Top cell types',
      help: 'How many of the most numerous cell types to list. 0 hides the tile.',
      default: 10,
      min: 0,
      max: 100,
      step: 5,
      presentational: true,
      advanced: true,
    },
    {
      /*
       * Which half of a synapse the completeness chart reports.
       *
       * Postsynaptic by default, and that default is a statement about the data rather than a
       * preference: the two answers differ by fifty points on hemibrain — 91% of presynaptic
       * sites are traced against 37% of postsynaptic ones — and the postsynaptic figure is the
       * one that bounds what a connectivity query can see, because a connection is only found
       * when the *receiving* neuron is reconstructed.
       *
       * There is deliberately no third option. neuPrint publishes `roipre`/`roipost` and
       * nothing else per region; `Meta.roiInfo` adds only `mito`/`dark`/`light`/`medium`,
       * which are EM annotations rather than tracing. A connection-level completeness would
       * need per-connection data nobody publishes.
       */
      id: 'completenessMeasure',
      kind: 'enum',
      label: 'Completeness',
      help: 'Which half of a synapse the region chart reports. Postsynaptic bounds what a connectivity query can see.',
      default: 'post',
      options: [
        { value: 'post', label: 'Postsynaptic' },
        { value: 'pre', label: 'Presynaptic' },
      ],
      presentational: true,
      advanced: true,
    },
    {
      /*
       * Ranked, or in name order.
       *
       * Ranked is the default because the chart's first job is "where can I trust this?", which
       * is a question about the *shape* of the list. Name order answers the other one — "how
       * complete is the region I already care about?" — and on male-CNS's 144 paged regions
       * that is the difference between looking something up and hunting for it.
       */
      id: 'completenessSort',
      kind: 'enum',
      label: 'Region order',
      help: 'Rank the region chart by completeness, or list the regions by name.',
      default: 'value',
      options: [
        { value: 'value', label: 'By value' },
        { value: 'label', label: 'By name' },
      ],
      presentational: true,
      advanced: true,
    },
    {
      id: 'refresh',
      kind: 'int',
      label: 'Refresh',
      help: "Bumped by the card's reload button. Re-downloads the dataset index instead of reading the cached copy.",
      default: 0,
      min: 0,
      presentational: true,
      advanced: true,
      // Machinery a widget writes, not a setting — so the card's `… N more` hint does not
      // announce it and turning it does not read as a parameter somebody changed.
      internal: true,
    },
  ],

  inferOutputs: () => ({}),

  /*
   * Nothing is fetched here, and nothing is returned.
   *
   * The check is still worth running: a Dataset socket wired to something that is not a dataset
   * should be a node error rather than a card that silently draws nothing, and it is the only
   * thing about this node the scheduler can usefully report.
   */
  evaluate: async (ctx) => {
    if (!isDatasetValue(ctx.input('dataset'))) throw new Error('Input is not a dataset')
    return {}
  },
})
