/**
 * Match Cell Types — the correspondence two connectomes need before anything can be compared.
 *
 * The node around `matchCellTypes` ([typeMapping.ts](../lib/typeMapping.ts)), which holds the
 * algorithm and its reasoning. What lives here is everything the algorithm deliberately does not
 * know about: which datasets, which columns, where the rows come from, and what the answer looks
 * like as a table. See [comparative.md](../../../docs/comparative.md) for the decisions.
 *
 * Three of those decisions show up directly in this file.
 *
 * **It takes every dataset at once** (decision 2's prerequisite). A three-dataset mapping is not
 * two two-dataset mappings composed — cocoa's AOTU008 figures, and the reason the ports are
 * variadic rather than a pair. Nothing here lets a user chain two of these, because the chained
 * answer is finer than the true one with nothing on screen to say so.
 *
 * **It reads each dataset's whole annotation table, not the rows somebody wired in** (decision
 * 4). The evidence that `A_a` and `A_b` split from `X` very often sits entirely outside the
 * neurons you selected, so a mapper fed a selection would give a *different* answer for the same
 * two neurons depending on what else the surrounding graph happened to query. That is why the
 * inputs are Datasets rather than tables, why the node needs the `neuronIndex` capability, and
 * why it **refuses by name** where a source has not got one instead of falling back to something
 * smaller. A fallback here is a different answer wearing the same node.
 *
 * **`expensive` is a safety property, not a cost estimate** (invariant 6). Each input is a
 * multi-megabyte download from a shared server; on the cheap pass this would fire one per
 * keystroke in the ignore-labels box.
 *
 * **Every correspondence is derived; the one thing a user may assert is that a type has none.**
 * There *was* a way to assert a correspondence — a `Synonyms` port carrying cocoa's
 * `add_synonym` edges — and it went because nobody used it, cocoa's own users included. So `LC4`
 * and `Lobula columnar 4`, the same cells under two naming conventions sharing no text, stay
 * apart, and forcing the pair is a downstream `Relabel` where the claim is a visible table row.
 *
 * The `Pass Through` port is the opposite assertion and is kept for a reason the `Synonyms` port
 * never had: a *sex-specific* type is real, common, and indistinguishable in the data from a
 * naming artifact — both are a label with neurons in one brain and none in another, which is
 * precisely what step 1 drops. Only the user knows which is which. It does not weaken the
 * matching, because it is a separate pass over what the matcher left empty rather than an
 * exemption threaded through the coverage tests; see `passThrough`, and the report's `matched`
 * column for how the two stay told apart. See [comparative.md](../../../docs/comparative.md).
 *
 * The per-dataset type-column pickers are `types1..typesN` hidden past the current count with
 * `visibleIf`, which is the pattern `core/ports.ts` documents: ports are variadic, params are
 * not, and a hidden param is outside the provenance key so a picker past the arity cannot stale
 * a run.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import {
  datasetRequest,
  requireDataset,
  schemasFromType,
  sourceLabel,
  sourceSupports,
} from '../lib/datasetParam'
import { warnOverThreshold } from '../../core/limits'
import { narrowPopulation } from '../../data/neuronFilter'
import { parseTypedLabels } from '../lib/labelLookup'
import { repeatParamId, repeatParams } from '../lib/repeatParams'
import type { LabelMode, MapperDataset } from '../lib/typeMapping'
import {
  DEFAULT_NO_SPLIT_PREFIXES,
  LABEL_MODE_OPTIONS,
  MAPPER_GRAPH_EDGE_SCHEMA,
  MAPPER_GRAPH_NODE_SCHEMA,
  MAPPER_LABELS_SCHEMA,
  MAPPER_REPORT_SCHEMA,
  UNMATCHED_WARN_FRACTION,
  keepLabelsFrom,
  mapperNetwork,
  mapperDatasetFrom,
  mapperLabelsTable,
  mapperReportTable,
  matchCellTypes,
} from '../lib/typeMapping'

/**
 * How many connectomes one mapping may span.
 *
 * Four, and it is a statement about the science rather than about the machine: FlyWire's two
 * hemispheres, the hemibrain and the maleCNS is the largest set anybody has actually asked to
 * map, and cocoa's own worked examples stop at three. Raising it costs nothing structural —
 * every port and picker is generated — but each input is a whole-brain annotation download, so
 * the number should follow a real use rather than lead it.
 */
const MAX_DATASETS = 4

/**
 * How many nodes may reach the `Network` port before the card says something.
 *
 * A statement about the *drawing*, not about the mapping, which is why it sits on the node
 * rather than beside `COMPONENT_NODE_CAP` in the mapper: the graph is correct at any size and
 * nothing downstream of the labels ports is affected. Two whole-brain annotation tables build a
 * few thousand label nodes and a few thousand neuron groups — cocoa's collapse is done at
 * construction, so this is already the small form — and a force layout is unreadable well
 * before it is slow. Chosen for legibility rather than measured, and it warns rather than
 * refusing ([limits.md](../../../docs/limits.md)): `Filter Network` is the answer, and a user
 * who wants the whole thing on screen is allowed to have it.
 */
const GRAPH_NODE_WARN = 2_000

/**
 * The arity, declared once and handed to both the param list and `repeatParams`.
 *
 * `registerNode` reads the group's range off this object; so does the picker loop below. A bare
 * `MAX_DATASETS` in the second place is the copy `registry.ts` removed from `PortGroupDef`.
 */
const datasetCountParam = {
  id: 'datasetCount',
  kind: 'int',
  label: 'Datasets',
  help: 'How many connectomes to map between. Two subtypes can stay distinct across two datasets and collapse when a third knows only the coarse label, so this is part of the question rather than a convenience.',
  default: 2,
  min: 2,
  max: MAX_DATASETS,
} as const

/**
 * The per-dataset type-column pickers, declared to `MAX_DATASETS` and hidden past the count.
 *
 * `repeatParams` supplies the id suffix, the port suffix and the `visibleIf` — see that module
 * for what goes wrong without it. What is left here is the one picker itself, and the one rule
 * this node has to keep: `from` and `schemaFrom` read `slot.port('dataset')`, the same call
 * twice, because `from` says which port must be connected and `schemaFrom` says where the
 * options come from — and a picker reading dataset 2's schema while resolving against dataset 3
 * shows an empty column list, which reads as a schema that has not arrived rather than as a bug.
 */
const typeColumnParams = repeatParams({
  count: datasetCountParam,
  build: (slot) => [
    {
      id: slot.id('types'),
      kind: 'columns',
      label: `Type columns ${slot.index}`,
      // One base, from which `repeatParams` writes both `from` and `schemaFrom` — see that
      // module for why the pair cannot be left to two hand-written strings.
      fromPort: 'dataset',
      schemaOf: (type) => schemasFromType(type).neurons,
      help: 'Every column naming a cell type, including the ones written in another dataset’s namespace — those cross-references are what the match is made of.',
      default: [] as string[],
      // Empty is refused by `validate` rather than by the picker, so the message can name which
      // dataset is missing its columns instead of four identical "required" marks.
      optional: true,
    },
  ],
})

export const matchTypesNode = registerNode({
  type: 'compare.matchTypes',
  label: 'Match Cell Types',
  category: 'analysis',
  description: 'Work out which cell types correspond between two or more connectomes.',
  guide:
    'Builds the correspondence every cross-brain comparison needs: which cell types in one connectome are the same cells as which in another, given that type names are revised per dataset and not backported. Emits one labels table per dataset plus a report — and the report is the part to read, since a mapping error looks exactly like a finding.',
  cost: 'expensive',
  dataCache: true,

  inputs: [
    {
      repeat: 'datasetCount',
      ports: [{ id: 'dataset', label: 'Dataset {n}', type: T.dataset() }],
    },
    {
      id: 'keep',
      label: 'Pass Through',
      type: T.table(),
      required: false,
    },
  ],
  outputs: [
    {
      repeat: 'datasetCount',
      ports: [{ id: 'labels', label: 'Labels {n}', type: T.table(MAPPER_LABELS_SCHEMA) }],
    },
    { id: 'report', label: 'Report', type: T.table(MAPPER_REPORT_SCHEMA) },
    {
      id: 'network',
      label: 'Network',
      type: T.network(MAPPER_GRAPH_NODE_SCHEMA, MAPPER_GRAPH_EDGE_SCHEMA),
    },
  ],

  params: [
    datasetCountParam,
    ...typeColumnParams,
    {
      id: 'labelMode',
      kind: 'enum',
      label: 'Name matches by',
      help: 'What a matched group is called. “Every name, joined” is the one to reach for when you want to see that two types were merged.',
      default: 'first',
      options: [...LABEL_MODE_OPTIONS],
    },
    {
      id: 'badLabels',
      kind: 'string',
      label: 'Ignore labels',
      help: 'Labels that are not cell types — “unknown”, “na”, a placeholder. Nothing in the data marks these, and left in they correspond like any other label and quietly assert that two neurons are the same cells. Commas or new lines.',
      default: '',
    },
    {
      id: 'keepColumn',
      kind: 'column',
      label: 'Pass-through labels',
      from: 'keep',
      help: 'On the Pass Through table: the column holding the type names to let through. One name per row; a name that never appears in any dataset simply does nothing.',
      default: 'label',
      /*
       * Optional, so that an empty picker means "nothing passes through" and keeps meaning it.
       * Required, it would fall back to the *first compatible column* of whatever is wired,
       * which on a neuron table is `neuronId` — a column of ids read as type names, matching
       * nothing, and the node then looks like it is ignoring the port.
       */
      optional: true,
    },
    /*
     * Everything below is `advanced`. `Pass-through labels` is not, and the Inspector renders
     * params in declaration order with no grouping of its own — declared after these it drew
     * under "Allow indirect matches", which is where a control goes to not be found.
     */
    {
      id: 'compoundSeparator',
      kind: 'string',
      label: 'Compound separator',
      help: 'What joins two type names written in one field — “PS008,PS009”. Split into its parts so a dataset that kept them apart can match one that did not.',
      default: ',',
      advanced: true,
    },
    {
      id: 'noSplitPrefixes',
      kind: 'string',
      label: 'Never split starting with',
      help: 'Prefixes marking a label whose separator is part of its name: “(M_adPNm4,M_adPNm5)b” is one type, “CB.FB3,4A9” is a compartment path. Commas or new lines, so a prefix cannot itself contain one.',
      default: DEFAULT_NO_SPLIT_PREFIXES.join(', '),
      advanced: true,
    },
    {
      id: 'allowIndirect',
      kind: 'boolean',
      label: 'Allow indirect matches',
      help: 'Let a correspondence run through another neuron — A shares a group label with B, and B has the type that matches. Off, because that is a claim about A that the data made about B.',
      default: false,
      advanced: true,
    },
  ],

  /*
   * No `inferOutputs`. Every schema this node publishes is a constant declared on the port
   * itself, and `outputTypesFor` already seeds each output from its declared type — so an
   * `inferOutputs` here would be a second derivation of the same two constants, kept in step
   * with the port list by hand. That is the parallel structure invariant 3 is about, in the one
   * form where it buys nothing.
   *
   * What makes the constants possible is that the *report* is long: one row per label per
   * dataset rather than a count column per dataset. See `MAPPER_REPORT_SCHEMA`.
   */

  validate: (ctx) => {
    const issues: string[] = []

    for (const port of ctx.inputPorts()) {
      if (port.group?.repeat !== 'datasetCount') continue
      const type = ctx.inputs[port.id]
      if (!type) continue
      const index = port.group.index

      /*
       * The capability, said at edit time on the card rather than at Run three layers down. A
       * source without a neuron index cannot answer "every neuron and its types", and decision 4
       * rules out falling back to whatever rows are around — so the honest thing is to name the
       * backend that cannot do it while there is still something to change.
       */
      if (!sourceSupports(type, 'neuronIndex')) {
        issues.push(
          `Dataset ${index}: ${sourceLabel(type) ?? 'This source'} cannot list a whole dataset, ` +
            `which is what matching types needs.`,
        )
      }
      if (ctx.columns(repeatParamId('types', index)).length === 0) {
        issues.push(`Dataset ${index}: pick at least one column holding cell types.`)
      }
    }

    /*
     * Only worth saying once something is wired. The picker is optional, so empty is a decision
     * everywhere else — but a *wired* table with no column chosen is a table somebody went to
     * the trouble of building and that this node is ignoring, which is the one reading of
     * "empty" nobody intends.
     */
    if (ctx.inputs.keep && !ctx.column('keepColumn')) {
      issues.push('Pass Through: pick the column holding the type names to let through.')
    }
    return issues
  },

  evaluate: async (ctx) => {
    const ports = ctx.inputPorts().filter((port) => port.group?.repeat === 'datasetCount')

    /*
     * Resolved before anything is fetched, so a source that cannot answer is named while nothing
     * has been downloaded yet — four multi-megabyte indices followed by a refusal is the same
     * refusal, thirty seconds later.
     */
    const wanted = ports.map((port) => {
      const dataset = requireDataset(ctx.input(port.id), port.label ?? port.id)
      const source = ctx.resolveSource(dataset.sourceId)
      if (!source.neuronIndex) {
        throw new Error(
          `${source.label} does not publish a neuron index, so ${dataset.datasetId} cannot be ` +
            `matched on cell types. Matching reads every neuron's types, not just the ones wired ` +
            `in — see the node's guide.`,
        )
      }
      return {
        dataset,
        source,
        columns: ctx.columns(repeatParamId('types', port.group!.index)),
      }
    })
    const names = wanted.map(({ dataset }) => dataset.datasetId)

    /*
     * Concurrently, and the progress is their mean. Each index is a separate host and separately
     * cached, so four sequential downloads would be four times the wait for no benefit — the
     * sequential version was measurably the whole cost of a first run.
     */
    const fractions = wanted.map(() => 0)
    const datasets: MapperDataset[] = await Promise.all(
      wanted.map(async ({ dataset, source, columns }, i) => {
        const index = await source.neuronIndex!({
          ...datasetRequest(dataset),
          refresh: ctx.refresh,
          onProgress: (fraction, note) => {
            fractions[i] = fraction
            const done = fractions.reduce((sum, f) => sum + f, 0) / fractions.length
            ctx.progress(done * 0.85, note ?? dataset.datasetId)
          },
          signal: ctx.signal,
        })
        // Each side's own population, applied per dataset: the two inputs are independent
        // dataset nodes and one may be narrowed while the other is not. On the rows in hand
        // rather than in the request, for `explore.ts`' reason — one cached index per dataset,
        // however many readings of it a graph holds.
        return mapperDatasetFrom(narrowPopulation(index, dataset.population), columns)
      }),
    )

    ctx.progress(0.9, 'matching')
    const mapping = matchCellTypes(datasets, {
      badLabels: parseTypedLabels(ctx.params.badLabels),
      compoundSeparator: String(ctx.params.compoundSeparator ?? ','),
      noSplitPrefixes: parseTypedLabels(ctx.params.noSplitPrefixes),
      labelMode: ctx.params.labelMode as LabelMode,
      allowIndirect: ctx.params.allowIndirect === true,
      keepLabels: keepLabelsFrom(ctx.input('keep'), ctx.column('keepColumn')),
      warn: ctx,
    })

    /*
     * How much of each dataset came out with no shared label — an attribution rather than a
     * threshold, in `docs/limits.md`'s sense. A mapping covering a tenth of a brain produces a
     * perfectly ordinary pair of tables, and every downstream comparison then silently describes
     * that tenth.
     */
    mapping.unmatched.forEach((count, i) => {
      const total = datasets[i]!.length
      if (!total || count / total < UNMATCHED_WARN_FRACTION) return
      ctx.warn(
        `${names[i]}: ${count.toLocaleString()} of ${total.toLocaleString()} neurons matched ` +
          `nothing in the other datasets. Anything built on this mapping describes only the rest.`,
      )
    })

    /*
     * The `Network` port carries every component, including the ones step 1 dropped, because
     * "why did these two not correspond?" is only answerable from a dropped one — which is most
     * of what an inspection port is for. That makes it the biggest thing this node emits and the
     * one nothing else trims, so the size is said here rather than discovered when a viewer
     * stops responding. A warning and not a refusal, `limits.md`'s rule: the graph is correct at
     * any size and `Filter Network` is the answer.
     */
    if (mapping.graph.nodes.length > GRAPH_NODE_WARN) {
      warnOverThreshold(ctx, {
        count: mapping.graph.nodes.length,
        threshold: GRAPH_NODE_WARN,
        unit: 'nodes on the Network port',
        control: 'what a node-link drawing stays readable at',
        cost:
          `The mapping itself is unaffected — this is only the inspection port. Put a Filter ` +
          `Network between it and the viewer: pick one label and expand to its connected ` +
          `component, which is the unit the algorithm actually decides on.`,
      })
    }

    return Object.fromEntries(
      ctx.outputPorts().map((port) => {
        if (port.group)
          return [port.id, mapperLabelsTable(mapping.labels[port.group.index - 1]!)]
        if (port.id === 'network') return [port.id, mapperNetwork(mapping.graph, names)]
        return [port.id, mapperReportTable(mapping.report, names)]
      }),
    )
  },
})
